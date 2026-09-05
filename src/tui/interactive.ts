/**
 * TUI 交互模式：底部输入框 + 消息滚动区，多轮对话全部在 TUI 内完成。
 *
 * 流程：等待输入框 Enter 提交 → 回显用户消息 → 跑一轮 Agent → 等待下一轮。
 * 支持 / 命令（/theme /exit /clear /help，见 commands.ts）：
 *   · 提交 `/xxx` 时调 runCommand 分发，'exit' 结果结束循环；
 *   · 带面板的命令（如 /theme）打开 state.menu——面板打开期间键盘事件由
 *     handleMenuKey 在全局 keypress 里先于输入框拦截（↑/↓/数字选择、Enter 确认、
 *     Esc 取消），输入框不参与，也不会误提交。
 * Ctrl+C 由 startTui 的 onCtrlC 处理：输入框有内容时清空输入框（不退出，可继续输入）；
 * 输入框为空才退出进程（原 exitOnCtrlC 语义）。
 *
 * 按键刷新：输入框内部编辑会自行 requestRender，但这里再订阅一次 keypress
 * 显式重绘，兜底保证键入字符实时上屏（与 30ms 节流无关，代价很小）。
 */
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { TextareaRenderable } from '@opentui/core';
import { createClient, type ModelEndpoint } from '../client.js';
import { prepareContext } from '../agent/context.js';
import { runAgent } from '../agent/loop.js';
import { maybeWriteGlobalMemory, maybeWriteProjectMemory } from '../agent/memory.js';
import { appendSessionMessages, finalizeSession, findSessionById, loadSession, persistableMessages, removeEmptySession, sessionIdFromPath } from '../agent/session.js';
import { autoGitCommit, createCheckpoint } from '../agent/rewind.js';
import { generateSessionTitle } from '../agent/title.js';
import type { RunOptions } from '../agent/types.js';
import { EventRecorder } from '../agent/events.js';
import { refreshTrace } from './trace.js';
import { closeMcpClients, discoverMcpServers, buildMcpTools, mcpInstructionsMessage, type McpServerConfig } from '../tools/mcp.js';
import { setTerminalTitle } from '../ui.js';
import { handleMenuKey, runCommand, scheduleCmdPanelAutoClose, type TuiCommandContext } from './commands.js';
import { matchShortcutKey } from './shortcuts.js';
import { persistLanguageToConfig, persistModelDefaultToConfig, persistReasoningEffortToConfig, persistVariantToConfig } from '../config/write.js';

function findProviderForModel(endpoints: ModelEndpoint[], model: string): string | undefined {
  return endpoints.find((endpoint) => endpoint.name === model)?.provider;
}
import { insertMention } from './mention.js';
import { enqueuePending, handlePendingKey, selectLastPending } from './pending.js';
import { t, tf } from './i18n.js';
import type { TuiOutput } from './output.js';
import type { TuiSession, TuiKey } from './render.js';
import { pushCmdLine, pushLine, type ScrollAction, type TuiState } from './state.js';

/**
 * 等待输入框下一次 Enter 提交，resolve 出输入内容与提交模式。
 *
 * 多行 Textarea 的 Enter 由自定义 keyBinding 路由到 submit()，submit() 触发
 * onSubmit 回调（不清空内容）。这里设置一次性 onSubmit：提交后立即解除，
 * 从 plainText（buffer 全文本，含换行）读取输入。
 *
 * 模式（state.submitMode，keypress 在 Enter 时写入）：Enter = queue（空闲时
 * 直接执行，运行中入待发送列表末尾）；Cmd/Ctrl/Super/Option+Enter = steer（空闲时
 * 直接执行，运行中打断当前回合并插到待发送列表最前优先执行）。submit 回调消费后
 * 重置为 queue。注意 macOS 上 Cmd 常被终端应用拦截，能到达终端的就是可用的修饰键。
 */
function waitForSubmit(input: TextareaRenderable, state: TuiState): Promise<{ text: string; mode: 'queue' | 'steer' }> {
  return new Promise((resolve) => {
    const handler = () => {
      input.onSubmit = undefined; // 一次性：本次提交消费后移除，避免重复触发
      const mode = state.submitMode;
      state.submitMode = 'queue'; // 消费后重置（联想 Enter 等路径不经过这里，但每次 Enter 都会重写）
      resolve({ text: input.plainText, mode });
    };
    input.onSubmit = handler;
  });
}

/**
 * 按键 → 滚动动作（返回 null 表示交给输入框处理）。
 *
 * 冲突规则：多行输入框（Textarea）占用了 ↑/↓/Home/End/Ctrl+U（光标移动/删除），
 * 所以只有当输入框为空时这些键才用于滚动；PgUp/PgDn/Ctrl+↑/↓/Ctrl+Home/End
 * 输入框未绑定，始终可滚动。
 */
function resolveScrollAction(key: TuiKey, input: TextareaRenderable): ScrollAction | null {
  const empty = input.plainText === '';
  switch (key.name) {
    case 'pageup':
      return 'page-up';
    case 'pagedown':
      return 'page-down';
    case 'up':
      return key.ctrl || empty ? 'line-up' : null;
    case 'down':
      return key.ctrl || empty ? 'line-down' : null;
    case 'home':
      return key.ctrl || key.meta || empty ? 'top' : null;
    case 'end':
      return key.ctrl || key.meta || empty ? 'bottom' : null;
    case 'u':
      return key.ctrl && empty ? 'page-up' : null; // Ctrl+U：空输入框时翻页上滚（有内容时留给删除到行首）
    case 'd':
      return key.ctrl && empty ? 'page-down' : null; // Ctrl+D：空输入框时翻页下滚
    default:
      return null;
  }
}

