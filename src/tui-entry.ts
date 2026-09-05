/**
 * TUI 入口（需 bun 运行时）：OpenTUI 全屏界面。
 *
 * 激活条件（全部满足才进 TUI）：
 *   · bun 运行时（OpenTUI 依赖 bun 的原生 FFI）
 *   · stdin/stdout 是真实 TTY（启动时要做终端能力协商）
 *   · 未加 --no-tui
 *
 * 进入 TUI 后：
 *   · 单次任务模式（带任务参数）：显示任务，跑完退出；
 *   · 交互模式（无参数）：底部输入框 + 消息滚动区，多轮对话（/exit /clear /help）。
 *
 * 否则自动回退到 console 输出（与 src/index.ts 行为一致）。
 *
 * 注意：本入口是纯 TypeScript（无 JSX）——OpenTUI 的 solid 集成依赖
 * preload 注册 JSX 转换插件，而入口文件在插件注册前就被转换；这里用
 * 命令式 renderable 渲染（见 tui/render.ts），完全不依赖 JSX 转换。
 */
import { parseArgs, printHelp } from './cli/args.js';
import { prepareContext } from './agent/context.js';
import { runAgent } from './agent/loop.js';
import { attachRuntime, main, prepareRun, prepareSessionPersistence, printSessions, resolveWorkspaceTrust } from './main.js';
import { ConsoleOutput } from './output/console.js';
import { crashLogPath, logCrash, logLifecycle } from './tui/crashlog.js';
import { runTuiInteractive } from './tui/interactive.js';
import { startTui, type TuiSession } from './tui/render.js';
import { TuiOutput } from './tui/output.js';
import { createTuiState } from './tui/state.js';
import { dim, isBun, isTTY, red } from './ui.js';
import { VERSION } from './version.js';

// 崩溃处理器：先于任何异步逻辑安装。未捕获异常落盘 + 尽力恢复终端后退出；
// 未处理拒绝只记录不退出（不致命，但日志能揭示与重绘/按键的关联）。
let activeSession: TuiSession | null = null;
process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err);
  const s = activeSession;
  activeSession = null;
  // 先恢复终端（否则提示画进备用屏会被抹掉），再打印提示并退出；stop 卡住时兜底退出
  const restored = s ? s.stop().catch(() => {}) : Promise.resolve();
  restored.then(() => {
    console.error(red('\n⚠️ 发生崩溃，详情已写入 ') + crashLogPath());
    process.exit(1);
  });
  setTimeout(() => process.exit(1), 500);
});
process.on('unhandledRejection', (reason) => {
  logCrash('unhandledRejection', reason);
});
// 终态标记：任何 process.exit 路径（含 exitOnCtrlC）都留痕，便于与崩溃区分
process.on('exit', (code) => {
  logLifecycle('process-exit', `code=${code}`);
});

