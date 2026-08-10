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
