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
  shouldShowWorkingTip,
  renderWorkingTip,
  WORKING_TIP_AFTER_SECS,
  workingLines,
  formatApprovalPrompt,
  parseApprovalAnswer,
  fmtElapsed,
  fmtLapDuration,
  foldRows,
  renderMiniBanner,
  renderTurnSeparator,
  renderWorkingLine,
  toolDetail,
  verbForTool,
} from '../../src/output/mini.js';
import { MiniMarkdownRenderer, chunksToAnsi } from '../../src/output/markdown-ansi.js';
import { parseMarkdownLine } from '../../src/tui/markdown.js';
import { normalizeScopes, buildAuthorizeUrl, parseCallbackParams } from '../../src/tools/mcp-oauth.js';
import { completeMention, MINI_SLASH_COMMANDS } from '../../src/cli/picker.js';
import { applyMentionInsert } from '../../src/cli/picker.js';
import { fuzzySlashMatch } from '../../src/cli/picker.js';
import { completeMiniLine } from '../../src/cli/picker.js';
import { commonPrefix } from '../../src/cli/picker.js';
import { loadInputHistory, saveInputHistory } from '../../src/cli/history.js';
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

import { lastAssistantText, lastUserText, sumSessionUsage } from '../../src/agent/report.js';
import { composeInEditor, flattenComposedText, resolveEditorCommand } from '../../src/cli/external-editor.js';
import { pushWarning, sessionWarnings } from '../../src/agent/warnings.js';
import { deleteSessionFile, sessionsDir } from '../../src/agent/session.js';
import { compactedSince } from '../../src/agent/events.js';
import { splitMiniOneShotFlags } from '../../src/cli/mini.js';
import { importFromClaudeCode } from '../../src/cli/import-claude.js';
import { runPluginCommand } from '../../src/cli/plugin.js';
import { recapConversation } from '../../src/agent/context.js';
import type OpenAI from 'openai';
import { isStopCommand } from '../../src/cli/interactive.js';
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
    // YOLO 判定（codex has_yolo_permissions：full + 沙箱近乎关闭；沙箱收紧即非 YOLO）
    const sandboxed = renderMiniBanner({ directory: '/tmp', permission: 'full', sandbox: 'read-only' }, 80, 'hi').join('\n');
    suite.assert(!sandboxed.includes('YOLO mode'), 'full + 沙箱收紧不显示 YOLO');
    const danger = renderMiniBanner({ directory: '/tmp', permission: 'full', sandbox: 'danger-full-access' }, 80, 'hi').join('\n');
    suite.assert(danger.includes('YOLO mode'), 'full + 无 OS 沙箱保持 YOLO');
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

  suite.test('working 中 tip（codex ca41ed3：30s 后状态行下方一条，同轮跳过 completion）', () => {
    suite.assert(WORKING_TIP_AFTER_SECS === 30, '阈值 30s（codex 同值）');
    suite.assert(shouldShowWorkingTip(29, false) === false, '29s 不出');
    suite.assert(shouldShowWorkingTip(30, false) === true, '30s 首现');
    suite.assert(shouldShowWorkingTip(120, false) === true, '超时持续可出');
    suite.assert(shouldShowWorkingTip(30, true) === false, '同轮只出一条');
    suite.assert(shouldShowWorkingTip(120, true) === false, '出过不再出');
    const line = renderWorkingTip('用 /model 切换模型。');
    suite.assert(line.includes('Tip: 用 /model 切换模型。'), '行文案 `Tip: ` 前缀');
  });
  suite.test('working live 块组装：状态行 / 出 tip 附第二行（LiveBlock 伸缩）', () => {
    const one = workingLines('W', null);
    suite.assert(one.length === 1 && one[0] === 'W', '未出 tip 单行');
    const two = workingLines('W', '用 /model 切换模型。');
    suite.assert(two.length === 2 && two[0] === 'W' && two[1]!.includes('Tip: 用 /model 切换模型。'), '出 tip 附第二行同文案');
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
    const r6 = splitMiniOneShotFlags(['-i', 'a.png', '验证', '--image=b.png']);
    suite.assert(r6.task === '验证' && r6.images.join(',') === 'a.png,b.png', '-i 可重复 + --image= 剥离');
    suite.assert(splitMiniOneShotFlags(['验证']).images.length === 0, '缺省无图片');
  });

  suite.test('/stop 精确匹配（codex /stop：轮内拦截与空闲提示共用）', () => {
    suite.assert(isStopCommand('/stop') === true, '精确命中');
    suite.assert(isStopCommand('  /stop  ') === true, '首尾空白容忍');
    suite.assert(isStopCommand('/stop xxx') === false, '带参不认（普通消息）');
    suite.assert(isStopCommand('/stop1') === false, '前缀不误判');
    suite.assert(isStopCommand('') === false, '空行不认');
    suite.assert(MINI_SLASH_COMMANDS.includes('/stop'), '补全表含 /stop');
    suite.assert(MINI_SLASH_COMMANDS.includes('/exit'), '补全表含 /exit（与 /quit 同为退出入口）');
    suite.assert(fuzzySlashMatch('ex').includes('/exit'), '/ex 模糊命中 /exit');
    suite.assert(formatShortcutsHelp().join('\n').includes('/stop'), '? 帮助提及 /stop');
  });

  suite.test('/import 从 Claude Code 迁移（codex Import slash，纯函数）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-import-'));
    try {
      // 空目录：全部跳过
      const r0 = importFromClaudeCode(dir);
      suite.assert(r0.done.length === 0 && r0.skipped.length > 0, '空目录全跳过');
      // CLAUDE.md → AGENTS.md（不存在才写）
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# rules');
      const r1 = importFromClaudeCode(dir);
      suite.assert(r1.done.some((d) => d.includes('CLAUDE.md')), 'CLAUDE.md 迁移');
      suite.assert(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8') === '# rules', '内容原样复制');
      // 已有 AGENTS.md 不覆盖
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# mine');
      const r2 = importFromClaudeCode(dir);
      suite.assert(r2.done.length === 0 && r2.skipped.some((x) => x.includes('已存在')), 'AGENTS.md 已存在不覆盖');
      // skills 目录复制
      fs.mkdirSync(path.join(dir, '.claude', 'skills', 's1'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'skills', 's1', 'SKILL.md'), '# s1');
      const r3 = importFromClaudeCode(dir);
      suite.assert(r3.done.some((d) => d.includes('s1')), 'skills 目录复制');
      suite.assert(fs.existsSync(path.join(dir, '.agents', 'skills', 's1', 'SKILL.md')), '技能落到 .agents');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  suite.test('/recap 按需会话摘要（codex Recap：只读，不改历史）', async () => {
    const stub = {
      chat: {
        completions: {
          create: async () => {
            async function* gen() {
              yield { choices: [{ delta: { content: '摘要正文' } }] };
            }
            return gen();
          },
        },
      },
    } as unknown as OpenAI;
    const r0 = await recapConversation(stub, 'm', []);
    suite.assert(r0 === null, '空历史返回 null');
    const r1 = await recapConversation(stub, 'm', [
      { role: 'system', content: '脚手架' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    suite.assert(r1 === '摘要正文', '有对话走独立 LLM 调用');
    const before = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ] as { role: 'user' | 'assistant'; content: string }[];
    await recapConversation(stub, 'm', before);
    suite.assert(before.length === 2, '只读：不修改消息数组');
    suite.assert(MINI_SLASH_COMMANDS.includes('/recap'), '补全表含 /recap');
  });

  suite.test('/plugin 透传顶层实现（codex Plugins：空目录 list 只读）', async () => {
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-plugin-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    try {
      const code = await runPluginCommand(['list']);
      suite.assert(code === 0, '空插件目录 list 退出码 0');
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  suite.test('/plugin install 本地目录往返（manifest 校验 + 启用 + 删除）', async () => {
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-plugin-ins-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-plugin-src-'));
    try {
      fs.writeFileSync(path.join(src, 'plugin.json'), JSON.stringify({ name: 'ft-demo', version: '0.0.1', description: 'fixture' }));
      suite.assert((await runPluginCommand(['install', src, '--yes'])) === 0, '本地目录 install 成功');
      suite.assert(fs.existsSync(path.join(tmpXdg, 'omni', 'plugins', 'ft-demo', 'plugin.json')), '插件目录落盘');
      suite.assert((await runPluginCommand(['install', src, '--yes'])) === 1, '重复安装拒绝（需 --force）');
      suite.assert((await runPluginCommand(['remove', 'ft-demo', '--yes'])) === 0, 'remove 成功');
      suite.assert(!fs.existsSync(path.join(tmpXdg, 'omni', 'plugins', 'ft-demo')), '插件目录已移除');
      suite.assert((await runPluginCommand(['install', '/nonexistent-dir-xyz'])) === 1, '非法源拒绝');
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpXdg, { recursive: true, force: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
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

  suite.test('Ctrl+T 账本落盘格式（先清 live 块再打印，轮内不抢区域）', () => {
    const out = new MiniOutput({ showThinking: false, stream: true });
    const text = renderAt(80, () => {
      out.dumpLedger('  头部', ['  行一', '  行二']);
    });
    const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const idxH = plain.indexOf('头部');
    const idx1 = plain.indexOf('行一');
    const idx2 = plain.indexOf('行二');
    suite.assert(idxH >= 0 && idx1 > idxH && idx2 > idx1, '头部→行依次落盘');
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
    suite.assert(bash!.includes(' doctor ') && bash!.includes('review) COMPREPLY'), 'bash 含顶层 doctor 与 review 专属补全');
    suite.assert(bash.includes('--ask-for-approval') && bash.includes('--title') && bash.includes('--no-browser'), 'bash 含新增 flags（-a/review --title/mcp 登录旗）');
    suite.assert(typeof zsh === 'string' && zsh.includes('#compdef omni') && zsh.includes('mini'), 'zsh 含 compdef 与 mini');
    const fish = completionScript('fish');
    const ps = completionScript('powershell');
    // 真机 fish 校验（若本机有 fish）：语法 + 子命令/flag 功能补全；缺解释器则跳过
    const fishBin = spawnSyncCheck('which', ['fish']);
    if (fishBin.status === 0) {
      const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-comp-fish-'));
      try {
        const ff = path.join(fdir, 'omni.fish');
        fs.writeFileSync(ff, fish!);
        suite.assert(spawnSyncCheck('fish', ['-n', ff]).status === 0, 'fish -n 语法通过');
        const sub = spawnSyncCheck('fish', ['-c', `source ${ff}; complete -C'omni '`]);
        const subOut = String(sub.stdout ?? '');
        suite.assert(subOut.includes('exec') && subOut.includes('doctor'), 'fish 子命令补全');
        const eflags = spawnSyncCheck('fish', ['-c', `source ${ff}; complete -C'omni exec --'`]);
        const efOut = String(eflags.stdout ?? '');
        suite.assert(efOut.includes('--ephemeral') && efOut.includes('--json'), 'fish exec flag 补全');
      } finally {
        fs.rmSync(fdir, { recursive: true, force: true });
      }
    }
    suite.assert(typeof fish === 'string' && fish.includes('__fish_seen_subcommand_from exec'), 'fish 含子命令条件补全');
    suite.assert(fish!.includes('--ephemeral') && fish!.split('\n').every((l) => !l.includes('\\')), 'fish 行无杂散转义');
    suite.assert(typeof ps === 'string' && ps.includes('Register-ArgumentCompleter') && ps.includes('-Native'), 'ps 原生补全注册');
    suite.assert(ps!.includes('ParameterName') && ps!.includes('StartsWith'), 'ps flag/子命令结果类型区分（codex 同款 ParameterName）');
    suite.assert(ps!.includes('@("exec","review"') && ps!.includes("'--ephemeral'") === false, 'ps 候选表 JSON 双引号');
    suite.assert(ps!.includes("'\\s+'"), 'ps 分词正则未被转义吃掉');
    suite.assert(completionScript('elvish') === null, 'elvish 暂不支持返回 null');
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
    suite.assert(runCompletionCommand(['elvish']) === 1, '不支持的 shell 非零退出');
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
    suite.assert(text.includes('Local tools: 1 call ('), '轮末分隔行带工具统计（lap/结果累积）');
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
    suite.assert(fmtElapsed(65_000) === '1m 5s', '耗时不补零（codex separators.rs：2m 5s 形态）');
    suite.assert(fmtElapsed(3_661_000) === '1h 1m 1s', '小时形态同样不补零');
    suite.assert(fmtLapDuration(300) === '300ms' && fmtLapDuration(1200) === '1.2s', 'lap 耗时毫秒/秒形态');
    const withStats = renderTurnSeparator(
      5_000, new Date(2026, 8, 24, 22, 30),
      { toolCalls: 2, toolMs: 1200, llmCalls: 1, llmMs: 300 }
    );
    suite.assert(withStats.includes('Local tools: 2 calls (1.2s)') && withStats.includes('Inference: 1 call (300ms)'), '分隔行带统计后缀');
    const noStats = renderTurnSeparator(5_000, new Date(2026, 8, 24, 22, 30), { toolCalls: 0, toolMs: 0, llmCalls: 0, llmMs: 0 });
    suite.assert(!noStats.includes('Local tools') && !noStats.includes('Inference'), '零调用不展示统计段');
    const stripAnsi = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const wideLines = stripAnsi(renderTurnSeparator(5_000, new Date(2026, 8, 24, 22, 30),
      { toolCalls: 12, toolMs: 34500, llmCalls: 8, llmMs: 120300 }, 80)).split('\n');
    suite.assert(wideLines.length === 1 && wideLines.every((l) => visualWidth(l) <= 80), '宽屏统计行单行不超宽');
    const narrow = stripAnsi(renderTurnSeparator(5_000, new Date(2026, 8, 24, 22, 30),
      { toolCalls: 12, toolMs: 34500, llmCalls: 8, llmMs: 120300 }, 40)).split('\n');
    suite.assert(narrow.length >= 2 && narrow.every((l) => visualWidth(l) <= 40), '窄屏按段折行且每行不超宽');
    suite.assert(narrow.every((l) => l.startsWith('  ')), '折行续行同缩进');
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

  suite.test('输入历史跨会话落盘/读回（codex composer history）', () => {
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-hist-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    try {
      const f = path.join(tmpXdg, 'omni', 'input-history.json');
      suite.assert(loadInputHistory().join() === '', '缺失回空');
      saveInputHistory(['b-new', 'a-old']);
      suite.assert(JSON.parse(fs.readFileSync(f, 'utf8')).join() === 'a-old,b-new', '落盘 oldest→newest');
      suite.assert(loadInputHistory().join() === 'a-old,b-new', '读回保序');
      saveInputHistory(['', '  ', 'x']);
      suite.assert(JSON.parse(fs.readFileSync(f, 'utf8')).join() === 'x', '空行不收');
      saveInputHistory(Array.from({ length: 250 }, (_, i) => `l${i}`));
      const capped = JSON.parse(fs.readFileSync(f, 'utf8')) as string[];
      suite.assert(capped.length === 200 && capped[0] === 'l199' && capped[199] === 'l0', '上限 200 保最新（newest-first 输入）');
      fs.writeFileSync(f, 'not-json{');
      suite.assert(loadInputHistory().join() === '', '损坏回空不断交互');
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  suite.test('Esc 取回上一条输入数据源（codex edit-previous）', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'second' },
    ];
    suite.assert(lastUserText(msgs as never) === 'second', '取最近 user 消息');
    suite.assert(lastUserText([{ role: 'assistant', content: 'a' }] as never) === '', '无 user 消息回空');
    suite.assert(lastUserText([]) === '', '空历史回空');
    suite.assert(lastUserText([{ role: 'user', content: '  ' }] as never) === '', '空白消息跳过');
  });

  suite.test('/status 会话累计 token：assistant 落盘 usage 求和（codex token usage）', () => {
    const msgs = [
      { role: 'system', content: '[全局记忆] x' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a', usage: { prompt: 100, completion: 20, total: 120, cached: 30 } },
      { role: 'assistant', content: null, tool_calls: [], usage: { prompt: 50, completion: 5, total: 55 } },
      { role: 'assistant', content: 'b' },
    ];
    const sum = sumSessionUsage(msgs as never);
    suite.assert(sum?.prompt === 150 && sum?.completion === 25 && sum?.total === 175, '多轮调用分别累计');
    suite.assert(sum?.cached === 30, 'cached 累计');
    suite.assert(sumSessionUsage([{ role: 'user', content: 'hi' }] as never) === undefined, '无用量回 undefined（保留暂无文案）');
    suite.assert(sumSessionUsage([]) === undefined, '空消息回 undefined');
  });

  suite.test('/warnings retained 警告：追加/快照/上限（codex /warnings）', () => {
    pushWarning('unittest', 'warn-a-1');
    pushWarning('unittest', 'warn-b-2');
    const tail = sessionWarnings().slice(-2);
    suite.assert(tail[0]?.source === 'unittest' && tail[0]?.message === 'warn-a-1', '追加保序');
    suite.assert(tail[1]?.message === 'warn-b-2', '快照只读含新项');
    pushWarning('unittest', '   ');
    suite.assert(!sessionWarnings().some((w) => w.source === 'unittest' && w.message === ''), '空正文忽略');
    for (let i = 0; i < 55; i++) pushWarning('capfill', `c${i}`);
    const all = sessionWarnings();
    suite.assert(all.length === 50, `上限 50（实际 ${all.length}）`);
    suite.assert(all[all.length - 1]?.message === 'c54', '超限丢最旧、保最新');
  });

  suite.test('外部编辑器组稿：命令解析 + 桩编辑器往返（codex Ctrl+G）', () => {
    suite.assert(resolveEditorCommand({ VISUAL: 'code --wait', EDITOR: 'vi' })?.join('|') === 'code|--wait', 'VISUAL 优先');
    suite.assert(resolveEditorCommand({ EDITOR: '  vim  ' })?.join('|') === 'vim', 'EDITOR 去空白');
    suite.assert(resolveEditorCommand({}) === null, '未配置回 null（调用方提示而非悄悄 vi）');
    // 桩编辑器：node -e 把第二个 argv（tmp 文件）覆写成定稿
    const stub = (body: string): string[] => [process.execPath, '-e', `require('fs').writeFileSync(process.argv[1], ${JSON.stringify(body)})`];
    const r1 = composeInEditor('种子', stub('组稿正文\n\n'));
    suite.assert(r1.ok && (r1 as { text: string }).text === '组稿正文', '桩编辑器往返 + 去尾部空白');
    const r2 = composeInEditor('', stub(''));
    suite.assert(r2.ok && (r2 as { text: string }).text === '', '存空回空（调用方清行）');
    const r3 = composeInEditor('x', ['/nonexistent-editor-xyz']);
    suite.assert(!r3.ok, '坏命令返回失败（不抛异常）');
    suite.assert(flattenComposedText('a\nb\r\nc  ') === 'a b c', '多行压单行（行缓冲见换行即提交）');
    suite.assert(flattenComposedText('   ') === '', '纯空白压空（调用方走清空）');
  });

  suite.test('mini markdown：空列表项保留 marker（codex #48623）', () => {
    const m = new MiniMarkdownRenderer(false);
    const one = (line: string): string => m.pushLine(line, 80).join('\n');
    suite.assert(one('-') === '• ', '裸 - 保留 •');
    suite.assert(one('  -') === '• ', '缩进裸 - 同样保留（与非空嵌套同策略去缩进）');
    suite.assert(one('*') === '• ', '裸 * 保留 •');
    suite.assert(one('8.') === '8. ', '裸 8. 保留序号');
    suite.assert(one('- [ ]') === '☐ ', '空任务项保留 ☐');
    suite.assert(one('- [x]') === '☑ ', '空已办项保留 ☑');
    suite.assert(one('> -') === '• ', '引用内裸 marker 保留 •');
    suite.assert(one('> - x') === '• x', '引用内列表项成 •（非原样透出）');
    suite.assert(one('>   - y') === '• y', '引用内嵌套去缩进与顶层一致');
    suite.assert(one('> 1. y') === '1. y', '引用内有序项解析');
    suite.assert(one('> - [x] done') === '☑ done', '引用内任务项解析');
    suite.assert(one('> foo') === 'foo', '纯文本引用去前缀既定风格不动');
    suite.assert(one('- 项') === '• 项', '非空无序项不受影响');
    suite.assert(one('1. 首') === '1. 首', '非空有序项不受影响');
    suite.assert(one('3.14') === '3.14', '小数不误判空序号');
    suite.assert(one('- [x]foo') !== '☑ foo', '缺空格的任务语法不误判');
  });

  suite.test('/ 联想模糊匹配（codex slash popup：子序列即命中）', () => {
    const hit = fuzzySlashMatch('ac');
    suite.assert(hit.includes('/compact'), '/ac 命中 /compact');
    suite.assert(hit[0] === '/compact' || hit[0] === '/auto', '前缀命中排前');
    suite.assert(fuzzySlashMatch('st')[0] === '/status', '/st 首选 /status');
    suite.assert(fuzzySlashMatch('xyz').length === 0, '无命中回空');
    suite.assert(fuzzySlashMatch('').length === MINI_SLASH_COMMANDS.length, '空串回全表');
    // 未知命令报错附推荐（与面板同算法）
    const guesses = fuzzySlashMatch('staus').slice(0, 3);
    suite.assert(guesses.includes('/status'), 'staus（漏字）推荐 /status');
  });

  suite.test('边界鲁棒性：新纯函数坏输入不抛（fuzz 锁定）', () => {
    suite.assert(normalizeScopes(undefined) === undefined && normalizeScopes(',,,') === undefined, 'scope 空回 undefined');
    let threwUrl = '';
    try { buildAuthorizeUrl('not a url', { clientId: 'c', redirectUri: 'r', challenge: 'h', state: 's' }); }
    catch { threwUrl = 'yes'; }
    suite.assert(threwUrl === 'yes', '非法授权端点抛错');
    suite.assert(parseCallbackParams(new URLSearchParams('code=a&state=s'), 's') === 'a', '回调取码');
    for (const l of ['', '-', '8.', '> -', '- [ ]', '*', '   ', '---', '- [x]', '> foo']) {
      suite.assert(Array.isArray(parseMarkdownLine(l)), `markdown 行可渲染：${JSON.stringify(l)}`);
    }
    suite.assert(sumSessionUsage([{ role: 'assistant', usage: null }] as never) === undefined, 'usage null 回 undefined');
    suite.assert(lastUserText([{ role: 'user', content: null }] as never) === '', 'content null 回空');
    suite.assert(resolveEditorCommand({}) === null && resolveEditorCommand({ EDITOR: '   ' }) === null, '编辑器未配置回 null');
    suite.assert(fmtElapsed(-5) === '0s' && fmtLapDuration(-3) === '0ms', '负耗时钳零');
    suite.assert(typeof renderTurnSeparator(1000, new Date(2026, 0, 1, 0, 5), { toolCalls: 1, toolMs: 5, llmCalls: 1, llmMs: 5 }, 20) === 'string', '极窄分隔行不断裂');
  });

  suite.test('Tab 补全：首词模糊兜底 + 第二词表（codex popup 对等）', () => {
    const ctx = { modelNames: [], modelName: 'm', effortOptions: [], variantIds: [] };
    const sw = { '/plugin': ['install', 'list', 'enable', 'disable', 'remove'], '/diff': ['--stat', '--full'] };
    suite.assert(completeMiniLine('/mo', ctx)[0].includes('/model'), '前缀命中');
    const [single, word] = completeMiniLine('/compact', ctx);
    suite.assert(single.join() === '/compact ' && word === '/compact', '打全补空格');
    const [fz, w] = completeMiniLine('/mpa', ctx);
    suite.assert(fz.join() === '/compact ' && w === '/mpa', '唯一模糊命中直插');
    suite.assert(completeMiniLine('/ac', ctx)[0].join(',') === '/compact,/archive,/unarchive,/trace', '多模糊命中列表');
    const [multi] = completeMiniLine('/st', ctx);
    suite.assert(multi.includes('/status') && multi.includes('/stop'), '多前缀命中列表');
    suite.assert(completeMiniLine('/plugin ', ctx, { secondWords: sw })[0].join(',') === 'install,list,enable,disable,remove', '/plugin 第二词表');
    suite.assert(completeMiniLine('/plugin ins', ctx, { secondWords: sw })[0].join() === 'install', '/plugin 第二词过滤');
    suite.assert(completeMiniLine('/diff --', ctx, { secondWords: sw })[0].join(',') === '--stat,--full', '/diff flags 第二词');
    suite.assert(completeMiniLine('/bogusxyz', ctx)[0].length === 0, '无命中回空');
    // commonPrefix：命令词多候选只补公共前缀（不触发 readline 原生哑巴列表——
    // 原生列表把输入行重画到列表下方，会破坏联想面板的整块 DL 光标纪律）
    suite.assert(commonPrefix(['/model', '/mcp', '/memory-apply']) === '/m', '公共前缀取到分叉点');
    suite.assert(commonPrefix(['/compact', '/archive']) === '/', '无公共身体回退 /');
    suite.assert(commonPrefix([]) === '' && commonPrefix(['/x']) === '/x', '空/单候选');
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
    // 行内 @ 后半截保留（已有空格不与尾空格叠加）
    const mid = applyMentionInsert('看 @ap 好', 2, 2, 'src/app.ts');
    suite.assert(mid.text === '看 @src/app.ts 好', `行内插入保留后半截：${JSON.stringify(mid.text)}`);
    const sp = applyMentionInsert('see @a then', 4, 1, 'a b.txt');
    suite.assert(sp.text === 'see @a b.txt then', `带空格文件名不叠空格：${JSON.stringify(sp.text)}`);
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

  suite.test('端到端：轮内 /stop 中断 + 空闲提示/? 帮助/开场 hint（PTY 真终端）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-stop-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 11;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      // MOCK_STREAM=1 + MOCK_SLOW_FIRST=1：流式逐字 20ms + 首 chunk 延迟 2s
      //（slow 只在 stream 下生效）——turn 约 4s+，/stop 在 +1s 落在窗口内确定性 abort
      env: { ...process.env, PORT: String(port), MOCK_STREAM: '1', MOCK_SLOW_FIRST: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      const log = path.join(xdg, 'stop-pty.log');
      const verdict = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const py = spawn('python3', ['scripts/feature-tests/stop-pty.py'], {
          cwd: ROOT,
          env: { ...process.env, OMNI_FT_ROOT: ROOT, OMNI_FT_XDG: xdg, OMNI_FT_PORT: String(port), OMNI_FT_LOG: log },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        py.stdout.on('data', (d) => (acc += d));
        py.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => py.kill('SIGKILL'), 120_000);
        py.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
      const lastLine = verdict.out.split('\n').filter(Boolean).pop() ?? '{}';
      let v: { prompted?: boolean; swallowed?: boolean; aborted?: boolean; alive?: boolean; exitCode?: number | null; idleHint?: boolean; helpStop?: boolean; introStop?: boolean; ledgerDumped?: boolean } = {};
      try {
        v = JSON.parse(lastLine);
      } catch { /* 非 JSON 则下面断言失败 */ }
      suite.assert(v.prompted === true, 'PTY 下看到 mini 提示符（主循环就绪）');
      suite.assert(v.swallowed === true, '/stop 被轮内拦截吞掉（hint 全场恰好一条，来自空闲 /stop）');
      suite.assert(v.aborted === true, 'slow-first 窗口内 abort（无模型最终回答）');
      suite.assert(v.alive === true, `中断后循环存活且干净退出（exit ${v.exitCode}，/pwd 生效）`);
      suite.assert(v.idleHint === true, '空闲 /stop 提示无执行中任务');
      suite.assert(v.helpStop === true, '? 帮助含 /stop 中断行');
      suite.assert(v.introStop === true, '开场 hint 含 /stop 停止');
      suite.assert(v.ledgerDumped === true, '轮内 Ctrl+T 账本落盘（live.clear 后打印）');
      suite.assert(verdict.code === 0, `pty 脚本退出码 0（实际 ${verdict.code}）`);
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：空行 Esc 取回上一条输入（PTY 真终端，codex edit-previous）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-esc-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 17;
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
      const log = path.join(xdg, 'esc-recall-pty.log');
      const verdict = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const py = spawn('python3', ['scripts/feature-tests/esc-recall-pty.py'], {
          cwd: ROOT,
          env: { ...process.env, OMNI_FT_ROOT: ROOT, OMNI_FT_XDG: xdg, OMNI_FT_PORT: String(port), OMNI_FT_LOG: log },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        py.stdout.on('data', (d) => (acc += d));
        py.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => py.kill('SIGKILL'), 120_000);
        py.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
      const lastLine = verdict.out.split('\n').filter(Boolean).pop() ?? '{}';
      let v: { prompted?: boolean; answered?: boolean; recalled?: boolean; quit0?: boolean; exitCode?: number | null } = {};
      try {
        v = JSON.parse(lastLine);
      } catch { /* 非 JSON 则下面断言失败 */ }
      suite.assert(v.prompted === true, 'PTY 下看到 mini 提示符');
      suite.assert(v.answered === true, 'mock 首轮回答（回提示符，行空）');
      suite.assert(v.recalled === true, '空行 Esc 后 marker 计数增加（取回重画）');
      suite.assert(v.quit0 === true, `取回后清行退出干净（exit ${v.exitCode}）`);
      suite.assert(verdict.code === 0, `pty 脚本退出码 0（实际 ${verdict.code}）`);
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：/ 联想面板取消不擦屏（输入框不上移）+ 回车整块回收（PTY 真终端）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-slash-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 18;
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
      const log = path.join(xdg, 'slash-cancel-pty.log');
      const verdict = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const py = spawn('python3', ['scripts/feature-tests/slash-cancel-pty.py'], {
          cwd: ROOT,
          env: { ...process.env, OMNI_FT_ROOT: ROOT, OMNI_FT_XDG: xdg, OMNI_FT_PORT: String(port), OMNI_FT_LOG: log },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        py.stdout.on('data', (d) => (acc += d));
        py.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => py.kill('SIGKILL'), 120_000);
        py.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
      const lastLine = verdict.out.split('\n').filter(Boolean).pop() ?? '{}';
      let v: { prompted?: boolean; panelShown?: boolean; cancelNoDelete?: boolean; submitReclaim?: boolean; quit0?: boolean; exitCode?: number | null } = {};
      try { v = JSON.parse(lastLine); } catch { /* 非 JSON 则下面断言失败 */ }
      suite.assert(v.prompted === true, 'PTY 下看到 mini 提示符');
      suite.assert(v.panelShown === true, '打 /m 后联想面板出现（/memory-apply 候选行）');
      suite.assert(v.cancelNoDelete === true, 'Ctrl+U 取消后面板不擦屏（无 DL 序列，输入框不上移）');
      suite.assert(v.submitReclaim === true, '/pwd 回车后面板+回显整块回收（上移 2 删 2）');
      suite.assert(v.quit0 === true, `干净退出（exit ${v.exitCode}）`);
      suite.assert(verdict.code === 0, `pty 脚本退出码 0（实际 ${verdict.code}）`);
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：mini -i 交互首轮图片附件（codex -i，全局通道）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-gi-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const shot = path.join(xdg, 'shot.png');
    fs.writeFileSync(
      shot,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      )
    );
    const port = MOCK_PORT + 15;
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
      const child = spawn('npx', ['tsx', 'src/index.ts', 'mini', '-i', shot], {
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
      await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
      child.stdin.write('看看这张图\n');
      await waitFor(async () => out.includes('已附加 1 张图片'), 30000, '首轮全局 -i 附件');
      await waitFor(async () => out.includes('mock 端到端验证通过'), 30000, '首轮回答');
      suite.assert(out.includes('› 看看这张图'), '任务文本无 -i 残留');
      child.stdin.write('/quit\n');
      const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
      suite.assert(code === 0, `退出码 0（实际 ${code}）`);
      // 首轮消费即清：第二轮不再重复附加
      suite.assert(out.split('已附加 1 张图片').length - 1 === 1, '附件只附加一次（消费即清）');
      // console 单次同样吃全局 -i（此前只认 mini 通道）：单任务 + 退出码
      const single = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const c2 = spawn('npx', ['tsx', 'src/index.ts', '-i', shot, '看图单次任务'], {
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
        let acc2 = '';
        c2.stdout.on('data', (d) => (acc2 += d));
        c2.stderr.on('data', (d) => (acc2 += d));
        const t2 = setTimeout(() => c2.kill('SIGKILL'), 60_000);
        c2.on('close', (cc) => {
          clearTimeout(t2);
          resolve({ code: cc, out: acc2 });
        });
      });
      suite.assert(single.code === 0, `console 单次退出码 0（实际 ${single.code}）`);
      suite.assert(single.out.includes('已附加 1 张图片'), 'console 单次全局 -i 生效');
      suite.assert(single.out.includes('mock 端到端验证通过'), 'console 单次拿到回答');
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：/mcp logout 透传顶层实现（交互内免跳出）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-mcplogout-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    // 空目录隔离 cwd：避开仓库 omni.json 的项目层替换（信任名单同步加新目录，免信任询问卡住）
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-mcpcwd-'));
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT, tmpCwd] }));
    // 本地 stdio mock：启动期建连即时完成（logout 本就不建连，但启动发现要快）；
    // remote 纯 http 端口（127.0.0.1:9 必然拒绝，启动发现瞬间失败不拖慢首提示符；logout 走 token 路径）
    fs.writeFileSync(
      path.join(xdg, 'omni', 'omni.json'),
      JSON.stringify({
        mcpServers: {
          demo: { command: 'node', args: [path.join(ROOT, 'scripts/mock-mcp.mjs')] },
          remote: { url: 'https://127.0.0.1:9/' },
        },
      })
    );
    // cwd=空目录时必须用绝对入口：相对 src/index.ts 会被解析到 cwd 下导致子进程秒退、无提示符
    const child = spawn('npx', ['tsx', path.join(ROOT, 'src/index.ts'), 'mini'], {
      cwd: tmpCwd,
      env: { ...process.env, XDG_CONFIG_HOME: xdg, OMNI_API_KEY: 'sk-test', OMNI_PERMISSION: 'full', OMNI_SHOW_THINKING: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const closed = new Promise<number | null>((r) => child.on('close', r));
    try {
      await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
      child.stdin.write('/mcp logout remote\n');
      await waitFor(async () => out.includes('本来就没有登录态'), 15000, '/mcp logout 透传');
      child.stdin.write('/mcp logout demo\n');
      await waitFor(async () => out.includes('无需 OAuth 登录'), 15000, '/mcp logout stdio 分支透传');
      child.stdin.write('/quit\n');
      const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
      suite.assert(code === 0, `退出码 0（实际 ${code}）`);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('端到端：/warnings 回看启动期 MCP 失败（codex /warnings）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-warnings-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    // 空目录隔离 cwd：mcpServers 按层覆盖非合并，cwd=仓库会用仓库 omni.json 盖掉本用例配置
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-warncwd-'));
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT, tmpCwd] }));
    // 坏 stdio 命令：启动发现即失败（ENOENT），只保留不建连
    fs.writeFileSync(
      path.join(xdg, 'omni', 'omni.json'),
      JSON.stringify({ mcpServers: { deadsvc: { command: 'omni-ft-no-such-binary-xyz' } } })
    );
    const child = spawn('npx', ['tsx', path.join(ROOT, 'src/index.ts'), 'mini'], {
      cwd: tmpCwd,
      env: { ...process.env, XDG_CONFIG_HOME: xdg, OMNI_API_KEY: 'sk-test', OMNI_PERMISSION: 'full', OMNI_SHOW_THINKING: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const closed = new Promise<number | null>((r) => child.on('close', r));
    try {
      await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
      child.stdin.write('/warnings\n');
      // deadsvc 在启动 ⚠️ 行里已出现过——等 /warnings 本体输出（含 server 名 + 来源标签）才算数
      await waitFor(async () => out.includes('[mcp]') && out.includes('deadsvc'), 15000, '/warnings 含失败 server 名与来源标签');
      child.stdin.write('/quit\n');
      const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
      suite.assert(code === 0, `退出码 0（实际 ${code}）`);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('端到端：/skills /plugins 别名 + /hooks 查看（codex 复数/($)Hooks）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-alias-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-aliascwd-'));
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT, tmpCwd] }));
    fs.writeFileSync(
      path.join(xdg, 'omni', 'omni.json'),
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'write_file', command: 'echo hookhi' }] } })
    );
    const child = spawn('npx', ['tsx', path.join(ROOT, 'src/index.ts'), 'mini'], {
      cwd: tmpCwd,
      env: { ...process.env, XDG_CONFIG_HOME: xdg, OMNI_API_KEY: 'sk-test', OMNI_PERMISSION: 'full', OMNI_SHOW_THINKING: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const closed = new Promise<number | null>((r) => child.on('close', r));
    try {
      await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
      child.stdin.write('/hooks\n');
      await waitFor(async () => out.includes('PostToolUse') && out.includes('echo hookhi'), 15000, '/hooks 列出事件与命令');
      child.stdin.write('/skills\n');
      await waitFor(async () => out.includes('技能'), 15000, '/skills 复数别名透传');
      child.stdin.write('/plugins list\n');
      await waitFor(async () => out.includes('插件'), 15000, '/plugins 复数别名透传');
      child.stdin.write('/quit\n');
      const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
      suite.assert(code === 0, `退出码 0（实际 ${code}）`);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('端到端：/mcp verbose 状态详情 + /rollout 会话路径（codex 对等）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-verbose-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-verbosecwd-'));
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT, tmpCwd] }));
    // demo 走本地 mock（已连接态），dead 走坏命令（启动失败态），remote 走 http（未登录态）
    fs.writeFileSync(
      path.join(xdg, 'omni', 'omni.json'),
      JSON.stringify({ mcpServers: {
        demo: { command: 'node', args: [path.join(ROOT, 'scripts/mock-mcp.mjs')] },
        dead: { command: 'omni-ft-no-such-binary-xyz' },
        remote: { url: 'https://127.0.0.1:9/' },
      } })
    );
    const child = spawn('npx', ['tsx', path.join(ROOT, 'src/index.ts'), 'mini'], {
      cwd: tmpCwd,
      env: { ...process.env, XDG_CONFIG_HOME: xdg, OMNI_API_KEY: 'sk-test', OMNI_PERMISSION: 'full', OMNI_SHOW_THINKING: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const closed = new Promise<number | null>((r) => child.on('close', r));
    try {
      await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
      child.stdin.write('/mcp verbose extra\n');
      await waitFor(async () => out.includes('用法：/mcp [verbose]'), 15000, 'verbose 带参报用法');
      child.stdin.write('/mcp verbose\n');
      await waitFor(async () => out.includes('已连接') && out.includes('启动失败') && out.includes('未登录'), 20000, 'verbose 三态齐全');
      suite.assert(out.includes('认证：'), 'verbose 含认证行');
      child.stdin.write('/rollout\n');
      await waitFor(async () => out.includes('当前会话文件：') && out.includes('.jsonl'), 15000, '/rollout 打印会话路径');
      child.stdin.write('/quit\n');
      const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
      suite.assert(code === 0, `退出码 0（实际 ${code}）`);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('端到端：/clear 开新会话文件（codex ClearUi→fresh，旧文件保留）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-clear-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-clearcwd-'));
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT, tmpCwd] }));
    const port = MOCK_PORT + 23;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let child: ReturnType<typeof spawn> | null = null;
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
    child = spawn('npx', ['tsx', path.join(ROOT, 'src/index.ts'), 'mini'], {
      cwd: tmpCwd,
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
    const rolloutPaths = (): string[] => {
      const m = out.match(/当前会话文件：(\S+\.jsonl)/g) ?? [];
      return m.map((l) => l.replace('当前会话文件：', ''));
    };
    try {
      await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
      child.stdin.write('clear-me-first-turn\n');
      await waitFor(async () => out.includes('mock 端到端验证通过'), 30000, '首轮回答（旧文件非空）');
      child.stdin.write('/rollout\n');
      await waitFor(async () => rolloutPaths().length >= 1, 15000, '首个会话路径');
      child.stdin.write('/clear\n');
      await waitFor(async () => out.includes('已清空上下文'), 15000, '/clear 执行');
      suite.assert(out.split('>_ ').length - 1 >= 2, '/clear 后重打 compact 会话头（codex e8fdbf1：新鲜会话头）');
      child.stdin.write('/rollout\n');
      await waitFor(async () => rolloutPaths().length >= 2, 15000, '/clear 后新会话路径');
      const [a, b] = rolloutPaths();
      suite.assert(a !== b, '换文件（同文件清空会在 resume 时复活，实锤 bug 回归锁）');
      for (const f of [a!, b!]) suite.assert(fs.existsSync(f), `旧文件保留可找回：${f}`);
      const oldText = fs.readFileSync(a!, 'utf8');
      const newText = fs.readFileSync(b!, 'utf8');
      suite.assert(oldText.includes('clear-me-first-turn'), '旧文件保留首轮内容');
      suite.assert(!newText.includes('clear-me-first-turn'), '新文件不含已清内容');
      child.stdin.write('/quit\n');
      const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
      suite.assert(code === 0, `退出码 0（实际 ${code}）`);
    } finally {
      child!.kill('SIGKILL');
    }
    } finally {
      mock.kill();
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('端到端：输入历史跨会话召回（PTY 双进程，codex composer history）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-hist-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const log = path.join(xdg, 'hist-recall-pty.log');
    const verdict = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const py = spawn('python3', ['scripts/feature-tests/hist-recall-pty.py'], {
        cwd: ROOT,
        env: { ...process.env, OMNI_FT_ROOT: ROOT, OMNI_FT_XDG: xdg, OMNI_FT_LOG: log },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let acc = '';
      py.stdout.on('data', (d) => (acc += d));
      py.stderr.on('data', (d) => (acc += d));
      const timer = setTimeout(() => py.kill('SIGKILL'), 180_000);
      py.on('close', (c) => {
        clearTimeout(timer);
        resolve({ code: c, out: acc });
      });
    });
    const lastLine = verdict.out.split('\n').filter(Boolean).pop() ?? '{}';
    let v: { prompted1?: boolean; prompted2?: boolean; recalled?: boolean; quit0?: boolean; exitCode?: number | null } = {};
    try {
      v = JSON.parse(lastLine);
    } catch { /* 非 JSON 则下面断言失败 */ }
    suite.assert(v.prompted1 === true, '会话一提示符就绪并提交');
    suite.assert(v.prompted2 === true, '会话二（新进程同 XDG）提示符就绪');
    suite.assert(v.recalled === true, 'Up 召回上一会话的输入行');
    suite.assert(v.quit0 === true, `清行退出干净（exit ${v.exitCode}）`);
    suite.assert(verdict.code === 0, `pty 脚本退出码 0（实际 ${verdict.code}）`);
  });

  suite.test('端到端：/diff 含未跟踪新文件内容（codex /diff 对等）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-diff-'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-diff-work-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [work] }));
    // hermetic git 仓库：一次提交 + 一个未跟踪新文件
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
    fs.writeFileSync(path.join(work, 'newfile.txt'), 'untracked-marker-456\nsecond\n');
    const child = spawn('npx', ['tsx', path.join(ROOT, 'src/index.ts'), 'mini'], {
      cwd: work,
      env: { ...process.env, XDG_CONFIG_HOME: xdg, OMNI_API_KEY: 'sk-test', OMNI_PERMISSION: 'full', OMNI_SHOW_THINKING: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const closed = new Promise<number | null>((r) => child.on('close', r));
    try {
      await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
      child.stdin.write('/diff\n');
      await waitFor(async () => out.includes('untracked-marker-456'), 15000, '/diff 含新文件内容');
      suite.assert(out.includes('newfile.txt'), '/diff 标出新文件名');
      child.stdin.write('/quit\n');
      const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
      suite.assert(code === 0, `退出码 0（实际 ${code}）`);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  suite.test('端到端：危险命令审批问答往返（PTY 真终端，codex approval）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-approve-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    // 空目录 cwd：审批通过后 git push 必 fast-fail（非仓库），无副作用
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-approvecwd-'));
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT, tmpCwd] }));
    const port = MOCK_PORT + 29;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), MOCK_DANGEROUS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      const log = path.join(xdg, 'approve-pty.log');
      const verdict = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const py = spawn('python3', ['scripts/feature-tests/approve-pty.py'], {
          cwd: ROOT,
          env: { ...process.env, OMNI_FT_ROOT: ROOT, OMNI_FT_XDG: xdg, OMNI_FT_PORT: String(port), OMNI_FT_LOG: log, OMNI_FT_CWD: tmpCwd },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        py.stdout.on('data', (d) => (acc += d));
        py.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => py.kill('SIGKILL'), 180_000);
        py.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
      const lastLine = verdict.out.split('\n').filter(Boolean).pop() ?? '{}';
      let v: { prompted?: boolean; approvalAsked?: boolean; approvedDone?: boolean; remembered?: boolean; noGhost?: boolean; quit0?: boolean; exitCode?: number | null } = {};
      try {
        v = JSON.parse(lastLine);
      } catch { /* 非 JSON 则下面断言失败 */ }
      suite.assert(v.prompted === true, 'PTY 下看到 mini 提示符');
      suite.assert(v.approvalAsked === true, 'safe 档位危险命令弹出审批（y/a/N）');
      suite.assert(v.approvedDone === true, '回答 a 后放行执行、回合完成');
      suite.assert(v.remembered === true, '第二轮同命令免询问（本会话记住）');
      suite.assert(v.noGhost === true, '答案行未漏进主循环（无幽灵第三轮）');
      suite.assert(v.quit0 === true, `干净退出（exit ${v.exitCode}）`);
      suite.assert(verdict.code === 0, `pty 脚本退出码 0（实际 ${verdict.code}）`);
      // 审批块版式顺序锁（真终端 transcript 实测：⚠ 工具 → $ 命令 → 原因 → 三选项 → 记住确认；只弹一次）
      try {
        const raw = fs.readFileSync(log, 'utf8');
        const plain = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r\n?/g, '\n');
        const iWarn = plain.indexOf('⚠ run_command');
        const iCmd = plain.indexOf('$ git push origin main');
        const iAsk = plain.indexOf('批准执行？');
        const iRemembered = plain.indexOf('会话已记住 run_command');
        suite.assert(iWarn >= 0 && iWarn < iCmd && iCmd < iAsk && iAsk < iRemembered, '审批块顺序：工具→命令→三选项→记住确认');
        suite.assert(plain.split('批准执行？').length - 1 === 1, '审批只弹一次（第二轮走记住）');
      } catch (err) {
        suite.assert(false, `审批 transcript 读取失败：${(err as Error)?.message ?? err}`);
      }
    } finally {
      mock.kill();
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('端到端：ask_user 提问往返 + 答案不泄漏（PTY 真终端）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-ask-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-askcwd-'));
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT, tmpCwd] }));
    const port = MOCK_PORT + 31;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), MOCK_ASK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      const log = path.join(xdg, 'ask-pty.log');
      const verdict = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const py = spawn('python3', ['scripts/feature-tests/ask-pty.py'], {
          cwd: ROOT,
          env: { ...process.env, OMNI_FT_ROOT: ROOT, OMNI_FT_XDG: xdg, OMNI_FT_PORT: String(port), OMNI_FT_LOG: log, OMNI_FT_CWD: tmpCwd },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        py.stdout.on('data', (d) => (acc += d));
        py.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => py.kill('SIGKILL'), 180_000);
        py.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
      const lastLine = verdict.out.split('\n').filter(Boolean).pop() ?? '{}';
      let v: { prompted?: boolean; asked?: boolean; answeredDone?: boolean; noGhost?: boolean; pwdAlive?: boolean; quit0?: boolean; exitCode?: number | null } = {};
      try {
        v = JSON.parse(lastLine);
      } catch { /* 非 JSON 则下面断言失败 */ }
      suite.assert(v.prompted === true, 'PTY 下看到 mini 提示符');
      suite.assert(v.asked === true, 'ask_user 提问卡弹出');
      suite.assert(v.answeredDone === true, '回序号后放行、回合完成');
      suite.assert(v.noGhost === true, '答案 1 未漏进主循环（无第二轮提问）');
      suite.assert(v.pwdAlive === true, '提问后 stdin 存活（input.resume 生效）');
      suite.assert(v.quit0 === true, `干净退出（exit ${v.exitCode}）`);
      suite.assert(verdict.code === 0, `pty 脚本退出码 0（实际 ${verdict.code}）`);
      // 提问卡版式顺序锁（真终端 transcript 实测：? 问题 → 序号选项 → 输入提示 → Asked 回显；只问一次）
      try {
        const raw = fs.readFileSync(log, 'utf8');
        const plain = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r\n?/g, '\n');
        const seq = ['? 接下来怎么做？', '1. 继续执行', '输入选项序号', '• Asked', '用户选择了选项'];
        const idx = seq.map((s) => plain.indexOf(s));
        suite.assert(idx.every((v, k) => v >= 0 && (k === 0 || idx[k - 1] < v)), '提问卡顺序：问题→选项→输入提示→Asked 回显');
        suite.assert(plain.split('? 接下来怎么做？').length - 1 === 1, '提问只弹一次（答案未触发第二轮）');
      } catch (err) {
        suite.assert(false, `提问 transcript 读取失败：${(err as Error)?.message ?? err}`);
      }
    } finally {
      mock.kill();
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('端到端：Ctrl+G 外部编辑器组稿（PTY 真终端）', async () => {
    // 种子行 seed（不换行）→ Ctrl+G → 桩 EDITOR 改写暂存为 seed-edited → 回车提交整轮
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-editor-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const stub = path.join(xdg, 'stub-editor.sh');
    fs.writeFileSync(stub, '#!/bin/sh\nprintf "%s" "$(cat "$1")-edited" > "$1"\n');
    fs.chmodSync(stub, 0o755);
    const port = MOCK_PORT + 89;
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
      const log = path.join(xdg, 'editor-pty.log');
      const verdict = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const py = spawn('python3', ['scripts/feature-tests/editor-pty.py'], {
          cwd: ROOT,
          env: { ...process.env, OMNI_FT_ROOT: ROOT, OMNI_FT_XDG: xdg, OMNI_FT_PORT: String(port), OMNI_FT_LOG: log, OMNI_FT_EDITOR: stub },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        py.stdout.on('data', (d) => (acc += d));
        py.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => py.kill('SIGKILL'), 180_000);
        py.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
      const lastLine = verdict.out.split('\n').filter(Boolean).pop() ?? '{}';
      let v: { prompted?: boolean; done?: boolean; quit0?: boolean; exitCode?: number | null } = {};
      try {
        v = JSON.parse(lastLine);
      } catch { /* 非 JSON 则下面断言失败 */ }
      suite.assert(v.prompted === true, 'PTY 下看到 mini 提示符');
      suite.assert(v.done === true, '组稿回填行回车提交、整轮完成');
      // 提交的是编辑器改写文本（种子 seed → seed-edited），读会话文件断言
      const sessDir = path.join(xdg, 'omni', 'sessions');
      let submitted = '';
      try {
        for (const f of fs.readdirSync(sessDir).filter((f) => f.endsWith('.jsonl'))) {
          submitted += fs.readFileSync(path.join(sessDir, f), 'utf8');
        }
      } catch { /* 无会话文件则下面断言失败 */ }
      suite.assert(submitted.includes('seed-edited'), '提交文本来自编辑器（非空行/种子原文）');
      suite.assert(v.quit0 === true, `干净退出（exit ${v.exitCode}）`);
      suite.assert(verdict.code === 0, `pty 脚本退出码 0（实际 ${verdict.code}）`);
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：审批提示处 Ctrl+C = 拒绝并继续（PTY 真终端）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-sigint-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-sigintcwd-'));
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT, tmpCwd] }));
    const port = MOCK_PORT + 37;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), MOCK_DANGEROUS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      const log = path.join(xdg, 'sigint-pty.log');
      const verdict = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const py = spawn('python3', ['scripts/feature-tests/sigint-pty.py'], {
          cwd: ROOT,
          env: { ...process.env, OMNI_FT_ROOT: ROOT, OMNI_FT_XDG: xdg, OMNI_FT_PORT: String(port), OMNI_FT_LOG: log, OMNI_FT_CWD: tmpCwd },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        py.stdout.on('data', (d) => (acc += d));
        py.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => py.kill('SIGKILL'), 180_000);
        py.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
      const lastLine = verdict.out.split('\n').filter(Boolean).pop() ?? '{}';
      let v: { prompted?: boolean; asked?: boolean; deniedDone?: boolean; alive?: boolean; quit0?: boolean; exitCode?: number | null } = {};
      try {
        v = JSON.parse(lastLine);
      } catch { /* 非 JSON 则下面断言失败 */ }
      suite.assert(v.prompted === true, 'PTY 下看到 mini 提示符');
      suite.assert(v.asked === true, '审批提示弹出');
      suite.assert(v.deniedDone === true, 'Ctrl+C 取消 = 拒绝，模型收尾完成');
      suite.assert(v.alive === true, '拒绝后会话存活可继续');
      suite.assert(v.quit0 === true, `干净退出（exit ${v.exitCode}）`);
      suite.assert(verdict.code === 0, `pty 脚本退出码 0（实际 ${verdict.code}）`);
    } finally {
      mock.kill();
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('端到端：console 模式审批往返（同双 readline 修复覆盖）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-con-approve-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-con-approvecwd-'));
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT, tmpCwd] }));
    const port = MOCK_PORT + 41;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), MOCK_DANGEROUS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      const log = path.join(xdg, 'console-approve-pty.log');
      const verdict = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const py = spawn('python3', ['scripts/feature-tests/console-approve-pty.py'], {
          cwd: ROOT,
          env: { ...process.env, OMNI_FT_ROOT: ROOT, OMNI_FT_XDG: xdg, OMNI_FT_PORT: String(port), OMNI_FT_LOG: log, OMNI_FT_CWD: tmpCwd },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        py.stdout.on('data', (d) => (acc += d));
        py.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => py.kill('SIGKILL'), 180_000);
        py.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
      const lastLine = verdict.out.split('\n').filter(Boolean).pop() ?? '{}';
      let v: { prompted?: boolean; asked?: boolean; done?: boolean; noGhost?: boolean; alive?: boolean; quit0?: boolean; exitCode?: number | null } = {};
      try {
        v = JSON.parse(lastLine);
      } catch { /* 非 JSON 则下面断言失败 */ }
      suite.assert(v.prompted === true, 'PTY 下看到 console 提示符');
      suite.assert(v.asked === true, '审批提示弹出');
      suite.assert(v.done === true, '回答 y 后放行、回合完成');
      suite.assert(v.noGhost === true, '答案未漏进主循环');
      suite.assert(v.alive === true, '审批后 stdin 存活');
      suite.assert(v.quit0 === true, `干净退出（exit ${v.exitCode}）`);
      suite.assert(verdict.code === 0, `pty 脚本退出码 0（实际 ${verdict.code}）`);
    } finally {
      mock.kill();
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('端到端：/compact 压缩后继续对话（mock 服务）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-compact-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 43;
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
      const answers = (): number => out.split('mock 端到端验证通过').length - 1;
      try {
        await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
        for (const t of ['compact-t1', 'compact-t2', 'compact-t3']) {
          child.stdin.write(`${t}\n`);
          const want = answers() + 1;
          await waitFor(async () => answers() >= want, 30000, `${t} 回答`);
        }
        child.stdin.write('/compact\n');
        await waitFor(async () => out.includes('已压缩'), 30000, '/compact 执行压缩');
        child.stdin.write('compact-t4\n');
        const want4 = answers() + 1;
        await waitFor(async () => answers() >= want4, 30000, '压缩后继续对话');
        child.stdin.write('/quit\n');
        const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
        suite.assert(code === 0, `退出码 0（实际 ${code}）`);
      } finally {
        child.kill('SIGKILL');
      }
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：write 后 /undo 删除新建文件（mock MOCK_WRITE）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-undo-'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-undo-work-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [work] }));
    const port = MOCK_PORT + 47;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), MOCK_WRITE: '1' },
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
      const target = path.join(work, 'undo-test.txt');
      try {
        await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
        child.stdin.write('write something\n');
        await waitFor(async () => fs.existsSync(target), 30000, 'mock write_file 落盘');
        suite.assert(fs.readFileSync(target, 'utf8').includes('mock-write-content'), '写入内容正确');
        child.stdin.write('/undo\n');
        await waitFor(async () => out.includes('已删除本次新建的文件'), 15000, '/undo 删除新建文件');
        suite.assert(!fs.existsSync(target), '文件已移除');
        child.stdin.write('/quit\n');
        const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
        suite.assert(code === 0, `退出码 0（实际 ${code}）`);
      } finally {
        child.kill('SIGKILL');
      }
    } finally {
      mock.kill();
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  suite.test('端到端：/cd 切换 + /pwd 确认 + /export 落盘（无 API）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-cdexp-'));
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-cdexp-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-cdexp-b-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [dirA, dirB] }));
    const child = spawn('npx', ['tsx', path.join(ROOT, 'src/index.ts'), 'mini'], {
      cwd: dirA,
      env: { ...process.env, XDG_CONFIG_HOME: xdg, OMNI_API_KEY: 'sk-test', OMNI_PERMISSION: 'full', OMNI_SHOW_THINKING: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const closed = new Promise<number | null>((r) => child.on('close', r));
    try {
      await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
      child.stdin.write(`/cd ${dirB}\n`);
      await waitFor(async () => out.includes('工作目录已切换'), 15000, '/cd 切换');
      child.stdin.write('/pwd\n');
      await waitFor(async () => out.includes(dirB), 15000, '/pwd 确认新目录');
      child.stdin.write('/export\n');
      await waitFor(async () => out.includes('已导出会话'), 15000, '/export 落盘');
      const exported = fs.readdirSync(path.join(dirB, '.omni')).filter((f) => f.startsWith('export-') && f.endsWith('.md'));
      suite.assert(exported.length === 1, `导出文件落到新目录（${exported.join()}）`);
      suite.assert(fs.readFileSync(path.join(dirB, '.omni', exported[0]!), 'utf8').includes('Omni 会话导出'), '导出含标题头');
      child.stdin.write('/quit\n');
      const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
      suite.assert(code === 0, `退出码 0（实际 ${code}）`);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  suite.test('端到端：/plan /permission /pin /rename /archive 联动（无 API）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-meta-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-metacwd-'));
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [tmpCwd] }));
    const child = spawn('npx', ['tsx', path.join(ROOT, 'src/index.ts'), 'mini'], {
      cwd: tmpCwd,
      env: { ...process.env, XDG_CONFIG_HOME: xdg, OMNI_API_KEY: 'sk-test', OMNI_PERMISSION: 'full', OMNI_SHOW_THINKING: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const closed = new Promise<number | null>((r) => child.on('close', r));
    const metaFile = (): string => {
      const dir = path.join(xdg, 'omni', 'sessions');
      const fsx = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      if (fsx.length !== 1) throw new Error(`期望恰好 1 个会话文件，实际 ${fsx.length}`);
      return path.join(dir, fsx[0]!);
    };
    const metaOf = (): Record<string, unknown> => JSON.parse(fs.readFileSync(metaFile(), 'utf8').split('\n')[0]!);
    try {
      await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
      child.stdin.write('/plan\n');
      await waitFor(async () => out.includes('已进入计划模式'), 15000, '/plan 进入');
      child.stdin.write('/plan\n');
      await waitFor(async () => out.includes('已退出计划模式'), 15000, '/plan 退出');
      child.stdin.write('/permission 只读\n');
      await waitFor(async () => out.includes('只读'), 15000, '/permission 切换只读');
      child.stdin.write('/status\n');
      await waitFor(async () => out.includes('权限：read'), 15000, '/status 确认档位');
      child.stdin.write('/pin\n');
      await waitFor(async () => out.includes('置顶'), 15000, '/pin 置顶');
      suite.assert(metaOf()['pinned'] === true, 'meta pinned 落盘');
      child.stdin.write('/rename MetaTitle\n');
      await waitFor(async () => out.includes('MetaTitle'), 15000, '/rename 改名');
      suite.assert(metaOf()['title'] === 'MetaTitle', 'meta title 落盘');
      child.stdin.write('/archive\n');
      await waitFor(async () => out.includes('已归档会话'), 15000, '/archive 归档');
      suite.assert(metaOf()['archived'] === true, 'meta archived 落盘');
      child.stdin.write('/quit\n');
      const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
      suite.assert(code === 0, `退出码 0（实际 ${code}）`);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('端到端：/auto /context 开关档位（无 API）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-toggles-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-togglescwd-'));
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [tmpCwd] }));
    const child = spawn('npx', ['tsx', path.join(ROOT, 'src/index.ts'), 'mini'], {
      cwd: tmpCwd,
      env: { ...process.env, XDG_CONFIG_HOME: xdg, OMNI_API_KEY: 'sk-test', OMNI_PERMISSION: 'full', OMNI_SHOW_THINKING: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const closed = new Promise<number | null>((r) => child.on('close', r));
    try {
      await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
      child.stdin.write('/auto on\n');
      await waitFor(async () => out.includes('已开启'), 15000, '/auto on');
      child.stdin.write('/auto off\n');
      await waitFor(async () => out.includes('已关闭'), 15000, '/auto off');
      child.stdin.write('/context 256\n');
      await waitFor(async () => out.includes('256'), 15000, '/context 256 生效');
      child.stdin.write('/context 默认\n');
      await waitFor(async () => out.includes('默认') || out.includes('清除'), 15000, '/context 默认清除');
      child.stdin.write('/quit\n');
      const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
      suite.assert(code === 0, `退出码 0（实际 ${code}）`);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('端到端：/undo 后 /redo 恢复文件（mock MOCK_WRITE）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-redo-'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-redo-work-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [work] }));
    const port = MOCK_PORT + 53;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), MOCK_WRITE: '1' },
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
      const target = path.join(work, 'undo-test.txt');
      try {
        await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
        child.stdin.write('write something\n');
        await waitFor(async () => fs.existsSync(target), 30000, 'mock write_file 落盘');
        child.stdin.write('/undo\n');
        await waitFor(async () => !fs.existsSync(target), 15000, '/undo 删除新建文件');
        child.stdin.write('/redo\n');
        await waitFor(async () => fs.existsSync(target), 15000, '/redo 恢复文件');
        suite.assert(fs.readFileSync(target, 'utf8').includes('mock-write-content'), '重做内容正确');
        child.stdin.write('/quit\n');
        const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
        suite.assert(code === 0, `退出码 0（实际 ${code}）`);
      } finally {
        child.kill('SIGKILL');
      }
    } finally {
      mock.kill();
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  suite.test('端到端：/import 迁移 + /init 生成（mock/夹具）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-impinit-'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-impinit-work-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [work] }));
    // /import 夹具：CLAUDE.md + .claude/skills/demo/SKILL.md（纯文件操作，无需网络）
    fs.writeFileSync(path.join(work, 'CLAUDE.md'), '# Claude 项目记忆\n');
    fs.mkdirSync(path.join(work, '.claude', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(work, '.claude', 'skills', 'demo', 'SKILL.md'), '# demo skill\n');
    fs.mkdirSync(path.join(work, 'sub'));
    const port = MOCK_PORT + 59;
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
      try {
        await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
        child.stdin.write('/import\n');
        await waitFor(async () => fs.existsSync(path.join(work, 'AGENTS.md')), 15000, '/import 生成 AGENTS.md');
        suite.assert(fs.readFileSync(path.join(work, 'AGENTS.md'), 'utf8').includes('Claude 项目记忆'), 'CLAUDE.md 内容迁移');
        suite.assert(fs.existsSync(path.join(work, '.agents', 'skills', 'demo', 'SKILL.md')), '技能目录迁移');
        child.stdin.write('/init sub\n');
        await waitFor(async () => fs.existsSync(path.join(work, 'sub', 'AGENTS.md')), 30000, '/init 子目录生成（mock）');
        child.stdin.write('/quit\n');
        const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
        suite.assert(code === 0, `退出码 0（实际 ${code}）`);
      } finally {
        child.kill('SIGKILL');
      }
    } finally {
      mock.kill();
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  suite.test('端到端：/model 双模型切换（无 API，直调切换）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-model-'));
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-modelcwd-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [tmpCwd] }));
    // 双模型同端点（切换本身不调 API；不配 mock 也能验证切换 + /status 跟随）
    fs.writeFileSync(
      path.join(xdg, 'omni', 'omni.json'),
      JSON.stringify({
        model: 'mock-a',
        providers: { t: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-test', models: { 'mock-a': {}, 'mock-b': {} } } },
      })
    );
    const child = spawn('npx', ['tsx', path.join(ROOT, 'src/index.ts'), 'mini'], {
      cwd: tmpCwd,
      env: { ...process.env, XDG_CONFIG_HOME: xdg, OMNI_PERMISSION: 'full', OMNI_SHOW_THINKING: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const closed = new Promise<number | null>((r) => child.on('close', r));
    try {
      await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
      child.stdin.write('/model mock-b\n');
      await waitFor(async () => out.includes('已切换模型') && out.includes('mock-b'), 15000, '/model 切换');
      child.stdin.write('/status\n');
      await waitFor(async () => out.includes('mock-b'), 15000, '/status 跟随新模型');
      child.stdin.write('/model no-such-model\n');
      await waitFor(async () => out.includes('未知模型'), 15000, '未知模型报错');
      child.stdin.write('/quit\n');
      const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
      suite.assert(code === 0, `退出码 0（实际 ${code}）`);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('端到端：/variants /skill /mcp reconnect 联动（无 API）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-misc-'));
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-misccwd-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [tmpCwd] }));
    fs.writeFileSync(
      path.join(xdg, 'omni', 'omni.json'),
      JSON.stringify({
        model: 'mock-a',
        providers: { t: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-test', models: { 'mock-a': { reasoningEffortOptions: ['low', 'high'] } } } },
        mcpServers: { demo: { command: 'node', args: [path.join(ROOT, 'scripts/mock-mcp.mjs')] } },
      })
    );
    const child = spawn('npx', ['tsx', path.join(ROOT, 'src/index.ts'), 'mini'], {
      cwd: tmpCwd,
      env: { ...process.env, XDG_CONFIG_HOME: xdg, OMNI_PERMISSION: 'full', OMNI_SHOW_THINKING: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const closed = new Promise<number | null>((r) => child.on('close', r));
    try {
      await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
      child.stdin.write('/variants low\n');
      await waitFor(async () => out.includes('已切换思考级别'), 15000, '/variants 切换');
      child.stdin.write('/variants bogus\n');
      await waitFor(async () => out.includes('未知思考级别'), 15000, '/variants 非法报错');
      child.stdin.write('/status\n');
      await waitFor(async () => out.includes('思考级别：low'), 15000, '/status 跟随级别');
      child.stdin.write('/skill\n');
      await waitFor(async () => out.includes('技能'), 15000, '/skill 列表');
      child.stdin.write('/mcp reconnect\n');
      await waitFor(async () => out.includes('已重连'), 15000, '/mcp 重连');
      child.stdin.write('/quit\n');
      const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
      suite.assert(code === 0, `退出码 0（实际 ${code}）`);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('端到端：/btw 旁问 + /team 空看板（mock 服务）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-btwteam-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 61;
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
      try {
        await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
        child.stdin.write('/btw README.md 是什么文件\n');
        await waitFor(async () => out.includes('旁问回答'), 30000, '/btw 旁问回答');
        child.stdin.write('/team\n');
        await waitFor(async () => out.includes('任务看板为空'), 15000, '/team 空看板');
        child.stdin.write('/quit\n');
        const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
        suite.assert(code === 0, `退出码 0（实际 ${code}）`);
      } finally {
        child.kill('SIGKILL');
      }
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：/session 列出 + id 继续（mock 服务）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-sess-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 67;
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
      const sessDir = path.join(xdg, 'omni', 'sessions');
      const firstId = (): string | null => {
        try {
          const fsx = fs.readdirSync(sessDir).filter((f) => f.endsWith('.jsonl'));
          if (fsx.length === 0) return null;
          const first = fsx.map((f) => path.join(sessDir, f)).sort(
            (a, b) => Number(fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
          )[0]!;
          return path.basename(first, '.jsonl');
        } catch {
          return null;
        }
      };
      try {
        await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
        child.stdin.write('session-one-task\n');
        await waitFor(async () => out.includes('mock 端到端验证通过'), 30000, '首轮回答');
        child.stdin.write('/new\n');
        await waitFor(async () => out.includes('已新建会话'), 15000, '/new 开新会话');
        child.stdin.write('/session\n');
        await waitFor(async () => out.includes('历史会话') || out.includes('条消息'), 15000, '/session 列出旧会话');
        const id = firstId();
        suite.assert(!!id, '旧会话文件存在');
        child.stdin.write(`/session ${id!.slice(0, 12)}\n`);
        await waitFor(async () => out.includes('已继续会话') || out.includes(id!.slice(0, 12)), 15000, '/session id 前缀继续');
        child.stdin.write('/quit\n');
        const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
        suite.assert(code === 0, `退出码 0（实际 ${code}）`);
      } finally {
        child.kill('SIGKILL');
      }
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：/vim /memory-apply /fork 空会话（无 API）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-misc2-'));
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-misc2cwd-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [tmpCwd] }));
    fs.mkdirSync(path.join(tmpCwd, '.omni'), { recursive: true });
    fs.writeFileSync(path.join(tmpCwd, '.omni', 'memory-pending.md'), '# 项目记忆片段\n');
    const child = spawn('npx', ['tsx', path.join(ROOT, 'src/index.ts'), 'mini'], {
      cwd: tmpCwd,
      env: { ...process.env, XDG_CONFIG_HOME: xdg, OMNI_API_KEY: 'sk-test', OMNI_PERMISSION: 'full', OMNI_SHOW_THINKING: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const closed = new Promise<number | null>((r) => child.on('close', r));
    try {
      await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
      child.stdin.write('/vim on\n');
      await waitFor(async () => out.includes('已开启'), 15000, '/vim on');
      child.stdin.write('/vim off\n');
      await waitFor(async () => out.includes('已关闭'), 15000, '/vim off');
      child.stdin.write('/memory-apply\n');
      await waitFor(async () => out.includes('已应用项目记忆'), 15000, '/memory-apply 应用');
      suite.assert(fs.readFileSync(path.join(tmpCwd, 'AGENTS.md'), 'utf8').includes('项目记忆片段'), '片段并入 AGENTS.md');
      suite.assert(!fs.existsSync(path.join(tmpCwd, '.omni', 'memory-pending.md')), '片段文件已清除');
      child.stdin.write('/fork\n');
      await waitFor(async () => out.includes('还没有可 fork 的消息'), 15000, '/fork 空会话提示');
      child.stdin.write('/quit\n');
      const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
      suite.assert(code === 0, `退出码 0（实际 ${code}）`);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  suite.test('端到端：/fork <N> 分叉保留前文（mock 服务）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-fork-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 71;
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
      const sessDir = path.join(xdg, 'omni', 'sessions');
      try {
        await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
        child.stdin.write('fork-me-task\n');
        await waitFor(async () => out.includes('mock 端到端验证通过'), 30000, '首轮回答');
        child.stdin.write('/fork 1\n');
        await waitFor(async () => out.includes('已分叉新会话'), 15000, '/fork 分叉');
        const files = fs.readdirSync(sessDir).filter((f) => f.endsWith('.jsonl'));
        suite.assert(files.length === 2, `原会话保留 + 新会话文件（实际 ${files.length} 个）`);
        child.stdin.write('/quit\n');
        const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
        suite.assert(code === 0, `退出码 0（实际 ${code}）`);
      } finally {
        child.kill('SIGKILL');
      }
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：/send 跨会话消息往返（mock 服务）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-send-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 73;
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
      const sessDir = path.join(xdg, 'omni', 'sessions');
      const oldestId = (): string | null => {
        try {
          const fsx = fs.readdirSync(sessDir).filter((f) => f.endsWith('.jsonl'));
          if (fsx.length === 0) return null;
          const first = fsx.map((f) => path.join(sessDir, f)).sort(
            (a, b) => Number(fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
          )[0]!;
          return path.basename(first, '.jsonl');
        } catch {
          return null;
        }
      };
      try {
        await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
        child.stdin.write('send-target-task\n');
        await waitFor(async () => out.includes('mock 端到端验证通过'), 30000, '首轮回答');
        child.stdin.write('/new\n');
        await waitFor(async () => out.includes('已新建会话'), 15000, '/new 开新会话');
        const id = oldestId();
        suite.assert(!!id, '目标会话文件存在');
        child.stdin.write(`/send ${id} 跨会话提问\n`);
        await waitFor(async () => out.includes('已回复') || out.includes('跨会话响应'), 60000, '/send 跨会话往返');
        child.stdin.write('/quit\n');
        const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
        suite.assert(code === 0, `退出码 0（实际 ${code}）`);
      } finally {
        child.kill('SIGKILL');
      }
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：管道模式 /delete 拒绝删除（非 TTY 防误触）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-del-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 79;
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
      const sessDir = path.join(xdg, 'omni', 'sessions');
      const oldestFile = (): string | null => {
        // 按 meta.created 排序（finalize 会刷新 mtime，不能用 mtime 判定新旧）
        try {
          const fsx = fs.readdirSync(sessDir).filter((f) => f.endsWith('.jsonl'));
          if (fsx.length === 0) return null;
          const withCreated = fsx.map((f) => {
            const fp = path.join(sessDir, f);
            try {
              return { fp, created: Number(JSON.parse(fs.readFileSync(fp, 'utf8').split('\n')[0]!).created ?? 0) };
            } catch {
              return { fp, created: 0 };
            }
          });
          withCreated.sort((a, b) => a.created - b.created);
          return withCreated[0]!.fp;
        } catch {
          return null;
        }
      };
      try {
        await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
        child.stdin.write('delete-me-task\n');
        await waitFor(async () => out.includes('mock 端到端验证通过'), 30000, '首轮回答');
        child.stdin.write('/new\n');
        await waitFor(async () => out.includes('已新建会话'), 15000, '/new 开新会话');
        suite.assert(out.split('>_ ').length - 1 >= 2, '/new 后重打 compact 会话头（codex e8fdbf1：新鲜会话头）');
        const victim = oldestFile();
        suite.assert(!!victim, '旧会话文件存在');
        // 管道（非 TTY）无真人确认：/delete 必须拒绝且不删文件（与审批/rewind 同哲学）
        const victimId = path.basename(victim!, '.jsonl');
        child.stdin.write(`/delete ${victimId}\n`);
        await waitFor(async () => out.includes('非交互模式拒绝删除会话'), 15000, '/delete 管道拒绝');
        suite.assert(fs.existsSync(victim!), '旧会话文件仍在（未被删除）');
        child.stdin.write('/quit\n');
        const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
        suite.assert(code === 0, `退出码 0（实际 ${code}）`);
      } finally {
        child.kill('SIGKILL');
      }
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：/delete y 确认删除旧会话（PTY 真终端）', async () => {
    // y 确认分支只在 TTY 下可达（管道一律拒绝，见上一个用例）：走 PTY 真终端覆盖
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-delpty-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 83;
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
      const log = path.join(xdg, 'delete-pty.log');
      const verdict = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const py = spawn('python3', ['scripts/feature-tests/delete-pty.py'], {
          cwd: ROOT,
          env: { ...process.env, OMNI_FT_ROOT: ROOT, OMNI_FT_XDG: xdg, OMNI_FT_PORT: String(port), OMNI_FT_LOG: log },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        py.stdout.on('data', (d) => (acc += d));
        py.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => py.kill('SIGKILL'), 180_000);
        py.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
      const lastLine = verdict.out.split('\n').filter(Boolean).pop() ?? '{}';
      let v: { prompted?: boolean; firstDone?: boolean; newOk?: boolean; confirmAsked?: boolean; deleted?: boolean; fileGone?: boolean; quit0?: boolean; exitCode?: number | null } = {};
      try {
        v = JSON.parse(lastLine);
      } catch { /* 非 JSON 则下面断言失败 */ }
      suite.assert(v.prompted === true, 'PTY 下看到 mini 提示符');
      suite.assert(v.firstDone === true, '首轮任务完成');
      suite.assert(v.newOk === true, '/new 开新会话');
      suite.assert(v.confirmAsked === true, '/delete 弹出不可恢复确认');
      suite.assert(v.deleted === true, '回 y 后打印已删除会话');
      suite.assert(v.fileGone === true, '旧会话文件已移除');
      suite.assert(v.quit0 === true, `干净退出（exit ${v.exitCode}）`);
      suite.assert(verdict.code === 0, `pty 脚本退出码 0（实际 ${verdict.code}）`);
    } finally {
      mock.kill();
    }
  });
  suite.test('端到端：未知斜杠命令报错不送模型（codex unknown command）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mini-unknown-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 19;
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
      try {
        await waitFor(async () => out.includes('›'), 15000, 'mini 提示符');
        child.stdin.write('/staus xyz\n');
        await waitFor(async () => out.includes('未知命令'), 15000, '未知命令报错');
        suite.assert(out.includes('/staus') && out.includes('/status'), '报错带命令头 + 模糊推荐');
        await sleep(1500);
        suite.assert(!out.includes('mock 端到端验证通过'), '未送模型（无回答）');
        child.stdin.write('/quit\n');
        const code = await Promise.race([closed, sleep(15000).then(() => child.kill('SIGKILL')).then(() => null)]);
        suite.assert(code === 0, `退出码 0（实际 ${code}）`);
      } finally {
        child.kill('SIGKILL');
      }
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