async function run(): Promise<void> {
  logLifecycle('start', `omni v${VERSION} pid=${process.pid} args=${JSON.stringify(process.argv.slice(2))}`);
  const { taskArgs, overrides, flags, resumeId, help, version } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }
  if (version) {
    console.log(`omni v${VERSION}`);
    return;
  }
  if (flags.listSessions) {
    await printSessions();
    return;
  }

  // Headless 子命令（exec / mcp-server / web）恒走 console 路径——TUI 全屏没有机器可读输出、web 是服务模式
  const headlessCmd = taskArgs[0] === 'exec' || taskArgs[0] === 'mcp-server' || taskArgs[0] === 'web';
  const useTui = !headlessCmd && isBun && isTTY && !flags.noTui;
  if (!useTui) {
    await main((cfg) => new ConsoleOutput({ stream: true, showThinking: cfg.showThinking }));
    return;
  }

  const ctx = prepareRun(overrides);
  const { cfg, client, messages, runOpts } = ctx;
  const singleTask = taskArgs.join(' ').trim();
  // 会话持久化：--continue / -r 恢复历史（历史消息在 startTui 前载入，随后回放到 TUI）；
  // 交互模式自动创建会话文件。console.log 此时还未进入全屏，直接输出恢复提示。
  const ok = await prepareSessionPersistence(flags, resumeId, cfg, messages, runOpts, Boolean(singleTask));
  if (!ok) return;
  const state = createTuiState();
  // 界面语言（/settings 语言面板可改并持久化；应用层已校验 zh/en）
  state.language = cfg.language === 'en' ? 'en' : 'zh';
  // 思考过程展示（/thinking 可运行时开关；初始值来自 showThinking 配置）
  state.thinkingShow = cfg.showThinking !== false;
  const session = await startTui(state, { withInput: !singleTask });
  activeSession = session; // 崩溃时优先恢复终端
  const output = new TuiOutput(state, { showThinking: cfg.showThinking }, session);
  // 工作区信任（第九节）：首次进入未信任目录时 TUI 审批卡片询问；未信任 → 只读 + 跳过项目级配置
  const trust = await resolveWorkspaceTrust(process.cwd(), output);
  await attachRuntime(ctx, output, { trust }); // 安全护栏 + 动态工具链 + 上下文选项（MCP 发现可能耗时）
  if (!trust && !singleTask) output.onUserMessage('⚠️ 当前目录未受信任——以只读模式运行（/status 查看；/permission 无法提升）');
  output.banner(cfg, runOpts.tools.map((t) => t.name));
  // 恢复的会话：把历史消息回放到 TUI（用户消息/思考块/纯文本回答；工具调用历史不重建卡片），
  // 让对话流与消息上下文一致——新一轮在历史之后继续。思考块（reasoning/reasoningMs 已随
  // assistant 消息持久化）一并回放，带「- thinking · 耗时」头行（旧会话无 reasoningMs → 无耗时）。
  // 注意：仅回放出实际内容行才收尾 onTurnEnd——messages 里可能只有 system 脚手架
  // （如 MCP instructions 在 attachRuntime 注入），此时无可见行，onTurnEnd 会推入
  // 一行空 meta 导致 lines 非空、误杀 hero 居中（首帧居中闪一下即沉底）。
  if (messages.length > 0) {
    let replayed = false;
    for (const m of messages) {
      if (m.role === 'user' && typeof m.content === 'string' && m.content) {
        output.onUserMessage(m.content);
        replayed = true;
      } else if (m.role === 'assistant') {
        const ext = m as unknown as { reasoning?: string; reasoningMs?: number };
        if (ext.reasoning) {
          output.onThinkingRestored?.(ext.reasoning, ext.reasoningMs);
          replayed = true;
        }
        if (typeof m.content === 'string' && m.content) {
          output.onAnswer(m.content);
          output.onAnswerEnd();
          replayed = true;
        }
      }
    }
    if (replayed) {
      output.onTurnEnd();
      await output.flush().catch(() => {});
    }
  }

  try {
    if (singleTask) {
      output.onUserMessage(singleTask);
      messages.push({ role: 'user', content: singleTask });
      await prepareContext(client, cfg.model, messages, runOpts.context ?? {}, runOpts.events);
      output.startLoading(); // 会话进行中：模型行思考级别右侧 loading 一直转
      try {
        await runAgent(client, cfg.model, messages, runOpts, output);
      } finally {
        output.stopLoading(); // 会话结束：loading 消失
      }
      output.onTurnEnd();
    } else {
      await runTuiInteractive(client, cfg.model, messages, runOpts, output, session, state);
    }
  } finally {
    // 先刷掉 30ms 节流窗口内未渲染的最后一帧（如“任务完成”），再退出全屏恢复终端
    try {
      await output.flush();
    } catch {
      // 渲染已停止时忽略刷新错误，继续走退出清理
    }
    await session.stop();
    // 退出后（终端已恢复，见 stop() 内 destroy）打印会话恢复提示：
    // /exit 与 Ctrl+C（render.ts onCtrlC）退出时都给用户 omni -s <id> 恢复命令
    if (state.restoreHint) {
      process.stdout.write(`\n${dim(`恢复此会话：${state.restoreHint}`)}\n`);
    }
  }
}

run()
  .then(() => {
    logLifecycle('exit-clean', `pid=${process.pid}`);
    process.exit(0);
  })
  .catch((err) => {
    logCrash('fatal', err);
    console.error(red('\n发生错误：'), err instanceof Error ? err.message : err);
    process.exit(1);
  });
