/**
 * TUI 交互模式：底部输入框 + 消息滚动区，多轮对话全部在 TUI 内完成。
 *
 * 流程：等待输入框 Enter 提交 → 回显用户消息 → 跑一轮 Agent → 等待下一轮。
 * 支持 / 命令（/theme /exit /clear /help，见 commands.ts）：
 *   · 提交 `/xxx` 时调 runCommand 分发，'exit' 结果结束循环；
 *   · 带面板的命令（如 /theme）打开 state.menu——面板打开期间键盘事件由
 *     handleMenuKey 在全局 keypress 里先于输入框拦截（↑/↓/数字选择、Enter 确认、
 *     Esc 取消），输入框不参与，也不会误提交。
 * Ctrl+C 由渲染器的 exitOnCtrlC 处理（直接退出进程）。
 *
 * 按键刷新：输入框内部编辑会自行 requestRender，但这里再订阅一次 keypress
 * 显式重绘，兜底保证键入字符实时上屏（与 30ms 节流无关，代价很小）。
 */
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { TextareaRenderable } from '@opentui/core';
import { prepareContext } from '../agent/context.js';
import { runAgent } from '../agent/loop.js';
import { maybeWriteGlobalMemory } from '../agent/memory.js';
import { appendSessionMessages, finalizeSession, persistableMessages } from '../agent/session.js';
import { generateSessionTitle } from '../agent/title.js';
import type { RunOptions } from '../agent/types.js';
import { setTerminalTitle } from '../ui.js';
import { handleMenuKey, runCommand } from './commands.js';
import type { TuiOutput } from './output.js';
import type { TuiSession, TuiKey } from './render.js';
import type { ScrollAction, TuiState } from './state.js';

/**
 * 等待输入框下一次 Enter 提交，resolve 出输入内容。
 *
 * 多行 Textarea 的 Enter 由自定义 keyBinding 路由到 submit()，submit() 触发
 * onSubmit 回调（不清空内容）。这里设置一次性 onSubmit：提交后立即解除，
 * 从 plainText（buffer 全文本，含换行）读取输入。
 */
