/**
 * 功能测试：`omni mini` 纯终端 CLI 模式（Codex CLI 形态渲染层）。
 *
 * 版面规则逐条对齐 codex-rs/tui 源码（session.rs / messages.rs / exec_cell / separators.rs）。
 *
 * 分两层：
 * - 纯函数/渲染层：banner 版式（各列宽一致、长文本截断）、动词与摘要映射、
 *   工具输出预览的「3 行 + +N lines (ctrl+t to view transcript)」折叠、失败/空输出形态；
 * - 端到端：mock OpenAI 服务 + 真实 CLI 入口（tsx src/index.ts mini "<任务>"），
 *   断言 mini 的终端形态（信息框 / › 用户行 / • 正文行 / • Ran + └ 工具单元格 / 分隔行）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestSuite } from './framework.js';
import {
  MiniOutput,
  TRANSCRIPT_HINT,
  USER_SHELL_FLAG,
  approvalSessionKey,
  formatApprovalPrompt,
  parseApprovalAnswer,
  fmtElapsed,
  foldRows,
  renderMiniBanner,
  renderTurnSeparator,
  renderWorkingLine,
  toolDetail,
  verbForTool,
} from '../../src/output/mini.js';
import { MiniMarkdownRenderer, chunksToAnsi } from '../../src/output/markdown-ansi.js';
import { completeMention } from '../../src/cli/picker.js';
import { applyMentionInsert } from '../../src/cli/picker.js';
import { isBangShellCommand, stripBangPrefix } from '../../src/cli/picker.js';
import { visualWidth } from '../../src/tui/width.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOCK_PORT = 47_000 + Math.floor(Math.random() * 800);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10000, msg = 'timeout'): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor: ${msg}`);
    await sleep(150);
  }
}

/** 捕获 console.log / stdout.write 输出（MiniOutput 直接写这两个流） */
function capture(fn: () => void): string {
  const chunks: string[] = [];
  const origLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => {
    chunks.push(args.map((a) => String(a)).join(' '));
  };
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
    chunks.push(String(c));
    return true;
  };
  try {
    fn();
  } finally {
    console.log = origLog;
    (process.stdout as unknown as { write: unknown }).write = origWrite;
  }
  return chunks.join('\n');
}

/** 固定列数的渲染（banner 的宽度计算读 process.stdout.columns，探针里临时改写） */
function renderAt(cols: number, fn: () => void): string {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  try {
    return capture(fn);
  } finally {
    if (original) Object.defineProperty(process.stdout, 'columns', original);
    else delete (process.stdout as unknown as { columns?: number }).columns;
  }
}

const MOCK_CMD_OUTPUT = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);

