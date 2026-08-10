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
import { runAgent } from './agent/loop.js';
import { main, prepareRun } from './main.js';
import { ConsoleOutput } from './output/console.js';
import { runTuiInteractive } from './tui/interactive.js';
import { startTui } from './tui/render.js';
import { TuiOutput } from './tui/output.js';
import { createTuiState } from './tui/state.js';
import { isBun, isTTY, red } from './ui.js';
import { VERSION } from './version.js';

async function run(): Promise<void> {
  const { taskArgs, overrides, flags, help, version } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }
  if (version) {
    console.log(`omni v${VERSION}`);
    return;
  }

  const useTui = isBun && isTTY && !flags.noTui;
  if (!useTui) {
    await main((cfg) => new ConsoleOutput({ stream: true, showThinking: cfg.showThinking }));
    return;
  }

  const { cfg, client, messages, runOpts } = prepareRun(overrides);
  const singleTask = taskArgs.join(' ').trim();
  const state = createTuiState();
  const session = await startTui(state, { withInput: !singleTask });
  const output = new TuiOutput(state, { showThinking: cfg.showThinking }, session);
  output.banner(cfg);

  try {
    if (singleTask) {
      output.onUserMessage(singleTask);
      messages.push({ role: 'user', content: singleTask });
      await runAgent(client, cfg.model, messages, runOpts, output);
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
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(red('\n发生错误：'), err instanceof Error ? err.message : err);
    process.exit(1);
  });
