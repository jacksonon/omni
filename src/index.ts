#!/usr/bin/env node
/**
 * CLI 入口（console 版）：Node / bun / 管道模式通用。
 *
 * TUI（OpenTUI 全屏界面，需 bun 运行时）见 src/tui-entry.tsx，
 * 由 release/omni（bun build --compile）与 npm run dev:tui 使用。
 */
import { main } from './main.js';
import { ConsoleOutput } from './output/console.js';
import { red } from './ui.js';

main((cfg) => new ConsoleOutput({ stream: true, showThinking: cfg.showThinking })).catch((err) => {
  console.error(red('发生错误：'), err instanceof Error ? err.message : err);
  process.exit(1);
});

// 未处理 Promise 拒绝兜底：第三方依赖（OpenAI SDK 等）在取消/网络抖动时可能产生
// 杂散 rejection——Node ≥15 默认因此杀死进程。Agent 会话稳定性优先：记录后继续运行
//（OMNI_STRICT=1 时保留默认崩溃行为，便于测试暴露真实问题）。
process.on('unhandledRejection', (reason) => {
  if (process.env.OMNI_STRICT) {
    console.error(reason);
    process.exit(1);
  }
  const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  console.error(`[omni] 已忽略未处理的异步错误：${msg.slice(0, 200)}`);
});