export function miniSuite(): TestSuite {
  const suite = new TestSuite('纯终端 CLI / omni mini（banner / 工具块 / 折叠提示 / 端到端）');

  suite.test('banner：内容自适应圆角框 + codex 字段版式', () => {
    const box = renderMiniBanner(
      { model: 'mock-model', effort: 'medium', directory: process.cwd(), permission: 'full' },
      80
    );
    const widths = [...new Set(box.map((l) => visualWidth(l)))];
    suite.assert(widths.length === 1, `框内每行等宽（实际 ${JSON.stringify(widths)}）`);
    suite.assert(/^╭─+╮$/.test(box[0]!) && /^╰─+╯$/.test(box.at(-1)!), '圆角边框（╭ ╰）');
    suite.assert(box.join('\n').includes('>_ Omni (v'), '标题行 `>_ Omni (vX)`');
    // codex session.rs：模型行 = `model: <模型> <effort>` + 3 空格 + `/model to change`（不右对齐；effort 纯文本）
    suite.assert(box.some((l) => l.includes('model:') && l.includes('mock-model medium') && l.includes('/model to change')), 'model 行（模型 + effort + /model 提示）');
    suite.assert(box.some((l) => l.includes('directory:') && l.includes('~')), 'directory 行（home 简写 ~）');
    suite.assert(box.some((l) => l.includes('permissions: YOLO mode')), 'full 档位 → YOLO mode（codex 仅 YOLO 展示该行）');
    suite.assert(
      !renderMiniBanner({ model: 'm', directory: '/tmp', permission: 'read' }, 80).some((l) => l.includes('permissions:')),
      '非 YOLO 档位不展示 permissions 行（codex session.rs if yolo 才 push）'
    );
    suite.assert(
      !renderMiniBanner({ model: 'm', directory: '/tmp', permission: 'safe' }, 80).some((l) => l.includes('permissions:')),
      'safe 档位不展示 permissions 行（经 /permissions 查看）'
    );
    // 内容自适应：框宽随内容变化（codex with_border 按最宽内容行定宽）
    const short = renderMiniBanner({ model: 'a', directory: '/tmp', permission: 'safe' }, 80)[0]!;
    const long = renderMiniBanner({ model: 'a-very-long-model-name-here', directory: '/tmp', permission: 'safe' }, 80)[0]!;
    suite.assert(visualWidth(long) > visualWidth(short), '框宽随最长内容行变化（非固定宽度）');
    // 窄终端：压到列宽内且不撑破右边框
    for (const cols of [80, 60, 44, 30]) {
      const lines = renderMiniBanner(
        { model: 'a-very-long-model-name-for-narrow-terminal', effort: 'xhigh', directory: process.cwd(), permission: 'safe' },
        cols
      );
      const w = [...new Set(lines.map((l) => visualWidth(l)))];
      suite.assert(w.length === 1 && w[0]! <= cols, `${cols} 列下等宽且不超屏（${JSON.stringify(w)}）`);
    }
  });

  suite.test('动词与摘要映射（Ran / Read / Searched / Called）', () => {
    suite.assert(verbForTool('run_command') === 'Ran', 'run_command → Ran');
    suite.assert(verbForTool('read_file') === 'Read', 'read_file → Read');
    suite.assert(verbForTool('write_file') === 'Wrote', 'write_file → Wrote');
    suite.assert(verbForTool('edit_file') === 'Edited', 'edit_file → Edited');
    suite.assert(verbForTool('search_code') === 'Searched', 'search_code → Searched');
    suite.assert(verbForTool('mcp__demo__fetch') === 'Called', 'MCP 等未登记工具 → Called');
    suite.assert(toolDetail('run_command', { command: 'git log --oneline' }, '$ x') === 'git log --oneline', '命令取 args.command');
    suite.assert(toolDetail('run_command', { command: 'npm run\n  build' }, '$ x') === 'npm run build', '多行命令折叠成单行');
    suite.assert(toolDetail('read_file', { path: 'src/a.ts' }, '* Read x') === 'src/a.ts', '路径取 args.path');
    suite.assert(
      toolDetail('search_code', { pattern: 'foo', path: 'src' }, '* Grep') === 'for "foo" in src',
      '检索摘要 for "pattern" in path'
    );
    suite.assert(toolDetail('run_command', undefined, '$ npm test') === 'npm test', '参数缺失回退 argsPreview（剥 $ 前缀）');
    suite.assert(toolDetail('read_file', undefined, '* Read src/a.ts') === 'src/a.ts', '参数缺失回退 argsPreview（剥 * Read）');
  });

  suite.test('工具块：3 行预览 + 折叠提示 / 空输出 / 失败 / diff 统计', () => {
    const out = new MiniOutput({ showThinking: false, stream: true });
    const text = renderAt(80, () => {
      out.onToolStep(0, 50, 'run_command', '$ npm test', { command: 'npm test' }, 1);
      out.onToolResult(true, 200, MOCK_CMD_OUTPUT, undefined, 1, MOCK_CMD_OUTPUT.length);
      out.onToolStep(1, 50, 'run_command', '$ echo hi', { command: 'echo hi' }, 2);
      out.onToolResult(true, 3, ['exit 0', 'hi'], undefined, 2, 2);
      out.onToolStep(2, 50, 'run_command', '$ true', { command: 'true' }, 3);
      out.onToolResult(true, 0, [], undefined, 3, 0);
      out.onToolStep(3, 50, 'run_command', '$ false', { command: 'false' }, 4);
      out.onToolResult(false, 12, ['boom'], undefined, 4, 1);
      out.onToolStep(4, 50, 'write_file', '← Write src/a.ts', { path: 'src/a.ts' }, 5);
      out.onToolResult(true, 10, ['已写入'], { diff: { original: 'a\nb\nc\n', content: 'a\nB\nc\nd\n' } }, 5, 1);
      out.onToolStep(5, 50, 'read_file', '* Read src/a.ts', { path: 'src/a.ts' }, 6);
      out.onToolResult(true, 10, ['a', 'b'], undefined, 6, 2);
    });
    suite.assert(text.includes('• Ran npm test'), '工具块首行 `• Ran <命令>`');
    suite.assert(text.includes('  └ line-1'), '输出首行用 `  └ ` 起头');
    suite.assert(text.includes('    line-2') && text.includes('    line-3'), '续行缩进 4 空格');
    suite.assert(text.includes(`    +7 lines (${TRANSCRIPT_HINT})`), '超出 3 行折叠为 +N lines 提示');
    suite.assert(!text.includes('line-4'), '第 4 行起不再展示（只留前 3 行）');
    suite.assert(!text.includes('退出码: 0'), '过滤「退出码: 0」噪声行');
    suite.assert(text.includes('└ (no output)'), '空输出显示 (no output)');
    suite.assert(text.includes('└ boom'), '失败单元格仍用 `└ `（bullet 颜色区分状态）');
    suite.assert(text.includes('└ +2 −1'), 'write_file 显示紧凑 diff 统计');
    suite.assert(!/• Read src\/a\.ts\n\s+└/.test(text), 'read_file 不铺输出内容');
  });

  suite.test('`!` shell：判定/剥前缀 + `• You ran` 标题（codex bash mode）', () => {
    suite.assert(isBangShellCommand('!git status'), '`!` 开头是 shell 命令');
    suite.assert(isBangShellCommand('  !ls'), '前导空格后 `!` 仍是 shell 命令');
    suite.assert(!isBangShellCommand('ls'), '普通文本不是 shell 命令');
    suite.assert(!isBangShellCommand('/model'), '斜杠命令不是 shell 命令');
    suite.assert(!isBangShellCommand(''), '空行不是 shell 命令');
    suite.assert(stripBangPrefix('!git status') === 'git status', '剥 `!` 取命令体');
    suite.assert(stripBangPrefix('!') === '', '裸 `!` 命令体为空');
    const out = new MiniOutput({ showThinking: false, stream: true });
    const text = renderAt(80, () => {
      out.onTurnStart();
      out.onToolStep(0, 1, 'run_command', '$ echo hi', { command: 'echo hi', [USER_SHELL_FLAG]: true }, 1);
      out.onToolResult(true, 8, ['hi'], undefined, 1, 1);
      out.onTurnEnd();
    });
    const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    suite.assert(plain.includes('You ran echo hi'), '用户直跑标题 `• You ran <cmd>`（codex is_user_shell_command）');
    suite.assert(!plain.includes('• Ran echo hi'), '用户直跑不用 `• Ran` 标题');
    suite.assert(plain.includes('└ hi'), '输出仍用 `└ ` 单元格');
  });

  suite.test('审批：y 本次 / a 本会话记住 / 其余拒绝（codex allow for session）', async () => {
    suite.assert(parseApprovalAnswer('y') === 'once', '`y` = 仅本次允许');
    suite.assert(parseApprovalAnswer('YES') === 'once', '`YES` = 仅本次允许（兼容旧行为）');
    suite.assert(parseApprovalAnswer('a') === 'session', '`a` = 本会话记住');
    suite.assert(parseApprovalAnswer('n') === 'deny', '`n` = 拒绝');
    suite.assert(parseApprovalAnswer('') === 'deny', '空输入 = 拒绝（fail-safe）');
    suite.assert(approvalSessionKey('run_command', '  $ npm test ') === 'run_command::$ npm test', '记住键：工具 + 去空格摘要');
    const prompt = formatApprovalPrompt({ tool: 'run_command', summary: '$ npm test', reason: '危险命令' }).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    suite.assert(prompt.includes('[y]本次允许') && prompt.includes('[a]本会话记住') && prompt.includes('[N]拒绝'), '提示文案含三选项');
    suite.assert(prompt.includes('$ npm test') && prompt.includes('危险命令'), '提示文案含摘要与原因');
    const out = new MiniOutput({ showThinking: false, stream: true });
    // 非 TTY fail-safe：无记住时拒绝（管道/测试环境 isTTY=false）
    suite.assert(await out.requestApproval({ tool: 'run_command', summary: '$ npm test', reason: '危险命令' }) === false, '无记住时拒绝');
    // 预置记住后自动放行（同工具同摘要）；摘要不同仍拒绝
    out.rememberApproval('run_command', '$ npm test');
    suite.assert(await out.requestApproval({ tool: 'run_command', summary: '$ npm test', reason: '危险命令' }) === true, '记住后同命令自动放行');
    suite.assert(await out.requestApproval({ tool: 'run_command', summary: '$ rm -rf /', reason: '危险命令' }) === false, '不同命令不受记住影响');
    suite.assert(await out.requestApproval({ tool: 'write_file', summary: '$ npm test', reason: 'x' }) === false, '不同工具不受记住影响');
    out.clearSessionApprovals();
    suite.assert(await out.requestApproval({ tool: 'run_command', summary: '$ npm test', reason: '危险命令' }) === false, '/new 语义：清掉后重新询问');
  });

  suite.test('回合形态：› 用户行 / • 正文行 / 运行中状态行 / Worked for 分隔行', () => {
    const out = new MiniOutput({ showThinking: false, stream: true });
    const text = renderAt(80, () => {
      out.onTurnStart();
      out.onUserMessage('验证一下环境');
      out.onToolStep(0, 50, 'run_command', '$ echo mock-ok', { command: 'echo mock-ok' }, 1);
      out.onToolResult(true, 8, ['mock-ok'], undefined, 1, 1);
      out.onRound(1, 50);
      out.onStreamStart();
      out.onAnswer('任务完成 ✅\n');
      out.onAnswerEnd();
      out.onTurnEnd();
    });
    suite.assert(text.includes('› 验证一下环境'), '用户消息用 `› ` 前缀（codex UserHistoryCell）');
    suite.assert(text.includes('• Ran echo mock-ok'), '工具单元格 `• Ran <cmd>`');
    suite.assert(text.includes('• 任务完成 ✅'), '正文用 `• ` 前缀（codex AgentMessageCell）');
    suite.assert(!text.includes('>>'), '不再使用早期的 `>> … <<` 形态');
    suite.assert(!text.includes('💭'), '思考不再用 💭 前缀');
    // 运行中状态行（codex status_indicator_widget.rs）
    const working = renderWorkingLine(12, '⠙');
    suite.assert(working.includes('Working') && working.includes('(12s • esc to interrupt)'), '运行中状态行文案');
    // 分隔行（codex separators.rs）：>60s 才写 Worked for，始终带本地时间
    const short = renderTurnSeparator(5_000, new Date(2026, 8, 24, 22, 30));
    suite.assert(!short.includes('Worked for') && short.includes('22:30'), '≤60s 只显示时间');
    const long = renderTurnSeparator(1_000_000, new Date(2026, 8, 24, 22, 30));
    suite.assert(long.includes('Worked for 16m 40s') && long.includes('22:30'), '1m 40s 以上显示 Worked for');
    suite.assert(fmtElapsed(65_000) === '1m 05s', '耗时格式 1m 05s');
  });

  suite.test('提交行折行：超长按终端宽折断 + 首行 • / 续行 2 空格（codex 同款）', () => {
    let rows: string[] = [];
    renderAt(80, () => {
      rows = foldRows('a'.repeat(200));
    });
    suite.assert(rows.length === 3, '200 列按可用宽折成 3 行');
    suite.assert(rows.every((r) => visualWidth(r) <= 78), '每 folded 行不超过终端宽（终端不软换行）');
    suite.assert(rows.join('') === 'a'.repeat(200), '折行不断字符');
    let cjk: string[] = [];
    renderAt(80, () => {
      cjk = foldRows('中'.repeat(50));
    });
    suite.assert(cjk.join('') === '中'.repeat(50), 'CJK 不拆字');
    suite.assert(cjk.every((r) => visualWidth(r) <= 78), 'CJK 每行不超过终端宽');
    let blank: string[] = [];
    renderAt(80, () => {
      blank = foldRows('');
    });
    suite.assert(blank.length === 1 && blank[0] === '', '空行保持单空行（不挂孤 bullet）');
    // 单元格级：仅首行挂 •，续行 2 空格缩进（codex AgentMessageCell）+ 超长折断 + 空行裸空行
    const text = renderAt(80, () => {
      const out = new MiniOutput({ showThinking: false, stream: true });
      out.onAnswer(`${'b'.repeat(200)}\n空行上\n\n分段下\n`);
      out.onAnswerEnd();
    });
    const stripped = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const lines = stripped.split('\n');
    const brows = lines.filter((l) => l.includes('b'));
    suite.assert(
      brows.length === 3 && brows[0]!.startsWith('• ') && brows.slice(1).every((l) => l.startsWith('  ') && !l.startsWith('• ')),
      '超长正文折成 3 行：仅首行 •，续行 2 空格缩进'
    );
    suite.assert(lines.every((l) => visualWidth(l) <= 80), '输出无超宽行（终端不软换行顶到 0 列）');
    suite.assert(lines.some((l) => l === '  空行上'), '续行 2 空格缩进（非每行 •）');
    suite.assert(!lines.some((l) => l === '• '), '空行不挂孤 bullet');
    suite.assert(lines.some((l) => l === '  分段下'), '后续段落同样缩进（同一单元格仅首行 •）');
  });

  suite.test('mini markdown：行内样式 + 围栏隐藏 + 表格框线 + 仅首行 •', () => {
    // SGR 映射（纯函数，color 显式开关）
    suite.assert(chunksToAnsi([{ text: '粗', bold: true }], true).includes('\x1b[1m粗\x1b[0m'), '加粗 SGR');
    suite.assert(chunksToAnsi([{ text: '码', fg: '#e6b450' }], true).includes('38;2;230;180;80'), '行内代码琥珀色');
    suite.assert(chunksToAnsi([{ text: '粗', bold: true }], false) === '粗', '无颜色时纯文本（管道可 grep）');
    // 行级状态机：围栏标记隐藏 + 代码着色
    const r = new MiniMarkdownRenderer(true);
    suite.assert(r.pushLine('```js', 80).length === 0, '围栏起始行隐藏');
    const code = r.pushLine('const a = 1;', 80);
    suite.assert(code.length === 1 && code[0]!.includes('const a = 1;') && !code[0]!.includes('```'), '代码行输出且无围栏标记');
    suite.assert(r.pushLine('```', 80).length === 0, '围栏结束行隐藏');
    // 表格：头/分隔/数据缓冲，空行触发整表渲染
    const t = new MiniMarkdownRenderer(false);
    suite.assert(t.pushLine('| 项目 | 状态 |', 80).length === 0, '表头暂存');
    suite.assert(t.pushLine('| --- | --- |', 80).length === 0, '分隔行暂存');
    suite.assert(t.pushLine('| 工具 | 成功 |', 80).length === 0, '数据行暂存');
    const table = t.pushLine('', 80);
    suite.assert(table.some((l) => l.includes('┌') && l.includes('┐')), '表格上边框');
    suite.assert(table.some((l) => l.includes('工具') && l.includes('成功')), '表格内容行');
    const widths = [...new Set(table.filter((l) => l !== '').map((l) => visualWidth(l)))];
    suite.assert(widths.length === 1, `表格每行等宽（${JSON.stringify(widths)}）`);
    // 孤含 | 行：下一行非分隔行则回吐原文
    const p = new MiniMarkdownRenderer(false);
    suite.assert(p.pushLine('a | b', 80).length === 0, '疑似表头暂存一行');
    suite.assert(p.pushLine('普通行', 80).join('\n').includes('a | b'), '非表格回吐原文');
    // 整机：markdown 多行仍仅首行 •
    const text = renderAt(80, () => {
      const out = new MiniOutput({ showThinking: false, stream: true, markdown: true });
      out.onAnswer('# 标\n**加粗**正文\n- 项\n');
      out.onAnswerEnd();
    });
    const stripped = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const lines = stripped.split('\n').filter((l) => l !== '');
    suite.assert(lines[0]!.startsWith('• ') && lines.slice(1).every((l) => l.startsWith('  ')), 'markdown 下仍仅首行 •');
    suite.assert(!stripped.includes('**') && !stripped.includes('# 标'), '标记已渲染（无残留）');
    suite.assert(lines.every((l) => visualWidth(l) <= 80), '无超宽行');
  });

  suite.test('@ 提及：Tab 补全候选（文件尾空格/目录留/·模糊/空白结束/斜杠抑制）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mention-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'x');
    fs.writeFileSync(path.join(dir, 'readme.md'), 'x');
    // 空查询：顶层浏览（目录保留 /，文件尾空格结束提及）
    const top = completeMention('@', dir)!;
    suite.assert(top[1] === '@', '被替换词为 @');
    suite.assert(top[0].includes('@src/'), '目录候选保留 /（继续深入）');
    suite.assert(top[0].includes('@readme.md '), '文件候选尾空格（结束提及）');
    // 非空查询：跨目录模糊命中
    const hits = completeMention('@app', dir)!;
    suite.assert(hits[0].includes('@src/app.ts '), '跨目录模糊命中文件');
    // 目录前缀下检索 + 行内位置
    const sub = completeMention('看看 @src/', dir)!;
    suite.assert(sub[0].includes('@src/app.ts '), '目录前缀下检索（行内 @ 生效）');
    // @ 后空白 → 提及结束
    suite.assert(completeMention('@app x', dir) === null, '@ 后空白无提及');
    // / 命令文本抑制（TUI 同款）
    suite.assert(completeMention('/model @app', dir) === null, '/ 文本不触发提及');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  suite.test('@ 提及插入纯函数（文件尾空格/目录留/·行内光标）', () => {
    // '看看 @app'：@ 下标 3，查询 'app' 长 3
    const f = applyMentionInsert('看看 @app', 3, 3, 'src/app.ts');
    suite.assert(f.text === '看看 @src/app.ts ', `文件插入尾空格：${JSON.stringify(f.text)}`);
    suite.assert(f.cursor === f.text.length, '光标落在插入段末尾');
    const d = applyMentionInsert('@src', 0, 3, 'src/');
    suite.assert(d.text === '@src/' && d.cursor === 5, '目录保留 / 继续深入（不加空格）');
    // 行内 @ 后半截保留
    const mid = applyMentionInsert('看 @ap 好', 2, 2, 'src/app.ts');
    suite.assert(mid.text === '看 @src/app.ts  好', `行内插入保留后半截：${JSON.stringify(mid.text)}`);
  });

  suite.test('端到端：omni mini "<任务>"（mock 服务）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(MOCK_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      const { code, out } = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn('npx', ['tsx', 'src/index.ts', 'mini', '验证 mini 模式'], {
          cwd: ROOT,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: xdg,
            OMNI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
            OMNI_API_KEY: 'sk-mock',
            OMNI_MODEL: 'mock-model',
            OMNI_PERMISSION: 'full',
            OMNI_SHOW_THINKING: '0',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        child.stdout.on('data', (d) => (acc += d));
        child.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
      suite.assert(code === 0, `进程退出码 0（实际 ${code}）`);
      const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      suite.assert(plain.includes('>_ Omni (v'), 'banner 信息框');
      suite.assert(plain.includes('model:') && plain.includes('mock-model') && plain.includes('/model to change'), 'banner 模型行版式（codex：model + /model to change）');
      suite.assert(plain.includes('permissions: YOLO mode'), 'banner 展示权限档位（YOLO 才展示）');
      suite.assert(out.includes('› 验证 mini 模式'), '用户输入回显（› 前缀）');
      suite.assert(out.includes('• Ran echo mock-ok'), '工具调用项目符号行');
      suite.assert(out.includes('• 任务完成'), '正文用 • 前缀');
      suite.assert(out.includes('└ mock-ok'), '工具输出预览');
      suite.assert(out.includes('mock 端到端验证通过'), '模型最终回答');
      suite.assert(/\d\d:\d\d/.test(out), '回合分隔行带本地时间');
      suite.assert(!out.includes('退出码: 0'), '不显示退出码 0');
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：omni mini 交互模式（输入 → 回合 → /exit）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-i-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 1;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      const child = spawn('npx', ['tsx', 'src/index.ts', 'mini'], {
        cwd: ROOT,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: xdg,
          OMNI_BASE_URL: `http://127.0.0.1:${port}/v1`,
          OMNI_API_KEY: 'sk-mock',
          OMNI_MODEL: 'mock-model',
          OMNI_PERMISSION: 'full',
          OMNI_SHOW_THINKING: '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      const closed = new Promise<number | null>((r) => child.on('close', r));
      // 等提示符就绪再喂输入（交互模式按行读取）
      await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
      child.stdin.write('验证 mini 交互\n');
      await waitFor(async () => out.includes('mock 端到端验证通过'), 30000, '首轮回答');
      child.stdin.write('!echo ledger-bang\n');
      await waitFor(async () => out.includes('You ran echo ledger-bang'), 15000, '`!` 直跑回显');
      child.stdin.write('/exit\n');
      const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
      suite.assert(out.includes('>_ Omni (v'), '交互模式同样打印信息框');
      suite.assert(out.includes('›'), '使用 mini 提示符 ›（替代 omni> ）');
      suite.assert(!out.includes('输入任务开始；'), '不打印内置开场提示（由 Tip 行接管）');
      suite.assert(out.includes('› 验证 mini 交互'), '用户输入回显（› 前缀）');
      suite.assert(out.includes('• Ran echo mock-ok'), '工具调用项目符号行');
      suite.assert(/\d\d:\d\d/.test(out), '回合分隔行带本地时间（codex separators.rs）');
      suite.assert(out.includes('└ ledger-bang'), '`!` 输出进 `└ ` 单元格');
      // 落盘账本：会话 JSONL 含 bang 工具调用（Ctrl+T 同源）
      let ledger = '';
      try {
        const dir = path.join(xdg, 'omni', 'sessions');
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.jsonl')) ledger += fs.readFileSync(path.join(dir, f), 'utf8');
        }
      } catch { /* 会话目录缺失则断言失败 */ }
      suite.assert(ledger.includes('ledger-bang'), '`!` 直跑进会话账本');
      suite.assert(code === 0 || code === null, `退出码 0（实际 ${code}）`);
    } finally {
      mock.kill();
    }
  });

  return suite;
}
