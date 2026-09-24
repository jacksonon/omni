/**
 * omni mini 版式探针（人工核对用：`npx tsx scripts/probe-tmp/probe-mini.ts`）。
 *
 * 打印 banner 在各终端宽度下的成品、回合耗时线、动词/摘要映射，以及工具块的
 * 全部形态（3 行预览 + 折叠提示 / 空输出 / 失败 / 写文件 diff 统计 / read 静默）。
 * 客观断言版本见 scripts/feature-tests/mini.ts（npm run test:features）。
 */
import {
  MiniOutput,
  renderMiniBanner,
  renderTurnSeparator,
  renderWorkingLine,
  toolDetail,
  verbForTool,
} from '../../src/output/mini.js';
import { visualWidth } from '../../src/tui/width.js';

console.log('=== banner：各终端宽度下的行宽一致性 ===');
for (const cols of [80, 62, 44, 30]) {
  const lines = renderMiniBanner(
    { model: 'deepseek-v4.1-flash', effort: 'xhigh', directory: process.cwd(), permission: 'safe', sandbox: 'workspace-write' },
    cols
  );
  console.log(`cols=${cols} 行宽=${JSON.stringify([...new Set(lines.map((l) => visualWidth(l)))])}`);
  if (cols === 80) for (const l of lines) console.log(l);
}

console.log('\n=== 工具块 ===');
const out = new MiniOutput({ showThinking: false, stream: true });
const many = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
out.onToolStep(0, 50, 'run_command', '$ npm test', { command: 'npm test' }, 1);
out.onToolResult(true, 200, many, undefined, 1, 10);
out.onToolStep(1, 50, 'run_command', '$ true', { command: 'true' }, 2);
out.onToolResult(true, 0, [], undefined, 2, 0);
out.onToolStep(2, 50, 'run_command', '$ false', { command: 'false' }, 3);
out.onToolResult(false, 12, ['boom'], undefined, 3, 1);
out.onToolStep(3, 50, 'write_file', '← Write src/a.ts', { path: 'src/a.ts' }, 4);
out.onToolResult(true, 10, ['已写入'], { diff: { original: 'a\nb\nc\n', content: 'a\nB\nc\nd\n' } }, 4, 1);
out.onToolStep(4, 50, 'read_file', '* Read src/a.ts', { path: 'src/a.ts' }, 5);
out.onToolResult(true, 10, ['a', 'B'], undefined, 5, 2);
out.onToolStep(5, 50, 'search_code', '* Grep "foo"', { pattern: 'foo', path: 'src' }, 6);
out.onToolResult(true, 100, ['src/a.ts:1: foo', 'src/b.ts:9: foo'], undefined, 6, 9);
out.onStreamStart();
out.onAnswer('回答正文（$\\rightarrow$ 转 Unicode）\n');
out.onAnswerEnd();

console.log('\n=== 运行中状态行 / 回合分隔行（codex 同款） ===');
console.log(renderWorkingLine(12, '⠙'));
console.log(renderTurnSeparator(5000, new Date(2026, 8, 24, 22, 30)));
console.log(renderTurnSeparator(1_000_000, new Date(2026, 8, 24, 22, 30)));

console.log('\n=== 动词 / 摘要映射 ===');
for (const n of ['run_command', 'read_file', 'write_file', 'search_code', 'mcp__demo__ping']) {
  const detail = toolDetail(n, { command: 'npm run build', path: 'src/a.ts', pattern: 'foo' }, '$ npm build');
  console.log(`${n.padEnd(18)} → ${verbForTool(n).padEnd(12)} ${detail}`);
}
