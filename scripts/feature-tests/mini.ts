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
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestSuite } from './framework.js';
import {
  MiniOutput,
  MINI_GREETINGS,
  TRANSCRIPT_HINT,
  pickMiniGreeting,
  USER_SHELL_FLAG,
  approvalSessionKey,
  diffPreviewBody,
  shouldShowTurnTip,
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
import { formatModePrompt } from '../../src/cli/picker.js';
import { hasLineContinuation, stripLineContinuation } from '../../src/cli/picker.js';
import { joinContinued } from '../../src/cli/picker.js';
import { historySearchItems } from '../../src/cli/picker.js';
import { isPickerConfirmKey } from '../../src/cli/picker.js';
import { isShortcutsHelpRequest, formatShortcutsHelp } from '../../src/cli/picker.js';
import { formatModelPickLabel } from '../../src/cli/picker.js';
import { completionScript, runCompletionCommand } from '../../src/cli/completion.js';
import { spawnSync as spawnSyncCheck } from 'node:child_process';
import { PasteBurstTracker } from '../../src/cli/picker.js';
import { copyTextToClipboard, osc52Sequence } from '../../src/ui.js';
import { parseAskAnswer } from '../../src/output/mini.js';
import { approvalDiffText } from '../../src/output/format.js';
import { prefixLines } from '../../src/output/format.js';

import { lastAssistantText } from '../../src/agent/report.js';
import { deleteSessionFile, sessionsDir } from '../../src/agent/session.js';
import { compactedSince } from '../../src/agent/events.js';
import { splitMiniOneShotFlags } from '../../src/cli/mini.js';
import { parseArgs } from '../../src/cli/args.js';
import { collectImageAttachments, isImagePath, userMessageWithImages } from '../../src/agent/context.js';
import type { TrajEvent } from '../../src/agent/events.js';
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

  suite.test('会话头：compact 无框版式（codex borderless session header）', () => {
    const g = pickMiniGreeting();
    suite.assert(typeof g === 'string' && g.length > 0 && (MINI_GREETINGS as readonly string[]).includes(g), '问候语来自目录');
    const head = renderMiniBanner({ directory: process.cwd(), permission: 'full' }, 80, 'Hello, you. Got an idea?');
    const text = head.join('\n');
    suite.assert(!text.includes('╭') && !text.includes('╰') && !text.includes('│'), '无框（borderless）');
    suite.assert(text.includes('>_ Omni (v') && text.includes('Hello, you. Got an idea?'), '标题 + 问候语');
    suite.assert(text.includes('~'), '目录行（home 简写 ~）');
    suite.assert(!text.includes('model:'), '无模型行（上游已删 boxed model row）');
    suite.assert(text.includes('permissions: YOLO mode'), 'YOLO 行保留');
    const plain = renderMiniBanner({ directory: '/tmp', permission: 'safe' }, 80, 'hi').join('\n');
    suite.assert(!plain.includes('permissions:'), '非 YOLO 无权限行');
    const nogreet = renderMiniBanner({ directory: '/tmp', permission: 'safe' }, 80, null).join('\n');
    suite.assert(!nogreet.includes('hi') && nogreet.includes('>_ Omni (v'), 'greeting=null 省略问候行');
    // 窄终端：目录居中截断，不超屏
    for (const cols of [80, 60, 44, 30]) {
      const lines = renderMiniBanner({ directory: process.cwd(), permission: 'safe' }, cols, 'hi');
      const stripped = lines.map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
      suite.assert(stripped.every((l) => visualWidth(l) <= cols), `${cols} 列下不超屏`);
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

  suite.test('回合完成 tip 节奏（codex turn tips：3 轮起/间隔 3/全会话 2 条）', () => {
    const s = (turn: number, shown: number, last: number, hasAnswer: boolean) =>
      shouldShowTurnTip({ turn, shown, lastShownTurn: last, hasAnswer });
    suite.assert(s(1, 0, 0, true) === false, '前两轮不打扰');
    suite.assert(s(2, 0, 0, true) === false, '第 2 轮不打扰');
    suite.assert(s(3, 0, 0, false) === false, '无最终回答不打扰');
    suite.assert(s(3, 0, 0, true) === true, '第 3 轮带回答首现');
    suite.assert(s(4, 1, 3, true) === false, '间隔不足 3 轮不打扰');
    suite.assert(s(6, 1, 3, true) === true, '间隔 3 轮可再现');
    suite.assert(s(9, 2, 6, true) === false, '全会话最多 2 条');
    // 集成：第 3 个带回答回合末出现 `Tip:`，第 4 轮不再出现
    const out = new MiniOutput({ showThinking: false, stream: true });
    const text = renderAt(80, () => {
      for (let i = 1; i <= 4; i++) {
        out.onUserMessage(`问题${i}`);
        out.onTurnStart();
        out.onAnswer(`回答${i}\n`);
        out.onAnswerEnd();
        out.onTurnEnd();
      }
    });
    const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const tips = plain.split('\n').filter((l) => l.includes('Tip:'));
    suite.assert(tips.length === 1, `仅第 3 轮末出现一次 tip（实际 ${tips.length} 条）`);
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
    const multi = formatApprovalPrompt({ tool: 'write_file', summary: 'x', reason: '统计行\n  1 - 旧\n  1 + 新' }).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    suite.assert(
      multi.split('\n').filter((l) => l.includes('旧') || l.includes('新') || l.includes('统计')).every((l) => l.startsWith('  ')),
      '多行 reason 逐行缩进（diff 正文不对齐到 0 列）'
    );
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

  suite.test('diff 预览：hunk 折叠 + 上限截断（codex patch cell）', () => {
    const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    // 小改动：变更行 + 上下 ctx 全留，无折叠
    const small = diffPreviewBody({ diff: { original: 'a\nb\nc\n', content: 'a\nB\nc\nd\n' } }, 80);
    const smallPlain = strip(small.body.join('\n'));
    suite.assert(small.truncated === false, '小 diff 不截断');
    suite.assert(smallPlain.includes('2 -  b') && smallPlain.includes('2 +  B'), '删/增行同屏（行号 + 符号）');
    suite.assert(smallPlain.includes('1') && smallPlain.includes('c'), 'ctx 行保留');
    // 大段未改 ctx 折叠为 …（头尾大段不吃行数）
    const mid = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
    const gap = diffPreviewBody({ diff: { original: `X\n${mid}\nY\n`, content: `X2\n${mid}\nY2\n` } }, 80);
    const gapPlain = strip(gap.body.join('\n'));
    suite.assert(gapPlain.includes('…'), '中间大段 ctx 折叠');
    suite.assert(!gapPlain.includes('l15'), '折叠区内容不展开');
    suite.assert(gapPlain.includes('X2') && gapPlain.includes('Y2'), '两端变更都可见');
    // 超上限截断（30 个新增 independently）
    const big = diffPreviewBody({ diff: { original: '', content: Array.from({ length: 30 }, (_, i) => `n${i}`).join('\n') } }, 80);
    suite.assert(big.truncated === true && big.body.length <= 10, '超长 diff 截断到上限');
    suite.assert(diffPreviewBody(undefined, 80).body.length === 0, '无 diff 数据返回空');
    // 集成：write_file 单元格在统计行后带 diff 正文
    const out = new MiniOutput({ showThinking: false, stream: true });
    const text = renderAt(80, () => {
      out.onToolStep(0, 1, 'write_file', '← Write src/a.ts', { path: 'src/a.ts' }, 1);
      out.onToolResult(true, 10, ['已写入'], { diff: { original: 'a\nb\nc\n', content: 'a\nB\nc\nd\n' } }, 1, 1);
    });
    const plain = strip(text);
    suite.assert(plain.includes('└ +2 −1') && plain.includes('2 -  b') && plain.includes('2 +  B'), '单元格：统计行 + diff 正文同屏');
  });

  suite.test('反斜杠续行：判定/去斜杠（codex 多行 composer 行式版）', () => {
    suite.assert(hasLineContinuation('abc\\\\') === false, '行尾 `\\\\` 转义不算续行');
    suite.assert(hasLineContinuation('abc\\\\'.slice(0, -1)) === true, '行尾单个 `\\` 算续行');
    suite.assert(hasLineContinuation('abc') === false, '普通行不续行');
    suite.assert(hasLineContinuation('') === false, '空行不续行');
    suite.assert(stripLineContinuation('abc\\\\'.slice(0, -1)) === 'abc', '去续行反斜杠');
    suite.assert([stripLineContinuation('第一行\\'), '第二行'].join('\n') === '第一行\n第二行', '去斜杠后累积块以换行拼接');
    suite.assert(joinContinued(['a\\', 'b'], false) === 'a\nb', '普通续行：去标记拼接');
    suite.assert(joinContinued(['!echo a\\', 'b'], true) === '!echo a\\' + '\n' + 'b', 'shell 续行：保留反斜杠交 sh 原生续行');
  });

  suite.test('复制：lastAssistantText 取最近回复 + 剪贴板写入', () => {
    const sys = { role: 'system', content: 'sys' };
    const user = { role: 'user', content: 'hi' };
    suite.assert(lastAssistantText([]) === '', '空历史为空');
    suite.assert(lastAssistantText([sys, user]) === '', '无 assistant 回复为空');
    suite.assert(lastAssistantText([sys, { role: 'assistant', content: '  ' }, user]) === '', '空白回复跳过');
    suite.assert(lastAssistantText([sys, { role: 'assistant', content: 'first' }, user, { role: 'assistant', content: 'second' }]) === 'second', '取最近一条');
    suite.assert(
      lastAssistantText([{ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: '' }, { type: 'text', text: 'b' }] }]) === 'ab',
      '数组 content 拼接纯文本 part'
    );
    // 剪贴板：OSC52 序列纯函数 + 平台工具收到完整文本（假 runner，不碰真剪贴板；
    // 测试环境非 TTY，OSC52 不直写 stdout，只验序列形状）
    suite.assert(osc52Sequence('hi').startsWith('\x1b]52;c;') && osc52Sequence('hi').endsWith('\x07'), 'OSC52 序列形状');
    const calls: Array<{ cmd: string; args: string[]; input: string }> = [];
    copyTextToClipboard('hello-clip', (cmd, args, input) => {
      calls.push({ cmd, args, input });
    });
    suite.assert(calls.length >= 1 && calls.every((c) => c.input === 'hello-clip'), '平台工具收到完整文本');
  });

  suite.test('图片提及：扩展名判定 + 附件收集（codex composer 图片）', async () => {
    suite.assert(isImagePath('a.png') && isImagePath('dir/b.JPG') && isImagePath('c.webp'), '图片扩展名');
    suite.assert(!isImagePath('a.ts') && !isImagePath('a.md') && !isImagePath('noext') && !isImagePath('a.svg'), '非图片/无扩展/svg 不是');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-img-'));
    try {
      fs.writeFileSync(path.join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
      fs.writeFileSync(path.join(dir, 'note.md'), '# hi');
      const at = await collectImageAttachments('看看 @shot.png 和 @note.md，还有 user@example.com', dir);
      suite.assert(at.length === 1 && at[0]!.path === 'shot.png', '只收图片：md 与邮箱排除');
      suite.assert(at[0]!.dataUrl.startsWith('data:image/png;base64,'), 'data URL 形状');
      const dup = await collectImageAttachments('@shot.png @shot.png', dir);
      suite.assert(dup.length === 1, '重复提及去重');
      const miss = await collectImageAttachments('@ghost.png', dir);
      suite.assert(miss.length === 0, '缺失文件跳过');
      const capped = await collectImageAttachments('@shot.png', dir, 0);
      suite.assert(capped.length === 0, '数量上限生效');
      const tiny = await collectImageAttachments('@shot.png', dir, 4, 2);
      suite.assert(tiny.length === 0, '大小上限生效');
      const plain = userMessageWithImages('hi', []);
      suite.assert(plain.role === 'user' && plain.content === 'hi', '无图保持纯文本');
      const rich = userMessageWithImages('看图', at);
      suite.assert(Array.isArray(rich.content) && rich.content.length === 2, '有图组装 parts');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  suite.test('全局 --cd：工作根覆盖解析（codex exec --cd）', () => {
    suite.assert(parseArgs(['mini', 'task']).flags.cd === null, '缺省为 null');
    suite.assert(parseArgs(['mini', '--cd', '/tmp/x', 'task']).flags.cd === '/tmp/x', '--cd 空格形态');
    suite.assert(parseArgs(['--cd=/tmp/y', 'mini', 'task']).flags.cd === '/tmp/y', '--cd= 等号形态');
    const r = parseArgs(['mini', '--cd', '/tmp/x', 'task']);
    suite.assert(r.taskArgs.join(' ') === 'mini task', '--cd 不污染任务参数');
  });

  suite.test('mini 单次 flags：-o 落盘最终回答（codex --output-last-message）', () => {
    const r1 = splitMiniOneShotFlags(['验证', 'mini', '模式']);
    suite.assert(r1.task === '验证 mini 模式' && r1.outputLastMessage === null, '纯任务原样');
    const r2 = splitMiniOneShotFlags(['验证', '-o', '/tmp/x.md']);
    suite.assert(r2.task === '验证' && r2.outputLastMessage === '/tmp/x.md', '-o 短 flag');
    const r3 = splitMiniOneShotFlags(['--output-last-message=/tmp/y.md', '验证']);
    suite.assert(r3.task === '验证' && r3.outputLastMessage === '/tmp/y.md', '--flag=value 形态');
    const r4 = splitMiniOneShotFlags(['验证', '-o']);
    suite.assert(r4.task === '验证' && r4.outputLastMessage === null, '缺值忽略不吞词');
    const r5 = splitMiniOneShotFlags(['验证', '--approve-for-me']);
    suite.assert(r5.task === '验证' && r5.approveForMe === true, '--approve-for-me 剥离并置位');
    suite.assert(splitMiniOneShotFlags(['a']).approveForMe === false, '缺省关闭');
  });

  suite.test('/delete：会话文件删除（目录内才删/外部拒绝/缺失报错）', async () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-del-'));
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const dir = sessionsDir();
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, '2026-09-27T00-00-00-testproj.jsonl');
      fs.writeFileSync(f, '{}\n');
      const r = await deleteSessionFile(f);
      suite.assert(r.ok === true, '目录内会话文件可删');
      suite.assert(!fs.existsSync(f), '文件确实被删除');
      const miss = await deleteSessionFile(path.join(dir, 'no-such.jsonl'));
      suite.assert(miss.ok === false, '缺失文件返回失败');
      const outside = path.join(xdg, 'outside.jsonl');
      fs.writeFileSync(outside, 'x');
      const rej = await deleteSessionFile(outside);
      suite.assert(rej.ok === false && fs.existsSync(outside), '目录外文件拒绝且保留');
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
      fs.rmSync(xdg, { recursive: true, force: true });
    }
  });

  suite.test('/model 面板行文案：字段全拼/缺字段跳过/思考级别（codex 模型面板）', () => {
    suite.assert(
      formatModelPickLabel({ name: 'm', displayName: 'M', provider: 'p', limit: { context: 256000, output: 16000 }, reasoningEffort: 'xhigh' }, true) ===
        'M · p · 256K/16K · xhigh · ✓',
      '全字段版式'
    );
    suite.assert(formatModelPickLabel({ name: 'm' }, false) === 'm', '裸模型只剩名称');
    suite.assert(formatModelPickLabel({ name: 'm', reasoningEffort: 'medium' }, false) === 'm · medium', '思考级别段');
    suite.assert(formatModelPickLabel({ name: 'm', limit: { context: 500 } }, false) === 'm · 500', '小数字不加 K');
  });

  suite.test('正文单元格复用：end 后再写另起 `• `（/review /btw 直调）', () => {
    const out = new MiniOutput({ showThinking: false, stream: true });
    const text = renderAt(80, () => {
      out.onAnswer('第一段\n');
      out.onAnswerEnd();
      out.onAnswer('第二段\n');
      out.onAnswerEnd();
    });
    const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const bullets = plain.split('\n').filter((l) => l.startsWith('• '));
    suite.assert(bullets.length === 2, `两段各起一个 • 单元格（实际 ${bullets.length} 个）`);
    suite.assert(bullets[1]!.includes('第二段'), '第二段挂在第二个 • 下');
  });

  suite.test('粘贴突发跟踪：多行粘贴计数 + 取走清零', () => {
    const tr = new PasteBurstTracker();
    tr.key('a');
    tr.key('enter');
    suite.assert(tr.takePending() === 0, '非突发内换行不计数');
    tr.key('paste-start');
    tr.key('p');
    tr.key('enter');
    tr.key('q');
    tr.key('paste-end');
    suite.assert(tr.takePending() === 2, '1 个换行 = 2 次提交');
    suite.assert(tr.takePending() === 0, '取走后清零');
    tr.key('paste-start');
    tr.key('paste-end');
    suite.assert(tr.takePending() === 0, '单行粘贴不提示');
    const tr2 = new PasteBurstTracker();
    tr2.key('paste-start');
    tr2.key('enter');
    tr2.key('enter');
    tr2.key('paste-end');
    suite.assert(tr2.takePending() === 3, '多换行累加');
  });

  suite.test('提问回答解析：空取消/序号/越界回落/自定义/去重', () => {
    const opts = ['红', '绿', '蓝'];
    suite.assert(parseAskAnswer('', opts) === null, '空输入取消');
    suite.assert(parseAskAnswer('   ', opts) === null, '空白取消');
    const one = parseAskAnswer('2', opts)!;
    suite.assert(one.choice === '绿' && one.custom === false && one.choices!.length === 1, '单选序号');
    const multi = parseAskAnswer('1,3', opts)!;
    suite.assert(multi.choice === '红、蓝' && multi.choices!.length === 2, '多选逗号分隔');
    const dup = parseAskAnswer('2, 2, 1', opts)!;
    suite.assert(dup.choices!.join('') === '绿红', '去重保序');
    const oob = parseAskAnswer('9', opts)!;
    suite.assert(oob.custom === true && oob.choice === '9', '越界整体回落自定义');
    const custom = parseAskAnswer('换个方案吧', opts)!;
    suite.assert(custom.custom === true && custom.choices![0] === '换个方案吧', '自由文本自定义');
  });

  suite.test('审批 diff 文本：统计+有界正文（各端 reason 共用）', () => {
    suite.assert(approvalDiffText('a\nb\n', 'a\nb\n') === null, '无变更返回 null');
    suite.assert(approvalDiffText('', 'x\n') !== null, '空到有算变更');
    const mod = approvalDiffText('a\nb\nc\n', 'a\nB\nc\nd\n')!;
    suite.assert(mod.includes('变更统计'), '首行统计');
    suite.assert(mod.includes('+') && mod.includes('B'), '增行在正文');
    suite.assert(mod.split('\n').length <= 14, '统计行 + 正文上限内');
    const fresh = approvalDiffText(null, 'l1\nl2\n')!;
    suite.assert(fresh.startsWith('新增文件'), '新建文件头');
    const big = approvalDiffText(null, Array.from({ length: 40 }, (_, i) => `r${i}`).join('\n'))!;
    suite.assert(big.includes('仅显示前 12 行'), '超限截断注记');
    suite.assert(approvalDiffText(null, '\n') === null, '空内容返回 null');
  });

  suite.test('逐行挂前缀：单行/多行/空（审批 reason 对齐共用）', () => {
    suite.assert(prefixLines('a', '  ') === '  a', '单行');
    suite.assert(prefixLines('a\nb\n', '  ') === '  a\n  b\n  ', '多行逐行（含尾空行）');
    suite.assert(prefixLines('', '--') === '--', '空文本仍挂前缀');
  });

  suite.test('单行 ? 快捷键帮助（codex ? 覆盖层行式版）', () => {
    suite.assert(isShortcutsHelpRequest('?') === true, '单问号是帮助');
    suite.assert(isShortcutsHelpRequest('  ?  ') === true, '首尾空格容忍');
    suite.assert(isShortcutsHelpRequest('真的吗?') === false, '问句不是帮助');
    suite.assert(isShortcutsHelpRequest('??') === false, '双问号不是帮助');
    suite.assert(isShortcutsHelpRequest('') === false, '空行不是帮助');
    const rows = formatShortcutsHelp();
    suite.assert(rows.length >= 5 && rows.some((l) => l.includes('Ctrl+R')), '覆盖主要按键');
    suite.assert(rows.some((l) => l.includes('\\ 续行')), '续行反斜杠字面正确（非转义吞字）');
  });

  suite.test('omni completion：脚本内容 + 真解释器语法校验', () => {
    const bash = completionScript('bash');
    const zsh = completionScript('zsh');
    suite.assert(typeof bash === 'string' && bash.includes('mini') && bash.includes('--approve-for-me'), 'bash 含子命令与 mini flags');
    suite.assert(typeof zsh === 'string' && zsh.includes('#compdef omni') && zsh.includes('mini'), 'zsh 含 compdef 与 mini');
    suite.assert(completionScript('fish') === null, '不支持的 shell 返回 null');
    suite.assert(completionScript('BASH') !== null, '大小写不敏感');
    // 真解释器校验（bash -n / zsh -n；以 tmp 文件为载体）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-comp-'));
    try {
      const bf = path.join(dir, 'c.bash');
      const zf = path.join(dir, 'c.zsh');
      fs.writeFileSync(bf, bash!);
      fs.writeFileSync(zf, zsh!);
      suite.assert(spawnSyncCheck('bash', ['-n', bf]).status === 0, 'bash -n 通过');
      suite.assert(spawnSyncCheck('zsh', ['-n', zf]).status === 0, 'zsh -n 通过');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    suite.assert(runCompletionCommand(['powershell']) === 1, '非法 shell 非零退出');
  });

  suite.test('输入区 hint 含续行反斜杠（TS 未知转义会吞 `\\`，回归锁定）', () => {
    const out = new MiniOutput({ showThinking: false, stream: true });
    const text = renderAt(80, () => {
      out.markInteractive();
    });
    const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    suite.assert(plain.includes('\\ 续行'), 'hint 显示 `\\ 续行`（单反斜杠，非双空格）');
  });

  suite.test('自动压缩可见反馈：compactedSince 取新增移除数', () => {
    const ev = (k: string, removed = 0): TrajEvent =>
      ({ s: 1, time: 0, turn: 1, k, removed }) as unknown as TrajEvent;
    suite.assert(compactedSince([], 0) === 0, '空账本为 0');
    const events = [ev('turn/start'), ev('user/message'), ev('compact', 12), ev('tool/call')];
    suite.assert(compactedSince(events, 0) === 12, '累计新增 compact 移除数');
    suite.assert(compactedSince(events, 3) === 0, 'since 之后无新增为 0');
    suite.assert(compactedSince(events, 99) === 0, 'since 越界为 0');
    suite.assert(compactedSince([ev('compact', 5), ev('compact', 7)], 0) === 12, '多 compact 累加');
  });

  suite.test('历史搜索条目：去空去重保序 + 上限（codex history-search）', () => {
    suite.assert(historySearchItems([], 50).length === 0, '空历史无条目');
    const items = historySearchItems(['  git status  ', '', 'git status', 'npm test'], 50);
    suite.assert(items.length === 2, '去空去重');
    suite.assert(items[0]!.label === 'git status' && items[0]!.value === '  git status  ', 'label 去空格、value 保原文');
    suite.assert(items[1]!.label === 'npm test', '保序');
    const many = Array.from({ length: 60 }, (_, i) => `cmd${i}`);
    suite.assert(historySearchItems(many, 50).length === 50, '上限 50 条');
  });

  suite.test('picker 确认键：return 与 enter 都确认（0x0A 回归）', () => {
    suite.assert(isPickerConfirmKey('return') === true, 'Enter 键确认');
    suite.assert(isPickerConfirmKey('enter') === true, '换行（Ctrl+J/粘贴）同样确认');
    suite.assert(isPickerConfirmKey('escape') === false, 'Esc 不是确认');
    suite.assert(isPickerConfirmKey('up') === false, '方向键不是确认');
  });

  suite.test('模式提示符：bang > plan > normal（codex footer 模式指示）', () => {
    const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    suite.assert(strip(formatModePrompt('normal', '› ')) === '› ', 'normal 原样返回基础提示符');
    suite.assert(strip(formatModePrompt('bang', '› ')) === '! ', 'bang 显示 `! `（codex bash mode）');
    suite.assert(strip(formatModePrompt('plan', '› ')) === 'plan › ', 'plan 显示品红 `plan` 前缀');
    suite.assert(strip(formatModePrompt('bang', 'plan › ')) === '! ', 'bang 优先于 plan');
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
      const lastMsgFile = path.join(xdg, 'last-message.md');
      const { code, out } = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn('npx', ['tsx', 'src/index.ts', 'mini', '验证 mini 模式', '-o', lastMsgFile], {
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
      suite.assert(plain.includes('>_ Omni (v'), 'banner 标题行');
      suite.assert(!plain.includes('╭'), '新会话 compact 头（无框，codex greeting 置位）');
      suite.assert(!plain.includes('model:'), 'compact 无模型行');
      suite.assert(plain.includes('permissions: YOLO mode'), 'YOLO 行保留');
      suite.assert(out.includes('› 验证 mini 模式'), '用户输入回显（› 前缀）');
      suite.assert(out.includes('• Ran echo mock-ok'), '工具调用项目符号行');
      suite.assert(out.includes('• 任务完成'), '正文用 • 前缀');
      suite.assert(out.includes('└ mock-ok'), '工具输出预览');
      suite.assert(out.includes('mock 端到端验证通过'), '模型最终回答');
      suite.assert(/\d\d:\d\d/.test(out), '回合分隔行带本地时间');
      suite.assert(!out.includes('退出码: 0'), '不显示退出码 0');
      suite.assert(fs.existsSync(lastMsgFile) && fs.readFileSync(lastMsgFile, 'utf8').includes('mock 端到端验证通过'), '-o 落盘最终回答');
      // --approve-for-me：只剥离进开关，不污染任务文本（回显无残留）+ 整轮完成
      const afile = path.join(xdg, 'afm.md');
      const arun = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const c2 = spawn('npx', ['tsx', 'src/index.ts', 'mini', '验证自动审批', '--approve-for-me', '-o', afile], {
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
        let acc2 = '';
        c2.stdout.on('data', (d) => (acc2 += d));
        c2.stderr.on('data', (d) => (acc2 += d));
        const t2 = setTimeout(() => c2.kill('SIGKILL'), 60_000);
        c2.on('close', (cc) => {
          clearTimeout(t2);
          resolve({ code: cc, out: acc2 });
        });
      });
      suite.assert(arun.code === 0, `--approve-for-me 退出码 0（实际 ${arun.code}）`);
      suite.assert(arun.out.includes('› 验证自动审批') && !arun.out.includes('--approve-for-me'), 'flag 剥离（回显无残留）');
      suite.assert(arun.out.includes('mock 端到端验证通过'), '--approve-for-me 下整轮完成');
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：mini 单次 stdin 两形态（codex exec 对等）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-stdin-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 4;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 空工作目录：避免项目 AGENTS.md 记忆挤掉 OMNI_DEBUG 6000 字符切片里的用户消息。
    // 注意 spawn cwd 保持 ROOT（npx 就近解析 tsx），工作根切换走 --cd（顺带覆盖组合）。
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-stdin-work-'));
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [work] }));
    const run = (args: string[], stdinText: string | null): Promise<{ code: number | null; out: string }> =>
      new Promise((resolve) => {
        const child = spawn('npx', ['tsx', 'src/index.ts', ...args], {
          cwd: ROOT,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: xdg,
            OMNI_BASE_URL: `http://127.0.0.1:${port}/v1`,
            OMNI_API_KEY: 'sk-mock',
            OMNI_MODEL: 'mock-model',
            OMNI_PERMISSION: 'full',
            OMNI_SHOW_THINKING: '0',
            OMNI_DEBUG: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let acc = '';
        child.stdout.on('data', (d) => (acc += d));
        child.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
        if (stdinText !== null) child.stdin.write(stdinText);
        child.stdin.end();
      });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      // 形态二：任务非空 + 管道 stdin → 注入 `[stdin 输入]` 上下文（请求体可见）
      const r1 = await run(['mini', '--cd', work, '验证stdin注入'], '管道上下文甲');
      suite.assert(r1.code === 0, `注入形态退出码 0（实际 ${r1.code}）`);
      suite.assert(r1.out.includes('[stdin 输入]') && r1.out.includes('管道上下文甲'), 'stdin 作为上下文块进请求');
      // 形态一：任务为 `-` → 整段 stdin 即 prompt（用户回显原文）
      const r2 = await run(['mini', '--cd', work, '-'], '整段任务乙');
      suite.assert(r2.code === 0, `破折号形态退出码 0（实际 ${r2.code}）`);
      suite.assert(r2.out.includes('› 整段任务乙'), 'stdin 全文回显为用户消息');
      suite.assert(r2.out.includes('mock 端到端验证通过'), '破折号形态整轮完成');
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：mini --cd <目录> 切换工作根（codex exec --cd）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-cd-'));
    // 固定短目录名：banner 窄终端居中截断会吃掉中间，随机后缀断言不可靠
    const work = path.join(os.tmpdir(), 'ft-cd-probe');
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [work] }));
    const port = MOCK_PORT + 2;
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
      const { code, out } = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn('npx', ['tsx', 'src/index.ts', 'mini', '--cd', work, '验证工作根'], {
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
      const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      suite.assert(code === 0, `进程退出码 0（实际 ${code}）`);
      suite.assert(plain.includes('ft-cd-probe'), 'banner directory 为 --cd 目标');
      suite.assert(out.includes('mock 端到端验证通过'), '--cd 下任务正常执行');
    } finally {
      mock.kill();
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  suite.test('端到端：omni mini 交互模式（输入 → 回合 → /pwd → /quit）', async () => {
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
      child.stdin.write('!echo contA\\\n');
      await sleep(500);
      child.stdin.write('contB\n');
      await waitFor(async () => out.includes('contAcontB'), 15000, 'shell 原生续行');
      child.stdin.write('续行甲\\\n');
      await sleep(500);
      child.stdin.write('续行乙\n');
      await waitFor(async () => out.includes('› 续行甲') && out.includes('  续行乙'), 30000, '续行回显');
      child.stdin.write('/pwd\n');
      await waitFor(async () => out.includes(ROOT), 15000, '/pwd 回显工作目录');
      child.stdin.write('/delete\n');
      await waitFor(async () => out.includes('不能删除当前会话'), 15000, '/delete 拒绝删当前会话');
      child.stdin.write('/delete no-such-xyz\n');
      await waitFor(async () => out.includes('不存在'), 15000, '/delete 无会话报错');
      child.stdin.write('/quit\n');
      const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
      suite.assert(out.includes('>_ Omni (v'), '交互模式同样打印信息框');
      suite.assert(out.includes('›'), '使用 mini 提示符 ›（替代 omni> ）');
      suite.assert(!out.includes('输入任务开始；'), '不打印内置开场提示（由 Tip 行接管）');
      suite.assert(out.includes('› 验证 mini 交互'), '用户输入回显（› 前缀）');
      suite.assert(out.includes('• Ran echo mock-ok'), '工具调用项目符号行');
      suite.assert(/\d\d:\d\d/.test(out), '回合分隔行带本地时间（codex separators.rs）');
      suite.assert(out.includes('└ ledger-bang'), '`!` 输出进 `└ ` 单元格');
      suite.assert(out.includes('└ contAcontB'), 'bang 续行反斜杠保留（sh 原生续行）');
      suite.assert(!out.includes('› 续行乙'), '续行不产生第二次 › 提交（单条消息）');
      suite.assert(out.includes(ROOT), '/pwd 输出工作目录');
      suite.assert(out.includes('不能删除当前会话'), '/delete 当前会话保护');
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

  suite.test('端到端：恢复会话同样 compact 头（codex 全会话 borderless）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-resume-'));
    const dir = path.join(xdg, 'omni', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    // 预置一个带内容的会话（project=ROOT），-c 恢复它；不输入直接杀进程，只看启动 banner
    const seed = path.join(dir, '20260927000000-testresume.jsonl');
    fs.writeFileSync(
      seed,
      JSON.stringify({ t: 'meta', id: '20260927000000-testresume', project: ROOT, model: 'mock-model', created: 1, updated: 2 }) + '\n' +
        JSON.stringify({ t: 'm', m: { role: 'user', content: 'seed' } }) + '\n'
    );
    const child = spawn('npx', ['tsx', 'src/index.ts', 'mini', '-c'], {
      cwd: ROOT,
      env: { ...process.env, XDG_CONFIG_HOME: xdg, OMNI_API_KEY: 'sk-mock', OMNI_PERMISSION: 'full' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    try {
      await waitFor(async () => out.includes('>_ Omni (v'), 20000, '恢复会话 banner');
      const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      suite.assert(!plain.includes('╭'), '恢复会话同样无框（borderless 全会话统一）');
      suite.assert(!plain.includes('model:'), '恢复会话同样无模型行');
      suite.assert(plain.includes('>_ Omni (v'), '恢复会话保留标题行');
      suite.assert(plain.includes('已恢复会话'), '提示恢复的会话');
    } finally {
      child.kill('SIGKILL');
    }
  });

  suite.test('端到端：/review 进正文单元格（`• ` + Markdown，非裸打）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-review-'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-review-work-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [work] }));
    // hermetic git 仓库：一次提交 + 一处未提交改动（collectDiff 有料；不依赖外层仓库脏净）
    const sh = (args: string[]): void => {
      const r = spawnSync('git', args, { cwd: work });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败`);
    };
    fs.writeFileSync(path.join(work, 'a.txt'), 'v1\n');
    sh(['init', '-q']);
    sh(['config', 'user.email', 't@t.t']);
    sh(['config', 'user.name', 't']);
    sh(['add', '.']);
    sh(['commit', '-qm', 'init']);
    fs.writeFileSync(path.join(work, 'a.txt'), 'v2\n');
    const port = MOCK_PORT + 5;
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
      const child = spawn('npx', ['tsx', path.join(ROOT, 'src/index.ts'), 'mini'], {
        cwd: work,
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
      await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
      child.stdin.write('/review\n');
      await waitFor(async () => out.includes('审查结果'), 60000, '/review 完成');
      child.stdin.write('/exit\n');
      await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL'))]);
      const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      suite.assert(plain.split('\n').some((l) => l.startsWith('• ')), '审查意见进 `• ` 正文单元格（非裸打）');
      suite.assert(plain.includes('typecheck 通过'), 'mock 审查意见正文落盘进单元格');
      // 注：管道下 markdown 缺省不渲染（原文可 grep，见 MiniOutputOptions.markdown），渲染由单测覆盖
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：EOF（Ctrl+D）同样收尾，不留空会话占位', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-eof-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 3;
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
      const code = await new Promise<number | null>((resolve) => {
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
        child.stdout.resume();
        child.stderr.resume();
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve(c);
        });
        // 不输入任何命令直接 EOF（Ctrl+D）：启动时建的空会话占位应被清理
        child.stdin.end();
      });
      suite.assert(code === 0, `EOF 干净退出（实际 ${code}）`);
      let leftovers: string[] = [];
      try {
        leftovers = fs.readdirSync(path.join(xdg, 'omni', 'sessions')).filter((f) => f.endsWith('.jsonl'));
      } catch { /* 会话目录不存在 = 更干净 */ }
      suite.assert(leftovers.length === 0, `空会话占位已清理（残留 ${leftovers.length} 个）`);
    } finally {
      mock.kill();
    }
  });

  return suite;
}