function waitForSubmit(input: TextareaRenderable): Promise<string> {
  return new Promise((resolve) => {
    const handler = () => {
      input.onSubmit = undefined; // 一次性：本次提交消费后移除，避免重复触发
      resolve(input.plainText);
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
  // 会话持久化：增量追加每轮新增消息。
  // savedCount 统计**可落盘**消息数（脚手架 system 消息不落盘，见 persistableMessages）：
  // · --continue/-r 恢复时历史已在文件里 → 从可落盘数起步，避免整段重复追加（review 抓到的 bug）；
  // · prepareContext 每轮可能 unshift 全局/项目记忆/预载 system 消息（不落盘）——按可落盘数
  //   切片不受下标偏移影响（否则恢复会话会把上轮回答重复写盘，实测抓到）
  const sessionPath = runOpts.sessionPath;
  let savedCount = persistableMessages(messages).length;
  const persistTurn = async (): Promise<void> => {
    if (!sessionPath) return;
    const persistable = persistableMessages(messages);
    if (savedCount > persistable.length) savedCount = 0; // /clear 后上下文重置
    if (persistable.length <= savedCount) return;
    await appendSessionMessages(sessionPath, persistable.slice(savedCount)).catch(() => {});
    savedCount = persistable.length;
  };

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
    // 工具审批卡片的按键（y/Enter 批准、n/Esc 拒绝）已挂在 startTui 全局
    // （单任务与交互模式共用，避免双重监听重复 resolve）——这里不再处理。
    // 命令面板打开时：面板消费所有按键（↑/↓/数字选择、Enter 确认、Esc 取消），
    // preventDefault 阻止输入框处理——不会把方向键当光标移动、Enter 也不会误提交。
    if (state.menu) {
      if (handleMenuKey(key, state)) key.preventDefault();
      paintNow();
      return;
    }
    // 命令联想列表（输入以 / 开头时显示）：非模态——只有 ↑/↓/Tab/Enter/Esc 被消费，
    // 其它按键照常输入（列表在下次 paint 按最新文本过滤，互不影响）。
    // Enter：填入高亮命令并 submit()——走主循环正常分发路径（/exit 也能正确退出）。
    const sug = state.cmdSuggest;
    if (sug && sug.items.length > 0) {
      const sel = Math.min(sug.selected, sug.items.length - 1);
      if (key.name === 'up') {
        sug.selected = (sel - 1 + sug.items.length) % sug.items.length;
        key.preventDefault();
      } else if (key.name === 'down') {
        sug.selected = (sel + 1) % sug.items.length;
        key.preventDefault();
      } else if (key.name === 'tab') {
        // Tab：只填入命令（带尾空格让联想自动消失），用户可继续编辑后 Enter 执行
        input.setText(`/${sug.items[sel]} `);
        state.cmdSuggest = null;
        key.preventDefault();
      } else if (key.name === 'return' || key.name === 'kpenter' || key.name === 'linefeed') {
        // Enter：直接执行高亮命令（填入后 submit，主循环 runCommand 分发）
        input.setText(`/${sug.items[sel]}`);
        state.cmdSuggest = null;
        key.preventDefault();
        input.submit();
      } else if (key.name === 'escape' || key.name === 'esc') {
        // 记录关闭时的输入文本：文本不变则保持隐藏（否则 repaintTree 会复活列表）
        state.cmdSuggest = null;
        state.cmdSuggestDismissedText = state.inputText;
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
    let turn = 0; // 真实对话轮次（斜杠命令/空输入不计）
    for (;;) {
      // 菜单打开时跳过“等待输入”状态刷新（会清掉面板提示）；面板由 keypress handler 驱动
      if (!state.menu) {
        out.onWaitForInput();
        await session.paint();
      }
      const text = await waitForSubmit(input);
      const cmd = text.trim();
      // 提交后回到最新：新消息和后续回答应立即可见
      state.scrollTop = null;
      state.scrollIntent = null;
      input.setText(''); // 多行 Textarea 的 value setter 不提交到 buffer，必须 setText 清空（同时复位自动增高）
      await session.paint(); // 立即清掉输入框，避免残留文本影响阅读

      if (!cmd) continue;
      // 斜杠命令：注册表分发（/theme 打开面板、/exit 返回 'exit' 结束循环…）
      if (cmd.startsWith('/')) {
        const ctx = { state, out, session, input, messages, client, model, undoStack: runOpts.undoStack };
        const result = await runCommand(ctx, cmd);
        await session.paint();
        if (result === 'exit') {
          // 会话结束：把本轮新表达的偏好自动追加进全局记忆（autoMemory 开关；静默失败）
          if (runOpts.context?.autoMemory !== false && messages.some((m) => m.role === 'user')) {
            await maybeWriteGlobalMemory(client, model, messages).catch(() => {});
          }
          if (sessionPath) await finalizeSession(sessionPath).catch(() => {}); // 刷新会话更新时间
          break;
        }
        continue;
      }

      messages.push({ role: 'user', content: cmd });
      out.onUserMessage(cmd);
      // 上下文管理：首轮预载相关文件 + 长对话摘要压缩（选项由入口统一注入 runOpts.context）
      await prepareContext(client, model, messages, runOpts.context ?? {});
      // Agent 运行期间 blur 输入框：防止运行中键入的内容混入下一轮输入
      input.blur();
      runOpts.planMode = state.planMode; // 每轮同步计划模式（/plan 切换即时生效）
      // 每轮同步权限档位：主循环按 runOpts.permission 新建 Safety；共用闸门（子代理）setTier 同步
      runOpts.permission = state.permission;
      runOpts.safetyGate?.setTier(state.permission);
      await runAgent(client, model, messages, runOpts, out);
      await persistTurn(); // 本轮消息（用户 + 助手 + 工具结果）追加进会话文件
      turn++;
      // 首轮对话结束后异步生成会话标题：独立轻量 LLM 调用，不阻塞主流程
      // （标题稍后到达并设为终端窗口/标签页标题——不显示在对话流里，保持信息流纯净；
      // 失败静默，不打扰对话）
      if (turn === 1 && state.sessionTitle === null) {
        void generateSessionTitle(client, model, messages).then((title) => {
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
    unsubKey();
  }
}