export async function runTuiInteractive(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  runOpts: RunOptions,
  out: TuiOutput,
  session: TuiSession,
  state: TuiState
): Promise<void> {
  const input = session.input;
  if (!input) return;
  // 运行中打断（steer，Cmd/Ctrl+Enter）消息槽：运行中提交 steer 时写入本槽并 abort
  // 当前流；loop 在流中断（AbortError）后经 takeInterrupt 取走、push 进 messages
  // （作为当前轮的新 user 消息）并在**同一轮内继续**——模型直接回答打断消息，
  // 不结束本轮（轮数不增、不闪「等待输入」）。interruptPending 为只读探测（区分
  // abort 是打断还是取消：Esc 取消时槽为空 → 优雅结束本轮）。
  // 回合自然结束时槽中残留的消息由 finally 转入待发送列表（不丢失）。
  let interruptText: string | null = null;
  runOpts.interruptPending = () => interruptText !== null;
  runOpts.takeInterrupt = () => {
    const t = interruptText;
    interruptText = null;
    return t;
  };
  // todo 清单实时镜像（todo_write 工具 → 输入区上方 todo 小视图）：写进 state +
  // 触发重绘（schedulePaint 由 TuiOutput 注入，pushToast 同款通道）
  runOpts.onTodo = (list) => {
    state.todoList = list;
    state.schedulePaint?.();
  };
  // 会话持久化：增量追加每轮新增消息。
  // savedCount 统计**可落盘**消息数（脚手架 system 消息不落盘，见 persistableMessages）：
  // · --continue/-r 恢复时历史已在文件里 → 从可落盘数起步，避免整段重复追加（review 抓到的 bug）；
  // · prepareContext 每轮可能 unshift 全局/项目记忆/预载 system 消息（不落盘）——按可落盘数
  //   切片不受下标偏移影响（否则恢复会话会把上轮回答重复写盘，实测抓到）
  // 会话文件路径取 runOpts.sessionPath（可变）：/resume、/session 恢复后会替换它，
  // 之后的持久化必须落到**新**文件（否则继续的对话会写进旧的空占位会话，e2e 抓到）
  let savedCount = persistableMessages(messages).length;
  const persistTurn = async (): Promise<void> => {
    if (!runOpts.sessionPath) return;
    const persistable = persistableMessages(messages);
    if (savedCount > persistable.length) savedCount = 0; // /clear 后上下文重置
    if (persistable.length <= savedCount) return;
    await appendSessionMessages(runOpts.sessionPath, persistable.slice(savedCount)).catch(() => {});
    savedCount = persistable.length;
    // 退出提示恢复命令：会话文件已写入真实消息后设置（/exit 或 Ctrl+C 退出、终端恢复后打印
    // 给用户——空会话/仅命令的会话不提示）。id 取文件名主干（omni -s <id> 可恢复）。
    if (runOpts.sessionPath) {
      state.restoreHint = `omni -s ${sessionIdFromPath(runOpts.sessionPath)}`;
    }
    // 轨迹事件批量落盘（`{"t":"ev"}` 行与消息共存；失败静默不打扰对话）
    await runOpts.events?.flush().catch(() => {});
  };

  // 恢复会话：替换 messages + 会话文件 + 重置落盘计数 + 把历史回放进对话流
  // （/resume、/session <id>、/session 面板共用同一逻辑）；轨迹记录器同步重开
  // 到新会话文件（读回其历史事件续 seq/turn，中断轨迹无缝衔接）
  const restoreSession = async (file: string, msgs: ChatCompletionMessageParam[]): Promise<void> => {
    const prevPath = runOpts.sessionPath;
    messages.length = 0;
    messages.push(...msgs);
    runOpts.sessionPath = file;
    savedCount = persistableMessages(messages).length; // 已落盘历史不重复追加
    // 会话级累计按历史重建：先清零再回放（usage/durMs/genMs/firstTokenMs 经 onUsage/onLlmLap 累加，
    // 每轮 turn-footer 含首 token 均值）；不清零会把新旧两份叠加。
    // 旧历史无 firstTokenMs → 该轮不显示首 token 段。
    state.stats = { turns: 0, steps: 0, llmMs: 0, toolsMs: 0, firstTokenSum: 0, firstTokenCount: 0, genMs: 0, cached: 0 };
    state.tokens = { prompt: 0, completion: 0, total: 0 };
    state.lastPromptTokens = 0;
    state.liveTokens = 0;
    state.liveGenMs = 0;
    // 快照旧记录器（恢复失败时保留原内存事件，不打断会话恢复流程）
    const oldEvents = runOpts.events;
    runOpts.events = await EventRecorder.open(file).catch(() => oldEvents);
    state.scrollTop = null;
    state.traceSelected = -1;
    state.traceScroll = 0;
    // 被替换的是本次交互刚创建的空占位会话（0 条消息）→ 删除，避免残留孤儿会话
    if (prevPath && prevPath !== file) void removeEmptySession(prevPath);
    let hasUser = false;
    for (const m of msgs) {
      if (m.role === 'user' && typeof m.content === 'string' && m.content) {
        if (hasUser) out.onTurnEnd();
        hasUser = true;
        out.onTurnStart();
        out.onUserMessage(m.content);
      } else if (m.role === 'assistant') {
        const ext = m as unknown as {
          reasoning?: string;
          reasoningMs?: number;
          usage?: import('../agent/messages.js').AssistantUsage;
          model?: string;
          durMs?: number;
          genMs?: number;
          firstTokenMs?: number;
        };
        if (ext.reasoning) out.onThinkingRestored?.(ext.reasoning, ext.reasoningMs);
        if (typeof m.content === 'string' && m.content) {
          out.onAnswer(m.content);
          out.onAnswerEnd();
        }
        if (ext.usage) {
          out.onUsage({
            prompt: ext.usage.prompt,
            completion: ext.usage.completion,
            total: ext.usage.total ?? (ext.usage.prompt + ext.usage.completion),
            cached: ext.usage.cached ?? 0,
          });
          if (ext.durMs) out.onLlmLap(ext.durMs, typeof ext.firstTokenMs === 'number' ? ext.firstTokenMs : null, ext.genMs);
        }
      }
    }
    if (hasUser) out.onTurnEnd();
  };

  // Ctrl+X 前缀快捷键的目标上下文：ctx 在每轮循环内重建（含当前 client/model），
  // 这里在循环里每轮更新引用——前缀动作（/settings theme /permission /undo 等）
  // 与手输斜杠命令走同一 runCommand 分发，完全等价。
  // 首次等待输入（第一轮循环前）时循环尚未建 ctx：这里用入口参数建一个最小等价
  // ctx 兜底（前缀命令均为菜单/切换类，不依赖回调字段；循环内每轮会刷新完整引用）。
  let shortcutCtx: TuiCommandContext | null = {
    state, out, session, input, messages,
    client, model,
    models: (runOpts.models ?? []).map((m) => m.name),
    undoStack: runOpts.undoStack,
    tools: runOpts.tools,
    maxSubagentSteps: runOpts.maxSubagentSteps,
    subagents: runOpts.subagents,
    maxSubagentDepth: runOpts.maxSubagentDepth,
    architectModel: runOpts.architectModel,
    editorModel: runOpts.editorModel,
    runOpts,
    sessionPath: runOpts.sessionPath,
    cfg: runOpts.cfg,
    mcpServers: runOpts.mcpServers,
    mcpHandles: runOpts.mcpHandles,
    events: runOpts.events,
    hooks: runOpts.hooks,
  };
  // hero 横幅动画定时器（150ms 一帧）：未开始对话（lines.length === 0）时 rainbow
  // 彩虹色沿横幅流动。定时器常驻交互全程，非 hero 时只推进 hue 不触发重绘（不浪费）。
  const bannerAnimTimer = setInterval(() => {
    state.bannerHue = (state.bannerHue + 4) % 360;
    if (state.lines.length === 0) void session.paint().catch(() => {});
  }, 150);
  const unsubKey = session.onKeyPress((key) => {    // 全局监听先于输入框执行：输入框的 buffer 此时还未更新（按键刚按下）。
    // 联想列表需要按「更新后的文本」过滤，所以这里额外延迟一帧重绘（setTimeout 0），
    // 让输入框先插入字符、repaintTree 再读到最新文本。合并 pending：连发按键只挂一个定时器。
    const paintNow = (): void => void session.paint().catch(() => {});
    let deferredPending = false;
    const paintDeferred = (): void => {
      if (deferredPending) return;
      deferredPending = true;
      setTimeout(() => {
        deferredPending = false;
        void session.paint().catch(() => {});
      }, 0);
    };
    // Ctrl+X 前缀快捷键（opencode 风格，见 shortcuts.ts）：前缀激活时下一个按键
    // 触发绑定动作（t 主题 / p 权限 / m 模型 / v 级别 / s 设置 / l 计划 / h 思考 /
    // u 撤销 / r 重做 / c 清空 / ? 帮助）——执行与手输斜杠命令等价的 runCommand；
    // Esc 取消前缀；未绑定键取消前缀并放行给输入框（继续输入即返回）。
    if (state.shortcutPrefix) {
      const cmd = matchShortcutKey(key);
      if (cmd) {
        state.shortcutPrefix = false;
        state.status = '';
        key.preventDefault();
        const c = shortcutCtx;
        if (c) {
          void runCommand(c, cmd)
            .then(() => session.paint())
            .catch((err) => {
              pushLine(state, {
                kind: 'warn',
                text: `${tf(state.language, 'meta.cmdError', { msg: (err as Error)?.message ?? String(err) })}`,
              });
              return session.paint();
            });
        }
        paintNow();
        return;
      }
      // 取消前缀：Esc（消费）或未绑定键（取消后放行给输入框继续处理）
      state.shortcutPrefix = false;
      state.status = '';
      paintNow();
      if (key.name === 'escape' || key.name === 'esc') {
        key.preventDefault();
        return;
      }
      // 未绑定键：继续下方正常处理（输入框编辑等），不 return
    }
    // Ctrl+X 进入前缀（无模态浮层时；ask 提问面板由 onAskKey 先消费按键，避免冲突）：
    // 状态栏显示绑定键提示，再按一次绑定键触发 / 再按 Esc/其它键取消。
    if (key.ctrl && key.name === 'x' && !state.menu && !state.ask) {
      state.shortcutPrefix = true;
      state.status = t(state.language, 'shortcut.hint');
      key.preventDefault();
      paintNow();
      return;
    }
    // 工具审批卡片的按键（y/Enter 批准、n/Esc 拒绝）已挂在 startTui 全局
    // （单任务与交互模式共用，避免双重监听重复 resolve）——这里不再处理。
    // 命令面板打开时：面板消费所有按键（↑/↓/数字选择、Enter 确认、Esc 取消），
    // preventDefault 阻止输入框处理——不会把方向键当光标移动、Enter 也不会误提交。
    if (state.menu) {
      if (handleMenuKey(key, state)) key.preventDefault();
      // 菜单确认（Enter/数字）后：确认提示进面板，短暂停留后自动收起（无需按 Esc 关闭）
      if (!state.menu && state.cmdPanel && state.cmdPanel.lines.length > 0) {
        scheduleCmdPanelAutoClose(state, session);
      }
      paintNow();
      return;
    }
    // 命令输出面板（所有 / 命令的独立窗口）：Esc 关闭、↑/↓/PgUp/PgDn 滚动；
    // **任意其它按键（含 Enter）关闭面板并放行给输入框**——继续输入/继续发送即收起，
    // 无需专门按 Esc；Enter 放行后空输入提交 → 循环继续（/session 选完等场景少按一次）。
    if (state.cmdPanel) {
      if (key.name === 'escape' || key.name === 'esc') {
        state.cmdPanel = null;
        key.preventDefault();
      } else if (key.name === 'return' || key.name === 'kpenter' || key.name === 'linefeed') {
        state.cmdPanel = null; // 不 preventDefault：Enter 继续走输入框提交（空输入 → 循环继续）
      } else if (key.name === 'up') {
        state.cmdPanel.scroll -= 1;
        key.preventDefault();
      } else if (key.name === 'down') {
        state.cmdPanel.scroll += 1;
        key.preventDefault();
      } else if (key.name === 'pageup') {
        state.cmdPanel.scroll -= 10;
        key.preventDefault();
      } else if (key.name === 'pagedown') {
        state.cmdPanel.scroll += 10;
        key.preventDefault();
      } else {
        state.cmdPanel = null; // 其它按键：关闭面板并放行（继续输入即收起，按键进入输入框）
      }
      // 滚动位置由 cmdPanelRows 在渲染时 clamp 到合法区间（回写 panel.scroll）
      paintNow();
      return;
    }
    // 轨迹面板（/trace 右侧栏）：非模态浮层——↑/↓ 移动选中行（渲染层兜底收敛滚动
    // 保持选中可见）、Esc 收起面板（preventDefault：不触发下方「Esc 取消运行」）；
    // 其余按键放行给输入框（可继续输入/Enter 发送，面板保持打开）。
    // **两级页面**：详情页（traceDetail 非空）——↑/↓ 滚动详情内容、Esc 回列表页、
    // Enter 不消费（放行输入框）；列表页——↑/↓ 移动选中、Enter 推入详情页、Esc 收起。
    if (state.traceOpen) {
      let consumed = false;
      if (state.traceDetail) {
        // 详情页：↑/↓ 滚动内容（复用 traceScroll，渲染层钳制）
        if (key.name === 'up' || key.name === 'down') {
          state.traceScroll += key.name === 'down' ? 1 : -1;
          consumed = true;
        } else if (key.name === 'escape' || key.name === 'esc') {
          state.traceDetail = null; // 回列表页（再按 Esc 收起面板）
          state.traceScroll = 0;
          consumed = true;
        }
      } else if (key.name === 'up' || key.name === 'down') {
        const rows = state.traceRows;
        if (rows.length > 0) {
          if (state.traceSelected < 0) state.traceSelected = rows.length - 1;
          else if (key.name === 'up') state.traceSelected = Math.max(0, state.traceSelected - 1);
          else state.traceSelected = Math.min(rows.length - 1, state.traceSelected + 1);
        }
        consumed = true;
      } else if (key.name === 'return' || key.name === 'kpenter' || key.name === 'linefeed') {
        if (state.traceSelected >= 0 && state.traceSelected < state.traceRows.length) {
          state.traceDetail = { rowIdx: state.traceSelected }; // Enter 推入详情页
          state.traceScroll = 0;
          consumed = true;
        }
      } else if (key.name === 'escape' || key.name === 'esc') {
        state.traceOpen = false;
        state.traceSelected = -1;
        state.traceScroll = 0;
        consumed = true;
      }
      if (consumed) {
        key.preventDefault();
        paintNow();
        return;
      }
    }
    // 待发送列表选择入口：输入框为空且有待发送消息时，↑ 进入列表选择
    //（否则 ↑ 是滚动——只有有待发送消息时让位给列表选择）
    if (state.pendingSelected === -1 && state.pending.length > 0 && input.plainText === '' && key.name === 'up') {
      selectLastPending(state);
      key.preventDefault();
      paintNow();
      return;
    }
    // 待发送列表管理（pendingSelected >= 0 时）：↑/↓ 移动高亮（循环）、←/→ 排序、
    // Enter 编辑（文本取回输入框，可修改后重新发送）、Backspace/Delete 删除、
    // Esc 退出选择；其余按键退出选择并放行给输入框（非模态——继续输入即返回）。
    if (state.pendingSelected >= 0) {
      const r = handlePendingKey(key, state);
      if (r) {
        if (r.kind === 'edit') {
          input.setText(r.text);
          key.preventDefault(); // Enter 编辑：不放行给输入框（避免同时提交空输入）
        } else if (r.kind === 'consumed') {
          key.preventDefault();
        }
        paintNow();
        if (r.kind === 'deselect') paintDeferred(); // 放行给输入框的按键会改内容 → 延迟重刷联想
        return;
      }
    }
    // 提交模式：Enter = queue（空闲直接执行 / 运行中入待发送列表末尾）；
    // Cmd/Ctrl/Super/Option+Enter = steer（空闲直接执行 / 运行中打断当前回合并插到列表最前）。
    // 注意：macOS 上 Cmd 常被终端应用拦截（key.super 也可能为空），所以只要
    // meta/ctrl/super/option 任一修饰键命中都按 steer 处理——能到达终端的就是可用的。
    // submit 回调消费后重置。
    if (key.name === 'return' || key.name === 'kpenter' || key.name === 'linefeed') {
      state.submitMode = key.meta || key.ctrl || key.super || key.option ? 'steer' : 'queue';
    }
    // 命令联想列表（输入以 / 开头时显示）：非模态——只有 ↑/↓/Tab/Enter/Esc 被消费，
    // 其它按键照常输入（列表在下次 paint 按最新文本过滤，互不影响）。
    // Enter：填入高亮命令并 submit()——走主循环正常分发路径（/exit 也能正确退出）。
    const sug = state.cmdSuggest;
    if (sug && sug.items.length > 0) {
      const sel = Math.min(sug.selected, sug.items.length - 1);
      const win = Math.max(1, sug.window);
      let consumed = false; // ↑/↓/Tab/Enter/Esc 消费按键；退格/普通字符等放行给输入框
      if (key.name === 'up') {
        // ↑/↓ 循环移动高亮，并保持选中项在可见窗口内（超出窗口时滚动）——
        // 全部命令都可到达（不再只循环可见的 9 条，用户反馈“超过一屏无法翻页”）
        sug.selected = (sel - 1 + sug.items.length) % sug.items.length;
        if (sug.selected < sug.top) sug.top = sug.selected;
        else if (sug.selected >= sug.top + win) sug.top = sug.selected - win + 1; // 环绕回底部
        consumed = true;
      } else if (key.name === 'down') {
        sug.selected = (sel + 1) % sug.items.length;
        if (sug.selected >= sug.top + win) sug.top = sug.selected - win + 1;
        else if (sug.selected < sug.top) sug.top = sug.selected; // 环绕回顶部
        consumed = true;
      } else if (key.name === 'tab') {
        // Tab：只填入命令（带尾空格让联想自动消失），用户可继续编辑后 Enter 执行
        input.setText(`/${sug.items[sel]} `);
        state.cmdSuggest = null;
        consumed = true;
      } else if (key.name === 'return' || key.name === 'kpenter' || key.name === 'linefeed') {
        // Enter：直接执行高亮命令（填入后 submit，主循环 runCommand 分发）
        input.setText(`/${sug.items[sel]}`);
        state.cmdSuggest = null;
        consumed = true;
        input.submit();
      } else if (key.name === 'escape' || key.name === 'esc') {
        // 记录关闭时的输入文本：文本不变则保持隐藏（否则 repaintTree 会复活列表）
        state.cmdSuggest = null;
        state.cmdSuggestDismissedText = state.inputText;
        consumed = true;
      }
      if (consumed) key.preventDefault(); // 消费按键不进入输入框（Enter 不误提交、↑↓ 不移动光标）
      paintNow();
      // 非消费按键（退格/普通字符）会修改输入框内容：当前帧 paintNow 时输入框 buffer
      // 还没更新（全局 keypress 先于输入框执行），必须再延迟一帧按更新后的文本重刷联想
      // ——否则删除 / 后菜单不消失、继续输入也不按新前缀过滤（用户报告/探针复现）
      if (!consumed) paintDeferred();
      return;
    }
    // @ 提及文件选择（输入含 @ 时显示）：非模态——↑/↓ 移动高亮、Tab/Enter 选中插入
    // （目录保留 / 继续进入下一层浏览；文件插入后加空格结束提及）、Esc 关闭；
    // 其余按键照常输入（列表在下次 paint 按最新文本过滤，互不影响）。
    const men = state.mention;
    if (men && men.items.length > 0) {
      const sel = Math.min(men.selected, men.items.length - 1);
      const win = Math.max(1, men.window);
      let consumed = false;
      if (key.name === 'up') {
        men.selected = (sel - 1 + men.items.length) % men.items.length;
        if (men.selected < men.top) men.top = men.selected;
        else if (men.selected >= men.top + win) men.top = men.selected - win + 1;
        consumed = true;
      } else if (key.name === 'down') {
        men.selected = (sel + 1) % men.items.length;
        if (men.selected >= men.top + win) men.top = men.selected - win + 1;
        else if (men.selected < men.top) men.top = men.selected;
        consumed = true;
      } else if (key.name === 'tab' || key.name === 'return' || key.name === 'kpenter' || key.name === 'linefeed') {
        // Tab/Enter：选中插入（Enter 只插入不发送——用户可能还要继续输入/换行）
        insertMention(input, men, sel);
        consumed = true;
      } else if (key.name === 'escape' || key.name === 'esc') {
        // 记录关闭时的 @ 位置与查询：文本不变则保持隐藏（否则 repaintTree 会复活列表）
        state.mention = null;
        state.mentionDismissedKey = `${men.atIndex}:${men.query}`;
        consumed = true;
      }
      if (consumed) key.preventDefault();
      paintNow();
      // 非消费按键同样延迟一帧重刷（@ 提及按最新文本过滤，见上）
      if (!consumed) paintDeferred();
      return;
    }
    // 轨迹面板（/trace 右侧栏）：非模态浮层——↑/↓ 移动选中行（渲染层兜底收敛滚动
    // 保持选中可见）、Esc 收起面板（preventDefault：不触发下方「Esc 取消运行」）；
    // 其余按键放行给输入框（可继续输入/Enter 发送，面板保持打开）。放在联想/提及
    // 之后：输入浮层（用户正在打字）优先消费 ↑/↓/Esc，轨迹面板是边缘 UI。
    if (state.traceOpen) {
      let consumed = false;
      if (key.name === 'up' || key.name === 'down') {
        const rows = state.traceRows;
        if (rows.length > 0) {
          if (state.traceSelected < 0) state.traceSelected = rows.length - 1;
          else if (key.name === 'up') state.traceSelected = Math.max(0, state.traceSelected - 1);
          else state.traceSelected = Math.min(rows.length - 1, state.traceSelected + 1);
        }
        consumed = true;
      } else if (key.name === 'escape' || key.name === 'esc') {
        state.traceOpen = false;
        state.traceSelected = -1;
        state.traceScroll = 0;
        consumed = true;
      }
      if (consumed) {
        key.preventDefault();
        paintNow();
        return;
      }
    }
    // ESC 取消正在进行的对话（同取消语义）：前面的浮层分支（菜单/面板/联想/提及/
    // 待发送选择/轨迹面板）已各自消费自己的 Esc——能走到这里说明无任何浮层。
    // 审批卡片打开时 ESC 由 startTui 的审批 handler 先消费（拒绝审批并置位
    // approvalKeyJustConsumed），这里跳过取消运行（拒绝审批 ≠ 取消对话）。
    if ((key.name === 'escape' || key.name === 'esc') && state.running) {
      if (state.approvalKeyJustConsumed) {
        state.approvalKeyJustConsumed = false; // 该 ESC 已用于拒绝审批
      } else if (state.askKeyJustConsumed) {
        state.askKeyJustConsumed = false; // 该 ESC 已用于取消提问（取消提问 ≠ 取消对话）
      } else {
        state.cancelRun?.(); // 取消当前回合（loop 优雅结束本轮：已输出保留、半截消息不入上下文）
        out.cancelVisuals(); // **立即**停右侧 loading + 状态栏「思考中/执行中」（不等 runAgent 返回）
        key.preventDefault();
      }
      paintNow();
      return;
    }
    // 滚动键：发出一次性意图（computeRows 消费），preventDefault 阻止输入框处理该键
    const action = resolveScrollAction(key, input);
    if (action) {
      state.scrollIntent = { action };
      key.preventDefault();
    }
    // 输入框自行 requestRender，这里兜底重绘（无状态变更时 repaint 是幂等的）；
    // 再延迟一帧刷新联想列表（输入框 buffer 在按键后才更新，见上）
    paintNow();
    paintDeferred();
  });

  try {
    input.focus();
    // 权限档位：初始取入口配置（runOpts.permission = cfg.permission），/permission 面板切换
    state.permission = runOpts.permission ?? state.permission;
    // 思考级别：初始取入口配置（runOpts.reasoningEffort = cfg.reasoningEffort），/variants 面板切换
    state.reasoningEffort = runOpts.reasoningEffort ?? state.reasoningEffort;
    // 思考级别选项：初始取入口配置（runOpts.reasoningEffortOptions = cfg.reasoningEffortOptions）；
    // /model 切换模型时 applyEndpoint 按该模型配置联动（per-model variants）
    state.reasoningEffortOptions = runOpts.reasoningEffortOptions ?? state.reasoningEffortOptions;
    // 命名 variant（1.0 P0-3）：初始取运行时（来自 models.<model>.variant 配置）
    state.activeVariant = runOpts.activeVariant ?? null;
    // 可用模型列表：顶层 model + config `models`（/model 面板列出）；当前模型初始取运行时
    state.models = (runOpts.models ?? []).map((m) => m.name);
    state.model = runOpts.modelRuntime?.model ?? model;
    // 当前模型所属 provider 组（footer 模型行显示 `模型名 组名`；不在分组内为空）
    state.provider = (runOpts.models ?? []).find((m) => m.name === state.model)?.provider
      ?? findProviderForModel(runOpts.models ?? [], state.model)
      ?? '';
    // 当前模型 context 上限（footer context 段显示 `上下文 已用/上限`；未知为 0）
    state.contextLimit = (runOpts.models ?? []).find((m) => m.name === state.model)?.limit?.context ?? 0;
    // 当前模型运行时（可变）：/model 切换时重建 client 并更新共享引用（子代理同步）
    let currentClient: OpenAI = client;
    let currentModel = state.model;
    // 把端点设为当前模型：重建 client（不同端点不能复用旧 client）+ 更新共享引用——
    // 主循环（每轮读 modelRuntime）与 delegate 子代理（闭包持有）同步生效
    const applyEndpoint = (endpoint: ModelEndpoint): void => {
      currentClient = createClient(endpoint, endpoint.apiKey ?? '');
      currentModel = endpoint.name;
      state.model = endpoint.name;
      state.provider = endpoint.provider ?? findProviderForModel(runOpts.models ?? [], endpoint.name) ?? ''; // footer 模型行显示所属 provider 组
      state.contextLimit = endpoint.limit?.context ?? 0; // footer context 段上限（未知 0）
      if (runOpts.modelRuntime) {
        runOpts.modelRuntime.client = currentClient;
        runOpts.modelRuntime.model = endpoint.name;
      }
      // per-model variants 联动：切换到该模型时，思考级别与 /variants 面板选项
      // 自动跟随该模型的配置（端点已在 modelEndpoints 展开时回退全局缺省）——
      // loop 请求（runOpts.reasoningEffort）与面板（state）立即反映新模型；
      // 命名 variant（1.0 P0-3）同样随端点带出（models.<名>.variant 初始值）
      runOpts.reasoningEffort = endpoint.reasoningEffort;
      runOpts.reasoningEffortOptions = endpoint.reasoningEffortOptions ?? runOpts.reasoningEffortOptions;
      // 压缩预算跟随新模型（数据源自动档：端点展开时 limit.context 已查表补缺；未知模型清空）
      if (runOpts.context) runOpts.context.contextLimit = endpoint.limit?.context;
      state.reasoningEffort = endpoint.reasoningEffort ?? '';
      if (endpoint.reasoningEffortOptions !== undefined) state.reasoningEffortOptions = endpoint.reasoningEffortOptions;
      runOpts.activeVariant = endpoint.variant;
      state.activeVariant = endpoint.variant ?? null;
    };
    const syncModel = (): void => {
      // 对比 state.model（/model 面板确认后变更）与当前运行时模型，变了才真正切换：
      // 从 runOpts.models 找目标端点（baseURL/apiKey/userAgent 已按配置展开），重建 client
      // 并更新 runOpts.modelRuntime——主循环（每轮读它）与 delegate 子代理（闭包持有）同步生效
      const target = state.model;
      if (!target || (target === currentModel && !state.modelProvider)) return;
      const endpoint = (runOpts.models ?? []).find((m) =>
        m.name === target && (!state.modelProvider || m.provider === state.modelProvider)
      );
      if (!endpoint) {
        pushLine(state, { kind: 'warn', text: `模型「${target}」不在可用列表（config models 未配置该端点）` });
        state.model = currentModel; // 还原面板高亮，避免每轮重复告警
        return;
      }
      applyEndpoint(endpoint);
      state.modelProvider = null;
      // 模型切换成功 → 右上角 toast（✓ 已切换到 X；面板确认与 /model <名称> 两条路径共用）
      out.pushToast(tf(state.language, 'toast.modelSwitched', { model: endpoint.name }), 'success');
    };
    // /model 面板确认的即时应用回调：confirmMenu（纯 state）记录意图后调用
    // syncModel——键盘 Enter/数字与鼠标点选两条确认路径共用（见 state.applyModelSwitch）
    state.applyModelSwitch = syncModel;
    let turn = 0; // 真实对话轮次（斜杠命令/空输入不计）
    // 运行中输入 /exit：runCommand 返回 'exit' 后标记，当前回合结束即统一清理退出
    let exitRequested = false;
    // 会话结束清理（/exit 与运行中 /exit 共用）：autoMemory 偏好提取 + 会话 finalize + 空占位删除
    const exitSession = async (): Promise<void> => {
      if (runOpts.context?.autoMemory !== false && messages.some((m) => m.role === 'user')) {
        await maybeWriteGlobalMemory(currentClient, currentModel, messages).catch(() => {});
        // P0 项目级自动写入：提取项目持久事实 → 生成待提交片段（.omni/memory-pending.md，不直接改 AGENTS.md）
        await maybeWriteProjectMemory(currentClient, currentModel, messages).catch(() => {});
      }
      // 轨迹事件最终落盘（persistTurn 已逐轮 flush，这里兜底 /clear 后等边界）
      await runOpts.events?.flush().catch(() => {});
      if (runOpts.sessionPath) {
        await finalizeSession(runOpts.sessionPath).catch(() => {}); // 刷新会话更新时间
        // 仅命令（无真实对话）的会话文件是空占位 → 退出时删除，避免污染会话列表
        await removeEmptySession(runOpts.sessionPath).catch(() => {});
      }
    };
    for (;;) {
      // /settings 语言保存意图：界面已即时生效（state.language 更新，全部界面 chrome
      // 按新语言重绘）——这里把配置**持久化**到配置文件（下次会话同样生效）；
      // 成功静默，失败才弹警告面板
      if (state.languageSave) {
        const lang = state.languageSave;
        state.languageSave = null;
        const cfg = runOpts.cfg;
        if (cfg) {
          const res = persistLanguageToConfig(lang, cfg);
          if (!res.ok) {
            pushCmdLine(state, { kind: 'warn', text: res.message }, '/settings language');
          }
          await session.paint();
        }
      }
      // /model 默认模型保存意图：切换已即时生效（interactive syncModel 重建 client +
      // 更新 modelRuntime）——这里把配置**持久化**（顶层 model 字段，下次启动默认使用）；
      // 成功静默，失败才弹警告面板
      if (state.modelSave) {
        const m = state.modelSave;
        state.modelSave = null;
        const cfg = runOpts.cfg;
        if (cfg) {
          const res = persistModelDefaultToConfig(m, cfg);
          if (!res.ok) {
            pushCmdLine(state, { kind: 'warn', text: res.message }, '/model');
          }
          await session.paint();
        }
      }
      // /variants 思考级别保存意图：切换已即时生效（interactive 每轮同步进
      // runOpts.reasoningEffort）——这里把配置**持久化**。per-model：当前模型在配置
      // 文件 models 表有专属条目时写 models.<模型>.reasoningEffort（仅该模型生效），
      // 否则写顶层全局默认（persistReasoningEffortToConfig 内部按 modelName 分流）；
      // 成功静默，失败才弹警告面板
      if (state.variantsSave) {
        const raw = state.variantsSave;
        state.variantsSave = null;
        const cfg = runOpts.cfg;
        // 命名 variant（1.0 P0-3）：值形如 `variant:<id>`——写 models."<模型>".variant
        if (raw.startsWith('variant:')) {
          const id = raw.slice('variant:'.length);
          runOpts.activeVariant = id;
          if (cfg) {
            const res = persistVariantToConfig(id, cfg, currentModel);
            if (!res.ok) pushCmdLine(state, { kind: 'warn', text: res.message }, '/variants');
            await session.paint();
          }
        } else {
          const v = raw;
          runOpts.activeVariant = undefined; // 普通级别：清除命名叠加
          state.activeVariant = null;
          if (cfg) {
            const res = persistReasoningEffortToConfig(v, cfg, currentModel);
            if (!res.ok) pushCmdLine(state, { kind: 'warn', text: res.message }, '/variants');
            await session.paint();
          }
        }
      }
      // /session 面板确认：恢复所选会话（异步加载；每轮只处理一次，处理完清空意图）
      if (state.sessionPick) {
        const pick = state.sessionPick;
        state.sessionPick = null;
        const file = await findSessionById(pick);
        if (!file) {
          pushCmdLine(state, { kind: 'warn', text: `会话「${pick}」不存在（/session 查看列表）` }, '/session');
        } else {
          const loaded = await loadSession(file);
          if (!loaded) {
            pushCmdLine(state, { kind: 'warn', text: `会话「${pick}」加载失败` }, '/session');
          } else {
            await restoreSession(file, loaded.messages);
            // 恢复会话标题（若有）→ 终端窗口标题
            if (loaded.meta.title) {
              state.sessionTitle = loaded.meta.title;
              setTerminalTitle(loaded.meta.title);
            }
            pushCmdLine(
              state,
              `已继续会话 ${loaded.meta.id}（${loaded.messages.length} 条消息 · 模型 ${loaded.meta.model}${loaded.meta.title ? ` · 标题「${loaded.meta.title}」` : ''}）`,
              '/session'
            );
          }
        }
        await session.paint();
      }
      // 菜单打开时跳过“等待输入”状态刷新（会清掉面板提示）；面板由 keypress handler 驱动
      // 待发送积压优先：回合结束后自动消费——steer（打断）消息插入时在最前、queue 追加在末尾，
      // shift() 天然按 打断优先 → 排队顺序 发送；用户可在此之前用 ↑ 选中管理（排序/删除/编辑）
      let text: string;
      let submitMode: 'queue' | 'steer';
      if (state.pending.length > 0) {
        state.pendingSelected = -1; // 列表即将消费：清掉选择态（若用户在选中管理中，下一轮从头来）
        const msg = state.pending.shift()!;
        text = msg.text;
        submitMode = msg.mode;
        // 回到最新：排队消息自动发送时，若用户此前上滚过（scrollTop 残留），新轮次的
        // thinking/回答会全部渲染在视口外——「对话轮次一多 thinking 区域块总会丢」
        //（新内容不可见）。与空闲提交（下方 else 分支）同语义：新消息开始即回底。
        state.scrollTop = null;
        state.scrollIntent = null;
      } else {
        if (!state.menu) {
          out.onWaitForInput();
          await session.paint();
        }
        const r = await waitForSubmit(input, state);
        text = r.text;
        submitMode = r.mode;
        // 提交后回到最新：新消息和后续回答应立即可见
        state.scrollTop = null;
        state.scrollIntent = null;
        input.setText(''); // 多行 Textarea 的 value setter 不提交到 buffer，必须 setText 清空（同时复位自动增高）
        await session.paint(); // 立即清掉输入框，避免残留文本影响阅读
      }
      const cmd = text.trim();
      if (!cmd) continue;
      // /model 面板/CLI 切换只改 state.model（意图），提交前先同步为真实运行时模型
      syncModel();
      // 命令执行上下文：空闲分发（本迭代顶部）与运行中分发（onSubmit 里输 / 命令）共用
      const ctx = {
        state, out, session, input, messages,
        client: currentClient, model: currentModel,
        models: state.models,
        undoStack: runOpts.undoStack,
        tools: runOpts.tools,
        maxSubagentSteps: runOpts.maxSubagentSteps,
        subagents: runOpts.subagents,
        maxSubagentDepth: runOpts.maxSubagentDepth,
        architectModel: runOpts.architectModel,
        editorModel: runOpts.editorModel,
        runOpts,
        sessionPath: runOpts.sessionPath,
        cfg: runOpts.cfg,
        mcpServers: runOpts.mcpServers,
        mcpHandles: runOpts.mcpHandles,
        // 轨迹事件记录器（/trace 面板数据源 + /compact 事件）
        events: runOpts.events,
        hooks: runOpts.hooks,
        // /mcp reconnect：关旧客户端 → 重新 discover → 重建工具链 + 更新 handles + 替换 instructions
        onReconnectMcp: async () => {
          closeMcpClients();
          const handles = await discoverMcpServers(runOpts.mcpServers);
          runOpts.mcpHandles = handles;
          runOpts.tools = [...(runOpts.baseTools ?? []), ...buildMcpTools(handles)];
          const instrContent = mcpInstructionsMessage(handles);
          if (instrContent) {
            const instrPrefix = '[MCP server instructions';
            const existingIdx = messages.findIndex(
              (m) => typeof m.content === 'string' && m.content.startsWith(instrPrefix)
            );
            const instrMsg = { role: 'system' as const, content: `${instrPrefix}]\n${instrContent}` };
            if (existingIdx >= 0) messages[existingIdx] = instrMsg;
            else messages.unshift(instrMsg);
          }
        },
        // /mcp add：连接新服务器 → 注入工具链 + 更新 handles + 替换 instructions（不关旧服务器）
        onAddMcp: async (name: string, cfg: McpServerConfig) => {
          try {
            const handles = await discoverMcpServers({ [name]: cfg });
            if (handles.length === 0) return '服务器连接失败（见上方警告）';
            runOpts.mcpServers = { ...(runOpts.mcpServers ?? {}), [name]: cfg };
            runOpts.mcpHandles = [...(runOpts.mcpHandles ?? []), ...handles];
            const base = runOpts.baseTools ?? [];
            // 重建完整工具链：基础 + 全部 MCP 工具（保留其它服务器已发现的工具）
            runOpts.tools = [...base, ...buildMcpTools(runOpts.mcpHandles)];
            const instrContent = mcpInstructionsMessage(runOpts.mcpHandles);
            if (instrContent) {
              const instrPrefix = '[MCP server instructions';
              const existingIdx = messages.findIndex(
                (m) => typeof m.content === 'string' && m.content.startsWith(instrPrefix)
              );
              const instrMsg = { role: 'system' as const, content: `${instrPrefix}]\n${instrContent}` };
              if (existingIdx >= 0) messages[existingIdx] = instrMsg;
              else messages.unshift(instrMsg);
            }
            return null;
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        },
        // /mcp remove：关闭服务器 → 移除工具链 + 更新 handles + 替换 instructions
        onRemoveMcp: async (name: string) => {
          try {
            const target = (runOpts.mcpHandles ?? []).find((h) => h.name === name);
            target?.client.close();
            runOpts.mcpServers = { ...(runOpts.mcpServers ?? {}) };
            delete runOpts.mcpServers[name];
            runOpts.mcpHandles = (runOpts.mcpHandles ?? []).filter((h) => h.name !== name);
            runOpts.tools = [...(runOpts.baseTools ?? []), ...buildMcpTools(runOpts.mcpHandles ?? [])];
            const instrContent = mcpInstructionsMessage(runOpts.mcpHandles ?? []);
            const instrPrefix = '[MCP server instructions';
            const existingIdx = messages.findIndex(
              (m) => typeof m.content === 'string' && m.content.startsWith(instrPrefix)
            );
            if (instrContent) {
              const instrMsg = { role: 'system' as const, content: `${instrPrefix}]\n${instrContent}` };
              if (existingIdx >= 0) messages[existingIdx] = instrMsg;
              else messages.unshift(instrMsg);
            } else if (existingIdx >= 0) {
              messages.splice(existingIdx, 1);
            }
            return null;
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        },
        // /mcp login：HTTP 服务器 OAuth 登录（成功后客户端自动携带 token）
        onLoginMcp: async (name: string) => {
          try {
            const h = (runOpts.mcpHandles ?? []).find((x) => x.name === name);
            if (!h) return '服务器未连接';
            const ok = await h.client.login();
            return ok ? null : '登录未完成（取消或超时）';
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        },
        // /model <名称>：按名称从 runOpts.models 找端点切换（未注册则提示）
        onSwitchModel: (name: string) => {
          const endpoint = (runOpts.models ?? []).find((m) => m.name === name);
          if (!endpoint) {
            return `未知模型「${name}」——可用：${(runOpts.models ?? []).map((m) => m.name).join(' / ')}（/model add <名称> [--base-url] [--api-key] 添加）`;
          }
          applyEndpoint(endpoint);
          return null;
        },
        // /model add：注册进运行时模型表（同名覆盖）+ 面板列表 + 切换
        onAddModel: (endpoint: ModelEndpoint) => {
          const list = runOpts.models ?? [];
          const existing = list.find((m) => m.name === endpoint.name);
          if (existing) Object.assign(existing, endpoint);
          else runOpts.models = [...list, endpoint];
          state.models = (runOpts.models ?? []).map((m) => m.name);
          applyEndpoint(endpoint);
          return null;
        },
        // /resume /session <id>：恢复会话（共用 restoreSession：替换 messages +
        // 会话文件 + 重置落盘计数 + 把历史回放进对话流；事件记录器同步重开）
        onResume: (file: string, msgs: ChatCompletionMessageParam[]) => {
          void restoreSession(file, msgs);
        },
      };
      // Ctrl+X 前缀快捷键的 ctx 引用：每轮刷新（当前 client/model 等字段随之更新）
      shortcutCtx = ctx;
      // /settings 菜单确认「环境诊断」的意图（confirmMenu 纯 state 无法执行——
      // 记录 doctorPending，这里在命令分发前消费，输出诊断报告到命令面板）
      if (state.doctorPending) {
        state.doctorPending = false;
        await runCommand(ctx, '/settings doctor');
        await session.paint();
      }
      // 斜杠命令：注册表分发（/theme 打开面板、/exit 返回 'exit' 结束循环…）
      if (cmd.startsWith('/')) {
        const result = await runCommand(ctx, cmd);
        await session.paint();
        if (result === 'exit') {
          await exitSession();
          break;
        }
        continue;
      }

      // Hooks：UserPromptSubmit——hook 返回 updatedPrompt 可改写 prompt（补上下文/策略）
      let userText = cmd;
      if (runOpts.hooks?.has('UserPromptSubmit')) {
        userText = (await runOpts.hooks.userPromptSubmit(cmd)).prompt;
      }
      messages.push({ role: 'user', content: userText });
      out.onUserMessage(cmd); // 回显用户原文（改写不替换 UI 回显，hook 输出已回显）
      runOpts.events?.user(userText); // 轨迹：用户消息（记录模型实际看到的 prompt，source=user）
      // 会话检查点（/rewind 数据源）：每轮用户消息提交后快照工作区修改文件（存盘，
      // 恢复会话后仍可 /rewind）；失败静默不打扰对话
      await createCheckpoint(runOpts.sessionPath, userText).catch(() => null);
      // 上下文管理：首轮预载相关文件 + 长对话摘要压缩（选项由入口统一注入 runOpts.context；
      // recorder 传下去——压缩成功时记 compact 轨迹事件）
      await prepareContext(currentClient, currentModel, messages, runOpts.context ?? {}, runOpts.events);
      // Agent 运行期间输入框**保持聚焦**（不 blur）：blur 会摘除 Textarea 的按键处理器
      //（OpenTUI blur() 里 offInternal("keypress")），Enter/Cmd+Enter 到不了 onSubmit——
      // queue/steer 运行中提交全是死路径（旧 mockInput 探针没模拟 blur 才"通过"）。
      // 运行中键入的内容经 onSubmit 分流进待发送列表/打断槽，不会混入下一轮输入。
      runOpts.planMode = state.planMode; // 每轮同步计划模式（/plan 切换即时生效）
      // 每轮同步权限档位：主循环按 runOpts.permission 新建 Safety；共用闸门（子代理）setTier 同步
      runOpts.permission = state.permission;
      runOpts.safetyGate?.setTier(state.permission);
      // 每轮同步思考级别（/variants 切换即时生效）：loop 请求带 reasoning_effort
      runOpts.reasoningEffort = state.reasoningEffort || undefined;
      // 每轮同步模型（/model 切换即时生效）：syncModel 里已重建 client 并更新 modelRuntime，
      // runAgent 用 currentClient/currentModel 发起请求。
      // 请求失败（网络/401/端点错误）时 runAgent 已在对话流提示并正常返回；这里再兜底
      // 捕获意外异常——任何运行错误都只在对话流显示、不把整个 TUI 打崩（发消息闪退的根因）
      // 取消支持：本轮创建 AbortController——Esc 取消、运行中 Ctrl+Enter（steer）、
      // Esc → abort 中断流式响应（loop 优雅结束本轮；半截消息不入上下文）；运行结束（含
      // 取消）后复位。**可重载**：steer 打断后 loop 换新信号继续本回合（旧信号已 abort，
      // 不复位则后续请求立刻 AbortError），rearmAbort 回调由 loop 调用重新武装——
      // cancelRun 始终 abort「当前」控制器（打断后的本回合仍可被 Esc 取消）
      const abortCtrl: { ctrl: AbortController | null } = { ctrl: null };
      runOpts.rearmAbort = () => {
        abortCtrl.ctrl = new AbortController();
        runOpts.abortSignal = abortCtrl.ctrl.signal;
      };
      runOpts.rearmAbort();
      state.running = true;
      state.cancelRun = () => abortCtrl.ctrl?.abort();
      // 子代理独立停止：delegate.execute 把 per-subagent abort 注册进 runOpts.subagentStops
      //（key = 工具配对 seq）；这里把查询/触发接到 state——卡片「⏹ 停止」点击时只停该
      // 子代理（Esc 取消整个回合不受影响）
      runOpts.stopSubagent = (seq: number) => {
        const stop = runOpts.subagentStops?.get(seq);
        if (stop) {
          stop();
          runOpts.subagentStops?.delete(seq);
        }
      };
      state.stopSubagent = runOpts.stopSubagent;
      out.startLoading(); // 会话进行中：统计行左侧 loading 一直转（Esc 取消/会话结束 stopLoading 消失）
      // 运行中提交处理（Enter / Cmd|Ctrl+Enter 都经此分流）：
      //   · Enter 且文本非空 → queue 入待发送列表（输入框正上方小视图，回合结束后按序发送）
      //   · Cmd/Ctrl+Enter 且文本非空 → steer 打断当前回合（abort），插到列表最前优先执行
      input.onSubmit = () => {
        const t = input.plainText.trim();
        const m = state.submitMode;
        state.submitMode = 'queue';
        // ask_user 提问面板打开：Enter 由 onAskKey 全局消费（确认提交）——这里兜底
        // 不再处理（onSubmit 仅当 Enter 未被面板消费时到达，例如面板刚关闭的边界）
        if (state.ask) {
          return;
        }
        if (m === 'steer') {
          if (t) {
            // 打断消息写入中断槽：loop 在流中断（AbortError）后经 takeInterrupt 取走，
            // 插入当前轮（作为新的 user 消息）同一轮内继续——模型直接回答打断消息，
            // 不结束本轮；回合自然结束时残留的消息由 finally 转入待发送列表
            interruptText = t;
            // 打断即用户主动发起新消息：回到最新——上滚残留会让打断消息与新一轮
            // thinking/回答渲染在视口外（「多轮后 thinking 区域块丢」的根因之一）
            state.scrollTop = null;
            state.scrollIntent = null;
            state.cancelRun?.(); // 打断当前回合（流中断后取走槽中的消息继续）
          }
          input.setText('');
        } else if (t.startsWith('/')) {
          // 运行中输入 / 命令：**立即分发执行**（/theme 打开菜单、/undo 回滚等），
          // 不进待发送列表——此前所有命令都被当普通消息排队，
          // 要等当前回合 + 前面排队消息全部结束才执行（用户报告）。异步分发不阻塞
          // 当前回合；/exit 返回 'exit' → 标记退出意图，回合结束后统一清理退出
          input.setText('');
          void (async () => {
            try {
              const result = await runCommand(ctx, t);
              await session.paint();
              if (result === 'exit') exitRequested = true;
            } catch (err) {
              pushLine(state, {
                kind: 'warn',
                text: tf(state.language, 'meta.cmdError', { msg: (err as Error)?.message ?? String(err) }),
              });
            }
          })();
        } else if (t) {
          enqueuePending(state, 'queue', t); // 追加到待发送列表末尾（回合结束后按序发送）
          input.setText('');
        }
      };
      try {
        await runAgent(currentClient, currentModel, messages, runOpts, out);
      } catch (err) {
        pushLine(state, {
          kind: 'warn',
          text: tf(state.language, 'meta.runError', { msg: (err as Error)?.message ?? String(err) }),
        });
      } finally {
        state.running = false;
        state.cancelRun = null;
        state.stopSubagent = null;
        runOpts.abortSignal = undefined;
        runOpts.rearmAbort = undefined;
        runOpts.stopSubagent = undefined;
        runOpts.subagentStops?.clear(); // 本回合 delegate 已全部结束：清理停止句柄
        input.onSubmit = undefined; // 恢复：下次提交由 waitForSubmit 接管
        out.stopLoading(); // 回合结束（含 Esc 取消）：loading 消失
        // 回合已自然结束（abort 未生效/未打断流，如最终回答恰在打断前完成）：
        // 中断槽残留的打断消息转入待发送列表（steer 插最前），下一轮正常发送——不丢消息
        if (interruptText) {
          enqueuePending(state, 'steer', interruptText);
          interruptText = null;
        }
      }
      // 运行中输入 /exit：回合结束后退出（与空闲 /exit 同一清理路径）
      if (exitRequested) {
        await exitSession();
        break;
      }
      await persistTurn(); // 本轮消息（用户 + 助手 + 工具结果）追加进会话文件 + 轨迹事件落盘
      // 自动 git commit（config autoCommit，Aider 原子提交）：有改动则提交
      if (runOpts.cfg?.autoCommit) {
        const committed = await autoGitCommit(cmd).catch(() => null);
        if (committed) pushLine(state, { kind: 'meta', text: `✓ ${committed}` });
      }
      // 轨迹投影刷新（/trace 面板数据源）：每轮结束重新折叠——面板下次重绘即为最新
      if (runOpts.events) refreshTrace(state, runOpts.events.events);
      turn++;
      // 首轮对话结束后异步生成会话标题：独立轻量 LLM 调用，不阻塞主流程
      // （标题稍后到达并设为终端窗口/标签页标题——不显示在对话流里，保持信息流纯净；
      // 失败静默，不打扰对话）
      if (turn === 1 && state.sessionTitle === null) {
        void generateSessionTitle(currentClient, currentModel, messages, state.language).then((title) => {
          if (title && state.sessionTitle === null) {
            state.sessionTitle = title;
            setTerminalTitle(title);
          }
        });
      }
      out.onTurnEnd();
      input.focus();
    }
  } finally {
    clearInterval(bannerAnimTimer); // 退出交互：停掉横幅动画定时器（setInterval 会拖住进程退出）
    unsubKey();
  }
}
