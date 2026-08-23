/**
 * TUI 快照验证（无 TTY 可用）：用 @opentui/core/testing 的 createTestRenderer 内存渲染。
 *
 * 与真实 CLI 共用 src/tui/render.ts 的 mountTree/repaintTree（同一渲染路径），
 * 断言：思考/工具卡片/回答/用户消息/输入框/状态栏渲染 + 溢出自动跟随最新 + 增量重绘生效。
 *
 * 运行：npm run tui:snapshot（或 bun run ./scripts/tui-snapshot.ts）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { countDiffLines, sideBySideDiff, toolCardLines } from '../src/output/format.js';
import { findSummarizeSplit, selectRelevantFiles } from '../src/agent/context.js';
import type { TrajEvent } from '../src/agent/events.js';
import { gateTool } from '../src/safety/policy.js';
import { CODE_FG, INLINE_CODE_FG, markdownToRows } from '../src/tui/markdown.js';
import { computeRows, hitTestApproval, hitTestCard, mountTree, repaintTree, type CardRect, type TuiSession } from '../src/tui/render.js';
import { buildBody } from '../src/tui/rows.js';
import { enqueuePending, handlePendingKey, movePending, removePending } from '../src/tui/pending.js';
import { SPINNER_FRAMES, createTuiState, pushCmdLine, pushLine, type TuiState } from '../src/tui/state.js';
import { visualWidth } from '../src/tui/width.js';

function fill(state: TuiState, fillLines: number): void {
  state.version = '0.1.0';
  state.model = 'mock';
  pushLine(state, { kind: 'user', text: '你是谁？' });
  pushLine(state, { kind: 'thinking', text: '用户想让我列出目录结构\n先观察再动手' });
  // 工具调用卡片（新格式）：无标题方框，收起态 = 命令 + 执行缩略 + 结果缩略
  pushLine(state, {
    kind: 'tool',
    text: '$ ls -la',
    card: {
      id: 1,
      name: 'list_directory',
      summary: '📁 .',
      status: 'ok',
      output: ['55 个文件/目录', 'AGENTS.md 的完整内容'],
      expanded: false,
      chars: 42,
    },
  });
  for (let i = 0; i < fillLines; i++) pushLine(state, { kind: 'meta', text: `第 ${i + 1} 行填充` });
  pushLine(state, { kind: 'answer', text: '当前目录共 3 个文件。' });
  state.status = '任务完成';
}

/** 建树 + 画一帧，返回测试句柄与字符帧（统一带输入框，与交互模式一致） */
async function render(state: TuiState, height = 20): Promise<{ t: TestRendererSetup; frame: string }> {
  const t = await createTestRenderer({ width: 64, height });
  mountTree(t.renderer, state, { withInput: true });
  await t.renderOnce();
  return { t, frame: t.captureCharFrame() };
}

async function main(): Promise<void> {
  // 场景 1：少量内容，全部可见（含用户消息 + 输入框 + 状态栏）；
  // 视口 25 行（思考模块展开态 +1 头行、16px 圆角灰块 +2 行边框后放不下全部内容）
  const s1 = createTuiState();
  fill(s1, 0);
  const r1 = await render(s1, 25);
  console.log('=== 场景 1：基础布局（输入框模式）===');
  console.log(r1.frame);

  // 无根边框/标题：不应出现 ┌ 边框字符与 Omni 标题
  if (r1.frame.includes('┌') || r1.frame.includes('Omni v')) {
    console.error('✗ 场景 1 仍显示根边框或 Omni 标题（已移除）');
    process.exit(1);
  }
  // 新卡片：无工具名标题（去掉「查看目录」），收起态 = **只显示完整的执行命令**（📁 .）
  // ——执行结果/输出点击展开才显示，无执行缩略/结果缩略/点击展开提示（用户要求）
  const checks1 = ['你是谁？', '📁 .', '当前目录共 3 个文件', '任务完成', '输入消息，Enter 发送', '输入', '模型 mock', '0 轮 · 0 步'];
  // 块式卡片（无边框字符）：每行总宽必须恰为内容宽度且带状态底色（宽度不一致
  // 会让色块右侧露出底色缺口——宽度数学与折行预算精确成立）
  const rows1w = computeRows(s1, { height: 20, width: 64 }, { withInput: true });
  const cardRows1 = rows1w.filter((r) => r.cardId === 1);
  const contentW1 = 64 - 2;
  for (const r of cardRows1) {
    if (visualWidth(r.text) !== contentW1) {
      console.error(`✗ 场景 1 卡片行宽错误: w=${visualWidth(r.text)} text=${JSON.stringify(r.text)}`);
      process.exit(1);
    }
    // 块式卡片每行至少一个 chunk 带状态底色（卡片为 ok → 淡绿 #dcfce7，用户要求
    // 「执行成功使用淡绿色背景」；失败/执行中分别淡红/超淡黄）
    if (!r.chunks || !r.chunks.some((c) => c.bg === '#dcfce7')) {
      console.error(`✗ 场景 1 卡片行缺少状态底色: ${JSON.stringify(r.chunks)}`);
      process.exit(1);
    }
  }
  // 完整长方形（用户要求「不要缺角」）：顶/底留白行整行状态底色填满——单 chunk、
  // 无透明角；不再是「左 1 透明 + 中间 + 右 1 透明」的圆角三 chunk 结构
  const topRow1 = cardRows1.find((r) => r.chunks?.length === 1);
  if (!topRow1 || topRow1.chunks![0].bg !== '#dcfce7') {
    console.error(`✗ 场景 1 卡片顶/底行应整行状态底色填满（完整长方形，无缺角）: ${JSON.stringify(topRow1?.chunks)}`);
    process.exit(1);
  }
  if (cardRows1.some((r) => r.chunks?.length === 3 && r.chunks[0].bg === undefined)) {
    console.error('✗ 场景 1 卡片仍存在圆角三 chunk 行（已改为完整长方形）');
    process.exit(1);
  }
  // 卡片不再有边框字符（╭╮│╰╯ 属于旧方框样式，已被色块替代）
  for (const r of cardRows1) {
    if (/[╭╮│╰╯]/.test(r.text)) {
      console.error(`✗ 场景 1 卡片行仍含边框字符: ${JSON.stringify(r.text)}`);
      process.exit(1);
    }
  }
  // 回归：emoji 摘要行宽度必须恰为内容宽度（charWidth 与 OpenTUI 渲染宽度不一致时，
  // 📁 按 1 列算会让色块实际宽 1 列、右侧露出底色缺口）
  const emojiCardRow1 = cardRows1.find((r) => r.text.includes('📁'));
  if (!emojiCardRow1 || visualWidth(emojiCardRow1.text) !== contentW1) {
    console.error(`✗ 场景 1 emoji 摘要行宽度异常: ${JSON.stringify(emojiCardRow1?.text)}`);
    process.exit(1);
  }
  const missing1 = checks1.filter((c) => !r1.frame.includes(c));
  if (missing1.length) {
    console.error(`✗ 场景 1 缺少: ${missing1.join(', ')}`);
    process.exit(1);
  }
  // 无工具名标题：不应出现「查看目录」「点击展开」这类旧文案
  for (const old of ['查看目录', '点击展开']) {
    if (r1.frame.includes(old)) {
      console.error(`✗ 场景 1 仍显示旧卡片文案: ${old}`);
      process.exit(1);
    }
  }
  // 收起态只显示命令：执行缩略/结果首行都不显示（用户要求「执行的结果等点击展开才显示」）
  for (const hidden of ['执行成功', '55 个文件/目录']) {
    if (r1.frame.includes(hidden)) {
      console.error(`✗ 场景 1 收起态仍显示结果/执行缩略: ${hidden}`);
      process.exit(1);
    }
  }
  // 收起态：结果缩略只取输出首行，第二行输出不得泄漏到帧里
  if (r1.frame.includes('AGENTS.md 的完整内容')) {
    console.error('✗ 场景 1 收起态卡片泄漏了输出第二行');
    process.exit(1);
  }
  console.log('✓ 场景 1 通过：无边框/标题 + 用户消息/思考/工具卡片(命令+执行+结果缩略)/回答/输入框/状态栏全部渲染');

  // 场景 2：大量内容溢出 → 自动跟随最新（应看到最新填充行 + 回答 + 状态，看不到最早的行）
  const s2 = createTuiState();
  fill(s2, 40);
  const r2 = await render(s2);
  console.log('=== 场景 2：溢出跟随最新（20 行视口）===');
  console.log(r2.frame);

  const checks2 = ['当前目录共 3 个文件', '任务完成', '第 40 行填充', '上方还有'];
  const missing2 = checks2.filter((c) => !r2.frame.includes(c));
  if (missing2.length) {
    console.error(`✗ 场景 2 缺少最新内容/顶部提示: ${missing2.join(', ')}`);
    process.exit(1);
  }
  if (r2.frame.includes('第 1 行填充') || r2.frame.includes('你是谁？')) {
    console.error('✗ 场景 2 显示了最早的行（未正确跟随最新）');
    process.exit(1);
  }
  console.log('✓ 场景 2 通过：溢出时自动跟随最新 + 顶部「上方还有」提示，旧行被裁剪');

  // 场景 3：状态变更后 repaintTree 增量重绘（模拟 agent 运行中途新增工具步骤）
  const s3 = createTuiState();
  fill(s3, 0);
  const t3 = await createTestRenderer({ width: 64, height: 20 });
  const tree3 = mountTree(t3.renderer, s3, { withInput: true });
  await t3.renderOnce();
  pushLine(s3, {
    kind: 'tool',
    text: '→ Read AGENTS.md',
    card: { id: 2, name: 'read_file', summary: '→ Read AGENTS.md', status: 'running', output: [], expanded: false },
  });
  repaintTree(t3.renderer, tree3, s3, { withInput: true });
  await t3.renderOnce();
  const frame3 = t3.captureCharFrame();
  console.log('=== 场景 3：增量重绘 ===');
  console.log(frame3);
  // 执行中卡片只显示 loading（spinner 帧/⏳ 回退），**不含「执行中…」文字**（用户要求
  // 「不需要显示文字，显示一个执行中 loading 即可」）；spinnerIndex=-1 时回退 ⏳
  if (!frame3.includes('→ Read AGENTS.md') || !frame3.includes('⏳') || frame3.includes('📄') || frame3.includes('执行中')) {
    console.error('✗ 场景 3 未显示新增工具卡片或执行中行含文字（应仅 ⏳ loading，无执行中文字）');
    process.exit(1);
  }
  // 执行中动画：spinnerIndex ≥ 0 时卡片执行中行显示 spinner 帧（不再是静态 ⏳）；
  // 帧随 spinnerIndex 变化（动画 loading 由 TuiOutput 200ms 定时器推进，用户要求）
  s3.spinnerIndex = 3;
  repaintTree(t3.renderer, tree3, s3, { withInput: true });
  await t3.renderOnce();
  const frame3spin = t3.captureCharFrame();
  const spinRow3 = frame3spin.split('\n').find((l) => l.includes('⠸'));
  if (!spinRow3 || spinRow3.includes('执行中') || frame3spin.split('\n').some((l) => l.includes('⏳'))) {
    console.error('✗ 场景 3 执行中卡片未显示 spinner 动画帧（应仅 ⠸ loading，无执行中文字/静态 ⏳）');
    process.exit(1);
  }
  console.log('✓ 场景 3 通过：状态变更后 repaintTree 正确更新渲染树（新增无标题卡片开框渲染 + 执行中仅 loading 无文字）');

  // 场景 4：TuiOutput 事件流 + flush() —— 验证最终状态在退出前上屏
  // （30ms 节流窗口内的最后一帧若不 flush 会丢失，这是 exit 前的关键修复）
  const s4 = createTuiState();
  const t4 = await createTestRenderer({ width: 64, height: 24 });
  const tree4 = mountTree(t4.renderer, s4, { withInput: true });
  const fakeSession = {
    paint: async () => {
      repaintTree(t4.renderer, tree4, s4, { withInput: true });
      await t4.renderOnce();
    },
    stop: async () => {},
    input: null,
    onKeyPress: () => () => {},
  };
  const { TuiOutput } = await import('../src/tui/output.js');
  const out = new TuiOutput(s4, { showThinking: true }, fakeSession);
  out.onUserMessage('你是谁？');
  out.banner({ model: 'mock' } as never);
  out.onRound(0, 50);
  // 真实循环：收到消息 onRound 立即预建 thinking 模块头行（用户要求，不等流式 chunk）；
  // 本轮无实际思考（模型直接回答）→ 内容到达时 finishThinking 移除空模块
  const preThink4 = s4.lines.filter((l) => l.kind === 'thinking');
  if (preThink4.length !== 1 || preThink4[0]!.thinkingRunning !== true || preThink4[0]!.text !== '') {
    console.error('✗ 场景 4 onRound 未立即预建 thinking 模块（空内容 running）');
    process.exit(1);
  }
  out.onStreamStart();
  out.thinking.finish(); // 内容到达 → finishThinking（空内容 → 移除空模块）
  if (s4.lines.some((l) => l.kind === 'thinking')) {
    console.error('✗ 场景 4 无实际思考的空 thinking 模块未被移除');
    process.exit(1);
  }
  out.onAnswer('正在分析任务…');
  // 生成中：光标应显示在输出文本末尾，状态栏无“生成中…/思考中…”文案
  await out.flush();
  const frame4mid = t4.captureCharFrame();
  if (!frame4mid.includes('正在分析任务…▌')) {
    console.error('✗ 场景 4 生成中光标未显示在输出末尾');
    process.exit(1);
  }
  if (frame4mid.includes('生成中…') || frame4mid.includes('思考中…')) {
    console.error('✗ 场景 4 生成中仍显示状态栏文案（应为空白 + 光标）');
    process.exit(1);
  }
  out.onToolStep(0, 50, 'run_command', '$ echo mock-ok');
  out.onToolResult(true, 14, ['退出码: 0', 'echo 输出内容']);
  out.onAnswer('任务完成 ✅ 验证通过。');
  out.onAnswerEnd();
  out.onTurnEnd();
  out.onWaitForInput();
  await out.flush();
  const frame4 = t4.captureCharFrame();
  console.log('=== 场景 4：TuiOutput 事件驱动 + flush（卡片收起态）===');
  console.log(frame4);
  // 收起态：**只显示完整的执行命令**（$ echo mock-ok）——执行结果/输出点击展开才显示
  //（用户要求），无执行缩略/结果缩略/点击展开提示；退出码 0 行本就不过滤进卡片
  const checks4 = ['你是谁？', '任务完成 ✅', 'mock', '正在分析任务', '$ echo mock-ok'];
  const missing4 = checks4.filter((c) => !frame4.includes(c));
  if (missing4.length) {
    console.error(`✗ 场景 4 缺少: ${missing4.join(', ')}（flush 或卡片未生效）`);
    process.exit(1);
  }
  for (const old of ['执行命令', '点击展开', '执行成功', 'echo 输出内容']) {
    if (frame4.includes(old)) {
      console.error(`✗ 场景 4 收起态仍显示旧文案/结果: ${old}`);
      process.exit(1);
    }
  }
  // 退出码 0 行（输出首行）不得泄漏进收起态摘要（用户要求「不显示退出码 0」）
  if (frame4.includes('退出码: 0')) {
    console.error('✗ 场景 4 收起态卡片仍显示退出码: 0（已过滤）');
    process.exit(1);
  }
  // 生成结束：光标应消失；等待输入：状态栏应空白（输入框占位符已提示）
  if (frame4.includes('▌')) {
    console.error('✗ 场景 4 生成结束后光标未消失');
    process.exit(1);
  }
  if (frame4.includes('等待输入')) {
    console.error('✗ 场景 4 等待输入状态栏仍显示文案（应空白）');
    process.exit(1);
  }
  const card4 = s4.lines.find((l) => l.kind === 'tool')?.card;
  if (!card4) {
    console.error('✗ 场景 4 未找到工具卡片');
    process.exit(1);
  }
  // 模拟点击展开 → 输出预览进入卡片
  card4.expanded = true;
  await out.flush();
  const frame4b = t4.captureCharFrame();
  console.log('=== 场景 4b：展开卡片（模拟点击）===');
  console.log(frame4b);
  // 展开态：输出预览进入卡片（退出码: 0 行同样过滤，只显示真实输出）
  const checks4b = ['echo 输出内容', '点击收起'];
  const missing4b = checks4b.filter((c) => !frame4b.includes(c));
  if (missing4b.length) {
    console.error(`✗ 场景 4b 展开后缺少输出: ${missing4b.join(', ')}`);
    process.exit(1);
  }
  if (frame4b.includes('退出码: 0')) {
    console.error('✗ 场景 4b 展开后仍显示退出码: 0（已过滤）');
    process.exit(1);
  }
  console.log('✓ 场景 4 通过：flush() 上屏 + 卡片收起（命令/执行/结果缩略）→ 展开后完整输出正确显示');

  // 场景 5：Markdown 行式渲染 —— **加粗** / `行内代码` / 围栏代码块 / 标题
  // 断言：内容保留、语法标记（**、```）被隐藏（conceal）
  const s5 = createTuiState();
  s5.version = '0.1.0';
  s5.model = 'mock';
  pushLine(s5, {
    kind: 'answer',
    text: '这是 **加粗** 和 `行内代码`\n```js\nconst a = 1;\n```\n- 列表项\n## 小标题',
  });
  s5.status = '任务完成';
  const r5 = await render(s5);
  console.log('=== 场景 5：Markdown 行式渲染 ===');
  console.log(r5.frame);
  const checks5 = ['加粗', '行内代码', 'const a = 1;', '列表项', '小标题'];
  const missing5 = checks5.filter((c) => !r5.frame.includes(c));
  if (missing5.length) {
    console.error(`✗ 场景 5 缺少内容: ${missing5.join(', ')}`);
    process.exit(1);
  }
  for (const leaked of ['**', '```', '## ']) {
    if (r5.frame.includes(leaked)) {
      console.error(`✗ 场景 5 语法标记未隐藏: ${JSON.stringify(leaked)}`);
      process.exit(1);
    }
  }
  console.log('✓ 场景 5 通过：加粗/行内代码/代码块内容渲染，语法标记隐藏');

  // 场景 6：markdownToRows 样式单元断言（字符帧看不到样式，这里直接断言 chunk）
  console.log('=== 场景 6：markdownToRows 样式单元断言 ===');
  const md1 = markdownToRows('**加粗** `代码` *斜体* foo_bar');
  const c1 = md1[0].chunks;
  const boldC = c1.find((c) => c.bold);
  const codeC = c1.find((c) => c.fg === INLINE_CODE_FG);
  const italicC = c1.find((c) => c.italic);
  if (!boldC || boldC.text !== '加粗') {
    console.error(`✗ 场景 6 加粗未生效: ${JSON.stringify(c1)}`);
    process.exit(1);
  }
  if (!codeC || codeC.text !== '代码') {
    console.error(`✗ 场景 6 行内代码未生效: ${JSON.stringify(c1)}`);
    process.exit(1);
  }
  if (!italicC || italicC.text !== '斜体') {
    console.error(`✗ 场景 6 斜体未生效: ${JSON.stringify(c1)}`);
    process.exit(1);
  }
  if (c1.some((c) => c.italic && c.text.includes('bar'))) {
    console.error('✗ 场景 6 snake_case 标识符被误渲染为斜体');
    process.exit(1);
  }
  const md2 = markdownToRows('```js\nconst a = 1;\n```\n## 标题\n> 引用');
  const codeRow = md2[0].chunks[0];
  const headingRow = md2[1].chunks[0];
  const quoteRow = md2[2].chunks[0];
  if (codeRow.text !== 'const a = 1;' || codeRow.fg !== CODE_FG) {
    console.error(`✗ 场景 6 代码块行样式错误: ${JSON.stringify(codeRow)}`);
    process.exit(1);
  }
  if (!headingRow.bold || headingRow.fg !== 'cyan') {
    console.error(`✗ 场景 6 标题样式错误: ${JSON.stringify(headingRow)}`);
    process.exit(1);
  }
  if (!quoteRow.dim) {
    console.error(`✗ 场景 6 引用样式错误: ${JSON.stringify(quoteRow)}`);
    process.exit(1);
  }
  console.log('✓ 场景 6 通过：加粗/行内代码/斜体/代码块/标题/引用样式正确，snake_case 不误伤');

  // 场景 7：溢出后上滚回看历史（scrollTop 指向历史窗口 + 底部滚动提示行）
  const s7 = createTuiState();
  fill(s7, 40);
  s7.scrollTop = 0; // 回滚到最早的内容
  const r7 = await render(s7, 21); // 思考头行 +1 行后 21 行才容得下 📁 .（scrollTop=0 窗 cap-1）
  console.log('=== 场景 7：上滚回看历史（scrollTop=0）===');
  console.log(r7.frame);
  const checks7 = ['你是谁？', '📁 .', '已上滚'];
  const missing7 = checks7.filter((c) => !r7.frame.includes(c));
  if (missing7.length) {
    console.error(`✗ 场景 7 上滚后缺少历史内容/提示行: ${missing7.join(', ')}`);
    process.exit(1);
  }
  if (r7.frame.includes('第 40 行填充')) {
    console.error('✗ 场景 7 上滚后仍显示最新行（滚动窗口未生效）');
    process.exit(1);
  }
  // 回到跟随模式 → 恢复显示最新
  s7.scrollTop = null;
  const r7b = await render(s7);
  if (!r7b.frame.includes('第 40 行填充') || r7b.frame.includes('你是谁？') || r7b.frame.includes('已上滚')) {
    console.error('✗ 场景 7 回到底部后未恢复跟随最新');
    process.exit(1);
  }
  console.log('✓ 场景 7 通过：scrollTop 上滚回看历史 + 提示行，回到 null 恢复跟随最新');

  // 场景 8：长行自动折行 —— 超宽行按显示列数折成多行（不截断），输入框布局不受影响
  // 内容宽度 = 64 - 4 = 60：普通行（user）与 Markdown 行（answer）两条折行路径都覆盖；
  // 中文散文在标点（，）后断行，每段完整可见可计数。
  const s8 = createTuiState();
  s8.version = '0.1.0';
  s8.model = 'mock';
  pushLine(s8, { kind: 'user', text: '这是一条非常长的用户消息用来验证普通行的自动折行，'.repeat(4) + 'USEREND' });
  pushLine(s8, { kind: 'answer', text: '很长的单行内容，'.repeat(12) + '……ENDMARKER' });
  s8.status = '任务完成';
  const r8 = await render(s8, 24);
  console.log('=== 场景 8：长行自动折行（内容宽度 60）===');
  console.log(r8.frame);
  const userRepeats8 = r8.frame.split('这是一条非常长的用户消息用来验证普通行的自动折行').length - 1;
  const answerRepeats8 = r8.frame.split('很长的单行内容').length - 1;
  if (userRepeats8 < 4) {
    console.error(`✗ 场景 8 普通长行被截断（只看到 ${userRepeats8}/4 段，应折行完整显示）`);
    process.exit(1);
  }
  if (answerRepeats8 < 12) {
    console.error(`✗ 场景 8 Markdown 长行被截断（只看到 ${answerRepeats8}/12 段，应折行完整显示）`);
    process.exit(1);
  }
  if (!r8.frame.includes('USEREND') || !r8.frame.includes('ENDMARKER')) {
    console.error('✗ 场景 8 行尾内容丢失（应完整显示，不被截断）');
    process.exit(1);
  }
  if (!r8.frame.includes('输入消息，Enter 发送') || !r8.frame.includes('输入')) {
    console.error('✗ 场景 8 输入框未完整渲染（长行折行撑破了布局）');
    process.exit(1);
  }
  console.log('✓ 场景 8 通过：普通行与 Markdown 行均自动折行完整显示，输入框布局未被撑破');

  // 场景 9：鼠标滚轮滚动意图（lines 步长消费）+ 跟随模式顶部溢出提示
  const s9 = createTuiState();
  fill(s9, 40);
  s9.scrollTop = 30;
  s9.scrollIntent = { action: 'line-up', lines: 3 };
  const r9 = computeRows(s9, { height: 20, width: 64 }, { withInput: true });
  if (s9.scrollTop !== 27) {
    console.error(`✗ 场景 9 滚轮上滚步长未生效（scrollTop=${s9.scrollTop}，期望 27）`);
    process.exit(1);
  }
  const last9 = r9[r9.length - 1];
  if (!last9.text.includes('已上滚')) {
    console.error(`✗ 场景 9 上滚模式底部提示行缺失: ${last9.text}`);
    process.exit(1);
  }
  s9.scrollIntent = { action: 'bottom' };
  computeRows(s9, { height: 20, width: 64 }, { withInput: true });
  const topHint9 = computeRows(s9, { height: 20, width: 64 }, { withInput: true })[0];
  if (!topHint9.text.includes('上方还有')) {
    console.error(`✗ 场景 9 跟随模式顶部溢出提示缺失: ${topHint9.text}`);
    process.exit(1);
  }
  console.log('✓ 场景 9 通过：滚轮步长滚动（lines=3）+ 回底部后顶部溢出提示');

  // 场景 10：多行输入框（opencode 风格）——Enter 发送 / Shift+Enter 换行 / 自动增高
  // a) 真实 Textarea 渲染：setText 三行内容后输入框自动增高，三行全部可见
  const s10 = createTuiState();
  s10.version = '0.1.0';
  s10.model = 'mock';
  pushLine(s10, { kind: 'user', text: '多行输入测试' });
  pushLine(s10, { kind: 'answer', text: '这是回答。' });
  s10.status = '任务完成';
  const t10 = await createTestRenderer({ width: 64, height: 20 });
  const tree10 = mountTree(t10.renderer, s10, { withInput: true });
  await t10.renderOnce();
  const inp10 = tree10.input;
  if (!inp10) {
    console.error('✗ 场景 10 输入框未创建');
    process.exit(1);
  }
  // 空输入时占位符可见（且单行，不撑破预算）
  const frame10empty = t10.captureCharFrame();
  if (!frame10empty.includes('输入消息，Enter 发送')) {
    console.error('✗ 场景 10 空输入时占位符缺失');
    process.exit(1);
  }
  inp10.setText('第一行\n第二行\n第三行');
  inp10.focus();
  await t10.renderOnce();
  const frame10 = t10.captureCharFrame();
  console.log('=== 场景 10：多行输入框自动增高 ===');
  console.log(frame10);
  const checks10 = ['第一行', '第二行', '第三行'];
  const missing10 = checks10.filter((c) => !frame10.includes(c));
  if (missing10.length) {
    console.error(`✗ 场景 10 多行输入未完整渲染: ${missing10.join(', ')}`);
    process.exit(1);
  }
  // 清空后应复位为单行（setText 是唯一可靠的清空路径）
  inp10.setText('');
  await t10.renderOnce();
  const frame10b = t10.captureCharFrame();
  if (frame10b.includes('第一行') || frame10b.includes('第三行')) {
    console.error('✗ 场景 10 setText 清空后内容残留');
    process.exit(1);
  }
  // b) 预算单元断言：inputLines=3 时内容区比 inputLines=1 少 2 行（输入框增高收缩内容区）
  const s10b = createTuiState();
  fill(s10b, 20);
  const rows1 = computeRows(s10b, { height: 20, width: 64 }, { withInput: true });
  s10b.inputLines = 3;
  const rows3 = computeRows(s10b, { height: 20, width: 64 }, { withInput: true });
  if (rows1.length - rows3.length !== 2) {
    console.error(`✗ 场景 10 输入框增高后内容区预算未收缩（1行=${rows1.length}，3行=${rows3.length}，应差 2）`);
    process.exit(1);
  }
  console.log('✓ 场景 10 通过：多行输入自动增高 + 内容区预算随输入框高度收缩');

  // 场景 11：点击命中判定（hitTestCard 纯函数）——卡片展开/收起切换 + 坐标映射
  const s11 = createTuiState();
  fill(s11, 0);
  const rows11 = computeRows(s11, { height: 20, width: 64 }, { withInput: true });
  // 与 repaintTree 相同逻辑重建 cardRects（根 paddingY:1：内容行 i → 事件 y = i + 1）
  const rects11 = new Map<number, CardRect>();
  rows11.forEach((r, i) => {
    if (r.cardId !== undefined) {
      const y2 = i + 1;
      const rect = rects11.get(r.cardId);
      if (rect) rect.bottom = y2;
      else rects11.set(r.cardId, { top: y2, bottom: y2 });
    }
  });
  const cardIdx11 = rows11.findIndex((r) => r.cardId === 1);
  if (cardIdx11 < 0) {
    console.error('✗ 场景 11 未找到卡片行');
    process.exit(1);
  }
  const card11 = s11.lines.find((l) => l.kind === 'tool')?.card;
  if (!card11) {
    console.error('✗ 场景 11 未找到卡片数据');
    process.exit(1);
  }
  const y11 = cardIdx11 + 1; // 卡片首行的 0-based 鼠标事件坐标（根 paddingY:1 → y = i + 1）
  if (card11.expanded) {
    console.error('✗ 场景 11 初始应为收起态');
    process.exit(1);
  }
  if (!hitTestCard(s11, rects11, y11) || !card11.expanded) {
    console.error('✗ 场景 11 点击卡片未展开');
    process.exit(1);
  }
  if (!hitTestCard(s11, rects11, y11) || card11.expanded) {
    console.error('✗ 场景 11 再次点击未收起');
    process.exit(1);
  }
  if (hitTestCard(s11, rects11, 0)) {
    console.error('✗ 场景 11 空白区域误命中');
    process.exit(1);
  }
  // 展开态渲染：输出进入卡片
  card11.expanded = true;
  const r11 = await render(s11);
  if (!r11.frame.includes('55 个文件/目录') || !r11.frame.includes('点击收起')) {
    console.error('✗ 场景 11 展开态未显示输出');
    process.exit(1);
  }
  console.log('✓ 场景 11 通过：hitTestCard 点击命中/展开/收起/空白不命中 + 展开态渲染输出');

  // 场景 12：多行/超长命令摘要不乱码（用户报告"运行指令乱码"回归）
  // a) formatToolCall 对多行命令（python3 -c "…\n…"）折叠换行 + 按列截断 → 恒为单行
  const { formatToolCall, toolCardLines } = await import('../src/output/format.js');
  const sum = formatToolCall('run_command', {
    command: 'curl -s "wttr.in/Beijing?lang=zh&format=j1" | python3 -c "\nimport json,sys\nimport datetime\nd=json.load(sys.stdin)\nprint(d)"',
  });
  if (sum.includes('\n')) {
    console.error(`✗ 场景 12 摘要仍含换行（会打破卡片边框）: ${JSON.stringify(sum)}`);
    process.exit(1);
  }
  if (!sum.startsWith('$ curl') || !sum.endsWith('…')) {
    console.error(`✗ 场景 12 摘要截断异常: ${JSON.stringify(sum)}`);
    process.exit(1);
  }
  // b) toolCardLines 防御路径：即使摘要带 \n，每行仍保持完整（无内嵌换行）
  const cardLines = toolCardLines(
    { name: 'run_command', summary: '第一段\n第二段 python3 -c "import json,sys"', status: 'ok', output: [], expanded: false, chars: 3 },
    60
  );
  for (const ln of cardLines) {
    if (ln.text.includes('\n')) {
      console.error(`✗ 场景 12 卡片行内嵌换行: ${JSON.stringify(ln.text)}`);
      process.exit(1);
    }
  }
  // 块式卡片：无边框字符（╭╮│╰╯ 已被颜色背景块替代），首尾为空白留白行（top/bottom 角色）
  if (cardLines[0].role !== 'top' || cardLines[cardLines.length - 1].role !== 'bottom') {
    console.error(`✗ 场景 12 卡片首尾行角色异常: ${cardLines.map((l) => l.role).join('|')}`);
    process.exit(1);
  }
  if (cardLines.some((l) => /[╭╮│╰╯]/.test(l.text))) {
    console.error(`✗ 场景 12 卡片行仍含边框字符: ${cardLines.map((l) => l.text).join('|')}`);
    process.exit(1);
  }
  // 每行总宽恰为内容宽度（色块填满，无缺口）
  for (const ln of cardLines) {
    if (visualWidth(ln.text) !== 60) {
      console.error(`✗ 场景 12 卡片行宽异常: w=${visualWidth(ln.text)} text=${JSON.stringify(ln.text)}`);
      process.exit(1);
    }
  }
  if (!cardLines.some((l) => l.text.includes('第一段')) || !cardLines.some((l) => l.text.includes('第二段'))) {
    console.error(`✗ 场景 12 摘要内容丢失: ${cardLines.map((l) => l.text).join('|')}`);
    process.exit(1);
  }
  // 收起态结构：top → cmd（完整命令，折行）→ bottom（用户要求只显示执行命令）
  const roles12 = cardLines.map((l) => l.role);
  const expectRoles12 = ['top', 'cmd', 'cmd', 'bottom'];
  if (JSON.stringify(roles12) !== JSON.stringify(expectRoles12)) {
    console.error(`✗ 场景 12 收起态角色结构异常: ${JSON.stringify(roles12)}`);
    process.exit(1);
  }
  // c) 真实 TUI 渲染：多行命令摘要的卡片 + 展开态输出，边框完整（无断行的 │）
  const s12 = createTuiState();
  s12.version = '0.1.0';
  s12.model = 'mock';
  pushLine(s12, {
    kind: 'tool',
    text: sum,
    card: { id: 12, name: 'run_command', summary: sum, status: 'ok', output: ['退出码: 0', 'sunny'], expanded: true },
  });
  s12.status = '任务完成';
  const r12 = await render(s12);
  console.log('=== 场景 12：多行命令摘要卡片（换行折叠 + 色块完整）===');
  console.log(r12.frame);
  // 展开态输出：退出码: 0 行已过滤（用户要求不显示），真实输出 sunny 保留
  if (!r12.frame.includes('sunny') || !r12.frame.includes('点击收起') || r12.frame.includes('退出码: 0')) {
    console.error('✗ 场景 12 展开态输出缺失或仍显示退出码: 0');
    process.exit(1);
  }
  console.log('✓ 场景 12 通过：多行命令折叠为单行摘要 + 卡片色块完整不乱码');

  // 场景 13：footer 统计行（轮次/步数/耗时/首 token/速率/缓存命中/输入输出）——灰色块下方整行
  const s13 = createTuiState();
  s13.version = '0.1.0';
  s13.model = 'grok-4.5';
  s13.tokens = { prompt: 1234, completion: 567, total: 1801 };
  pushLine(s13, { kind: 'user', text: '你好' });
  s13.status = '任务完成';
  const r13 = await render(s13);
  console.log('=== 场景 13：footer 统计行（窄屏段级截断）===');
  console.log(r13.frame);
  const checks13 = ['模型 grok-4.5', '0 轮 · 0 步', 'LLM 0s · 工具调用 0.0s', '…'];
  const missing13 = checks13.filter((c) => !r13.frame.includes(c));
  if (missing13.length) {
    console.error(`✗ 场景 13 footer 缺少: ${missing13.join(', ')}`);
    process.exit(1);
  }
  // 窄屏段级截断：第三段（首 token/速率）起被省略，只保留左侧段 + … 标记
  if (r13.frame.includes('首 token 平均')) {
    console.error('✗ 场景 13 窄屏未截断统计行（应省略首 token/速率段）');
    process.exit(1);
  }
  // 统计事件累计：TuiOutput 各事件（onTurnStart/onToolStep/onLlmLap/onToolsLap/onUsage）累加进 state
  const s13b = createTuiState();
  const t13b = await createTestRenderer({ width: 120, height: 20 });
  const tree13b = mountTree(t13b.renderer, s13b, { withInput: true });
  const fakeSession13 = {
    paint: async () => {
      repaintTree(t13b.renderer, tree13b, s13b, { withInput: true });
      await t13b.renderOnce();
    },
    stop: async () => {},
    input: null,
    onKeyPress: () => () => {},
  };
  const { TuiOutput: TuiOutput13 } = await import('../src/tui/output.js');
  const out13 = new TuiOutput13(s13b, { showThinking: true }, fakeSession13);
  out13.onTurnStart(); // 轮 +1
  out13.onToolStep(0, 50, 'run_command', '$ ls'); // 步 +1
  out13.onLlmLap(1000, 500); // LLM 墙钟 1s + 首 token 500ms
  out13.onToolsLap(200); // 工具墙钟 0.2s
  out13.onUsage({ prompt: 1000, completion: 200, total: 1200, cached: 970 });
  out13.onUsage({ prompt: 300, completion: 150, total: 450, cached: 30 });
  await out13.flush();
  const frame13 = t13b.captureCharFrame();
  // 期望：1 轮 · 1 步| LLM 1s · 工具调用 0.2s| 首 token 平均 0.5s · 350 tok/s| 缓存命中 77%| 输入 1.3K tok · 输出 350 tok
  const expect13 = '1 轮 · 1 步| LLM 1s · 工具调用 0.2s| 首 token 平均 0.5s · 350 tok/s| 缓存命中 77%| 输入 1.3K tok · 输出 350 tok';
  if (!frame13.includes(expect13)) {
    console.error(`✗ 场景 13 统计累计不符\n期望: ${expect13}\n实际 tokens: ${JSON.stringify(s13b.tokens)}\n实际 stats: ${JSON.stringify(s13b.stats)}`);
    process.exit(1);
  }
  // 用户示例格式验证（示例值：7 轮 · 41 步| LLM 6m35s · 工具调用 7s| 首 token 平均 6.5s · 112 tok/s| 缓存命中 97%| 输入 3M tok · 输出 44.2K tok）
  const s13c = createTuiState();
  s13c.model = 'mock';
  s13c.tokens = { prompt: 3_000_000, completion: 44_200, total: 3_044_200, cached: 2_910_000 };
  s13c.stats = { turns: 7, steps: 41, llmMs: 394_642, toolsMs: 7_000, firstTokenSum: 45_500, firstTokenCount: 7, cached: 2_910_000 };
  const t13c = await createTestRenderer({ width: 120, height: 20 });
  const tree13c = mountTree(t13c.renderer, s13c, { withInput: true });
  await t13c.renderOnce();
  const frame13c = t13c.captureCharFrame();
  const expect13c = '7 轮 · 41 步| LLM 6m35s · 工具调用 7.0s| 首 token 平均 6.5s · 112 tok/s| 缓存命中 97%| 输入 3M tok · 输出 44.2K tok';
  if (!frame13c.includes(expect13c)) {
    console.error(`✗ 场景 13 示例格式不符\n期望: ${expect13c}\n实际帧:\n${frame13c}`);
    process.exit(1);
  }
  console.log('✓ 场景 13 通过：footer 统计行（窄屏截断/事件累计/完整示例格式）渲染正确');

  // 场景 14：用户消息左侧蓝色细线（▍≈3px）+ 白色文本 + 灰色背景——折行后每行都保留
  const s14 = createTuiState();
  s14.version = '0.1.0';
  s14.model = 'mock';
  pushLine(s14, { kind: 'user', text: '这是一条非常长的用户消息用来验证左侧蓝色细线与灰底在折行后每一行都保留，' + '继续加长确保超过内容宽度，' + 'USERBAR-END' });
  s14.status = '任务完成';
  const rows14 = computeRows(s14, { height: 20, width: 64 }, { withInput: true });
  const userRows14 = rows14.filter((r) => r.chunks?.some((c) => c.fg === '#3b82f6' && c.text === '▍'));
  if (userRows14.length < 2) {
    console.error(`✗ 场景 14 用户消息折行后细线行数不足（${userRows14.length}，应 ≥2）`);
    process.exit(1);
  }
  for (const r of userRows14) {
    const first = r.chunks?.[0];
    if (!first || first.fg !== '#3b82f6' || first.text !== '▍' || first.bg !== '#3f3f46') {
      console.error(`✗ 场景 14 行首细线 chunk 异常: ${JSON.stringify(first)}`);
      process.exit(1);
    }
    // 文本 chunk：白色 + 灰色背景（用户消息气泡底色）
    const rest = r.chunks!.slice(1);
    if (!rest.some((c) => c.bg === '#3f3f46') || !rest.some((c) => c.fg === '#e2e8f0')) {
      console.error(`✗ 场景 14 文本未白字灰底: ${JSON.stringify(rest)}`);
      process.exit(1);
    }
    if (!r.text.startsWith('▍')) {
      console.error(`✗ 场景 14 行首缺细线字符: ${JSON.stringify(r.text)}`);
      process.exit(1);
    }
  }
  const joined14 = userRows14.map((r) => r.text).join('');
  if (!joined14.includes('USERBAR-END')) {
    console.error('✗ 场景 14 长用户消息行尾内容丢失');
    process.exit(1);
  }
  const r14 = await render(s14);
  const frame14 = r14.frame;
  if (!frame14.includes('USERBAR-END') || !frame14.includes('输入消息，Enter 发送')) {
    console.error('✗ 场景 14 渲染帧缺内容或输入框被挤坏');
    process.exit(1);
  }
  console.log('✓ 场景 14 通过：用户消息每行蓝色细线（▍）+ 白字灰底 + 内容完整 + 布局未破坏');

  // 场景 16：亮色主题 —— 灰色块与用户消息改为淡灰底 + 深色文字（主题色板切换）
  const s16 = createTuiState();
  s16.version = '0.1.0';
  s16.model = 'mock';
  s16.themeMode = 'light'; // 模拟亮色终端（OpenTUI 按终端背景亮度检测）
  pushLine(s16, { kind: 'user', text: '你好' });
  s16.status = '任务完成';
  // a) 用户消息 chunk：淡灰底 + 深色文字（与深色主题的白字灰底相反）
  const rows16 = computeRows(s16, { height: 20, width: 64 }, { withInput: true });
  const userRow16 = rows16.find((r) => r.chunks?.some((c) => c.text === '你好'));
  if (!userRow16) {
    console.error('✗ 场景 16 亮色主题未找到用户消息行');
    process.exit(1);
  }
  const bar16 = userRow16.chunks?.[0];
  const text16 = userRow16.chunks?.find((c) => c.text === '你好');
  if (!bar16 || bar16.fg !== '#2563eb' || bar16.bg !== '#e4e4e7') {
    console.error(`✗ 场景 16 亮色主题蓝色细线样式错误: ${JSON.stringify(bar16)}（应 fg #2563eb + bg #e4e4e7）`);
    process.exit(1);
  }
  if (!text16 || text16.fg !== '#27272a' || text16.bg !== '#e4e4e7') {
    console.error(`✗ 场景 16 亮色主题用户消息文字样式错误: ${JSON.stringify(text16)}（应 fg #27272a + bg #e4e4e7）`);
    process.exit(1);
  }
  // b) 真实渲染树：footer 灰色块 / 输入框 / 蓝色细线 / 模型行均换淡灰底或深色文字
  const t16 = await createTestRenderer({ width: 64, height: 20 });
  const tree16 = mountTree(t16.renderer, s16, { withInput: true });
  await t16.renderOnce();
  const bgInts = (c: unknown): number[] => ((c as { toInts: () => number[] }).toInts?.() ?? []).slice(0, 3);
  if (!tree16.footerBox || JSON.stringify(bgInts(tree16.footerBox.backgroundColor)) !== JSON.stringify([228, 228, 231])) {
    console.error(`✗ 场景 16 亮色主题 footer 底色错误: ${JSON.stringify(bgInts(tree16.footerBox?.backgroundColor))}（应 [228,228,231]）`);
    process.exit(1);
  }
  // 亮色修复：内容区根背景 = 白（不再是黑色）、输入框与灰块同色（用户要求去掉白色背景）
  if (JSON.stringify(bgInts(tree16.root.backgroundColor)) !== JSON.stringify([255, 255, 255])) {
    console.error(`✗ 场景 16 亮色主题内容区根背景未变白: ${JSON.stringify(bgInts(tree16.root.backgroundColor))}（应 [255,255,255]）`);
    process.exit(1);
  }
  if (!tree16.input || JSON.stringify(bgInts(tree16.input.backgroundColor)) !== JSON.stringify([228, 228, 231])) {
    console.error('✗ 场景 16 亮色主题输入框底色未与灰块同色（应 [228,228,231] 同 footerBg，不再是白色）');
    process.exit(1);
  }
  if (!tree16.queueBox) {
    console.error('✗ 场景 16 亮色主题排队区缺失');
    process.exit(1);
  }
  const frame16 = t16.captureCharFrame();
  if (!frame16.includes('你好') || !frame16.includes('输入消息，Enter 发送') || !frame16.includes('模型 mock')) {
    console.error('✗ 场景 16 亮色主题渲染帧缺内容');
    process.exit(1);
  }
  // c) 切回深色主题：footer 底色恢复深灰（themeMode 变化在下一帧生效）
  s16.themeMode = 'dark';
  repaintTree(t16.renderer, tree16, s16, { withInput: true });
  await t16.renderOnce();
  if (JSON.stringify(bgInts(tree16.footerBox?.backgroundColor)) !== JSON.stringify([63, 63, 70])) {
    console.error('✗ 场景 16 切回深色主题后 footer 底色未恢复（应 [63,63,70]）');
    process.exit(1);
  }
  if (JSON.stringify(bgInts(tree16.root.backgroundColor)) === JSON.stringify([255, 255, 255])) {
    console.error('✗ 场景 16 切回深色主题后根背景仍是白色（应恢复终端底色）');
    process.exit(1);
  }
  // d) 内容区文字主题化（用户报告：亮色下 AI 输出白字看不见）：
  //    亮色下 AI 回答默认文字 = 深灰、思考/meta（dim 行）显式深灰、markdown 代码块映射深蓝灰；
  //    切回深色后恢复浅色文字。
  const s16b = createTuiState();
  s16b.version = '0.1.0';
  s16b.model = 'mock';
  s16b.themeMode = 'light';
  pushLine(s16b, { kind: 'user', text: '你好' });
  pushLine(s16b, { kind: 'thinking', text: '思考过程' });
  pushLine(s16b, { kind: 'answer', text: '这是回答，含 `代码` 与代码块：\n```js\nconst a = 1;\n```' });
  pushLine(s16b, { kind: 'meta', text: '元信息' });
  s16b.status = '任务完成';
  const t16b = await createTestRenderer({ width: 64, height: 20 });
  const tree16b = mountTree(t16b.renderer, s16b, { withInput: true });
  await t16b.renderOnce();
  const fgInts16 = (c: unknown): number[] => ((c as { toInts: () => number[] }).toInts?.() ?? []).slice(0, 3);
  const cellText16 = (cell: unknown): string => {
    const c = (cell as { content?: unknown }).content;
    if (typeof c === 'string') return c;
    const chunks = (c as { chunks?: { text: string }[] })?.chunks;
    return (chunks ?? []).map((ch) => ch.text).join('');
  };
  const idxOf16 = (text: string): number => tree16b.cells.findIndex((cell) => cellText16(cell).includes(text));
  const ansIdx16 = idxOf16('这是回答');
  const thinkIdx16 = idxOf16('思考过程');
  const metaIdx16 = idxOf16('元信息');
  if (ansIdx16 < 0 || thinkIdx16 < 0 || metaIdx16 < 0) {
    console.error(`✗ 场景 16 未找到内容行细胞（ans=${ansIdx16} think=${thinkIdx16} meta=${metaIdx16}）`);
    process.exit(1);
  }
  if (JSON.stringify(fgInts16(tree16b.cells[ansIdx16].fg)) !== JSON.stringify([39, 39, 42])) {
    console.error(`✗ 场景 16 亮色下 AI 回答仍是浅色文字: ${JSON.stringify(fgInts16(tree16b.cells[ansIdx16].fg))}（应 #27272a=[39,39,42]）`);
    process.exit(1);
  }
  for (const [label, idx] of [['思考', thinkIdx16], ['meta', metaIdx16]] as const) {
    if (JSON.stringify(fgInts16(tree16b.cells[idx].fg)) !== JSON.stringify([82, 82, 91])) {
      console.error(`✗ 场景 16 亮色下 ${label} 行文字不是深灰: ${JSON.stringify(fgInts16(tree16b.cells[idx].fg))}（应 #52525b=[82,82,91]）`);
      process.exit(1);
    }
  }
  // markdown 代码块颜色在亮色下映射为深蓝灰（#8fa3bf → #475569）
  const rows16b = computeRows(s16b, { height: 20, width: 64 }, { withInput: true });
  const codeRow16b = rows16b.find((r) => r.chunks?.some((c) => c.text === 'const a = 1;'));
  if (!codeRow16b || !codeRow16b.chunks?.some((c) => c.fg === '#475569')) {
    console.error(`✗ 场景 16 亮色下 markdown 代码块颜色未映射深色: ${JSON.stringify(codeRow16b?.chunks)}`);
    process.exit(1);
  }
  // 切回深色：回答文字恢复浅色（#e2e8f0=[226,232,240]）
  s16b.themeMode = 'dark';
  repaintTree(t16b.renderer, tree16b, s16b, { withInput: true });
  await t16b.renderOnce();
  if (JSON.stringify(fgInts16(tree16b.cells[ansIdx16].fg)) !== JSON.stringify([226, 232, 240])) {
    console.error(`✗ 场景 16 切回深色后回答文字未恢复浅色: ${JSON.stringify(fgInts16(tree16b.cells[ansIdx16].fg))}`);
    process.exit(1);
  }
  console.log('✓ 场景 16 通过：亮色主题灰色块/用户消息淡灰底+深字，内容区回答/思考/meta/markdown 代码块全部换深色文字，切回深色恢复');

  // 场景 15：输入区 16px 圆角灰块（rounded 边框 + 同色线模拟圆角）+ 右下角发送按钮
  // + 模型/思考强度行（思考强度淡色）；输入增高时灰块同步变高
  const s15 = createTuiState();
  s15.version = '0.1.0';
  s15.model = 'mock';
  pushLine(s15, { kind: 'user', text: '你好' });
  const t15 = await createTestRenderer({ width: 64, height: 24 });
  const tree15 = mountTree(t15.renderer, s15, { withInput: true });
  await t15.renderOnce();
  const toInts15 = (c: unknown): number[] => ((c as { toInts?: () => number[] }).toInts?.() ?? []).slice(0, 3);
  // a) 圆角：rounded 边框 + 边框色与背景色一致（同色边框线不可见，圆角外露终端底色）
  if (!tree15.footerBox || String((tree15.footerBox as { borderStyle?: unknown }).borderStyle) !== 'rounded') {
    console.error('✗ 场景 15 灰块未启用 rounded 圆角边框（应 16px 圆角）');
    process.exit(1);
  }
  if (JSON.stringify(toInts15(tree15.footerBox.borderColor)) !== JSON.stringify(toInts15(tree15.footerBox.backgroundColor))) {
    console.error('✗ 场景 15 灰块边框色与背景色不一致（应同色形成圆角视觉）');
    process.exit(1);
  }
  // b) 发送按钮已移除（TUI 无点击交互，Esc 取消 + Enter 排队 + Cmd/Ctrl+Enter steer 替代）；
  //    模型行保留：模型 + 思考强度（未设置不显示）
  if (!tree15.footerModel || !JSON.stringify(tree15.footerModel.content).includes('模型 mock')) {
    console.error('✗ 场景 15 模型行缺失');
    process.exit(1);
  }
  if (!tree15.footerEffort || JSON.stringify(tree15.footerEffort.content).includes('思考')) {
    console.error('✗ 场景 15 未设置思考级别时不应显示思考强度');
    process.exit(1);
  }
  s15.reasoningEffort = 'medium';
  repaintTree(t15.renderer, tree15, s15, { withInput: true });
  await t15.renderOnce();
  if (!JSON.stringify(tree15.footerEffort?.content).includes('思考 medium')) {
    console.error(`✗ 场景 15 思考强度未显示: ${JSON.stringify(tree15.footerEffort?.content)}`);
    process.exit(1);
  }
  // b2) 输入区域右侧 loading（与模型行同一行）：未运行隐藏；运行中转圈（帧随
  //     loadingIndex 换）；Esc/会话结束（loading=false）清空消失
  if (!tree15.footerLoading) {
    console.error('✗ 场景 15 右侧 loading 节点未创建');
    process.exit(1);
  }
  const loadingText15 = (t: unknown): string => {
    const c = (t as { content?: unknown }).content;
    const chunks = (c as { chunks?: { text: string }[] })?.chunks;
    return (chunks ?? []).map((ch) => ch.text).join('');
  };
  if (loadingText15(tree15.footerLoading) !== '') {
    console.error(`✗ 场景 15 未运行时 loading 应为空: ${JSON.stringify(loadingText15(tree15.footerLoading))}`);
    process.exit(1);
  }
  s15.loading = true;
  s15.loadingIndex = 2;
  repaintTree(t15.renderer, tree15, s15, { withInput: true });
  await t15.renderOnce();
  const frame15load = t15.captureCharFrame();
  const frameLines15 = frame15load.split('\n');
  const modelRow15 = frameLines15.findIndex((l) => l.includes('模型 mock'));
  const loadChar15 = SPINNER_FRAMES[2];
  const loadRow15 = frameLines15.findIndex((l) => l.includes(loadChar15));
  if (loadingText15(tree15.footerLoading) !== loadChar15) {
    console.error(`✗ 场景 15 loading 帧内容错误: ${JSON.stringify(loadingText15(tree15.footerLoading))}（应 ${loadChar15}）`);
    process.exit(1);
  }
  if (loadRow15 !== modelRow15) {
    console.error(`✗ 场景 15 loading 应与模型行同一行（model=${modelRow15} load=${loadRow15}）`);
    console.log(frame15load);
    process.exit(1);
  }
  if (loadRow15 < 0 || frameLines15[loadRow15]!.indexOf(loadChar15) < frameLines15[loadRow15]!.indexOf('模型')) {
    console.error('✗ 场景 15 loading 应位于模型行文字右侧（灰色块右缘）');
    process.exit(1);
  }
  s15.loading = false;
  s15.loadingIndex = -1;
  repaintTree(t15.renderer, tree15, s15, { withInput: true });
  await t15.renderOnce();
  if (loadingText15(tree15.footerLoading) !== '') {
    console.error('✗ 场景 15 会话结束（loading=false）后 loading 应清空');
    process.exit(1);
  }
  // b3) loading 右侧「esc」取消提示：运行中显示（跟随 loading）、结束后消失
  if (!tree15.footerEsc) {
    console.error('✗ 场景 15 footerEsc 节点未创建');
    process.exit(1);
  }
  const escText15 = loadingText15; // 同款 chunks 文本提取
  if (escText15(tree15.footerEsc) !== '') {
    console.error(`✗ 场景 15 未运行时 esc 提示应为空: ${JSON.stringify(escText15(tree15.footerEsc))}`);
    process.exit(1);
  }
  s15.loading = true;
  s15.loadingIndex = 2;
  repaintTree(t15.renderer, tree15, s15, { withInput: true });
  await t15.renderOnce();
  if (escText15(tree15.footerEsc) !== 'esc') {
    console.error(`✗ 场景 15 运行中 esc 提示应显示: ${JSON.stringify(escText15(tree15.footerEsc))}`);
    process.exit(1);
  }
  const escFrame15 = t15.captureCharFrame();
  const escModelRow15 = escFrame15.split('\n').findIndex((l) => l.includes('模型 mock'));
  const escLine15 = escFrame15.split('\n')[escModelRow15];
  if (!escLine15 || !escLine15.includes('esc')) {
    console.error('✗ 场景 15 运行中模型行应含 esc 提示');
    process.exit(1);
  }
  // c) 待发送消息区（输入框正上方）：空列表隐藏；置入消息后显示标题（含 queue/steer 徽标计数）
  //    + 消息行（queue `·` / steer `⚡` 徽标）+ 选中高亮（›）——**钉在灰色块正上方**
  if (!tree15.queueBox || JSON.stringify(tree15.queueBox.visible) !== 'false') {
    console.error('✗ 场景 15 空待发送时消息区应隐藏');
    process.exit(1);
  }
  enqueuePending(s15, 'queue', '第一条排队消息');
  enqueuePending(s15, 'steer', '打断消息');
  enqueuePending(s15, 'queue', '第三条排队消息');
  enqueuePending(s15, 'queue', '第四条排队消息');
  repaintTree(t15.renderer, tree15, s15, { withInput: true });
  await t15.renderOnce();
  const frame15 = t15.captureCharFrame();
  if (
    !frame15.includes('⏳ 待发送（4 · ⚡ 1 打断）') ||
    !frame15.includes('· 第一条排队消息') ||
    !frame15.includes('⚡ 打断消息') ||
    !frame15.includes('第四条排队消息')
  ) {
    console.error('✗ 场景 15 待发送区渲染缺失（应显示标题含打断计数/queue·steer⚡徽标/消息行）');
    console.log(frame15);
    process.exit(1);
  }
  // 待发送区必须**紧贴灰色块正上方**（底部固定块钉底；位置确定与内容长度无关）
  const lines15 = frame15.split('\n');
  const titleIdx15 = lines15.findIndex((l) => l.includes('⏳ 待发送（4'));
  const greyTop15 = lines15.findIndex((l) => l.includes('╮'));
  if (titleIdx15 < 0 || greyTop15 < 0 || titleIdx15 + 5 !== greyTop15) {
    console.error(`✗ 场景 15 待发送区未钉在灰色块正上方（title=${titleIdx15} grey=${greyTop15}，应 title+5==grey）`);
    console.log(frame15);
    process.exit(1);
  }
  // 选中高亮：选中第 3 条（下标 2）→ 该行显示 › 且 pendingRects 命中真实消息行
  s15.pendingSelected = 2;
  repaintTree(t15.renderer, tree15, s15, { withInput: true });
  await t15.renderOnce();
  const frame15c = t15.captureCharFrame();
  if (!frame15c.includes('› · 第三条排队消息')) {
    console.error('✗ 场景 15 选中行未显示 › 高亮');
    console.log(frame15c);
    process.exit(1);
  }
  const rectY15 = [...tree15.pendingRects.entries()].find(([, idx]) => idx === 2)?.[0];
  if (rectY15 === undefined || !lines15[rectY15]?.includes('第三条排队消息')) {
    console.error(`✗ 场景 15 pendingRects 未命中真实消息行（y=${rectY15}）`);
    process.exit(1);
  }
  // d) 左侧蓝色细线（与对话流用户消息同款 ▍）：紧贴灰块左缘、**竖跨整个灰色背景
  //    含上下圆角边框行**——单行输入 = 边框 1 + 输入 1 + 间距 1 + 模型 1 + 边框 1 = 5 行；
  //    增高到 3 行输入后 = 7 行
  if (!tree15.blueLine) {
    console.error('✗ 场景 15 输入区域蓝色细线未创建');
    process.exit(1);
  }
  const barText15 = (t: unknown): string => {
    const c = (t as { content?: unknown }).content;
    if (typeof c === 'string') return c;
    const chunks = (c as { chunks?: { text: string }[] })?.chunks;
    return (chunks ?? []).map((ch) => ch.text).join('');
  };
  if (barText15(tree15.blueLine) !== '▍\n▍\n▍\n▍\n▍') {
    console.error(`✗ 场景 15 单行输入时细线高度错误: ${JSON.stringify(barText15(tree15.blueLine))}（应 5 行 ▍）`);
    process.exit(1);
  }
  // 帧内灰色块**全部行（含上下边框行）**左侧都以 ▍ 开头——细线真实渲染在
  // 输入区域左缘（根 Box paddingX 1 → 行首为空格 + ▍；marginLeft:-1 贴块左缘、
  // 盖住左右角；marginTop/Bottom:-1 溢到底边框行）
  const frame15d = t15.captureCharFrame();
  const lines15d = frame15d.split('\n');
  const greyTop15d = lines15d.findIndex((l) => l.includes('╮'));
  const greyEnd15 = lines15d.findIndex((l) => l.includes('╯'));
  if (greyTop15d < 0 || greyEnd15 <= greyTop15d) {
    console.error('✗ 场景 15 帧中未找到灰色块右缘边框');
    console.log(frame15d);
    process.exit(1);
  }
  const barRows15 = lines15d.slice(greyTop15d, greyEnd15 + 1).filter((l) => l.trimStart().startsWith('▍'));
  if (barRows15.length !== greyEnd15 - greyTop15d + 1) {
    console.error(`✗ 场景 15 细线未撑满整个灰色背景（灰块 ${greyEnd15 - greyTop15d + 1} 行仅 ${barRows15.length} 行 ▍）`);
    console.log(frame15d);
    process.exit(1);
  }
  // e) 输入框增高到 3 行 → 灰块同步变高（输入完整 + 模型行仍在），细线同步变 7 行（边框 2 + 输入 3 + 间距 1 + 模型 1）
  tree15.input?.setText('第一行\n第二行\n第三行');
  repaintTree(t15.renderer, tree15, s15, { withInput: true });
  await t15.renderOnce();
  const frame15b = t15.captureCharFrame();
  if (!frame15b.includes('第一行') || !frame15b.includes('第三行') || !frame15b.includes('模型 mock')) {
    console.error('✗ 场景 15 输入增高后渲染缺失（输入/模型行）');
    process.exit(1);
  }
  if (barText15(tree15.blueLine) !== '▍\n▍\n▍\n▍\n▍\n▍\n▍') {
    console.error(`✗ 场景 15 输入增高后细线高度未同步: ${JSON.stringify(barText15(tree15.blueLine))}（应 7 行 ▍）`);
    process.exit(1);
  }
  const lines15b = frame15b.split('\n');
  const gs15b = lines15b.findIndex((l) => l.includes('╮'));
  const ge15b = lines15b.findIndex((l) => l.includes('╯'));
  const bar15b = lines15b.slice(gs15b, ge15b + 1).filter((l) => l.trimStart().startsWith('▍')).length;
  if (gs15b < 0 || ge15b <= gs15b || bar15b !== ge15b - gs15b + 1) {
    console.error(`✗ 场景 15 增高后细线未撑满灰色背景（灰块 ${ge15b - gs15b + 1} 行仅 ${bar15b} 行 ▍）`);
    console.log(frame15b);
    process.exit(1);
  }
  // f) 圆角边框轮廓：右缘 ╮╯ 保留（蓝线只盖左缘两角，右侧圆角仍可见）
  if (!frame15b.includes('╮') || !frame15b.includes('╯') || frame15b.includes('╭') || frame15b.includes('╰')) {
    console.error('✗ 场景 15 圆角边框轮廓异常（应右缘 ╮╯ 可见、左缘 ╭╰ 被蓝线覆盖）');
    console.log(frame15b);
    process.exit(1);
  }
  console.log('✓ 场景 15 通过：16px 圆角灰块（高度低，paddingY 0）+ 无按钮（Esc 取消+排队替代）+ 模型/思考强度行 + 待发送区渲染（⏳ 待发送/queue·steer⚡ 徽标/› 选中/钉在灰块正上方）+ 输入增高同步 + 左侧蓝色细线（▍ 竖跨整个灰色背景含上下边框行）');

  // 场景 17：/theme 命令面板 —— openThemeMenu 打开面板 + handleMenuKey 选择/确认/取消 + 渲染
  const { closeMenu, handleMenuKey, openThemeMenu } = await import('../src/tui/commands.js');
  const s17 = createTuiState();
  s17.version = '0.1.0';
  s17.model = 'mock';
  s17.themeMode = 'system';
  s17.detectedTheme = 'light'; // 系统跟随：检测到亮色终端
  pushLine(s17, { kind: 'user', text: '你好' });
  s17.status = '任务完成';
  openThemeMenu(s17);
  // a) 面板打开：3 个选项，高亮当前值（system）
  if (!s17.menu || s17.menu.id !== 'theme' || s17.menu.options.length !== 3) {
    console.error('✗ 场景 17 面板未正确打开');
    process.exit(1);
  }
  if (s17.menu.selectedIndex !== 0 || s17.menu.currentValue !== 'system') {
    console.error(`✗ 场景 17 初始高亮/当前值错误: ${JSON.stringify(s17.menu)}`);
    process.exit(1);
  }
  // b) 键盘：↓ 移动高亮 → 数字 2 直接选中「亮色」并确认 → themeMode 变为 light、面板关闭
  const key = (name: string): { name: string; sequence: string; preventDefault: () => void; stopPropagation: () => void } => ({
    name,
    sequence: '',
    preventDefault: () => {},
    stopPropagation: () => {},
  });
  if (!handleMenuKey(key('down'), s17) || s17.menu?.selectedIndex !== 1) {
    console.error('✗ 场景 17 ↓ 未移动高亮');
    process.exit(1);
  }
  if (!handleMenuKey(key('2'), s17) || s17.menu !== null || s17.themeMode !== 'light') {
    console.error('✗ 场景 17 数字键确认未生效（themeMode 应变 light、面板应关闭）');
    process.exit(1);
  }
  // c) Esc 取消：再打开面板 → Esc → 面板关闭且 themeMode 不变
  openThemeMenu(s17);
  s17.menu!.selectedIndex = 2; // 高亮「深色」但不确认
  if (!handleMenuKey(key('escape'), s17) || s17.menu !== null || s17.themeMode !== 'light') {
    console.error('✗ 场景 17 Esc 取消未生效');
    process.exit(1);
  }
  // d) Enter 确认：打开面板 → 高亮「深色」→ Enter → themeMode = dark
  openThemeMenu(s17);
  s17.menu!.selectedIndex = 2;
  if (!handleMenuKey(key('return'), s17) || s17.menu !== null || s17.themeMode !== 'dark') {
    console.error('✗ 场景 17 Enter 确认未生效');
    process.exit(1);
  }
  // e) 面板浮层渲染（alert：绝对定位居中，独立于会话流）：
  //    标题/选项/当前值 ✓/光标 ›/提示行都在；未确认不应有切换提示
  const s17e = createTuiState();
  s17e.version = '0.1.0';
  s17e.model = 'mock';
  s17e.themeMode = 'system';
  pushLine(s17e, { kind: 'user', text: '你好' });
  openThemeMenu(s17e);
  const t17e = await createTestRenderer({ width: 64, height: 20 });
  const tree17e = mountTree(t17e.renderer, s17e, { withInput: true });
  await t17e.renderOnce();
  const r17 = { frame: t17e.captureCharFrame() };
  console.log('=== 场景 17：/settings theme 主题面板（alert 浮层）===');
  console.log(r17.frame);
  const checks17 = ['主题', '跟随系统 ✓', '› 跟随系统', '亮色', '深色', 'Enter 确认', 'Esc 取消'];
  const missing17 = checks17.filter((c) => !r17.frame.includes(c));
  if (missing17.length) {
    console.error(`✗ 场景 17 面板渲染缺: ${missing17.join(', ')}`);
    process.exit(1);
  }
  if (r17.frame.includes('已切换主题')) {
    console.error('✗ 场景 17 未确认就出现了切换提示');
    process.exit(1);
  }
  // 菜单在浮层上（absolute 定位 + 居中），不在内容流里
  if (!tree17e.menuOverlay || !tree17e.menuOverlay.visible) {
    console.error('✗ 场景 17 菜单浮层未显示（应为 alert 浮层）');
    process.exit(1);
  }
  const rows17e = computeRows(s17e, { height: 20, width: 64 }, { withInput: true });
  if (rows17e.some((r) => r.text.includes('跟随系统') || r.text.includes('Enter 确认'))) {
    console.error('✗ 场景 17 菜单行仍内联在内容流（应移到 alert 浮层）');
    process.exit(1);
  }
  const top17 = tree17e.menuOverlay.top as number;
  const left17 = tree17e.menuOverlay.left as number;
  if (typeof top17 !== 'number' || typeof left17 !== 'number' || left17 < 5 || left17 > 15) {
    console.error(`✗ 场景 17 浮层未居中: top=${top17} left=${left17}（panelW=44 时 left 应在 10 附近）`);
    process.exit(1);
  }
  // 关闭面板 → 浮层隐藏
  closeMenu(s17e);
  repaintTree(t17e.renderer, tree17e, s17e, { withInput: true });
  await t17e.renderOnce();
  if (tree17e.menuOverlay.visible) {
    console.error('✗ 场景 17 关闭面板后浮层未隐藏');
    process.exit(1);
  }
  // f) system 跟随：detectedTheme=light 时 system 模式应取亮色主题（用户消息淡灰底 + 深字）
  const s17b = createTuiState();
  s17b.version = '0.1.0';
  s17b.model = 'mock';
  s17b.themeMode = 'system';
  s17b.detectedTheme = 'light';
  pushLine(s17b, { kind: 'user', text: '你好' });
  s17b.status = '任务完成';
  const t17b = await createTestRenderer({ width: 64, height: 20 });
  const tree17b = mountTree(t17b.renderer, s17b, { withInput: true });
  await t17b.renderOnce();
  const bgInts17 = (c: unknown): number[] => ((c as { toInts: () => number[] }).toInts?.() ?? []).slice(0, 3);
  if (!tree17b.footerBox || JSON.stringify(bgInts17(tree17b.footerBox.backgroundColor)) !== JSON.stringify([228, 228, 231])) {
    console.error('✗ 场景 17 system 跟随（detected=light）未取亮色主题');
    process.exit(1);
  }
  // 切检测为 dark → 同帧重绘应回到深灰（system 动态跟随）
  s17b.detectedTheme = 'dark';
  repaintTree(t17b.renderer, tree17b, s17b, { withInput: true });
  await t17b.renderOnce();
  if (JSON.stringify(bgInts17(tree17b.footerBox?.backgroundColor)) !== JSON.stringify([63, 63, 70])) {
    console.error('✗ 场景 17 system 跟随切 dark 后未恢复深灰底');
    process.exit(1);
  }
  console.log('✓ 场景 17 通过：主题面板（打开/↑↓/数字/Enter/Esc）+ 渲染 + system 跟随亮暗');

  // 场景 18：Markdown 表格（box-drawing）+ 删除线 + 任务清单 + 用户消息↔思考间距
  console.log('=== 场景 18：Markdown 表格 / 删除线 / 任务清单 / 用户间距 ===');
  // a) markdownToRows 单元断言：表格边框行 + 删除线 chunk + 任务清单 + 表头样式
  const md18 = markdownToRows(
    '| 项目 | 状态 | 说明 |\n| --- | :---: | --- |\n| 工具调用 | ✅ | 执行成功 |\n| ~~废弃项~~ | ❌ | 已移除 |\n\n- [x] 已完成\n- [ ] 待办'
  );
  const strike18 = md18.flatMap((r) => r.chunks).find((c) => c.strike);
  if (!strike18 || strike18.text !== '废弃项') {
    console.error(`✗ 场景 18 删除线未生效: ${JSON.stringify(strike18)}`);
    process.exit(1);
  }
  const taskDone18 = md18.flatMap((r) => r.chunks).find((c) => c.text === '☑ ');
  const taskTodo18 = md18.flatMap((r) => r.chunks).find((c) => c.text === '☐ ');
  if (!taskDone18 || !taskTodo18) {
    console.error('✗ 场景 18 任务清单未渲染 ☑/☐');
    process.exit(1);
  }
  const headerChunk18 = md18.find((r) => r.chunks.some((c) => c.text === '项目' && c.bold && c.fg === 'cyan'));
  if (!headerChunk18) {
    console.error(`✗ 场景 18 表头未加粗青色: ${JSON.stringify(md18.slice(0, 2))}`);
    process.exit(1);
  }
  // 表格各行（边框 + 内容）总宽一致且 ≤ 内容宽（不折行、对齐不被打破）
  const tableRows18 = md18.filter((r) => r.chunks.some((c) => c.dim && /^[┌├└│]/.test(c.text)));
  const widths18 = tableRows18.map((r) => visualWidth(r.chunks.map((c) => c.text).join('')));
  if (tableRows18.length < 5 || new Set(widths18).size !== 1 || widths18[0] > 60) {
    console.error(`✗ 场景 18 表格行宽不一致或超宽: ${JSON.stringify(widths18)}`);
    process.exit(1);
  }
  // b) 真实渲染：表格边框字符与内容上屏，且无原始管道分隔符泄漏
  const s18 = createTuiState();
  s18.version = '0.1.0';
  s18.model = 'mock';
  pushLine(s18, {
    kind: 'answer',
    text: '表格如下：\n\n| 项目 | 状态 |\n| --- | :---: |\n| 工具 | ✅ |\n\n- [x] 已完成\n\n~~废弃~~',
  });
  s18.status = '任务完成';
  const r18 = await render(s18, 24);
  console.log('=== 场景 18：Markdown 表格渲染 ===');
  console.log(r18.frame);
  const checks18 = ['┌', '└', '项目', '工具', '✅', '☑ ', '废弃'];
  const missing18 = checks18.filter((c) => !r18.frame.includes(c));
  if (missing18.length) {
    console.error(`✗ 场景 18 表格/任务清单/删除线渲染缺: ${missing18.join(', ')}`);
    process.exit(1);
  }
  if (r18.frame.includes('| ---')) {
    console.error('✗ 场景 18 原始表格分隔符泄漏（应渲染成 box-drawing 边框）');
    process.exit(1);
  }
  // c) 用户消息与思考间距：user 行后紧跟 1 行空行，再是 thinking（不再紧贴）
  const s18b = createTuiState();
  s18b.version = '0.1.0';
  s18b.model = 'mock';
  pushLine(s18b, { kind: 'user', text: '你好' });
  pushLine(s18b, { kind: 'thinking', text: '思考中' });
  pushLine(s18b, { kind: 'answer', text: '回答' });
  s18b.status = '任务完成';
  const rows18b = computeRows(s18b, { height: 20, width: 64 }, { withInput: true });
  const userIdx18 = rows18b.findIndex((r) => r.text.includes('你好'));
  // 思考模块展开态 = `- thinking` 头行 + 内容（用户要求）——间距以**头行**为思考起点
  const thinkIdx18 = rows18b.findIndex((r) => r.text.trim().startsWith('- thinking'));
  if (userIdx18 < 0 || thinkIdx18 < 0 || thinkIdx18 - userIdx18 !== 2) {
    console.error(`✗ 场景 18 用户消息与思考之间缺空行（thinkIdx=${thinkIdx18} userIdx=${userIdx18}，应差 2）`);
    process.exit(1);
  }
  if (rows18b[userIdx18 + 1].text !== '' || rows18b[userIdx18 + 1].chunks) {
    console.error('✗ 场景 18 用户消息后的间距行不是空白行');
    process.exit(1);
  }
  // d) 思考内容与回答间距：思考**内容行**后紧跟 1 行空行，再是 answer（不再贴在一起）
  const thinkContentIdx18 = rows18b.findIndex((r) => r.text.includes('思考中'));
  const ansIdx18 = rows18b.findIndex((r) => r.text.includes('回答'));
  if (ansIdx18 < 0 || ansIdx18 - thinkContentIdx18 !== 2) {
    console.error(`✗ 场景 18 思考与回答之间缺空行（ansIdx=${ansIdx18} thinkIdx=${thinkContentIdx18}，应差 2）`);
    process.exit(1);
  }
  if (rows18b[thinkContentIdx18 + 1].text !== '' || rows18b[thinkContentIdx18 + 1].chunks) {
    console.error('✗ 场景 18 思考后的间距行不是空白行');
    process.exit(1);
  }
  // e) thinking ↔ 工具卡片间距（用户要求「loading思考中 和 tool 工具调用的黄色区域
  //    需要合理间距」）：思考与卡片之间 **2 行空白**（组间）+ 卡片顶/底自带黄留白；
  //    tool→thinking 同样 2 行；thinking→回答保持 1 行（回归）
  const s18c = createTuiState();
  s18c.version = '0.1.0';
  s18c.model = 'mock';
  pushLine(s18c, { kind: 'thinking', text: '思考中' });
  pushLine(s18c, {
    kind: 'tool',
    card: { id: 1, name: 'run_command', summary: '$ echo ok', status: 'ok', output: [], expanded: false },
  });
  pushLine(s18c, { kind: 'thinking', text: '继续思考' });
  pushLine(s18c, { kind: 'answer', text: '回答' });
  // buildBody 是全量行（computeRows 有视口尾部裁剪，内容多时会把 thinking 裁掉）
  const rows18c = buildBody(s18c, 64);
  const thinkIdx18c = rows18c.findIndex((r) => r.text.includes('思考中'));
  const cardIdx18c = rows18c.findIndex((r) => r.text.includes('$ echo ok'));
  // 卡片底行 = 最后一行带 cardId 的行（收起态无 result 行，卡片 = top/cmd/bottom）
  const cardBottomIdx18c = rows18c.map((r) => r.cardId).lastIndexOf(1);
  const think2Idx18c = rows18c.findIndex((r) => r.text.includes('继续思考'));
  const ansIdx18c = rows18c.findIndex((r) => r.text.includes('回答'));
  if (thinkIdx18c < 0 || cardIdx18c < 0 || cardIdx18c - thinkIdx18c !== 3) {
    // 1 行空白 + 卡片顶留白 + 命令行 = 差 3（用户反馈「命令执行的块区域和下面的文字
    // 距离太远」，thinking↔卡片统一收为 1 行间距）
    console.error(`✗ 场景 18 thinking↔卡片间距异常（应 1 行空白+顶留白 = 差 3，实际 ${cardIdx18c - thinkIdx18c}）`);
    console.log(rows18c.map((r) => r.text).join('\n'));
    process.exit(1);
  }
  if (rows18c[thinkIdx18c + 1].text !== '') {
    console.error('✗ 场景 18 thinking 后的间距行应为空白行');
    process.exit(1);
  }
  if (think2Idx18c - cardBottomIdx18c !== 3) {
    // 卡片底行 + 1 行空白 + `- thinking` 头行 + 内容 = 差 3（收起态卡片 = top/cmd/bottom）
    console.error(`✗ 场景 18 卡片↔thinking 间距异常（应底留白+1 行空白+头行 = 差 3，实际 ${think2Idx18c - cardBottomIdx18c}）`);
    process.exit(1);
  }
  if (ansIdx18c - think2Idx18c !== 2) {
    console.error(`✗ 场景 18 thinking↔回答应保持 1 行间距（实际差 ${ansIdx18c - think2Idx18c}）`);
    process.exit(1);
  }
  console.log('✓ 场景 18 通过：表格 box-drawing 渲染 + 删除线 + 任务清单 + 用户消息↔思考↔回答间距 + thinking↔工具卡片 2 行间距');

  // 场景 19：/ 命令联想列表 —— 输入 / 显示列表（非模态），前缀过滤 / 无匹配隐藏 + 面板渲染
  const s19 = createTuiState();
  s19.version = '0.1.0';
  s19.model = 'mock';
  pushLine(s19, { kind: 'user', text: '你好' });
  s19.status = '任务完成';
  const t19 = await createTestRenderer({ width: 64, height: 20 });
  const tree19 = mountTree(t19.renderer, s19, { withInput: true });
  await t19.renderOnce();
  // a) 输入 '/' → 联想列出全部命令（items 全量 32 条不再截断；紧凑窗口 = 6 行 + ↓ 提示行）
  tree19.input?.setText('/');
  repaintTree(t19.renderer, tree19, s19, { withInput: true });
  await t19.renderOnce();
  if (!s19.cmdSuggest || s19.cmdSuggest.items.length !== 34 || s19.cmdSuggest.top !== 0 || s19.cmdSuggest.window !== 6) {
    console.error(`✗ 场景 19 输入 / 未列出全部命令（items 应 34、窗口应 6）: ${JSON.stringify(s19.cmdSuggest)}`);
    process.exit(1);
  }
  // 面板是圆角方框（整体背景 + rounded 圆角 12 风格）：border=true + borderStyle='rounded'
  if (!tree19.suggestBox || tree19.suggestBox.border !== true || tree19.suggestBox.borderStyle !== 'rounded') {
    console.error(`✗ 场景 19 联想面板未启用圆角边框: border=${tree19.suggestBox?.border} style=${tree19.suggestBox?.borderStyle}`);
    process.exit(1);
  }
  // b) 前缀过滤：'/th' → 只剩 thinking（/t 会同时命中 thinking 与 tokens——tokens 已并入 /settings）
  tree19.input?.setText('/th');
  repaintTree(t19.renderer, tree19, s19, { withInput: true });
  await t19.renderOnce();
  if (!s19.cmdSuggest || s19.cmdSuggest.items.length !== 1 || s19.cmdSuggest.items[0] !== 'thinking') {
    console.error(`✗ 场景 19 前缀过滤错误: ${JSON.stringify(s19.cmdSuggest)}`);
    process.exit(1);
  }
  // c) 无匹配自动隐藏（互不影响输入——列表不拦截，用户可继续输入任意文本）
  tree19.input?.setText('/xyz');
  repaintTree(t19.renderer, tree19, s19, { withInput: true });
  await t19.renderOnce();
  if (s19.cmdSuggest !== null) {
    console.error('✗ 场景 19 无匹配应隐藏联想列表');
    process.exit(1);
  }
  // d) 普通文本不触发联想
  tree19.input?.setText('你好呀');
  repaintTree(t19.renderer, tree19, s19, { withInput: true });
  await t19.renderOnce();
  if (s19.cmdSuggest !== null) {
    console.error('✗ 场景 19 普通文本不应显示联想');
    process.exit(1);
  }
  // d2) Esc 关闭后保持隐藏（文本未变不复活；变了才恢复）——review 抓到的 bug 回归
  tree19.input?.setText('/th');
  repaintTree(t19.renderer, tree19, s19, { withInput: true });
  await t19.renderOnce();
  if (!s19.cmdSuggest || s19.cmdSuggest.items.length !== 1) {
    console.error('✗ 场景 19 Esc 回归前置条件失败（/th 应列出 thinking）');
    process.exit(1);
  }
  s19.cmdSuggestDismissedText = '/th'; // 模拟 interactive.ts 的 Esc 分支
  repaintTree(t19.renderer, tree19, s19, { withInput: true });
  await t19.renderOnce();
  if (s19.cmdSuggest !== null) {
    console.error('✗ 场景 19 Esc 关闭后列表复活（应保持隐藏直到文本变化）');
    process.exit(1);
  }
  // 文本变化 → 联想恢复
  tree19.input?.setText('/t');
  repaintTree(t19.renderer, tree19, s19, { withInput: true });
  await t19.renderOnce();
  if (!s19.cmdSuggest || s19.cmdSuggest.items[0] !== 'thinking') {
    console.error('✗ 场景 19 文本变化后联想未恢复');
    process.exit(1);
  }
  // Tab 填入的尾空格（`/thinking `）→ 联想自动隐藏（commandSuggestions 不 trim）
  tree19.input?.setText('/thinking ');
  repaintTree(t19.renderer, tree19, s19, { withInput: true });
  await t19.renderOnce();
  if (s19.cmdSuggest !== null) {
    console.error('✗ 场景 19 Tab 填入尾空格后联想应隐藏');
    process.exit(1);
  }
  // e) 渲染：'/' 时列表显示（含 /theme 描述等），输入框不受影响
  tree19.input?.setText('/');
  repaintTree(t19.renderer, tree19, s19, { withInput: true });
  await t19.renderOnce();
  const frame19 = t19.captureCharFrame();
  console.log('=== 场景 19：/ 命令联想列表 ===');
  console.log(frame19);
  // 紧凑窗口：只显示前 6 条（permission/plan/thinking/exit/clear/undo）+ 底部「↓ 还有 26 个」提示行
  const checks19 = ['/permission', '切换安全权限', '/plan', '计划模式（只读调研，不修改文件）', '/thinking', '开/关思考过程展示', '/exit', '退出 TUI', '/clear', '清空对话上下文', '/undo', '撤销本次会话的 write_file 修改（all = 全部撤销）', '↓ 还有 28 个'];
  const missing19 = checks19.filter((c) => !frame19.includes(c));
  if (missing19.length) {
    console.error(`✗ 场景 19 联想列表渲染缺: ${missing19.join(', ')}`);
    process.exit(1);
  }
  // 圆角方框面板：帧内出现 ╭（面板顶/左边框）与 ╰（底/左边框）——圆角边框真实渲染
  if (!frame19.includes('╭') || !frame19.includes('╰')) {
    console.error('✗ 场景 19 联想面板未渲染圆角边框（应见 ╭╰）');
    process.exit(1);
  }
  // 紧凑下拉不铺满内容区：窗口外命令不渲染（靠 ↑/↓ 滚动到达，不再截断成不可达）
  for (const hidden of ['/init', '/skill', '/compact', '/agents', '/orchestrate', '/goal', '/review', '/variants', '/spec', '/preset', '/settings', '/model', '/status', '/context', '/export', '/config', '/mcp', '/diff', '/rename', '/fork', '/send', '/memory-apply', '/resume', '/session', '/redo', '/trace', '/help']) {
    if (frame19.includes(hidden)) {
      console.error(`✗ 场景 19 窗口外命令 ${hidden} 不应渲染（应滚入窗口）`);
      process.exit(1);
    }
  }
  if (!tree19.suggestBox || !tree19.suggestBox.visible) {
    console.error('✗ 场景 19 联想面板未显示');
    process.exit(1);
  }
  // 输入框仍在（非模态，输入内容 '/' 显示在灰色块内，列表不阻塞输入）
  if (tree19.input?.plainText !== '/') {
    console.error('✗ 场景 19 输入框内容被联想列表破坏');
    process.exit(1);
  }
  // e2) 独立浮层：绝对定位悬停在输入框（灰色块）上方，不占内容流
  //     （0-based 屏幕行：底部块顶 = 20 - 7 - (inputLines+4) = 12，浮层底应在其上方）
  if (!tree19.suggestRect) {
    console.error('✗ 场景 19 联想浮层未记录 suggestRect（应可鼠标点击）');
    process.exit(1);
  }
  const top19 = tree19.suggestBox.top as number;
  const left19 = tree19.suggestBox.left as number;
  if (typeof top19 !== 'number' || typeof left19 !== 'number' || left19 !== 2 || top19 < 1) {
    console.error(`✗ 场景 19 联想浮层定位错误: top=${top19} left=${left19}（应 left=2、top≥1）`);
    process.exit(1);
  }
  const footerTop19 = 20 - 7 - s19.inputLines; // 底部块顶部（0-based；圆角边框 +2 行、统计行间距 1、无排队区）
  if (tree19.suggestRect.bottom >= footerTop19) {
    console.error(`✗ 场景 19 联想浮层未浮在输入框上方: ${JSON.stringify(tree19.suggestRect)}（底部块顶=${footerTop19}）`);
    process.exit(1);
  }
  // f) 独立浮层：联想打开时内容区预算不变（不占内容流、对话不因联想出现而跳动）
  const s19b = createTuiState();
  fill(s19b, 20);
  const rowsNone19 = computeRows(s19b, { height: 20, width: 64 }, { withInput: true });
  s19b.cmdSuggest = { query: '', items: ['theme', 'exit', 'clear', 'help'], top: 0, selected: 0, window: 4 };
  const rowsSug19 = computeRows(s19b, { height: 20, width: 64 }, { withInput: true });
  if (rowsNone19.length !== rowsSug19.length) {
    console.error(`✗ 场景 19 联想浮层不应挤动内容区（${rowsNone19.length} → ${rowsSug19.length}，应相同）`);
    process.exit(1);
  }
  // g) 滚动到全部命令：选中项 20（窗口外）→ repaint 把 top 收敛到选中项可见，
  //    出现顶部「↑ 还有 N 个」提示行、窗口外命令（/review）不再渲染（用户反馈无法翻页的回归）
  const s19s = createTuiState();
  s19s.version = '0.1.0';
  s19s.model = 'mock';
  pushLine(s19s, { kind: 'user', text: '你好' });
  const t19s = await createTestRenderer({ width: 64, height: 20 });
  const tree19s = mountTree(t19s.renderer, s19s, { withInput: true });
  await t19s.renderOnce();
  tree19s.input?.setText('/');
  repaintTree(t19s.renderer, tree19s, s19s, { withInput: true });
  await t19s.renderOnce();
  if (!s19s.cmdSuggest) {
    console.error('✗ 场景 19 滚动前置失败（无联想列表）');
    process.exit(1);
  }
  s19s.cmdSuggest.selected = 20; // 模拟交互层 ↑/↓ 循环后选中窗口外条目
  s19s.cmdSuggest.top = 0;
  repaintTree(t19s.renderer, tree19s, s19s, { withInput: true });
  await t19s.renderOnce();
  const cg = s19s.cmdSuggest;
  if (cg.top > cg.selected || cg.selected >= cg.top + cg.window) {
    console.error(`✗ 场景 19 选中项未滚入窗口: selected=${cg.selected} top=${cg.top} window=${cg.window}`);
    process.exit(1);
  }
  const frame19s = t19s.captureCharFrame();
  // 滚动后：出现上下提示行、窗口外命令（/review 等）不渲染、选中项（/export，下标 20）在窗口内
  if (!frame19s.includes('↑ 还有') || !frame19s.includes('↓ 还有') || frame19s.includes('/review') || !frame19s.includes('/export')) {
    console.error('✗ 场景 19 滚动后窗口/提示行错误（应见 ↑/↓ 还有 N 个、无 /review、含选中项 /export）');
    process.exit(1);
  }
  console.log('✓ 场景 19 通过：/ 联想列表（全量 items + 窗口/提示行 + ↑/↓ 滚动到全部 + 前缀过滤/无匹配隐藏/圆角浮层/不挤动内容区）');

  // 场景 20：会话标题 —— 首轮对话后模型生成，**不显示在对话流里**，改为终端窗口/标签页标题（OSC 0）
  const { cleanTitle } = await import('../src/agent/title.js');
  // a) cleanTitle 单元断言：去引号/书名号/结尾标点、空白折叠、按列宽截断
  if (cleanTitle('「测试标题」') !== '测试标题') {
    console.error(`✗ 场景 20 cleanTitle 未去书名号: ${JSON.stringify(cleanTitle('「测试标题」'))}`);
    process.exit(1);
  }
  if (cleanTitle('  "测试 标题。" ') !== '测试 标题') {
    console.error(`✗ 场景 20 cleanTitle 未去引号/标点: ${JSON.stringify(cleanTitle('  "测试 标题。" '))}`);
    process.exit(1);
  }
  if (cleanTitle('   \n  ') !== null) {
    console.error('✗ 场景 20 cleanTitle 空输入应返回 null');
    process.exit(1);
  }
  const longTitle = cleanTitle('这是一个非常非常长的会话标题用来验证超长截断处理逻辑是否正常工作');
  if (!longTitle || !longTitle.endsWith('…') || visualWidth(longTitle) > 24) {
    console.error(`✗ 场景 20 cleanTitle 超长未截断: ${JSON.stringify(longTitle)}`);
    process.exit(1);
  }
  // b) 有标题：computeRows 首行 = 用户消息（标题**不得**出现在信息流里）
  const s20 = createTuiState();
  s20.version = '0.1.0';
  s20.model = 'mock';
  s20.sessionTitle = '测试会话标题';
  pushLine(s20, { kind: 'user', text: '你好' });
  s20.status = '任务完成';
  const rows20 = computeRows(s20, { height: 20, width: 64 }, { withInput: true });
  if (rows20.some((r) => r.text.includes('测试会话标题') || r.text.includes('— 测试'))) {
    console.error(`✗ 场景 20 标题不应出现在信息流: ${JSON.stringify(rows20[0]?.text)}`);
    process.exit(1);
  }
  if (!rows20[0].text.includes('你好')) {
    console.error(`✗ 场景 20 首行应为用户消息（标题已从流中移除）: ${JSON.stringify(rows20[0]?.text)}`);
    process.exit(1);
  }
  // c) 真实渲染：帧内无标题行 + footer 统计行正常 + 内容/输入框正常
  s20.cwd = '/Users/alice/work/omni';
  const r20 = await render(s20);
  console.log('=== 场景 20：会话标题（终端窗口标题，不显示在信息流）===');
  console.log(r20.frame);
  if (r20.frame.includes('— 测试会话标题 —') || r20.frame.includes('测试会话标题')) {
    console.error('✗ 场景 20 渲染帧不应包含会话标题（已改为窗口标题）');
    process.exit(1);
  }
  if (!r20.frame.includes('0 轮 · 0 步')) {
    console.error('✗ 场景 20 footer 统计行缺失');
    process.exit(1);
  }
  if (!r20.frame.includes('你好') || !r20.frame.includes('输入消息，Enter 发送')) {
    console.error('✗ 场景 20 内容/输入框异常');
    process.exit(1);
  }
  // d) setTerminalTitle 单元断言：OSC 0 序列 + 控制字符清洗（纯函数，不依赖 TTY）
  const { terminalTitleSequence } = await import('../src/ui.js');
  const seq20 = terminalTitleSequence('测试 标题');
  if (seq20 !== '\x1b]0;测试 标题\x07') {
    console.error(`✗ 场景 20 窗口标题序列错误: ${JSON.stringify(seq20)}`);
    process.exit(1);
  }
  const seqClean20 = terminalTitleSequence('a\x1b]2;b\x07c');
  // 序列两端是 OSC 分隔符（\x1b]0; 前缀 + \x07 终止），控制字符只能出现在标题内容里
  const titlePart20 = seqClean20.slice(4, -1);
  if (seqClean20 !== '\x1b]0;a]2;bc\x07' || /[\x00-\x1f\x7f]/.test(titlePart20)) {
    console.error(`✗ 场景 20 窗口标题未清洗控制字符: ${JSON.stringify(seqClean20)}`);
    process.exit(1);
  }
  // e) 无标题（null）：首行不是标题行（既有场景隐含覆盖，这里显式断言一次）
  const s20b = createTuiState();
  fill(s20b, 0);
  const rows20b = computeRows(s20b, { height: 20, width: 64 }, { withInput: true });
  if (rows20b[0].text.trim().startsWith('— ') || rows20b[0].text.includes('—')) {
    console.error('✗ 场景 20 无标题时不应出现标题行');
    process.exit(1);
  }
  console.log('✓ 场景 20 通过：会话标题（cleanTitle 清洗/不占信息流/帧内零泄漏/窗口标题 OSC 序列正确）');

  // 场景 21：/thinking 命令 —— 展示开关（开/关思考流）+ 点击单条展开/收起
  console.log('=== 场景 21：/thinking 展示开关 + 思考点击展开/收起 ===');
  const s21 = createTuiState();
  s21.version = '0.1.0';
  s21.model = 'mock';
  pushLine(s21, { kind: 'user', text: '你好' });
  pushLine(s21, { kind: 'thinking', text: '第一段思考内容\n第二行细节\n第三行结论', thinkingMs: 3200 });
  pushLine(s21, { kind: 'thinking', text: '第二轮思考', thinkingMs: 1500 });
  pushLine(s21, { kind: 'answer', text: '最终回答' });
  s21.status = '任务完成';
  // a) 默认展示 + 展开：每个思考段落 = `- thinking` 头行（含思考时间 · 3.2s）+ 全文
  //    （用户要求「展示时显示 - thinking + 思考时间 + 思考内容」）
  const rows21 = computeRows(s21, { height: 20, width: 64 }, { withInput: true });
  const thinkFull21 = rows21.filter((r) => r.text.includes('第一段思考内容') || r.text.includes('第二轮思考'));
  if (thinkFull21.length !== 2) {
    console.error(`✗ 场景 21 默认未展开思考全文: ${JSON.stringify(thinkFull21)}`);
    process.exit(1);
  }
  const headerRows21 = rows21.filter((r) => r.text.trim().startsWith('- thinking'));
  if (headerRows21.length !== 2 || !rows21.some((r) => r.text.includes('- thinking · 3.2s')) || !rows21.some((r) => r.text.includes('- thinking · 1.5s'))) {
    console.error(`✗ 场景 21 展开态缺 - thinking 头行/思考时间: ${JSON.stringify(headerRows21.map((r) => r.text))}`);
    process.exit(1);
  }
  // a2) **思考中头行 = loading + thinking + 实时耗时**（用户要求）：thinkingRunning=true
  //     时前缀为 spinner 帧（随 spinnerIndex 变化）；思考完（false）前缀变 `-`。
  const s21a2 = createTuiState();
  s21a2.version = '0.1.0';
  s21a2.model = 'mock';
  pushLine(s21a2, { kind: 'thinking', text: '正在思考', thinkingRunning: true, thinkingMs: 1200 });
  s21a2.spinnerIndex = 3;
  const rows21a2 = computeRows(s21a2, { height: 20, width: 64 }, { withInput: true });
  const runHead21 = rows21a2.find((r) => r.text.includes('thinking'));
  if (!runHead21 || !runHead21.text.startsWith('⠸ thinking · 1.2s')) {
    console.error(`✗ 场景 21 思考中头行应为 loading+thinking+time（⠸ thinking · 1.2s）: ${JSON.stringify(runHead21?.text)}`);
    process.exit(1);
  }
  s21a2.lines[0]!.thinkingRunning = false; // 思考完 → 前缀变 `-`
  const rows21a2b = computeRows(s21a2, { height: 20, width: 64 }, { withInput: true });
  const doneHead21 = rows21a2b.find((r) => r.text.includes('thinking'));
  if (!doneHead21 || !doneHead21.text.startsWith('- thinking · 1.2s')) {
    console.error(`✗ 场景 21 思考完头行应为 - thinking · time: ${JSON.stringify(doneHead21?.text)}`);
    process.exit(1);
  }
  // a2b) **收起态（点击单条收起）思考中 = loading 而非 + 号**（用户要求「收起时正在思考，
  //      左侧不显示 + 号，而是应该显示 loading」）：collapsedThinking 记录该条 + running
  //      → 头行 `⠸ thinking`（spinner 帧，无时间）；思考完 → `+ thinking`
  s21a2.collapsedThinking.add(0);
  s21a2.lines[0]!.thinkingRunning = true;
  const rows21a2c = computeRows(s21a2, { height: 20, width: 64 }, { withInput: true });
  const runColl21 = rows21a2c.find((r) => r.text.includes('thinking'));
  if (!runColl21 || !runColl21.text.startsWith('⠸ thinking') || runColl21.text.includes('·')) {
    console.error(`✗ 场景 21 收起态思考中应为 loading（⠸ thinking，无 + 号）: ${JSON.stringify(runColl21?.text)}`);
    process.exit(1);
  }
  s21a2.lines[0]!.thinkingRunning = false; // 思考完 → 恢复 + thinking
  const rows21a2d = computeRows(s21a2, { height: 20, width: 64 }, { withInput: true });
  if (rows21a2d.filter((r) => r.text.trim() === '+ thinking').length !== 1) {
    console.error('✗ 场景 21 收起态思考完应恢复 + thinking');
    process.exit(1);
  }
  // a3) **收到消息开始思考（onRound）立即显示 thinking 模块**（用户要求「接收到消息开始
  //     thinking 的时候就要显示，而不是收到流式返回才开始」）：onRound 预建空内容
  //     running 行 → 头行 `⠋ thinking · 0.0s`（无内容行）；无实际思考 finish 移除空模块
  {
    const { TuiOutput } = await import('../src/tui/output.js');
    const s21a3 = createTuiState();
    s21a3.version = '0.1.0';
    s21a3.model = 'mock';
    const fakeS3 = { paint: async () => {}, stop: async () => {}, input: null, onKeyPress: () => () => {} };
    const out3 = new TuiOutput(s21a3, { showThinking: true }, fakeS3 as never);
    out3.onRound(0, 50);
    const tl3 = s21a3.lines.filter((l) => l.kind === 'thinking');
    if (tl3.length !== 1 || tl3[0]!.thinkingRunning !== true || tl3[0]!.text !== '') {
      console.error('✗ 场景 21 onRound 未立即预建 thinking 模块');
      process.exit(1);
    }
    const rows21a3 = computeRows(s21a3, { height: 20, width: 64 }, { withInput: true });
    const head3 = rows21a3.find((r) => r.text.includes('thinking'));
    if (!head3 || !head3.text.includes('thinking') || rows21a3.some((r) => r.thinkingIdx !== undefined && r.text !== '' && !r.text.includes('thinking'))) {
      console.error(`✗ 场景 21 onRound 后应只显示头行（无空内容行）: ${JSON.stringify(rows21a3.map((r) => r.text))}`);
      process.exit(1);
    }
    out3.thinking.finish(); // 无实际思考 → 移除空模块
    if (s21a3.lines.some((l) => l.kind === 'thinking')) {
      console.error('✗ 场景 21 无思考内容的空模块未被移除');
      process.exit(1);
    }
  }
  // b) **/thinking 关闭（thinkingShow=false）→ 思考流完全不展示**：无 `- thinking` 头行、
  //    无 `+ thinking` 摘要、无思考全文（历史行与新轮行都在渲染层过滤）；回答不受影响。
  s21.thinkingShow = false;
  const rows21b = computeRows(s21, { height: 20, width: 64 }, { withInput: true });
  if (rows21b.some((r) => r.text.includes('第一段思考内容') || r.text.includes('第二轮思考') || r.text.trim() === '+ thinking' || r.text.includes('- thinking'))) {
    console.error(`✗ 场景 21 thinkingShow=false 仍渲染思考内容: ${JSON.stringify(rows21b.map((r) => r.text))}`);
    process.exit(1);
  }
  if (!rows21b.some((r) => r.text.includes('最终回答'))) {
    console.error('✗ 场景 21 关闭思考展示后回答丢失');
    process.exit(1);
  }
  // c) 真实渲染：关闭态帧内无任何思考痕迹
  const r21 = await render(s21);
  console.log(r21.frame);
  if (r21.frame.includes('thinking') || r21.frame.includes('思考')) {
    console.error('✗ 场景 21 渲染帧关闭态仍含思考痕迹');
    process.exit(1);
  }
  if (!r21.frame.includes('最终回答')) {
    console.error('✗ 场景 21 渲染帧关闭态缺回答');
    process.exit(1);
  }
  // d) 命令分发：/thinking 切换展示开关（thinkingShow + out.showThinking + runOpts.showThinking
  //    三处同步）+ 不推 meta 提示 + 清空单独反例集合
  const { findCommand, runCommand } = await import('../src/tui/commands.js');
  if (!findCommand('thinking')) {
    console.error('✗ 场景 21 /thinking 命令未注册');
    process.exit(1);
  }
  const s21c = createTuiState();
  s21c.thinkingShow = true;
  s21c.expandedThinking.add(1);
  s21c.collapsedThinking.add(2);
  const runOpts21 = { showThinking: true };
  const fakeCtx21 = {
    state: s21c,
    out: { showThinking: true },
    session: {},
    input: {},
    messages: [],
    runOpts: runOpts21,
  };
  await runCommand(fakeCtx21 as never, '/thinking');
  if (s21c.thinkingShow !== false || fakeCtx21.out.showThinking !== false || runOpts21.showThinking !== false) {
    console.error('✗ 场景 21 /thinking 未关闭展示（state/out/runOpts 未同步）');
    process.exit(1);
  }
  if (s21c.expandedThinking.size !== 0 || s21c.collapsedThinking.size !== 0) {
    console.error('✗ 场景 21 /thinking 未清空单独展开/收起标记');
    process.exit(1);
  }
  if (s21c.lines.some((l) => l.text.includes('已关闭') || l.text.includes('已开启'))) {
    console.error('✗ 场景 21 /thinking 不应推提示文字');
    process.exit(1);
  }
  await runCommand(fakeCtx21 as never, '/thinking');
  if (s21c.thinkingShow !== true || fakeCtx21.out.showThinking !== true || runOpts21.showThinking !== true) {
    console.error('✗ 场景 21 /thinking 未再次开启展示');
    process.exit(1);
  }
  // e) **展开态点击单条收起/再点击展开**（用户要求「思考模块支持点击展开、收起」）：
  //    buildRects 构造 thinkingRects（与 repaintTree 相同逻辑：可见行 i → 事件 y = i + 1，
  //    根 paddingY:1 下移一行）；点头行/内容 → collapsedThinking 记录该条；再点 `+ thinking`
  //    → 重新展开（collapsedThinking 移除）。
  const { hitTestThinking } = await import('../src/tui/render.js');
  const buildRects21 = (rowsArr: Row[]): Map<number, number> => {
    const m = new Map<number, number>();
    rowsArr.forEach((r, i) => {
      if (r.thinkingIdx !== undefined) m.set(i + 1, r.thinkingIdx);
    });
    return m;
  };
  s21.thinkingShow = true;
  s21.thinkingExpanded = true;
  s21.collapsedThinking.clear();
  s21.expandedThinking.clear();
  const rows21e = computeRows(s21, { height: 20, width: 64 }, { withInput: true });
  const rects21e = buildRects21(rows21e);
  const contentRow21 = rows21e.findIndex((r) => r.text.includes('第一段思考内容'));
  const headerRow21 = rows21e.findIndex((r) => r.text.includes('- thinking · 3.2s'));
  if (contentRow21 < 0 || headerRow21 < 0 || rects21e.get(contentRow21 + 1) !== 1 || rects21e.get(headerRow21 + 1) !== 1) {
    console.error(`✗ 场景 21 展开态思考行未带 thinkingIdx: ${JSON.stringify([...rects21e])}`);
    process.exit(1);
  }
  // 点头行 → 收起第 1 条（collapsedThinking 记录；第 2 条不受影响）
  if (!hitTestThinking(s21, rects21e, headerRow21 + 1) || !s21.collapsedThinking.has(1) || s21.collapsedThinking.has(2)) {
    console.error('✗ 场景 21 展开态点头行未单独收起');
    process.exit(1);
  }
  const rows21f = computeRows(s21, { height: 20, width: 64 }, { withInput: true });
  if (rows21f.some((r) => r.text.includes('第一段思考内容')) || !rows21f.some((r) => r.text.includes('第二轮思考')) || rows21f.filter((r) => r.text.trim() === '+ thinking').length !== 1) {
    console.error('✗ 场景 21 收起后第 1 条应只剩 + thinking、第 2 条仍展开');
    process.exit(1);
  }
  // 空白行点击不命中（不消费、不误展开）：点用户行（y=0）
  if (hitTestThinking(s21, rects21e, 0)) {
    console.error('✗ 场景 21 空白区域误命中思考行');
    process.exit(1);
  }
  // 再点 `+ thinking` → 重新展开该条
  const rects21f2 = buildRects21(rows21f);
  const sumRow21 = rows21f.findIndex((r) => r.text.trim() === '+ thinking');
  if (sumRow21 < 0 || !hitTestThinking(s21, rects21f2, sumRow21 + 1) || s21.collapsedThinking.has(1)) {
    console.error('✗ 场景 21 展开态点 + thinking 未重新展开');
    process.exit(1);
  }
  const rows21g = computeRows(s21, { height: 20, width: 64 }, { withInput: true });
  if (!rows21g.some((r) => r.text.includes('第一段思考内容')) || rows21g.some((r) => r.text.trim() === '+ thinking')) {
    console.error('✗ 场景 21 重新展开后思考全文未恢复');
    process.exit(1);
  }
  // f) TuiOutput 运行时开关：showThinking=false 时不建模块/不写 chunk；重新开启恢复
  {
    const { TuiOutput } = await import('../src/tui/output.js');
    const s21f = createTuiState();
    s21f.version = '0.1.0';
    s21f.model = 'mock';
    const fakeS4 = { paint: async () => {}, stop: async () => {}, input: null, onKeyPress: () => () => {} };
    const out4 = new TuiOutput(s21f, { showThinking: true }, fakeS4 as never);
    out4.onRound(0, 50); // 预建模块
    if (!s21f.lines.some((l) => l.kind === 'thinking')) {
      console.error('✗ 场景 21 开启态 onRound 应预建 thinking 模块');
      process.exit(1);
    }
    out4.thinking.finish(); // 首轮结束：空模块移除、shown 复位（真实回合生命周期）
    out4.showThinking = false; // /thinking 关闭
    out4.onRound(0, 50); // 新一轮：不建模块
    const before = s21f.lines.length;
    out4.thinking.write('新思考内容');
    out4.thinking.finish();
    if (s21f.lines.length !== before || s21f.lines.some((l) => l.text.includes('新思考内容'))) {
      console.error('✗ 场景 21 关闭态 write 不应写 chunk / finish 不应建行');
      process.exit(1);
    }
    out4.showThinking = true; // /thinking 开启
    out4.onRound(0, 50);
    if (!s21f.lines.some((l) => l.kind === 'thinking')) {
      console.error('✗ 场景 21 重新开启后 onRound 应恢复预建模块');
      process.exit(1);
    }
  }
  console.log('✓ 场景 21 通过：/thinking 展示开关（state/out/runOpts 三同步 + 渲染过滤）+ 点击单条展开/收起');

  // 场景 22：工具审批卡片（安全护栏）——渲染 + 点击命中判定
  console.log('=== 场景 22：工具审批卡片 ===');
  const s22 = createTuiState();
  s22.version = '0.1.0';
  s22.model = 'mock';
  pushLine(s22, { kind: 'user', text: '清理临时文件' });
  s22.approval = { tool: 'run_command', summary: '$ rm -rf /tmp/x', reason: '对临时目录执行 rm -rf' };
  let approved22: boolean | null = null;
  s22.approvalResolve = (b) => (approved22 = b);
  s22.status = '等待审批：run_command';
  const rows22 = computeRows(s22, { height: 20, width: 64 }, { withInput: true });
  if (!rows22.some((r) => r.text.includes('需要审批')) || !rows22.some((r) => r.text.includes('[y] 批准'))) {
    console.error('✗ 场景 22 审批卡片未渲染（需要审批 / [y] 批准 缺失）');
    process.exit(1);
  }
  const apprIdx22 = rows22.map((r, i) => (r.approvalId !== undefined ? i : -1)).filter((i) => i >= 0);
  if (apprIdx22.length === 0) {
    console.error('✗ 场景 22 审批行未标记 approvalId');
    process.exit(1);
  }
  const rect22 = { top: apprIdx22[0], bottom: apprIdx22[apprIdx22.length - 1] };
  if (!hitTestApproval(s22, rect22, rect22.top)) {
    console.error('✗ 场景 22 审批卡片区域内点击未命中');
    process.exit(1);
  }
  if (hitTestApproval(s22, rect22, rect22.top - 1) || hitTestApproval(s22, null, rect22.top) || hitTestApproval(s22, rect22, rect22.bottom + 1)) {
    console.error('✗ 场景 22 审批卡片区域外点击误命中');
    process.exit(1);
  }
  const r22 = await render(s22);
  if (!r22.frame.includes('需要审批') || !r22.frame.includes('[y] 批准') || !r22.frame.includes('rm -rf /tmp/x')) {
    console.error('✗ 场景 22 审批卡片未渲染进帧');
    process.exit(1);
  }
  // 未解析前 approval 保持（不允许被渲染层清掉）
  if (s22.approval === null || approved22 !== null) {
    console.error('✗ 场景 22 渲染层错误地解析/清除了审批');
    process.exit(1);
  }
  console.log('✓ 场景 22 通过：审批卡片渲染（工具/摘要/原因/[y]批准 [n]拒绝）+ 点击命中判定');

  // 场景 23：安全策略（权限分级 gateTool 纯函数）
  console.log('=== 场景 23：权限分级 + per-tool 审批模式 ===');
  // 构造测试用 Tool（name + 可选 approvalMode/readOnly）
  const mkTool = (name: string, extra?: Record<string, unknown>) =>
    ({ name, description: '', parameters: {}, execute: async () => '', ...extra }) as never;
  // full：任意命令直通（含危险命令——用户选择全量信任），普通命令放行
  if (gateTool('full', mkTool('run_command'), { command: 'git push origin main' }).allow !== true) {
    console.error('✗ 场景 23 full 级危险命令未直通');
    process.exit(1);
  }
  if (gateTool('full', mkTool('run_command'), { command: 'echo hi' }).allow !== true) {
    console.error('✗ 场景 23 full 级普通命令被误拦');
    process.exit(1);
  }
  // safe：危险命令转审批（不再硬拦），普通命令放行
  const g23b = gateTool('safe', mkTool('run_command'), { command: 'rm -rf /tmp/x' });
  if (!('needApproval' in g23b)) {
    console.error('✗ 场景 23 safe 级危险命令未转审批');
    process.exit(1);
  }
  if (gateTool('safe', mkTool('run_command'), { command: 'ls' }).allow !== true) {
    console.error('✗ 场景 23 safe 级普通命令被误拦');
    process.exit(1);
  }
  // ask：所有工具调用都需要审批
  if (!('needApproval' in gateTool('ask', mkTool('read_file'), { path: 'a.ts' }))) {
    console.error('✗ 场景 23 ask 级读工具未转审批');
    process.exit(1);
  }
  // read：写/执行直接拒绝（连询问都不给），读放行
  if (gateTool('read', mkTool('run_command'), { command: 'ls' }).allow !== false) {
    console.error('✗ 场景 23 read 级未拒绝 run_command');
    process.exit(1);
  }
  if (gateTool('read', mkTool('write_file'), { path: 'a.ts' }).allow !== false) {
    console.error('✗ 场景 23 read 级未拒绝 write_file');
    process.exit(1);
  }
  if (gateTool('read', mkTool('read_file'), { path: 'a.ts' }).allow !== true) {
    console.error('✗ 场景 23 read 级误拦 read_file');
    process.exit(1);
  }
  // per-tool 审批模式：approve 放行 / prompt 询问 / writes 写询问读放行 / readOnly 不视为写
  if (gateTool('ask', mkTool('mcp_tool', { approvalMode: 'approve' }), {}).allow !== true) {
    console.error('✗ 场景 23 approve 模式未放行（ask 档位下）');
    process.exit(1);
  }
  if (!('needApproval' in gateTool('full', mkTool('mcp_tool', { approvalMode: 'prompt' }), {}))) {
    console.error('✗ 场景 23 prompt 模式未询问');
    process.exit(1);
  }
  if (!('needApproval' in gateTool('full', mkTool('mcp_tool', { approvalMode: 'writes' }), {}))) {
    console.error('✗ 场景 23 writes 模式未询问（MCP 工具视为写）');
    process.exit(1);
  }
  if (gateTool('full', mkTool('mcp_read', { approvalMode: 'writes', readOnly: true }), {}).allow !== true) {
    console.error('✗ 场景 23 writes 模式误拦只读工具');
    process.exit(1);
  }
  if (gateTool('read', mkTool('mcp_tool', { approvalMode: 'approve' }), {}).allow !== false) {
    console.error('✗ 场景 23 approve 模式绕过 read 硬拒绝');
    process.exit(1);
  }
  console.log('✓ 场景 23 通过：权限分级（full/safe/ask/read）+ per-tool 审批模式（approve/prompt/writes/只读）');

  // 场景 24：上下文管理（相关文件预载 + 摘要切分边界）
  console.log('=== 场景 24：上下文管理 ===');
  const files24 = await selectRelevantFiles('读取 package.json 的 name，并看看 src/index.ts 的入口', 5, 100000);
  if (!files24.some((f) => f.path === 'package.json') || !files24.some((f) => f.path === 'src/index.ts')) {
    console.error(`✗ 场景 24 相关文件预载未命中: ${JSON.stringify(files24.map((f) => f.path))}`);
    process.exit(1);
  }
  const files24b = await selectRelevantFiles('读取 does-not-exist-xyz.ts 的内容', 5, 100000);
  if (files24b.length !== 0) {
    console.error('✗ 场景 24 不存在的路径未被过滤');
    process.exit(1);
  }
  // 摘要切分边界：不切开「assistant 工具调用 ↔ 其 tool 结果」配对
  const msgs24: ChatCompletionMessageParam[] = [
    { role: 'user', content: '任务一' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '结果一' },
    { role: 'user', content: '任务二' },
    { role: 'assistant', content: '回答二' },
    { role: 'user', content: '任务三' },
    { role: 'assistant', content: '回答三' },
  ];
  const split24 = findSummarizeSplit(msgs24, 2); // 期望 5：head=[0..4] 完整回合，tail=[5..6]
  if (split24 !== 5) {
    console.error(`✗ 场景 24 摘要切分点错误（期望 5，实际 ${split24}）`);
    process.exit(1);
  }
  // 切点前一跳是 assistant(带工具调用) → 整组回退留 tail（配对不被切开）
  const msgs24b: ChatCompletionMessageParam[] = [
    { role: 'user', content: '任务一' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '结果一' },
    { role: 'user', content: '任务二' },
  ];
  const split24b = findSummarizeSplit(msgs24b, 2); // 期望 -1：切点(2)前一跳是 assistant 工具调用 → 回退到 1 < 2，不值得压缩
  if (split24b !== -1) {
    console.error(`✗ 场景 24 工具配对边界未保护（期望 -1，实际 ${split24b}）`);
    process.exit(1);
  }
  console.log('✓ 场景 24 通过：相关文件预载（命中/过滤）+ 摘要切分不切开工具配对');

  // 场景 25：项目记忆 AGENTS.md —— 嵌套发现/加载/注入 + /init 命令注册与生成
  console.log('=== 场景 25：项目记忆（AGENTS.md 嵌套发现 + /init）===');
  const { findAgentsFiles, findAgentsFile, loadProjectMemory, memoryMessage, MEMORY_MAX_BYTES } = await import('../src/agent/memory.js');
  const { cleanInitContent, findProjectRoot, collectProjectSnapshot, writeAgentsFile } = await import('../src/agent/init.js');
  const { prepareContext } = await import('../src/agent/context.js');
  // a) 发现：从 src/ 向上找到仓库根 AGENTS.md（git 根为边界）
  const agents25 = findAgentsFile(path.join(process.cwd(), 'src'));
  if (!agents25 || !agents25.endsWith('AGENTS.md')) {
    console.error(`✗ 场景 25 AGENTS.md 向上发现失败: ${JSON.stringify(agents25)}`);
    process.exit(1);
  }
  // a2) 嵌套发现：本仓库 src/ 下无 AGENTS.md → 只发现仓库根一层
  const agents25all = findAgentsFiles(path.join(process.cwd(), 'src'));
  if (agents25all.length !== 1 || agents25all[0] !== agents25) {
    console.error(`✗ 场景 25 嵌套发现数量错误: ${JSON.stringify(agents25all)}`);
    process.exit(1);
  }
  // b) 加载：内容非空且超长截断（本仓库 AGENTS.md 超过上限，应带截断提示）
  const mems25 = await loadProjectMemory(path.join(process.cwd(), 'src'));
  if (!mems25 || mems25.length !== 1) {
    console.error(`✗ 场景 25 loadProjectMemory 返回数量错误: ${JSON.stringify(mems25)}`);
    process.exit(1);
  }
  const mem25 = mems25[0];
  if (mem25.content.length === 0) {
    console.error('✗ 场景 25 loadProjectMemory 返回空');
    process.exit(1);
  }
  if (mem25.content.length > MEMORY_MAX_BYTES + 500) {
    console.error(`✗ 场景 25 记忆未截断（${mem25.content.length} > ${MEMORY_MAX_BYTES}）`);
    process.exit(1);
  }
  // c) 消息构建：system 角色 + 前缀标识（prepareContext 靠它去重）
  const msg25 = memoryMessage(mem25);
  if (msg25.role !== 'system' || typeof msg25.content !== 'string' || !msg25.content.startsWith('[项目记忆 AGENTS.md')) {
    console.error(`✗ 场景 25 memoryMessage 格式错误: ${JSON.stringify(msg25.content).slice(0, 80)}`);
    process.exit(1);
  }
  // d) prepareContext 注入：agentsFile 默认开 → 首轮自动注入一次；再调用不重复
  //    （globalAgentsFile: false 隔离：本机若有 ~/.config/omni/AGENTS.md 不影响本场景断言）
  const msgs25: ChatCompletionMessageParam[] = [{ role: 'user', content: '你好' }];
  await prepareContext({} as never, 'mock', msgs25, { agentsFile: true, globalAgentsFile: false, preloadFiles: false, summarizeAt: 0 });
  const memoryCount25 = msgs25.filter((m) => typeof m.content === 'string' && m.content.startsWith('[项目记忆 AGENTS.md')).length;
  if (memoryCount25 !== 1 || msgs25[0].role !== 'system') {
    console.error(`✗ 场景 25 记忆未注入到首部（count=${memoryCount25}）`);
    process.exit(1);
  }
  await prepareContext({} as never, 'mock', msgs25, { agentsFile: true, globalAgentsFile: false, preloadFiles: false, summarizeAt: 0 });
  if (msgs25.filter((m) => typeof m.content === 'string' && m.content.startsWith('[项目记忆 AGENTS.md')).length !== 1) {
    console.error('✗ 场景 25 记忆重复注入');
    process.exit(1);
  }
  // e) agentsFile=false 关闭：不注入
  const msgs25b: ChatCompletionMessageParam[] = [{ role: 'user', content: '你好' }];
  await prepareContext({} as never, 'mock', msgs25b, { agentsFile: false, globalAgentsFile: false, preloadFiles: false, summarizeAt: 0 });
  if (msgs25b.some((m) => typeof m.content === 'string' && m.content.startsWith('[项目记忆 AGENTS.md'))) {
    console.error('✗ 场景 25 agentsFile=false 仍注入记忆');
    process.exit(1);
  }
  // e2) 嵌套 AGENTS.md：临时 git 仓库内构造两层（repo/AGENTS.md 外层 + repo/src/AGENTS.md 内层），
  //     从 src 向上发现两层（内层在前），prepareContext 按「外层 → 内层」注入（内层贴近用户消息、权重最高）
  const nestedRoot25 = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-nested-'));
  fs.mkdirSync(path.join(nestedRoot25, 'repo', 'src'), { recursive: true });
  fs.mkdirSync(path.join(nestedRoot25, 'repo', '.git'));
  fs.writeFileSync(path.join(nestedRoot25, 'repo', 'AGENTS.md'), '# 外层（项目根）\n\n- 整体约定\n');
  fs.writeFileSync(path.join(nestedRoot25, 'repo', 'src', 'AGENTS.md'), '# 内层（src）\n\n- 子目录约定\n');
  const nestedFiles25 = findAgentsFiles(path.join(nestedRoot25, 'repo', 'src'));
  if (
    nestedFiles25.length !== 2 ||
    !nestedFiles25[0].endsWith(path.join('src', 'AGENTS.md')) ||
    !nestedFiles25[1].endsWith(path.join('repo', 'AGENTS.md'))
  ) {
    console.error(`✗ 场景 25 嵌套发现顺序错误: ${JSON.stringify(nestedFiles25)}`);
    process.exit(1);
  }
  const nestedMems25 = await loadProjectMemory(path.join(nestedRoot25, 'repo', 'src'));
  if (
    nestedMems25.length !== 2 ||
    !nestedMems25[0].path.includes(path.join('src', 'AGENTS.md')) ||
    !nestedMems25[1].path.includes(path.join('repo', 'AGENTS.md'))
  ) {
    console.error(`✗ 场景 25 嵌套加载错误: ${JSON.stringify(nestedMems25)}`);
    process.exit(1);
  }
  // 注入顺序端到端：chdir 到内层目录后 prepareContext（内部 loadProjectMemory() 用 process.cwd()），
  // 两条记忆都注入且顺序为 [外层, 内层]——外层靠 system prompt、内层贴近用户消息
  const oldCwd25 = process.cwd();
  process.chdir(path.join(nestedRoot25, 'repo', 'src'));
  const msgs25e: ChatCompletionMessageParam[] = [{ role: 'user', content: '你好' }];
  await prepareContext({} as never, 'mock', msgs25e, { agentsFile: true, globalAgentsFile: false, preloadFiles: false, summarizeAt: 0 });
  process.chdir(oldCwd25);
  const memMsgs25 = msgs25e.filter((m) => typeof m.content === 'string' && m.content.startsWith('[项目记忆 AGENTS.md'));
  if (memMsgs25.length !== 2) {
    console.error(`✗ 场景 25 嵌套注入数量错误: ${JSON.stringify(memMsgs25)}`);
    process.exit(1);
  }
  const memOrder25 = memMsgs25.map((m) => String(m.content));
  if (!memOrder25[0].includes('外层（项目根）') || !memOrder25[1].includes('内层（src）')) {
    console.error(`✗ 场景 25 嵌套注入顺序错误（外层应在前、内层贴近用户消息）: ${JSON.stringify(memOrder25)}`);
    process.exit(1);
  }
  fs.rmSync(nestedRoot25, { recursive: true, force: true });
  // f) /init 命令注册：findCommand 命中 + 联想列出（findCommand/runCommand 已在场景 21 声明，这里用别名）
  const { findCommand: findCmd25, runCommand: runCmd25, commandSuggestions } = await import('../src/tui/commands.js');
  if (!findCmd25('init')) {
    console.error('✗ 场景 25 /init 命令未注册');
    process.exit(1);
  }
  if (!commandSuggestions('in').some((c) => c.name === 'init')) {
    console.error('✗ 场景 25 /init 不在联想列表');
    process.exit(1);
  }
  // g) 生成：cleanInitContent 去代码块包裹；快照含顶层内容；项目根定位 git 根
  if (cleanInitContent('```markdown\n# 标题\n内容\n```') !== '# 标题\n内容') {
    console.error(`✗ 场景 25 cleanInitContent 未去代码块: ${JSON.stringify(cleanInitContent('```markdown\n# 标题\n内容\n```'))}`);
    process.exit(1);
  }
  const root25 = findProjectRoot(process.cwd());
  // 断言「定位到的就是 git 根」（存在 .git）而非目录名——worktree 下目录名是
  // .worktrees/rewind（第一百四十五次日志记录过的环境假设误报），语义上仍是本仓库
  if (!fs.existsSync(path.join(root25, '.git'))) {
    console.error(`✗ 场景 25 findProjectRoot 未定位到 git 根: ${root25}`);
    process.exit(1);
  }
  const snap25 = await collectProjectSnapshot(root25);
  if (!snap25.includes('package.json') || !snap25.includes('## 顶层内容')) {
    console.error('✗ 场景 25 项目快照缺关键内容');
    process.exit(1);
  }
  // h) 写入：已存在 AGENTS.md → 拒绝覆盖（本仓库根目录就有 AGENTS.md）
  const write25 = await writeAgentsFile(root25, '# 测试内容');
  if (write25.ok) {
    console.error('✗ 场景 25 已存在的 AGENTS.md 被覆盖');
    process.exit(1);
  }
  if (!write25.path.endsWith('AGENTS.md')) {
    console.error(`✗ 场景 25 写入目标路径错误: ${write25.path}`);
    process.exit(1);
  }
  // i) /init 无 client 时提示不崩溃（命令层守卫，输出进独立面板不污染对话流）
  const s25 = createTuiState();
  await runCmd25({ state: s25, out: {}, session: {}, input: {}, messages: [] } as never, '/init');
  const panel25 = s25.cmdPanel;
  if (!panel25 || !panel25.lines.some((l) => String(l).includes('/init 需要 LLM 客户端'))) {
    console.error('✗ 场景 25 /init 无 client 未提示（或未进命令面板）');
    process.exit(1);
  }
  if (s25.lines.some((l) => l.text.includes('/init 需要 LLM 客户端'))) {
    console.error('✗ 场景 25 /init 提示泄漏进了对话流');
    process.exit(1);
  }
  console.log('✓ 场景 25 通过：AGENTS.md 发现/截断/消息构建 + prepareContext 注入与去重 + /init 注册/生成/防覆盖');

  // 场景 26：全局记忆 —— 路径/级联注入/自动写入 + /init --global 分发
  console.log('=== 场景 26：全局记忆（级联加载 + 自动写入 + --global）===');
  const memModule26 = await import('../src/agent/memory.js');
  const { globalMemoryDir, globalMemoryPath, loadGlobalMemory, globalMemoryMessage, extractSessionMemory, appendGlobalMemory, GLOBAL_MEMORY_PREFIX } = memModule26;
  const initModule26 = await import('../src/agent/init.js');
  const { generateGlobalAgentsFile, writeGlobalAgentsFile, collectGlobalSnapshot } = initModule26;
  // a) 路径：尊重 XDG_CONFIG_HOME（临时目录下 omni/AGENTS.md）
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const fakeXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-global-'));
  process.env.XDG_CONFIG_HOME = fakeXdg;
  const globalDir26 = globalMemoryDir();
  const globalFile26 = globalMemoryPath();
  if (globalDir26 !== path.join(fakeXdg, 'omni') || !globalFile26.endsWith(path.join('omni', 'AGENTS.md'))) {
    console.error(`✗ 场景 26 全局记忆路径错误: dir=${globalDir26} file=${globalFile26}`);
    process.exit(1);
  }
  // b) 写入全局记忆文件 → 读取 + 消息构建
  fs.mkdirSync(globalDir26, { recursive: true });
  fs.writeFileSync(globalFile26, '# 全局偏好\n- 用中文回复\n');
  const gmem26 = await loadGlobalMemory();
  if (!gmem26 || !gmem26.content.includes('用中文回复')) {
    console.error('✗ 场景 26 loadGlobalMemory 读取失败');
    process.exit(1);
  }
  const gmsg26 = globalMemoryMessage(gmem26);
  if (gmsg26.role !== 'system' || typeof gmsg26.content !== 'string' || !gmsg26.content.startsWith(GLOBAL_MEMORY_PREFIX)) {
    console.error(`✗ 场景 26 globalMemoryMessage 格式错误: ${JSON.stringify(gmsg26.content).slice(0, 60)}`);
    process.exit(1);
  }
  // c) 级联注入顺序：全局在前、项目在后（repo 根有 AGENTS.md；XDG 指向临时全局）
  const msgs26: ChatCompletionMessageParam[] = [{ role: 'user', content: '你好' }];
  await prepareContext({} as never, 'mock', msgs26, { agentsFile: true, globalAgentsFile: true, preloadFiles: false, summarizeAt: 0 });
  const isGlobal26 = (m: ChatCompletionMessageParam): boolean => typeof m.content === 'string' && m.content.startsWith('[全局记忆 AGENTS.md');
  const isProject26 = (m: ChatCompletionMessageParam): boolean => typeof m.content === 'string' && m.content.startsWith('[项目记忆 AGENTS.md');
  const gi26 = msgs26.findIndex(isGlobal26);
  const pi26 = msgs26.findIndex(isProject26);
  if (gi26 < 0 || pi26 < 0 || gi26 >= pi26) {
    console.error(`✗ 场景 26 级联顺序错误（全局=${gi26} 项目=${pi26}，应 全局<项目）: ${JSON.stringify(msgs26.map((m) => typeof m.content === 'string' ? m.content.slice(0, 14) : m.role))}`);
    process.exit(1);
  }
  // d) globalAgentsFile=false：全局不注入、项目仍注入
  const msgs26b: ChatCompletionMessageParam[] = [{ role: 'user', content: '你好' }];
  await prepareContext({} as never, 'mock', msgs26b, { agentsFile: true, globalAgentsFile: false, preloadFiles: false, summarizeAt: 0 });
  if (msgs26b.some(isGlobal26) || !msgs26b.some(isProject26)) {
    console.error('✗ 场景 26 globalAgentsFile=false 未隔离全局记忆');
    process.exit(1);
  }
  // e) 自动写入：extractSessionMemory 提取 → appendGlobalMemory 追加（含防膨胀裁剪）
  const fakeStream26 = {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: '- 用户偏好使用中文回复\n- 用户喜欢简洁的步骤说明' } }] };
    },
  };
  const fakeClient26: any = { chat: { completions: { create: async () => fakeStream26 } } };
  const entry26 = await extractSessionMemory(fakeClient26, 'mock', [{ role: 'user', content: '以后都用中文回复我' }]);
  if (!entry26 || !entry26.includes('中文回复')) {
    console.error(`✗ 场景 26 extractSessionMemory 提取失败: ${JSON.stringify(entry26)}`);
    process.exit(1);
  }
  // 无新偏好：返回「无」→ null
  const noneStream26 = {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: '无' } }] };
    },
  };
  const entryNone26 = await extractSessionMemory({ chat: { completions: { create: async () => noneStream26 } } } as any, 'mock', [{ role: 'user', content: '帮我看下时间' }]);
  if (entryNone26 !== null) {
    console.error(`✗ 场景 26 「无」未转为 null: ${JSON.stringify(entryNone26)}`);
    process.exit(1);
  }
  const appended26 = await appendGlobalMemory(entry26!);
  if (!appended26) {
    console.error('✗ 场景 26 appendGlobalMemory 失败');
    process.exit(1);
  }
  // 1.0 P1-2 结构化布局：新写入进 memory/MEMORY.md 索引 + memory/topics/*.md
  const memTopics26 = await import('../src/agent/memory-topics.js');
  const topics26 = await memTopics26.listTopics();
  const joined26 = topics26.map((t) => t.content).join('\n');
  const index26 = fs.existsSync(memTopics26.memoryIndexFile()) ? fs.readFileSync(memTopics26.memoryIndexFile(), 'utf8') : '';
  if (!joined26.includes('用户喜欢简洁的步骤说明') || !index26.includes('用户喜欢简洁的步骤说明')) {
    console.error(`✗ 场景 26 结构化写入内容缺失: topics=${JSON.stringify(topics26.map((t) => t.file))} index=${JSON.stringify(index26.slice(-200))}`);
    process.exit(1);
  }
  // 去重：旧 AGENTS.md 的「用中文回复」已计入 known，「用户偏好使用中文回复」不重复写入
  if (joined26.includes('用户偏好使用中文回复')) {
    console.error('✗ 场景 26 去重未生效（「用户偏好使用中文回复」与遗留「用中文回复」重复，不应追加）');
    process.exit(1);
  }
  // 遗留 AGENTS.md 保持只读（结构化写入不碰它）；loadGlobalMemory 合并返回 legacy+索引
  const legacyAfter26 = fs.readFileSync(globalFile26, 'utf8');
  if (legacyAfter26 !== '# 全局偏好\n- 用中文回复\n') {
    console.error(`✗ 场景 26 遗留 AGENTS.md 被结构化写入污染: ${JSON.stringify(legacyAfter26)}`);
    process.exit(1);
  }
  const gmemAfter26 = await loadGlobalMemory();
  if (!gmemAfter26 || !gmemAfter26.content.includes('用户喜欢简洁的步骤说明')) {
    console.error('✗ 场景 26 loadGlobalMemory 未合并结构化索引');
    process.exit(1);
  }
  // TTL 归档（topics 版）：过期主题标记 archived 并重建索引
  const ttl26 = await memTopics26.applyTopicsTTL(-1); // 负值 = 全部视为过期
  const topicsAfterTtl26 = await memTopics26.listTopics();
  if (ttl26 < 1 || topicsAfterTtl26.some((t) => !t.archived)) {
    console.error('✗ 场景 26 topics TTL 归档失败');
    process.exit(1);
  }
  // f) /init --global：命令分发带 --global 参数（无 client 时提示，不崩溃）；
  //    writeGlobalAgentsFile 已存在不覆盖
  const s26 = createTuiState();
  await runCmd25({ state: s26, out: {}, session: {}, input: {}, messages: [], args: '--global' } as never, '/init --global');
  const panel26 = s26.cmdPanel;
  if (!panel26 || !panel26.lines.some((l) => String(l).includes('/init 需要 LLM 客户端'))) {
    console.error('✗ 场景 26 /init --global 无 client 未提示（或未进命令面板）');
    process.exit(1);
  }
  if (s26.lines.some((l) => l.text.includes('/init 需要 LLM 客户端'))) {
    console.error('✗ 场景 26 /init --global 提示泄漏进了对话流');
    process.exit(1);
  }
  const gw26 = await writeGlobalAgentsFile('# 新内容');
  if (gw26.ok) {
    console.error('✗ 场景 26 writeGlobalAgentsFile 覆盖了已存在文件');
    process.exit(1);
  }
  if (!gw26.path.endsWith('AGENTS.md')) {
    console.error(`✗ 场景 26 全局写入路径错误: ${gw26.path}`);
    process.exit(1);
  }
  // g) 快照：全局目录内容 + 运行环境
  const snap26 = await collectGlobalSnapshot();
  if (!snap26.includes('全局配置目录') || !snap26.includes('运行环境')) {
    console.error('✗ 场景 26 全局快照缺关键内容');
    process.exit(1);
  }
  // 清理临时 XDG 目录并恢复环境
  process.env.XDG_CONFIG_HOME = oldXdg;
  fs.rmSync(fakeXdg, { recursive: true, force: true });
  console.log('✓ 场景 26 通过：全局记忆路径/级联顺序/开关隔离/自动提取写入/防膨胀/--global 分发/防覆盖');

  // 场景 27：偏好去重 / 矛盾合并 —— normalizeMemoryItem/topicKey/extractMemoryItems/dedupMemoryItems
  //          + appendGlobalMemory 合并语义（重复跳过、矛盾原位替换、全重复返回 false）
  console.log('=== 场景 27：偏好去重（重复跳过 + 矛盾替换）===');
  const mem27 = await import('../src/agent/memory.js');
  const { normalizeMemoryItem, topicKey, extractMemoryItems, dedupMemoryItems, appendGlobalMemory: appendGlobalMemory27 } = mem27;
  // a) 规范化：去 - 前缀/标点/折叠空白/小写
  if (normalizeMemoryItem('- 用中文回复。') !== '用中文回复') {
    console.error(`✗ 场景 27 normalizeMemoryItem 失败: ${JSON.stringify(normalizeMemoryItem('- 用中文回复。'))}`);
    process.exit(1);
  }
  if (normalizeMemoryItem('  Reply   in  English  ') !== 'reply in english') {
    console.error(`✗ 场景 27 normalizeMemoryItem 未折叠空白/小写: ${JSON.stringify(normalizeMemoryItem('  Reply   in  English  '))}`);
    process.exit(1);
  }
  // b) 主题关键词：取分隔符前的短语
  if (topicKey('回复语言：中文') !== '回复语言' || topicKey('常用命令：npm') !== '常用命令') {
    console.error(`✗ 场景 27 topicKey 提取失败: ${JSON.stringify([topicKey('回复语言：中文'), topicKey('常用命令：npm')])}`);
    process.exit(1);
  }
  // c) 条目提取：- 开头的行；纯文本兜底为单条目
  if (JSON.stringify(extractMemoryItems('- 用中文\n- 用 npm')) !== JSON.stringify(['- 用中文', '- 用 npm'])) {
    console.error(`✗ 场景 27 extractMemoryItems 失败: ${JSON.stringify(extractMemoryItems('- 用中文\n- 用 npm'))}`);
    process.exit(1);
  }
  if (JSON.stringify(extractMemoryItems('喜欢简洁的回答')) !== JSON.stringify(['喜欢简洁的回答'])) {
    console.error(`✗ 场景 27 extractMemoryItems 纯文本兜底失败: ${JSON.stringify(extractMemoryItems('喜欢简洁的回答'))}`);
    process.exit(1);
  }
  // d) 去重：精确重复跳过；近似重复（包含关系）跳过；同主题矛盾替换
  const known27 = new Map<string, string>([
    ['用中文回复', '- 用中文回复'],
    ['回复语言中文', '- 回复语言：中文'],
    ['喜欢简洁的回答', '- 喜欢简洁的回答'],
  ]);
  const d27 = dedupMemoryItems(known27, [
    '- 用中文回复。', // 规范化后与「用中文回复」相同 → 重复跳过
    '- 用中文回复，谢谢', // 包含「用中文回复」→ 近似重复跳过
    '- 回复语言：English', // 同主题（回复语言）不同内容 → 矛盾替换
    '- 用户喜欢先用 npm 安装', // 新条目
  ]);
  if (d27.fresh.length !== 1 || d27.fresh[0] !== '- 用户喜欢先用 npm 安装') {
    console.error(`✗ 场景 27 去重结果错误: ${JSON.stringify(d27)}`);
    process.exit(1);
  }
  if (d27.replaced.get('- 回复语言：中文') !== '- 回复语言：English') {
    console.error(`✗ 场景 27 矛盾替换未生效: ${JSON.stringify([...d27.replaced])}`);
    process.exit(1);
  }
  if (d27.replaced.has('- 用中文回复')) {
    console.error('✗ 场景 27 重复条目被误判为矛盾替换');
    process.exit(1);
  }
  // e) appendGlobalMemory 合并语义（临时 XDG，1.0 P1-2 结构化布局）：
  //    追加 → 再追加相同 → 全重复返回 false 且不堆积；同主题矛盾写 topics 追加修正条目
  const oldXdg27 = process.env.XDG_CONFIG_HOME;
  const fakeXdg27 = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dedup-'));
  process.env.XDG_CONFIG_HOME = fakeXdg27;
  const ok27a = await appendGlobalMemory27('- 回复语言：中文');
  const ok27b = await appendGlobalMemory27('- 回复语言：中文。'); // 规范化后重复
  const ok27c = await appendGlobalMemory27('- 回复语言：English'); // 同主题（回复语言）追加修正
  if (!ok27a || ok27b !== false || !ok27c) {
    console.error(`✗ 场景 27 appendGlobalMemory 返回语义错误: ${JSON.stringify([ok27a, ok27b, ok27c])}`);
    process.exit(1);
  }
  const memTopics27 = await import('../src/agent/memory-topics.js');
  const topics27 = await memTopics27.listTopics();
  const joined27 = topics27.map((t) => t.content).join('\n');
  const index27 = fs.existsSync(memTopics27.memoryIndexFile()) ? fs.readFileSync(memTopics27.memoryIndexFile(), 'utf8') : '';
  // 同主题去重：该主题文件里「中文」只出现一次（追加被拒）
  if (topics27.length !== 1 || (joined27.match(/回复语言/g) ?? []).length !== 2) {
    console.error(`✗ 场景 27 去重结果错误（应 1 个主题、共 2 处「回复语言」）: ${JSON.stringify(topics27.map((t) => t.content))}`);
    process.exit(1);
  }
  // 矛盾修正：新值追加进主题文件（旧值保留可追溯——结构化布局是追加语义）
  if (!joined27.includes('回复语言：English')) {
    console.error(`✗ 场景 27 矛盾修正未生效（应追加 English）: ${JSON.stringify(joined27)}`);
    process.exit(1);
  }
  process.env.XDG_CONFIG_HOME = oldXdg27;
  fs.rmSync(fakeXdg27, { recursive: true, force: true });
  console.log('✓ 场景 27 通过：规范化/主题提取/去重/矛盾修正 + appendGlobalMemory 结构化合并（重复 false、修正生效）');

  // 场景 28：/plan 计划模式 —— 命令注册 + 只读工具过滤 + 系统提示 + footer 常驻指示
  console.log('=== 场景 28：/plan 计划模式（只读调研）===');
  const loop28 = await import('../src/agent/loop.js');
  const { buildToolSchemas, READ_ONLY_TOOLS, PLAN_MODE_NOTE } = loop28;
  const cmd28 = await import('../src/tui/commands.js');
  const { findCommand: findCmd28, runCommand: runCmd28 } = cmd28;
  // a) /plan 命令注册 + 切换（runCommand 分发，无提示文字，只翻转 state.planMode）
  if (!findCmd28('plan')) {
    console.error('✗ 场景 28 /plan 命令未注册');
    process.exit(1);
  }
  const s28 = createTuiState();
  await runCmd28({ state: s28, out: {}, session: {}, input: {}, messages: [] } as never, '/plan');
  if (!s28.planMode) {
    console.error('✗ 场景 28 /plan 未进入计划模式');
    process.exit(1);
  }
  if (s28.lines.some((l) => l.text.includes('计划'))) {
    console.error('✗ 场景 28 /plan 不应推 meta 提示文字（footer 常驻指示即可）');
    process.exit(1);
  }
  await runCmd28({ state: s28, out: {}, session: {}, input: {}, messages: [] } as never, '/plan');
  if (s28.planMode) {
    console.error('✗ 场景 28 /plan 再次执行未退出计划模式');
    process.exit(1);
  }
  // b) 只读工具过滤：planMode 时只剩 read_file/list_directory/search_code
  const allTools28 = [
    { name: 'read_file', description: '读文件' },
    { name: 'list_directory', description: '列目录' },
    { name: 'search_code', description: '搜索' },
    { name: 'write_file', description: '写文件' },
    { name: 'run_command', description: '执行命令' },
  ];
  const full28 = buildToolSchemas(allTools28, false);
  const plan28 = buildToolSchemas(allTools28, true);
  if (full28.length !== 5 || plan28.length !== 3) {
    console.error(`✗ 场景 28 工具过滤数量错误（full=${full28.length} plan=${plan28.length}）`);
    process.exit(1);
  }
  if (plan28.some((t) => !READ_ONLY_TOOLS.has(t.function.name))) {
    console.error(`✗ 场景 28 计划模式暴露了非只读工具: ${JSON.stringify(plan28.map((t) => t.function.name))}`);
    process.exit(1);
  }
  for (const n of ['read_file', 'list_directory', 'search_code']) {
    if (!plan28.some((t) => t.function.name === n)) {
      console.error(`✗ 场景 28 计划模式缺少只读工具 ${n}`);
      process.exit(1);
    }
  }
  // c) 系统提示追加只读说明
  if (!PLAN_MODE_NOTE.includes('计划模式') || !PLAN_MODE_NOTE.includes('read_file')) {
    console.error(`✗ 场景 28 PLAN_MODE_NOTE 内容缺失: ${JSON.stringify(PLAN_MODE_NOTE.slice(0, 60))}`);
    process.exit(1);
  }
  // d) footer 常驻指示：planMode=true 时模型行显示「模型 X · 计划模式」
  const s28b = createTuiState();
  s28b.version = '0.1.0';
  s28b.model = 'mock';
  s28b.planMode = true;
  pushLine(s28b, { kind: 'user', text: '你好' });
  const r28 = await render(s28b);
  if (!r28.frame.includes('模型 mock · 计划模式')) {
    console.error('✗ 场景 28 footer 未显示计划模式指示');
    process.exit(1);
  }
  s28b.planMode = false;
  const r28b = await render(s28b);
  if (r28b.frame.includes('计划模式')) {
    console.error('✗ 场景 28 退出计划模式后 footer 指示未消失');
    process.exit(1);
  }
  console.log('✓ 场景 28 通过：/plan 注册切换 + 只读工具过滤（write/run 不可见）+ 系统提示 + footer 常驻指示');

  // 场景 29：会话持久化 —— JSONL 落盘 / 列表 / 恢复 round-trip + 脚手架过滤
  console.log('=== 场景 29：会话持久化（JSONL 落盘 / --continue / -r）===');
  const sess29 = await import('../src/agent/session.js');
  const {
    sessionsDir,
    createSession,
    appendSessionMessages,
    finalizeSession,
    listSessions,
    latestSession,
    findSessionById,
    loadSession,
    persistableMessages,
    formatSessionInfo,
  } = sess29;
  const oldXdg29 = process.env.XDG_CONFIG_HOME;
  const fakeXdg29 = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-sess-'));
  process.env.XDG_CONFIG_HOME = fakeXdg29;
  // a) 目录路径尊重 XDG
  if (!sessionsDir().startsWith(fakeXdg29)) {
    console.error(`✗ 场景 29 sessionsDir 未尊重 XDG_CONFIG_HOME: ${sessionsDir()}`);
    process.exit(1);
  }
  // b) 创建 → meta 首行
  const proj29 = '/tmp/demo-project';
  const file29 = await createSession({ project: proj29, model: 'mock-model' });
  if (!file29 || !file29.endsWith('.jsonl') || !fs.existsSync(file29)) {
    console.error(`✗ 场景 29 createSession 失败: ${file29}`);
    process.exit(1);
  }
  const head29 = fs.readFileSync(file29, 'utf8').split('\n')[0];
  const meta29 = JSON.parse(head29);
  if (meta29.t !== 'meta' || meta29.project !== proj29 || meta29.model !== 'mock-model' || !meta29.id) {
    console.error(`✗ 场景 29 meta 首行格式错误: ${JSON.stringify(meta29)}`);
    process.exit(1);
  }
  // c) 追加消息：脚手架（项目记忆/预载）被过滤，对话消息完整保留
  const msgs29: ChatCompletionMessageParam[] = [
    { role: 'system', content: '[项目记忆 AGENTS.md：/x/AGENTS.md]\n项目约定' },
    { role: 'system', content: '[已按任务预载相关文件]\nfile content' },
    { role: 'user', content: '帮我看看项目结构' },
    { role: 'assistant', content: '好的，我来看看。' },
    { role: 'user', content: '再改一下 README' },
  ];
  const persistable29 = persistableMessages(msgs29);
  if (persistable29.some((m) => typeof m.content === 'string' && m.content.startsWith('['))) {
    console.error(`✗ 场景 29 persistableMessages 未过滤脚手架: ${JSON.stringify(persistable29)}`);
    process.exit(1);
  }
  if (!(await appendSessionMessages(file29, msgs29))) {
    console.error('✗ 场景 29 appendSessionMessages 失败');
    process.exit(1);
  }
  // d) round-trip：loadSession 恢复出对话消息（不含脚手架）
  const loaded29 = await loadSession(file29);
  if (!loaded29 || loaded29.messages.length !== 3) {
    console.error(`✗ 场景 29 loadSession round-trip 消息数错误: ${JSON.stringify(loaded29?.messages.length)}`);
    process.exit(1);
  }
  if (loaded29.messages[0].role !== 'user' || loaded29.messages[2].content !== '再改一下 README') {
    console.error(`✗ 场景 29 loadSession 内容错误: ${JSON.stringify(loaded29.messages)}`);
    process.exit(1);
  }
  // e) 列表 / 最近 / 按 id 查找
  await finalizeSession(file29);
  const list29 = await listSessions(proj29);
  if (list29.length !== 1 || list29[0].messages !== 3 || list29[0].id !== meta29.id) {
    console.error(`✗ 场景 29 listSessions 错误: ${JSON.stringify(list29.map((s) => ({ id: s.id, n: s.messages })))}`);
    process.exit(1);
  }
  const latest29 = await latestSession(proj29);
  if (!latest29 || latest29.id !== meta29.id) {
    console.error('✗ 场景 29 latestSession 未命中');
    process.exit(1);
  }
  const byId29 = await findSessionById(meta29.id);
  if (!byId29 || path.resolve(byId29) !== path.resolve(file29)) {
    console.error('✗ 场景 29 findSessionById 未命中');
    process.exit(1);
  }
  if (!formatSessionInfo(list29[0]).includes(meta29.id) || !formatSessionInfo(list29[0]).includes('3 条消息')) {
    console.error(`✗ 场景 29 formatSessionInfo 错误: ${formatSessionInfo(list29[0])}`);
    process.exit(1);
  }
  // f) 项目隔离：别的项目列表为空
  if ((await listSessions('/other/project')).length !== 0) {
    console.error('✗ 场景 29 会话未按项目隔离');
    process.exit(1);
  }
  // g) 恢复防重复回归（review 抓到的 bug）：--continue 恢复 + prepareContext 注入脚手架
  //    （unshift 全局记忆 system 消息）→ 按**可落盘数**切片，不会因下标偏移重复写盘
  const msgs29g: ChatCompletionMessageParam[] = [
    { role: 'user', content: '第一轮' },
    { role: 'assistant', content: '回答一' },
  ];
  const file29g = await createSession({ project: proj29, model: 'mock' });
  if (!file29g || !(await appendSessionMessages(file29g, msgs29g))) {
    console.error('✗ 场景 29 恢复回归前置失败');
    process.exit(1);
  }
  const loaded29g = await loadSession(file29g);
  if (!loaded29g || loaded29g.messages.length !== 2) {
    console.error('✗ 场景 29 恢复回归加载失败');
    process.exit(1);
  }
  const resumed29: ChatCompletionMessageParam[] = [...loaded29g.messages];
  const savedCount29 = persistableMessages(resumed29).length; // 已落盘可落盘数 = 2
  // prepareContext 注入脚手架（unshift 一条全局记忆 system）→ 可落盘计数不受影响
  resumed29.unshift({ role: 'system', content: '[全局记忆 AGENTS.md：/x/AGENTS.md]\n用中文' });
  resumed29.push({ role: 'user', content: '继续' });
  resumed29.push({ role: 'assistant', content: '回答二' });
  const toAppend29 = persistableMessages(resumed29).slice(savedCount29);
  if (toAppend29.length !== 2 || toAppend29[0].content !== '继续' || toAppend29[1].content !== '回答二') {
    console.error(`✗ 场景 29 恢复后按可落盘数切片错误（应只追加新轮 2 条）: ${JSON.stringify(toAppend29.map((m) => m.content))}`);
    process.exit(1);
  }
  process.env.XDG_CONFIG_HOME = oldXdg29;
  fs.rmSync(fakeXdg29, { recursive: true, force: true });
  console.log('✓ 场景 29 通过：JSONL 落盘/脚手架过滤/round-trip 恢复/列表/最近/按 id/项目隔离/格式化/恢复防重复');

  // 场景 30：/undo 文件撤销 —— UndoStack 快照/恢复 + /undo 命令端到端（恢复已有文件/删除新建/空栈）
  console.log('=== 场景 30：/undo 文件撤销 ===');
  const undo30 = await import('../src/tools/undo.js');
  const { UndoStack, applyUndo, withUndoSnapshot, SNAPSHOT_MAX_BYTES } = undo30;
  const cmd30 = await import('../src/tui/commands.js');
  const { findCommand: findCmd30, runCommand: runCmd30 } = cmd30;
  // a) 命令注册 + 联想
  if (!findCmd30('undo')) {
    console.error('✗ 场景 30 /undo 命令未注册');
    process.exit(1);
  }
  // b) 快照已有文件 → 修改 → applyUndo 恢复原内容
  const tmp30 = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-undo-'));
  const f30a = path.join(tmp30, 'a.txt');
  fs.writeFileSync(f30a, '原始内容 v1');
  const stack30 = new UndoStack();
  if (!(await stack30.snapshotWrite(f30a))) {
    console.error('✗ 场景 30 已有文件快照失败');
    process.exit(1);
  }
  fs.writeFileSync(f30a, '被修改的内容 v2');
  const entry30 = stack30.pop();
  if (!entry30 || !entry30.existed || entry30.content !== '原始内容 v1') {
    console.error(`✗ 场景 30 快照内容错误: ${JSON.stringify(entry30)}`);
    process.exit(1);
  }
  const msg30 = await applyUndo(entry30);
  if (fs.readFileSync(f30a, 'utf8') !== '原始内容 v1' || !msg30.includes('已恢复')) {
    console.error(`✗ 场景 30 撤销未恢复原内容（${msg30}）: ${JSON.stringify(fs.readFileSync(f30a, 'utf8'))}`);
    process.exit(1);
  }
  // c) 快照新建文件 → 撤销删除文件
  const f30b = path.join(tmp30, 'b-new.txt');
  if (!(await stack30.snapshotWrite(f30b))) {
    console.error('✗ 场景 30 新建文件快照失败');
    process.exit(1);
  }
  fs.writeFileSync(f30b, '新建内容');
  const entry30b = stack30.pop();
  if (!entry30b || entry30b.existed) {
    console.error(`✗ 场景 30 新建文件快照标记错误: ${JSON.stringify(entry30b)}`);
    process.exit(1);
  }
  const msg30b = await applyUndo(entry30b);
  if (fs.existsSync(f30b) || !msg30b.includes('删除')) {
    console.error(`✗ 场景 30 新建文件撤销未删除（${msg30b}）`);
    process.exit(1);
  }
  // d) 大小上限：超过 SNAPSHOT_MAX_BYTES 的快照跳过（不记录）
  const f30c = path.join(tmp30, 'big.txt');
  fs.writeFileSync(f30c, 'x'.repeat(SNAPSHOT_MAX_BYTES + 1));
  const stack30c = new UndoStack();
  if (await stack30c.snapshotWrite(f30c)) {
    console.error('✗ 场景 30 超大文件不应记录快照');
    process.exit(1);
  }
  if (stack30c.size !== 0) {
    console.error('✗ 场景 30 超大文件快照仍入栈');
    process.exit(1);
  }
  // e) withUndoSnapshot 包装：write_file 执行前自动快照；非写工具原样返回
  const stack30e = new UndoStack();
  const wrapped30 = withUndoSnapshot({ name: 'write_file', description: '', parameters: {}, execute: async () => 'ok' }, stack30e);
  if (wrapped30 === undefined || wrapped30.name !== 'write_file') {
    console.error('✗ 场景 30 包装后工具名错误');
    process.exit(1);
  }
  await wrapped30.execute({ path: f30a, content: 'v3' });
  if (stack30e.size !== 1 || stack30e.snapshotList()[0].content !== '原始内容 v1') {
    console.error('✗ 场景 30 withUndoSnapshot 未在写入前快照');
    process.exit(1);
  }
  const passthrough30 = withUndoSnapshot({ name: 'run_command', description: '', parameters: {}, execute: async () => 'ok' }, stack30e);
  if (passthrough30.name !== 'run_command') {
    console.error('✗ 场景 30 非写工具不应被包装');
    process.exit(1);
  }
  // f) /undo 命令端到端（TUI）：真实文件 + 快照栈 → 命令恢复文件 + 注入 system 提示
  const f30d = path.join(tmp30, 'undo-cmd.txt');
  fs.writeFileSync(f30d, '会话前内容');
  const s30 = createTuiState();
  const msgs30: ChatCompletionMessageParam[] = [];
  const stack30f = new UndoStack();
  await stack30f.snapshotWrite(f30d);
  fs.writeFileSync(f30d, '会话修改后的内容');
  await runCmd30({ state: s30, out: {}, session: {}, input: {}, messages: msgs30, undoStack: stack30f } as never, '/undo');
  if (fs.readFileSync(f30d, 'utf8') !== '会话前内容') {
    console.error(`✗ 场景 30 /undo 未恢复文件: ${JSON.stringify(fs.readFileSync(f30d, 'utf8'))}`);
    process.exit(1);
  }
  if (!s30.cmdPanel || !s30.cmdPanel.lines.some((l) => String(l).includes('已恢复') && String(l).includes('undo-cmd.txt'))) {
    console.error(`✗ 场景 30 /undo 结果提示缺失: ${JSON.stringify(s30.cmdPanel)}`);
    process.exit(1);
  }
  if (s30.lines.some((l) => l.text.includes('已恢复') && l.text.includes('undo-cmd.txt'))) {
    console.error('✗ 场景 30 /undo 结果提示泄漏进了对话流');
    process.exit(1);
  }
  if (!msgs30.some((m) => typeof m.content === 'string' && m.content.startsWith('[已执行 /undo]'))) {
    console.error('✗ 场景 30 /undo 未注入 system 提示');
    process.exit(1);
  }
  // g) /undo all：多文件全部恢复 + 新建文件删除；空栈提示不崩溃
  const f30e = path.join(tmp30, 'e.txt');
  const f30f = path.join(tmp30, 'f-new.txt');
  fs.writeFileSync(f30e, 'E 原');
  const stack30g = new UndoStack();
  await stack30g.snapshotWrite(f30e);
  await stack30g.snapshotWrite(f30f); // 新建
  fs.writeFileSync(f30e, 'E 改');
  fs.writeFileSync(f30f, 'F 新内容');
  const s30g = createTuiState();
  const msgs30g: ChatCompletionMessageParam[] = [];
  await runCmd30({ state: s30g, out: {}, session: {}, input: {}, messages: msgs30g, undoStack: stack30g, args: 'all' } as never, '/undo all');
  if (fs.readFileSync(f30e, 'utf8') !== 'E 原' || fs.existsSync(f30f)) {
    console.error('✗ 场景 30 /undo all 未全部恢复（E 应回原、f-new 应删除）');
    process.exit(1);
  }
  if (!s30g.cmdPanel || !s30g.cmdPanel.lines.some((l) => String(l).includes('已撤销全部 2 个写操作'))) {
    console.error(`✗ 场景 30 /undo all 提示缺失: ${JSON.stringify(s30g.cmdPanel)}`);
    process.exit(1);
  }
  const s30h = createTuiState();
  await runCmd30({ state: s30h, out: {}, session: {}, input: {}, messages: [] } as never, '/undo');
  if (!s30h.cmdPanel || !s30h.cmdPanel.lines.some((l) => String(l).includes('没有可撤销'))) {
    console.error('✗ 场景 30 空栈 /undo 未提示');
    process.exit(1);
  }
  // h) 边界：目标是目录 / stat 非 ENOENT 错误 → 不记录快照（review 抓到的误判）
  const dir30 = path.join(tmp30, 'subdir');
  fs.mkdirSync(dir30);
  const stack30h = new UndoStack();
  if (await stack30h.snapshotWrite(dir30)) {
    console.error('✗ 场景 30 目录不应记录快照（会被误判为新建文件）');
    process.exit(1);
  }
  if (stack30h.size !== 0) {
    console.error('✗ 场景 30 目录仍入栈');
    process.exit(1);
  }
  // 同一文件多次写入：popAll 逆序恢复 → 回到会话前状态
  const f30i = path.join(tmp30, 'i.txt');
  fs.writeFileSync(f30i, '原始');
  const stack30i = new UndoStack();
  await stack30i.snapshotWrite(f30i);
  fs.writeFileSync(f30i, '第一次改');
  await stack30i.snapshotWrite(f30i);
  fs.writeFileSync(f30i, '第二次改');
  const all30i = stack30i.popAll();
  for (const e of all30i) await applyUndo(e);
  if (fs.readFileSync(f30i, 'utf8') !== '原始' || all30i.length !== 2) {
    console.error(`✗ 场景 30 同文件多次写入 popAll 未回到原始状态: ${JSON.stringify(fs.readFileSync(f30i, 'utf8'))}`);
    process.exit(1);
  }
  fs.rmSync(tmp30, { recursive: true, force: true });
  console.log('✓ 场景 30 通过：快照/恢复/删除新建/上限/包装器 + /undo 与 /undo all 命令端到端/空栈提示');

  // 场景 31：/permission 安全权限面板 —— 低=read / 中=safe / 高=ask / 全量=full
  // 打开面板（默认高亮当前档位）+ ↑/↓/数字选择 + Enter 确认（state.permission 变更+meta）+ Esc 取消 + 渲染
  const cmd31 = await import('../src/tui/commands.js');
  const { openPermissionMenu, handleMenuKey: handleMenuKey31, PERMISSION_OPTIONS } = cmd31;
  console.log('=== 场景 31：/permission 安全权限面板 ===');
  const s31 = createTuiState();
  s31.version = '0.1.0';
  s31.model = 'mock';
  s31.permission = 'safe'; // 默认中（标准）
  pushLine(s31, { kind: 'user', text: '你好' });
  s31.status = '任务完成';
  // a) 面板打开：4 个档位，高亮当前值（safe）
  openPermissionMenu(s31);
  if (!s31.menu || s31.menu.id !== 'permission' || PERMISSION_OPTIONS.length !== 4) {
    console.error(`✗ 场景 31 面板未正确打开: ${JSON.stringify(s31.menu)}`);
    process.exit(1);
  }
  if (s31.menu.selectedIndex !== 1 || s31.menu.currentValue !== 'safe') {
    console.error(`✗ 场景 31 初始高亮/当前值错误: ${JSON.stringify(s31.menu)}`);
    process.exit(1);
  }
  // b) 键盘：↑ 从「中」上移到「低」→ 数字 1 直接选中「低」并确认 → permission=read、面板关闭、meta 提示
  if (!handleMenuKey31({ name: 'up', sequence: '', preventDefault: () => {}, stopPropagation: () => {} }, s31) || s31.menu?.selectedIndex !== 0) {
    console.error(`✗ 场景 31 ↑ 未移动高亮: ${JSON.stringify(s31.menu)}`);
    process.exit(1);
  }
  if (!handleMenuKey31({ name: '1', sequence: '', preventDefault: () => {}, stopPropagation: () => {} }, s31) || s31.menu !== null || s31.permission !== 'read') {
    console.error(`✗ 场景 31 数字键确认未生效（permission 应=read、面板应关闭）: ${JSON.stringify(s31.menu)}`);
    process.exit(1);
  }
  if (!s31.cmdPanel || !s31.cmdPanel.lines.some((l) => String(l).includes('已切换安全权限 → 低'))) {
    console.error(`✗ 场景 31 确认后 meta 提示缺失: ${JSON.stringify(s31.cmdPanel)}`);
    process.exit(1);
  }
  if (s31.lines.some((l) => l.text.includes('已切换安全权限'))) {
    console.error('✗ 场景 31 权限切换提示泄漏进了对话流');
    process.exit(1);
  }
  // c) Enter 确认：打开面板 → ↓ 移到「全量」→ Enter → permission=full
  openPermissionMenu(s31);
  handleMenuKey31({ name: 'down', sequence: '', preventDefault: () => {}, stopPropagation: () => {} }, s31);
  handleMenuKey31({ name: 'down', sequence: '', preventDefault: () => {}, stopPropagation: () => {} }, s31);
  handleMenuKey31({ name: 'down', sequence: '', preventDefault: () => {}, stopPropagation: () => {} }, s31);
  if (!handleMenuKey31({ name: 'return', sequence: '', preventDefault: () => {}, stopPropagation: () => {} }, s31) || s31.menu !== null || s31.permission !== 'full') {
    console.error(`✗ 场景 31 Enter 确认未生效（permission 应=full）: ${JSON.stringify(s31.menu)}`);
    process.exit(1);
  }
  // d) Esc 取消：再打开面板 → Esc → 面板关闭且档位不变
  openPermissionMenu(s31);
  s31.menu!.selectedIndex = 2; // 高亮「高」但不确认
  if (!handleMenuKey31({ name: 'escape', sequence: '', preventDefault: () => {}, stopPropagation: () => {} }, s31) || s31.menu !== null || s31.permission !== 'full') {
    console.error('✗ 场景 31 Esc 取消未生效');
    process.exit(1);
  }
  // e) runCommand('/permission') 分发：注册表里找到 → 打开面板（interactive 走同一路径）
  const s31e = createTuiState();
  s31e.version = '0.1.0';
  s31e.model = 'mock';
  s31e.permission = 'ask';
  const msgs31e: unknown[] = [];
  await cmd31.runCommand({ state: s31e, out: {}, session: {}, input: {}, messages: msgs31e } as never, '/permission');
  if (!s31e.menu || s31e.menu.id !== 'permission' || s31e.menu.selectedIndex !== 2) {
    console.error(`✗ 场景 31 runCommand /permission 未打开面板（应高亮当前 ask）: ${JSON.stringify(s31e.menu)}`);
    process.exit(1);
  }
  // f) 面板浮层渲染（alert）：4 个档位 + 当前值 ✓ + 光标 › + 提示行；未确认无切换提示
  const s31f = createTuiState();
  s31f.version = '0.1.0';
  s31f.model = 'mock';
  s31f.permission = 'read';
  pushLine(s31f, { kind: 'user', text: '你好' });
  openPermissionMenu(s31f);
  const t31f = await createTestRenderer({ width: 64, height: 20 });
  const tree31f = mountTree(t31f.renderer, s31f, { withInput: true });
  await t31f.renderOnce();
  const r31 = { frame: t31f.captureCharFrame() };
  console.log(r31.frame);
  const checks31 = ['安全权限', '低（只读）', '中（标准）', '高（谨慎）', '全量（直通）', '› 低（只读）', 'Enter 确认', 'Esc 取消'];
  const missing31 = checks31.filter((c) => !r31.frame.includes(c));
  if (missing31.length) {
    console.error(`✗ 场景 31 面板渲染缺: ${missing31.join(', ')}`);
    process.exit(1);
  }
  if (r31.frame.includes('已切换安全权限')) {
    console.error('✗ 场景 31 未确认就出现了切换提示');
    process.exit(1);
  }
  const rows31f = computeRows(s31f, { height: 20, width: 64 }, { withInput: true });
  if (rows31f.some((r) => r.text.includes('低（只读）') || r.text.includes('Enter 确认'))) {
    console.error('✗ 场景 31 菜单行仍内联在内容流（应移到 alert 浮层）');
    process.exit(1);
  }
  console.log('✓ 场景 31 通过：/permission 面板 4 档位（低/中/高/全量）+ ↑↓/数字/Enter/Esc + runCommand 分发 + 浮层渲染');

  // 场景 32：技能系统 —— frontmatter 解析 / 发现（项目+全局去重）/ 加载 / 注入消息 / /skill 命令分发
  console.log('=== 场景 32：技能（SKILL.md）系统 ===');
  const skill32 = await import('../src/agent/skill.js');
  const { parseSkillFrontmatter, discoverSkills, loadSkillContent, skillMessage, parseSkillFindResults, SKILL_PREFIX } = skill32;
  // a) frontmatter 解析：只认 name/description，其余字段忽略；无 frontmatter → 空
  const fm32 = parseSkillFrontmatter('---\nname: git-release\ndescription: 创建一致的发布与变更日志\nlicense: MIT\nmetadata:\n  audience: maintainers\n---\n## 用法\n- 从 PR 起草发布说明');
  if (fm32.name !== 'git-release' || fm32.description !== '创建一致的发布与变更日志') {
    console.error(`✗ 场景 32 frontmatter 解析错误: ${JSON.stringify(fm32)}`);
    process.exit(1);
  }
  if (parseSkillFrontmatter('没有 frontmatter 的正文').name !== undefined) {
    console.error('✗ 场景 32 无 frontmatter 不应解析出 name');
    process.exit(1);
  }
  // b) 发现：临时目录里建 .agents/skills/<name>/SKILL.md（合法）+ 非法（名字不符/缺 description）→ 只发现合法
  const tmp32 = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-skill-'));
  fs.mkdirSync(path.join(tmp32, '.agents', 'skills', 'git-release'), { recursive: true });
  fs.writeFileSync(path.join(tmp32, '.agents', 'skills', 'git-release', 'SKILL.md'), '---\nname: git-release\ndescription: 创建一致的发布\n---\n发布流程：\n1. 从 PR 起草说明\n2. 提议版本号\n3. gh release create');
  // 非法 1：frontmatter name 与目录名不符（目录 bad-name，frontmatter name: other）→ 跳过
  fs.mkdirSync(path.join(tmp32, '.agents', 'skills', 'bad-name'), { recursive: true });
  fs.writeFileSync(path.join(tmp32, '.agents', 'skills', 'bad-name', 'SKILL.md'), '---\nname: other-name\ndescription: 名字不符\n---\n内容');
  // 非法 2：缺 description → 跳过
  fs.mkdirSync(path.join(tmp32, '.agents', 'skills', 'no-desc'), { recursive: true });
  fs.writeFileSync(path.join(tmp32, '.agents', 'skills', 'no-desc', 'SKILL.md'), '---\nname: no-desc\n---\n内容');
  // 项目级发现需要 git 根边界（临时目录无 .git → 会向上扫到仓库根，可能发现仓库自身技能）——
  // 建一个 .git 目录作为边界，确保项目级只在临时目录内发现
  fs.mkdirSync(path.join(tmp32, '.git'), { recursive: true });
  const skills32 = await discoverSkills(tmp32);
  // 断言与机器环境无关：临时目录里的合法技能被发现（且非全局），非法目录被跳过；
  // 全局目录（~/.agents/skills 等）里的技能也会被发现（用户环境可能已有全局技能，不在此断言）
  const local32 = skills32.find((s) => s.name === 'git-release');
  if (!local32 || local32.global) {
    console.error(`✗ 场景 32 项目技能未发现: ${JSON.stringify(skills32)}`);
    process.exit(1);
  }
  if (skills32.some((s) => s.name === 'bad-name' || s.name === 'no-desc')) {
    console.error(`✗ 场景 32 非法技能目录未被跳过: ${JSON.stringify(skills32)}`);
    process.exit(1);
  }
  // c) 加载：按名返回 SKILL.md 完整内容；未知名返回 null
  const content32 = await loadSkillContent('git-release', tmp32);
  if (!content32 || !content32.includes('gh release create')) {
    console.error(`✗ 场景 32 加载技能内容错误: ${JSON.stringify(content32)}`);
    process.exit(1);
  }
  if ((await loadSkillContent('unknown-skill', tmp32)) !== null) {
    console.error('✗ 场景 32 未知技能不应加载到内容');
    process.exit(1);
  }
  // d) skillMessage：system 消息只列 name+description（不注入全文）
  const msg32 = skillMessage(skills32);
  if (msg32.role !== 'system' || typeof msg32.content !== 'string' || !msg32.content.startsWith(SKILL_PREFIX)) {
    console.error(`✗ 场景 32 skillMessage 格式错误: ${JSON.stringify(msg32.content).slice(0, 60)}`);
    process.exit(1);
  }
  if (msg32.content.includes('gh release create') || !msg32.content.includes('git-release')) {
    console.error('✗ 场景 32 skillMessage 应只列清单不含全文');
    process.exit(1);
  }
  // e) skill 工具：模型按 name 加载全文
  const { skillTool } = await import('../src/tools/skill.js');
  const oldCwd32 = process.cwd();
  process.chdir(tmp32);
  const toolRes32 = await skillTool.execute({ name: 'git-release' });
  if (!toolRes32.includes('gh release create')) {
    console.error(`✗ 场景 32 skill 工具加载失败: ${JSON.stringify(toolRes32.slice(0, 80))}`);
    process.exit(1);
  }
  const toolMiss32 = await skillTool.execute({ name: 'nope' });
  if (!toolMiss32.includes('未找到技能')) {
    console.error(`✗ 场景 32 skill 工具未知名应报未找到: ${JSON.stringify(toolMiss32.slice(0, 80))}`);
    process.exit(1);
  }
  // f) /skill 命令注册与分发：/skill 列出已发现（含 /skill show / 用法提示）
  const cmd32 = await import('../src/tui/commands.js');
  if (!cmd32.findCommand('skill')) {
    console.error('✗ 场景 32 /skill 命令未注册');
    process.exit(1);
  }
  const s32 = createTuiState();
  s32.version = '0.1.0';
  s32.model = 'mock';
  await cmd32.runCommand({ state: s32, out: {}, session: { paint: async () => {} }, input: {}, messages: [] } as never, '/skill');
  const pl32 = s32.cmdPanel?.lines ?? [];
  if (!pl32.some((l) => String(l).includes('git-release') && String(l).includes('创建一致的发布'))) {
    console.error(`✗ 场景 32 /skill 未列出已发现技能: ${JSON.stringify(pl32)}`);
    process.exit(1);
  }
  if (s32.lines.some((l) => l.text.includes('git-release'))) {
    console.error('✗ 场景 32 /skill 输出泄漏进了对话流');
    process.exit(1);
  }
  const s32b = createTuiState();
  await cmd32.runCommand({ state: s32b, out: {}, session: { paint: async () => {} }, input: {}, messages: [] } as never, '/skill show git-release');
  if (!(s32b.cmdPanel?.lines ?? []).some((l) => String(l).includes('gh release create'))) {
    console.error(`✗ 场景 32 /skill show 未显示内容: ${JSON.stringify(s32b.cmdPanel?.lines)}`);
    process.exit(1);
  }
  const s32c = createTuiState();
  await cmd32.runCommand({ state: s32c, out: {}, session: { paint: async () => {} }, input: {}, messages: [] } as never, '/skill badsub');
  if (!(s32c.cmdPanel?.lines ?? []).some((l) => String(l).includes('用法：/skill'))) {
    console.error(`✗ 场景 32 /skill 未知子命令未提示用法: ${JSON.stringify(s32c.cmdPanel?.lines)}`);
    process.exit(1);
  }
  process.chdir(oldCwd32);
  // g) 解析 npx skills find 输出（结果行 = owner/repo@skill，过滤噪音）
  const findOut32 = '安装前请确认技能来源可信\nvercel-labs/agent-skills@typescript-guide 1.2K installs\n└ https://skills.sh/typescript-guide\nwaybarrios/opencode-power-pack@code-review 856 installs\n└ https://skills.sh/code-review\nTip: 更多技能见 skills.sh';
  const parsed32 = parseSkillFindResults(findOut32);
  if (parsed32.length !== 2 || !parsed32[0].startsWith('vercel-labs/agent-skills@typescript-guide') || !parsed32[1].startsWith('waybarrios/opencode-power-pack@code-review')) {
    console.error(`✗ 场景 32 解析 find 输出错误: ${JSON.stringify(parsed32)}`);
    process.exit(1);
  }
  fs.rmSync(tmp32, { recursive: true, force: true });
  console.log('✓ 场景 32 通过：frontmatter 解析/发现去重/加载/skillMessage/skill 工具//skill 命令分发/find 输出解析');

  // 场景 33：/compact /agents /review /variants 四个命令 + 思考级别面板 + reasoningEffort 同步
  console.log('=== 场景 33：/compact /agents /review /variants ===');
  const cmd33 = await import('../src/tui/commands.js');
  const { openVariantsMenu, handleMenuKey: handleMenuKey33 } = cmd33;
  // a) 四个命令都已注册
  for (const n of ['compact', 'agents', 'review', 'variants']) {
    if (!cmd33.findCommand(n)) {
      console.error(`✗ 场景 33 /${n} 命令未注册`);
      process.exit(1);
    }
  }
  // b) /variants 面板：打开 → 高亮当前级别（medium）→ ↓ 移动 → Enter 确认 → state.reasoningEffort 变更 + meta 提示
  const s33 = createTuiState();
  s33.version = '0.1.0';
  s33.model = 'mock';
  s33.reasoningEffort = 'medium';
  s33.reasoningEffortOptions = ['low', 'medium', 'high'];
  pushLine(s33, { kind: 'user', text: '你好' });
  s33.status = '任务完成';
  openVariantsMenu(s33);
  if (!s33.menu || s33.menu.id !== 'variants' || s33.menu.options.length !== 3 || s33.menu.selectedIndex !== 1) {
    console.error(`✗ 场景 33 /variants 面板未正确打开: ${JSON.stringify(s33.menu)}`);
    process.exit(1);
  }
  // ↓ 移到 high → Enter 确认
  handleMenuKey33({ name: 'down', sequence: '', preventDefault: () => {}, stopPropagation: () => {} }, s33);
  if (!handleMenuKey33({ name: 'return', sequence: '', preventDefault: () => {}, stopPropagation: () => {} }, s33) || s33.menu !== null || s33.reasoningEffort !== 'high') {
    console.error(`✗ 场景 33 /variants Enter 确认未生效（应=high）: ${JSON.stringify(s33.menu)}`);
    process.exit(1);
  }
  if (!s33.cmdPanel || !s33.cmdPanel.lines.some((l) => String(l).includes('已切换思考级别 → high'))) {
    console.error(`✗ 场景 33 /variants 确认后 meta 提示缺失: ${JSON.stringify(s33.cmdPanel)}`);
    process.exit(1);
  }
  if (s33.lines.some((l) => l.text.includes('已切换思考级别'))) {
    console.error('✗ 场景 33 /variants 提示泄漏进了对话流');
    process.exit(1);
  }
  if (s33.variantsSave !== 'high') {
    console.error(`✗ 场景 33 /variants 确认未记录持久化意图: ${JSON.stringify(s33.variantsSave)}`);
    process.exit(1);
  }
  // 自定义选项（配置 reasoningEffortOptions 只支持 low/high）：面板只列配置的选项
  const s33b = createTuiState();
  s33b.reasoningEffort = 'low';
  s33b.reasoningEffortOptions = ['low', 'high'];
  openVariantsMenu(s33b);
  if (!s33b.menu || s33b.menu.options.length !== 2 || s33b.menu.options[1].value !== 'high') {
    console.error(`✗ 场景 33 /variants 自定义选项未生效: ${JSON.stringify(s33b.menu)}`);
    process.exit(1);
  }
  // c) /compact：无 client → 提示需要客户端（不崩溃）；有 client + 消息太短 → 提示无可压缩
  const fakeStream33 = {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: '（摘要）前几轮内容已合并。' } }] };
    },
  };
  const fakeClient33: any = { chat: { completions: { create: async () => fakeStream33 } } };
  const s33c = createTuiState();
  await cmd33.runCommand({ state: s33c, out: {}, session: {}, input: {}, messages: [] } as never, '/compact');
  if (!(s33c.cmdPanel?.lines ?? []).some((l) => String(l).includes('/compact 需要 LLM 客户端'))) {
    console.error(`✗ 场景 33 /compact 无 client 未提示: ${JSON.stringify(s33c.cmdPanel?.lines)}`);
    process.exit(1);
  }
  // 短对话（无摘要切分点）→ 提示「还很短或无可压缩」
  const s33d = createTuiState();
  const msgs33d: ChatCompletionMessageParam[] = [
    { role: 'user', content: '第一轮' },
    { role: 'assistant', content: '回答一' },
  ];
  await cmd33.runCommand({ state: s33d, out: {}, session: {}, input: {}, messages: msgs33d, client: fakeClient33, model: 'mock' } as never, '/compact');
  if (!(s33d.cmdPanel?.lines ?? []).some((l) => String(l).includes('还很短或无可压缩'))) {
    console.error(`✗ 场景 33 /compact 短对话未提示: ${JSON.stringify(s33d.cmdPanel?.lines)}`);
    process.exit(1);
  }
  // 长对话（有可压缩切分点）→ 真的压缩了旧消息（fake client 返回摘要）
  const msgs33e: ChatCompletionMessageParam[] = [];
  for (let i = 0; i < 20; i++) {
    msgs33e.push({ role: 'user', content: `第 ${i} 轮问题` });
    msgs33e.push({ role: 'assistant', content: `第 ${i} 轮回答` });
  }
  const s33e = createTuiState();
  const before33 = msgs33e.length;
  await cmd33.runCommand({ state: s33e, out: {}, session: {}, input: {}, messages: msgs33e, client: fakeClient33, model: 'mock' } as never, '/compact');
  if (msgs33e.length >= before33 || !(s33e.cmdPanel?.lines ?? []).some((l) => String(l).includes('已压缩'))) {
    console.error(`✗ 场景 33 /compact 长对话未压缩（${before33}→${msgs33e.length}）: ${JSON.stringify(s33e.cmdPanel?.lines)}`);
    process.exit(1);
  }
  // d) /agents：展示子代理配置（工具列表含 delegate → 已启用；模型/步骤上限/工具名）
  const s33f = createTuiState();
  const fakeTools33 = [
    { name: 'read_file' }, { name: 'write_file' }, { name: 'list_directory' },
    { name: 'search_code' }, { name: 'run_command' }, { name: 'skill' }, { name: 'delegate' },
  ];
  await cmd33.runCommand({ state: s33f, out: {}, session: {}, input: {}, messages: [], tools: fakeTools33, model: 'mock-model', maxSubagentSteps: 10 } as never, '/agents');
  const agentsLines33 = (s33f.cmdPanel?.lines ?? []).map((l) => String(l)).join('\n');
  if (!agentsLines33.includes('已启用') || !agentsLines33.includes('mock-model') || !agentsLines33.includes('最大循环步数：10')) {
    console.error(`✗ 场景 33 /agents 未展示子代理配置: ${JSON.stringify(s33f.cmdPanel?.lines)}`);
    process.exit(1);
  }
  if (!agentsLines33.includes('read_file') || agentsLines33.includes('delegate、read_file')) {
    console.error(`✗ 场景 33 /agents 工具列表错误（应列出除 delegate 外的工具）: ${JSON.stringify(s33f.cmdPanel?.lines)}`);
    process.exit(1);
  }
  if (s33f.lines.some((l) => l.text.includes('已启用'))) {
    console.error('✗ 场景 33 /agents 输出泄漏进了对话流');
    process.exit(1);
  }
  // 未启用：工具链无 delegate
  const s33g = createTuiState();
  await cmd33.runCommand({ state: s33g, out: {}, session: {}, input: {}, messages: [], tools: [{ name: 'read_file' }], model: 'mock', maxSubagentSteps: 10 } as never, '/agents');
  if (!(s33g.cmdPanel?.lines ?? []).some((l) => String(l).includes('未启用'))) {
    console.error(`✗ 场景 33 /agents 未展示未启用状态: ${JSON.stringify(s33g.cmdPanel?.lines)}`);
    process.exit(1);
  }
  // e) /review：无 client → 提示需要客户端（不崩溃）；有 client 但 git 不可用 → 提示
  const s33h = createTuiState();
  await cmd33.runCommand({ state: s33h, out: {}, session: {}, input: {}, messages: [] } as never, '/review');
  if (!(s33h.cmdPanel?.lines ?? []).some((l) => String(l).includes('/review 需要 LLM 客户端'))) {
    console.error(`✗ 场景 33 /review 无 client 未提示: ${JSON.stringify(s33h.cmdPanel?.lines)}`);
    process.exit(1);
  }
  // 在临时 git 仓库里跑 /review（有改动）→ typecheck 检测 + collectDiff + LLM 审查
  const tmp33 = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-review-'));
  fs.writeFileSync(path.join(tmp33, 'package.json'), JSON.stringify({ scripts: { typecheck: 'echo typecheck-ok' } }));
  const oldCwd33 = process.cwd();
  process.chdir(tmp33);
  const { spawnSync } = await import('node:child_process');
  spawnSync('git', ['init', '-q'], { cwd: tmp33 });
  spawnSync('git', ['add', '-A'], { cwd: tmp33 });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: tmp33 });
  fs.writeFileSync(path.join(tmp33, 'a.ts'), 'export const a = 1;\n');
  const s33i = createTuiState();
  await cmd33.runCommand({ state: s33i, out: {}, session: { paint: async () => {} }, input: {}, messages: [], client: fakeClient33, model: 'mock' } as never, '/review');
  const reviewLines33 = (s33i.cmdPanel?.lines ?? []).map((l) => String(l)).join('\n');
  if (!reviewLines33.includes('审查结果') || !reviewLines33.includes('typecheck')) {
    console.error(`✗ 场景 33 /review 未输出审查结果: ${JSON.stringify(s33i.cmdPanel?.lines)}`);
    process.exit(1);
  }
  if (s33i.lines.some((l) => l.text.includes('审查结果'))) {
    console.error('✗ 场景 33 /review 输出泄漏进了对话流');
    process.exit(1);
  }
  process.chdir(oldCwd33);
  fs.rmSync(tmp33, { recursive: true, force: true });
  console.log('✓ 场景 33 通过：/compact 压缩（短/长对话）/agents 配置展示/variants 面板+自定义选项/review 无 client 守卫 + 真实 git 仓库审查');

  // 场景 34：/model 切换模型 —— config models 多端点展开 + attachRuntime 注入 models/modelRuntime
  //          + /model 面板打开/确认 + createClient 按端点重建
  console.log('=== 场景 34：/model 切换模型 ===');
  // a) config models 解析：顶层 model + models 缺省字段回退到顶层
  const tmp34 = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-model-'));
  fs.writeFileSync(
    path.join(tmp34, 'omni.json'),
    JSON.stringify({
      model: 'deepseek-chat',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-top',
      // per-model variants：顶层全局思考级别 + glm 专属级别/选项（moonshot 只配端点 → 回退全局）
      reasoningEffort: 'medium',
      reasoningEffortOptions: ['low', 'medium', 'high'],
      models: {
        'glm-4-flash': {
          baseURL: 'https://open.bigmodel.cn/api/paas/v4',
          apiKey: 'sk-glm',
          reasoningEffortOptions: ['low', 'high'],
          reasoningEffort: 'high',
        },
        'moonshot-v1-8k': { baseURL: 'https://api.moonshot.cn/v1' },
      },
    })
  );
  const { loadConfig } = await import('../src/config/index.js');
  const oldEnv34 = process.env.OMNI_CONFIG;
  process.env.OMNI_CONFIG = path.join(tmp34, 'omni.json');
  const cfg34 = loadConfig();
  if (!cfg34.models || Object.keys(cfg34.models).length !== 2) {
    console.error(`✗ 场景 34 config models 解析失败: ${JSON.stringify(cfg34.models)}`);
    process.exit(1);
  }
  // b) attachRuntime：展开 models 列表（顶层 + 配置）+ modelRuntime 指向默认模型
  // （保持 OMNI_CONFIG 指向临时配置，让 prepareRun 内二次 loadConfig 读到同一份）
  const { prepareRun, attachRuntime } = await import('../src/main.js');
  const runCtx34 = prepareRun({});
  await attachRuntime(runCtx34, {} as never);
  process.env.OMNI_CONFIG = oldEnv34;
  const models34 = runCtx34.runOpts.models ?? [];
  if (models34.length !== 3 || models34[0].name !== 'deepseek-chat' || !models34.find((m) => m.name === 'glm-4-flash') || !models34.find((m) => m.name === 'moonshot-v1-8k')) {
    console.error(`✗ 场景 34 attachRuntime 未展开 models 列表: ${JSON.stringify(models34.map((m) => m.name))}`);
    process.exit(1);
  }
  const glm34 = models34.find((m) => m.name === 'glm-4-flash')!;
  const moon34 = models34.find((m) => m.name === 'moonshot-v1-8k')!;
  if (glm34.baseURL !== 'https://open.bigmodel.cn/api/paas/v4' || glm34.apiKey !== 'sk-glm') {
    console.error(`✗ 场景 34 glm 端点缺省字段未生效: ${JSON.stringify(glm34)}`);
    process.exit(1);
  }
  if (moon34.apiKey !== 'sk-top' || moon34.baseURL !== 'https://api.moonshot.cn/v1') {
    console.error(`✗ 场景 34 moonshot 未回退顶层 apiKey: ${JSON.stringify(moon34)}`);
    process.exit(1);
  }
  // b2) per-model variants 展开：端点携带解析后的思考级别（缺省回退顶层全局）
  const def34 = models34[0];
  if (
    def34.reasoningEffort !== 'medium' ||
    JSON.stringify(def34.reasoningEffortOptions) !== JSON.stringify(['low', 'medium', 'high']) ||
    glm34.reasoningEffort !== 'high' ||
    JSON.stringify(glm34.reasoningEffortOptions) !== JSON.stringify(['low', 'high']) ||
    moon34.reasoningEffort !== 'medium' ||
    JSON.stringify(moon34.reasoningEffortOptions) !== JSON.stringify(['low', 'medium', 'high'])
  ) {
    console.error(`✗ 场景 34 per-model variants 展开失败: def=${JSON.stringify(def34)} glm=${JSON.stringify(glm34)} moon=${JSON.stringify(moon34)}`);
    process.exit(1);
  }
  if (runCtx34.runOpts.modelRuntime?.model !== 'deepseek-chat') {
    console.error(`✗ 场景 34 modelRuntime 未指向默认模型: ${JSON.stringify(runCtx34.runOpts.modelRuntime)}`);
    process.exit(1);
  }
  // c) createClient：按端点重建（baseURL/UA 生效）
  const { createClient } = await import('../src/client.js');
  const c34 = createClient(glm34, '');
  if (!c34.baseURL || !c34.baseURL.includes('open.bigmodel.cn')) {
    console.error(`✗ 场景 34 createClient 未按端点 baseURL 重建: ${c34.baseURL}`);
    process.exit(1);
  }
  // d) /model 面板：打开 → 高亮当前（deepseek-chat）→ ↓↓ 移到 moonshot → Enter 确认 → state.model 变更 + meta
  const cmd34 = await import('../src/tui/commands.js');
  const { openModelMenu, handleMenuKey: handleMenuKey34 } = cmd34;
  if (!cmd34.findCommand('model')) {
    console.error('✗ 场景 34 /model 命令未注册');
    process.exit(1);
  }
  const s34 = createTuiState();
  s34.version = '0.1.0';
  s34.model = 'deepseek-chat';
  s34.models = ['deepseek-chat', 'glm-4-flash', 'moonshot-v1-8k'];
  pushLine(s34, { kind: 'user', text: '你好' });
  openModelMenu(s34);
  if (!s34.menu || s34.menu.id !== 'model' || s34.menu.options.length !== 3 || s34.menu.selectedIndex !== 0) {
    console.error(`✗ 场景 34 /model 面板未正确打开: ${JSON.stringify(s34.menu)}`);
    process.exit(1);
  }
  const key34 = { sequence: '', preventDefault: () => {}, stopPropagation: () => {} };
  handleMenuKey34({ name: 'down', ...key34 }, s34);
  handleMenuKey34({ name: 'down', ...key34 }, s34);
  if (!handleMenuKey34({ name: 'return', ...key34 }, s34) || s34.menu !== null || s34.model !== 'moonshot-v1-8k') {
    console.error(`✗ 场景 34 /model Enter 确认未生效（应=moonshot-v1-8k）: ${JSON.stringify(s34.menu)}`);
    process.exit(1);
  }
  if (!s34.cmdPanel || !s34.cmdPanel.lines.some((l) => String(l).includes('已切换模型 → moonshot-v1-8k'))) {
    console.error(`✗ 场景 34 /model 确认后 meta 提示缺失: ${JSON.stringify(s34.cmdPanel)}`);
    process.exit(1);
  }
  if (s34.lines.some((l) => l.text.includes('已切换模型'))) {
    console.error('✗ 场景 34 /model 提示泄漏进了对话流');
    process.exit(1);
  }
  if (s34.modelSave !== 'moonshot-v1-8k') {
    console.error(`✗ 场景 34 /model 确认未记录持久化意图: ${JSON.stringify(s34.modelSave)}`);
    process.exit(1);
  }
  // 数字键 1 直接选中第一个模型
  openModelMenu(s34);
  handleMenuKey34({ name: '1', ...key34 }, s34);
  if (s34.model !== 'deepseek-chat' || s34.menu !== null) {
    console.error(`✗ 场景 34 /model 数字键选择未生效: ${JSON.stringify(s34)}`);
    process.exit(1);
  }
  if (s34.modelSave !== 'deepseek-chat') {
    console.error(`✗ 场景 34 /model 数字键确认未记录持久化意图: ${JSON.stringify(s34.modelSave)}`);
    process.exit(1);
  }
  // Esc 取消不改模型
  openModelMenu(s34);
  handleMenuKey34({ name: 'escape', ...key34 }, s34);
  if (s34.menu !== null || s34.model !== 'deepseek-chat') {
    console.error(`✗ 场景 34 /model Esc 取消未生效: ${JSON.stringify(s34)}`);
    process.exit(1);
  }
  // 无 models 时回退到当前模型单选项
  const s34b = createTuiState();
  s34b.model = 'gpt-4o-mini';
  s34b.models = [];
  openModelMenu(s34b);
  if (!s34b.menu || s34b.menu.options.length !== 1 || s34b.menu.options[0].value !== 'gpt-4o-mini') {
    console.error(`✗ 场景 34 /model 无 models 回退失败: ${JSON.stringify(s34b.menu)}`);
    process.exit(1);
  }
  // e) /model add：参数解析（parseModelAddArgs）——名称 + 三个 flag + 未知 flag/缺名报错
  const { parseModelAddArgs, persistModelDefaultToConfig, persistModelToConfig, persistReasoningEffortToConfig } = await import('../src/config/write.js');
  const addOk = parseModelAddArgs('my-model --base-url https://x.com/v1 --api-key sk-1 --user-agent ua-1');
  if (!addOk.ok || addOk.name !== 'my-model' || addOk.baseURL !== 'https://x.com/v1' || addOk.apiKey !== 'sk-1' || addOk.userAgent !== 'ua-1') {
    console.error(`✗ 场景 34 parseModelAddArgs 解析失败: ${JSON.stringify(addOk)}`);
    process.exit(1);
  }
  const addMin = parseModelAddArgs('deepseek-chat --base-url https://api.deepseek.com/v1');
  if (!addMin.ok || addMin.name !== 'deepseek-chat' || addMin.apiKey !== undefined || addMin.userAgent !== undefined) {
    console.error(`✗ 场景 34 parseModelAddArgs 缺省字段应为 undefined: ${JSON.stringify(addMin)}`);
    process.exit(1);
  }
  if (parseModelAddArgs('--base-url https://x.com').ok || parseModelAddArgs('x --bad-flag v').ok || parseModelAddArgs('x --api-key').ok) {
    console.error('✗ 场景 34 parseModelAddArgs 未知 flag / 缺名 / 缺值未报错');
    process.exit(1);
  }
  // f) persistModelToConfig：纯 JSON 配置文件自动追加 + JSONC 跳过 + 无配置时新建
  const tmp34b = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-add-'));
  const jsonFile = path.join(tmp34b, 'omni.json');
  fs.writeFileSync(jsonFile, JSON.stringify({ model: 'a', models: { a: { baseURL: 'https://a.com/v1' } } }));
  const cfg34add = { sources: [jsonFile] } as never;
  const resJson = persistModelToConfig('b', { baseURL: 'https://b.com/v1', apiKey: 'sk-b' }, cfg34add);
  if (!resJson.ok || resJson.file !== jsonFile) {
    console.error(`✗ 场景 34 持久化到纯 JSON 失败: ${JSON.stringify(resJson)}`);
    process.exit(1);
  }
  const written34 = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  if (written34.models?.b?.baseURL !== 'https://b.com/v1' || written34.models?.b?.apiKey !== 'sk-b' || written34.models?.a?.baseURL !== 'https://a.com/v1') {
    console.error(`✗ 场景 34 持久化内容错误: ${JSON.stringify(written34)}`);
    process.exit(1);
  }
  // JSONC（带注释）不自动改写，返回提示
  const jsoncFile = path.join(tmp34b, 'omni.jsonc');
  fs.writeFileSync(jsoncFile, '{ "model": "a", // 注释\n "models": {} }\n');
  const resJsonc = persistModelToConfig('c', { baseURL: 'https://c.com/v1' }, { sources: [jsoncFile] } as never);
  if (resJsonc.ok || !resJsonc.message.includes('手动')) {
    console.error(`✗ 场景 34 JSONC 未跳过自动改写: ${JSON.stringify(resJsonc)}`);
    process.exit(1);
  }
  if (!fs.readFileSync(jsoncFile, 'utf8').includes('// 注释')) {
    console.error('✗ 场景 34 JSONC 文件被破坏（注释丢失）');
    process.exit(1);
  }
  // 无配置文件 → 新建 ./omni.json（cwd 指向临时目录）
  const tmp34c = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-new-'));
  const oldCwd34 = process.cwd();
  process.chdir(tmp34c);
  const resNew = persistModelToConfig('n', { baseURL: 'https://n.com/v1' }, { sources: [] } as never);
  process.chdir(oldCwd34);
  if (!resNew.ok || !fs.existsSync(path.join(tmp34c, 'omni.json')) || JSON.parse(fs.readFileSync(path.join(tmp34c, 'omni.json'), 'utf8')).models?.n?.baseURL !== 'https://n.com/v1') {
    console.error(`✗ 场景 34 无配置时未新建 omni.json: ${JSON.stringify(resNew)}`);
    process.exit(1);
  }
  // g) TUI /model add 分发：runCommand 经 ctx.onAddModel 注册 + state.models 更新 + 切换。
  //     **必须切到临时 cwd**：cfg.sources 为空 → persistModelToConfig 在 cwd 新建
  //     ./omni.json（无配置新建语义）。测试 cwd 是项目根，会把测试模型写进项目 omni.json、
  //     覆盖用户配置——实测事故：跑快照后项目根 omni.json 被 glm-4-flash fixture 覆盖。
  const tmp34g = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-add-dispatch-'));
  const oldCwd34g = process.cwd();
  process.chdir(tmp34g);
  const s34c = createTuiState();
  s34c.version = '0.1.0';
  s34c.model = 'deepseek-chat';
  s34c.models = ['deepseek-chat'];
  const runCtx34add = {
    state: s34c,
    args: 'add glm-4-flash --base-url https://open.bigmodel.cn/api/paas/v4 --api-key sk-glm',
    models: s34c.models,
    cfg: { sources: [] } as never,
    onAddModel: (ep: { name: string; baseURL?: string; apiKey?: string }) => {
      s34c.models = [...s34c.models, ep.name];
      s34c.model = ep.name;
      return null;
    },
  } as never;
  await cmd34.runCommand(runCtx34add, '/model add glm-4-flash --base-url https://open.bigmodel.cn/api/paas/v4 --api-key sk-glm');
  process.chdir(oldCwd34g);
  // 持久化目标落在临时目录：项目根不被污染，临时目录出现测试 fixture
  const gWritten = fs.existsSync(path.join(tmp34g, 'omni.json'))
    ? JSON.parse(fs.readFileSync(path.join(tmp34g, 'omni.json'), 'utf8'))
    : null;
  if (!gWritten || gWritten.models?.['glm-4-flash']?.baseURL !== 'https://open.bigmodel.cn/api/paas/v4') {
    console.error(`✗ 场景 34 /model add 分发未持久化到临时 cwd: ${JSON.stringify(gWritten)}`);
    process.exit(1);
  }
  if (s34c.model !== 'glm-4-flash' || !s34c.models.includes('glm-4-flash') || !(s34c.cmdPanel?.lines ?? []).some((l) => String(l).includes('已添加并切换模型 → glm-4-flash'))) {
    console.error(`✗ 场景 34 TUI /model add 分发未生效: ${JSON.stringify({ model: s34c.model, models: s34c.models, panel: s34c.cmdPanel?.lines })}`);
    process.exit(1);
  }
  fs.rmSync(tmp34g, { recursive: true, force: true });
  // /model <名称> 直接切换：onSwitchModel 回调被调用
  const s34d = createTuiState();
  s34d.version = '0.1.0';
  s34d.model = 'deepseek-chat';
  s34d.models = ['deepseek-chat', 'glm-4-flash'];
  let switched34: string | null = null;
  await cmd34.runCommand(
    { state: s34d, args: 'glm-4-flash', onSwitchModel: (n: string) => { switched34 = n; return null; } } as never,
    '/model glm-4-flash'
  );
  if (switched34 !== 'glm-4-flash' || !(s34d.cmdPanel?.lines ?? []).some((l) => String(l).includes('已切换模型 → glm-4-flash'))) {
    console.error(`✗ 场景 34 TUI /model <名称> 切换分发未生效: switched=${switched34} panel=${JSON.stringify(s34d.cmdPanel?.lines)}`);
    process.exit(1);
  }
  if (s34d.modelSave !== 'glm-4-flash') {
    console.error(`✗ 场景 34 /model <名称> 切换未记录持久化意图: ${JSON.stringify(s34d.modelSave)}`);
    process.exit(1);
  }
  // h) persistModelDefaultToConfig / persistReasoningEffortToConfig：纯 JSON 改写顶层字段 + JSONC 跳过
  const tmp34d = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-def-'));
  const jsonFile2 = path.join(tmp34d, 'omni.json');
  fs.writeFileSync(jsonFile2, JSON.stringify({ model: 'a', reasoningEffort: 'low' }));
  const resDef = persistModelDefaultToConfig('glm-4-flash', { sources: [jsonFile2] } as never);
  if (!resDef.ok || !resDef.message.includes('glm-4-flash')) {
    console.error(`✗ 场景 34 persistModelDefaultToConfig 失败: ${JSON.stringify(resDef)}`);
    process.exit(1);
  }
  const resEff = persistReasoningEffortToConfig('high', { sources: [jsonFile2] } as never);
  if (!resEff.ok) {
    console.error(`✗ 场景 34 persistReasoningEffortToConfig 失败: ${JSON.stringify(resEff)}`);
    process.exit(1);
  }
  const written34d = JSON.parse(fs.readFileSync(jsonFile2, 'utf8'));
  if (written34d.model !== 'glm-4-flash' || written34d.reasoningEffort !== 'high') {
    console.error(`✗ 场景 34 顶层字段持久化内容错误: ${JSON.stringify(written34d)}`);
    process.exit(1);
  }
  const jsoncFile2 = path.join(tmp34d, 'omni.jsonc');
  fs.writeFileSync(jsoncFile2, '{ "model": "a", // 注释\n}\n');
  const resDefJsonc = persistModelDefaultToConfig('b', { sources: [jsoncFile2] } as never);
  if (resDefJsonc.ok || !resDefJsonc.message.includes('手动')) {
    console.error(`✗ 场景 34 persistModelDefaultToConfig 未跳过 JSONC: ${JSON.stringify(resDefJsonc)}`);
    process.exit(1);
  }
  if (!fs.readFileSync(jsoncFile2, 'utf8').includes('// 注释')) {
    console.error('✗ 场景 34 JSONC 文件被破坏（注释丢失）');
    process.exit(1);
  }
  // h2) per-model variants 持久化：当前模型在 models 表有专属条目 → 写 models.<模型>.reasoningEffort；
  //     未指定模型 / 未知模型 → 写顶层全局（models 表既有专属级别不被破坏）
  const tmp34e = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-eff-model-'));
  const jsonFile3 = path.join(tmp34e, 'omni.json');
  fs.writeFileSync(
    jsonFile3,
    JSON.stringify({
      model: 'a',
      reasoningEffort: 'medium',
      models: { a: { baseURL: 'https://a.com/v1' }, b: { baseURL: 'https://b.com/v1' } },
    })
  );
  const resEffModel = persistReasoningEffortToConfig('high', { sources: [jsonFile3] } as never, 'a');
  if (!resEffModel.ok || !resEffModel.message.includes('仅对模型 a 生效')) {
    console.error(`✗ 场景 34 per-model 持久化失败: ${JSON.stringify(resEffModel)}`);
    process.exit(1);
  }
  const writtenEff = JSON.parse(fs.readFileSync(jsonFile3, 'utf8'));
  if (
    writtenEff.models?.a?.reasoningEffort !== 'high' ||
    writtenEff.reasoningEffort !== 'medium' ||
    writtenEff.models?.b?.reasoningEffort !== undefined ||
    writtenEff.models?.a?.baseURL !== 'https://a.com/v1'
  ) {
    console.error(`✗ 场景 34 per-model 持久化内容错误: ${JSON.stringify(writtenEff)}`);
    process.exit(1);
  }
  const resEffGlobal = persistReasoningEffortToConfig('low', { sources: [jsonFile3] } as never);
  if (!resEffGlobal.ok) {
    console.error(`✗ 场景 34 全局持久化失败: ${JSON.stringify(resEffGlobal)}`);
    process.exit(1);
  }
  const writtenEff2 = JSON.parse(fs.readFileSync(jsonFile3, 'utf8'));
  if (writtenEff2.reasoningEffort !== 'low' || writtenEff2.models?.a?.reasoningEffort !== 'high') {
    console.error(`✗ 场景 34 全局持久化污染模型专属级别: ${JSON.stringify(writtenEff2)}`);
    process.exit(1);
  }
  const resEffUnknown = persistReasoningEffortToConfig('medium', { sources: [jsonFile3] } as never, 'nope');
  if (!resEffUnknown.ok) {
    console.error(`✗ 场景 34 未知模型持久化失败: ${JSON.stringify(resEffUnknown)}`);
    process.exit(1);
  }
  const writtenEff3 = JSON.parse(fs.readFileSync(jsonFile3, 'utf8'));
  if (writtenEff3.reasoningEffort !== 'medium' || writtenEff3.models?.a?.reasoningEffort !== 'high') {
    console.error(`✗ 场景 34 未知模型误写 models 表: ${JSON.stringify(writtenEff3)}`);
    process.exit(1);
  }
  fs.rmSync(tmp34e, { recursive: true, force: true });
  fs.rmSync(tmp34d, { recursive: true, force: true });
  fs.rmSync(tmp34, { recursive: true, force: true });
  fs.rmSync(tmp34b, { recursive: true, force: true });
  fs.rmSync(tmp34c, { recursive: true, force: true });
  console.log('✓ 场景 34 通过：config models 多端点解析/attachRuntime 展开+modelRuntime/createClient 重建//model 面板选择确认/数字键/Esc/无列表回退 + /model add 解析/持久化（纯 JSON 改写·JSONC 跳过·无配置新建）/TUI 分发 + per-model variants（展开缺省回退全局·persist 按模型分流写 models.<名>.reasoningEffort）');

  // 场景 35：/status /context /export /config /mcp /diff /rename /resume /redo 九个命令 + /settings doctor 诊断
  console.log('=== 场景 35：批量新命令 ===');
  const cmd35 = await import('../src/tui/commands.js');
  // a) 全部注册（doctor 已并入 /settings 二级菜单）
  for (const n of ['status', 'context', 'export', 'config', 'mcp', 'diff', 'rename', 'resume', 'redo']) {
    if (!cmd35.findCommand(n)) {
      console.error(`✗ 场景 35 /${n} 命令未注册`);
      process.exit(1);
    }
  }
  // b) /status：输出模型/权限/思考级别/脚手架
  const s35 = createTuiState();
  s35.version = '0.1.0';
  s35.model = 'mock-model';
  s35.permission = 'safe';
  s35.planMode = false;
  s35.reasoningEffort = 'high';
  s35.tokens = { prompt: 100, completion: 50, total: 150 };
  await cmd35.runCommand({ state: s35, out: {}, session: {}, input: {}, messages: [], model: 'mock-model', sessionPath: 'mock-session.jsonl' } as never, '/status');
  const status35 = (s35.cmdPanel?.lines ?? []).map((l) => String(l)).join('\n');
  if (!status35.includes('mock-model') || !status35.includes('权限') || !status35.includes('high') || !status35.includes('150') || !status35.includes('mock-session.jsonl')) {
    console.error(`✗ 场景 35 /status 输出缺失: ${JSON.stringify(s35.cmdPanel?.lines)}`);
    process.exit(1);
  }
  if (s35.lines.some((l) => l.text.includes('mock-model'))) {
    console.error('✗ 场景 35 /status 输出泄漏进了对话流');
    process.exit(1);
  }
  // c) /context：消息数 + 压缩建议
  const s35c = createTuiState();
  const msgs35c: ChatCompletionMessageParam[] = [
    { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
  ];
  await cmd35.runCommand({ state: s35c, out: {}, session: {}, input: {}, messages: msgs35c, cfg: { summarizeAt: 40 } as never } as never, '/context');
  if (!(s35c.cmdPanel?.lines ?? []).some((l) => String(l).includes('4 条消息')) || !(s35c.cmdPanel?.lines ?? []).some((l) => String(l).includes('/compact'))) {
    console.error(`✗ 场景 35 /context 输出缺失: ${JSON.stringify(s35c.cmdPanel?.lines)}`);
    process.exit(1);
  }
  // d) /rename：设置会话标题
  const s35d = createTuiState();
  await cmd35.runCommand({ state: s35d, out: {}, session: {}, input: {}, messages: [] } as never, '/rename 测试标题');
  if (s35d.sessionTitle !== '测试标题' || !(s35d.cmdPanel?.lines ?? []).some((l) => String(l).includes('会话标题已改为'))) {
    console.error(`✗ 场景 35 /rename 未生效: ${JSON.stringify(s35d.cmdPanel?.lines)}`);
    process.exit(1);
  }
  // e) /export：导出 .omni/export-*.md（临时 cwd）
  const tmp35 = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-cmd-'));
  const oldCwd35 = process.cwd();
  process.chdir(tmp35);
  const s35e = createTuiState();
  await cmd35.runCommand({ state: s35e, out: {}, session: {}, input: {}, messages: msgs35c } as never, '/export');
  const exports35 = fs.readdirSync(path.join(tmp35, '.omni')).filter((f) => f.startsWith('export-'));
  if (exports35.length === 0 || !(s35e.cmdPanel?.lines ?? []).some((l) => String(l).includes('已导出会话'))) {
    console.error(`✗ 场景 35 /export 未写出文件: ${JSON.stringify(s35e.cmdPanel?.lines)}`);
    process.exit(1);
  }
  // f) /config：打印配置路径（TUI 不 spawn 编辑器）
  const s35f = createTuiState();
  await cmd35.runCommand({ state: s35f, out: {}, session: {}, input: {}, messages: [], cfg: { sources: ['项目配置 omni.json'] } as never } as never, '/config');
  if (!(s35f.cmdPanel?.lines ?? []).some((l) => String(l).includes('配置文件')) || !(s35f.cmdPanel?.lines ?? []).some((l) => String(l).includes('omni.json'))) {
    console.error(`✗ 场景 35 /config 输出缺失: ${JSON.stringify(s35f.cmdPanel?.lines)}`);
    process.exit(1);
  }
  // g) /mcp：无配置 → 提示；配置了 → 列出工具
  const s35g = createTuiState();
  await cmd35.runCommand({ state: s35g, out: {}, session: {}, input: {}, messages: [], mcpServers: {} } as never, '/mcp');
  if (!(s35g.cmdPanel?.lines ?? []).some((l) => String(l).includes('未配置 MCP 服务器'))) {
    console.error(`✗ 场景 35 /mcp 无配置未提示: ${JSON.stringify(s35g.cmdPanel?.lines)}`);
    process.exit(1);
  }
  const s35g2 = createTuiState();
  await cmd35.runCommand({ state: s35g2, out: {}, session: {}, input: {}, messages: [], mcpServers: { demo: {} } as never, tools: [{ name: 'demo_ping' }, { name: 'run_command' }] as never } as never, '/mcp');
  if (!(s35g2.cmdPanel?.lines ?? []).some((l) => String(l).includes('已配置 1 个 MCP 服务器')) || !(s35g2.cmdPanel?.lines ?? []).some((l) => String(l).includes('demo_ping'))) {
    console.error(`✗ 场景 35 /mcp 列表缺失: ${JSON.stringify(s35g2.cmdPanel?.lines)}`);
    process.exit(1);
  }
  // h) /diff：临时 git 仓库有改动 → 输出 diff
  const { spawnSync: spawnSync35 } = await import('node:child_process');
  spawnSync35('git', ['init', '-q'], { cwd: tmp35 });
  spawnSync35('git', ['add', '-A'], { cwd: tmp35 });
  spawnSync35('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: tmp35 });
  fs.writeFileSync(path.join(tmp35, 'b.ts'), 'export const b = 2;\n');
  const s35h = createTuiState();
  await cmd35.runCommand({ state: s35h, out: {}, session: { paint: async () => {} }, input: {}, messages: [] } as never, '/diff');
  if (!(s35h.cmdPanel?.lines ?? []).some((l) => String(l).includes('git diff')) || !(s35h.cmdPanel?.lines ?? []).some((l) => String(l).includes('b.ts'))) {
    console.error(`✗ 场景 35 /diff 未输出改动: ${JSON.stringify(s35h.cmdPanel?.lines)}`);
    process.exit(1);
  }
  process.chdir(oldCwd35);
  // i) /redo：写 v1 → 快照 → 写 v2 → undo 回 v1 → redo 回 v2；新写入清空 redo
  const { UndoStack: UndoStack35, applyUndo: applyUndo35 } = await import('../src/tools/undo.js');
  const stack35 = new UndoStack35();
  const redoFile = path.join(tmp35, 'redo-test.txt');
  fs.writeFileSync(redoFile, 'v1\n');
  await stack35.snapshotWrite(redoFile);
  fs.writeFileSync(redoFile, 'v2\n');
  const ue35 = await stack35.popForUndo();
  if (!ue35) {
    console.error('✗ 场景 35 popForUndo 无快照');
    process.exit(1);
  }
  await applyUndo35(ue35);
  if (fs.readFileSync(redoFile, 'utf8') !== 'v1\n' || stack35.redoSize !== 1) {
    console.error(`✗ 场景 35 /undo 后未回到 v1 或 redo 栈未记录: redoSize=${stack35.redoSize}`);
    process.exit(1);
  }
  const re35 = stack35.redo();
  if (!re35) {
    console.error('✗ 场景 35 redo 无候选');
    process.exit(1);
  }
  await applyUndo35(re35);
  if (fs.readFileSync(redoFile, 'utf8') !== 'v2\n') {
    console.error('✗ 场景 35 /redo 未恢复到 v2');
    process.exit(1);
  }
  // 新写入清空 redo 历史
  await stack35.snapshotWrite(redoFile);
  if (stack35.redoSize !== 0) {
    console.error(`✗ 场景 35 新写入未清空 redo 栈: redoSize=${stack35.redoSize}`);
    process.exit(1);
  }
  // /redo 命令本体（空栈提示）
  const s35r = createTuiState();
  await cmd35.runCommand({ state: s35r, out: {}, session: {}, input: {}, messages: [], undoStack: stack35 } as never, '/redo');
  if (!(s35r.cmdPanel?.lines ?? []).some((l) => String(l).includes('没有可重做的操作'))) {
    console.error(`✗ 场景 35 /redo 空栈未提示: ${JSON.stringify(s35r.cmdPanel?.lines)}`);
    process.exit(1);
  }
  // j) /resume：XDG_CONFIG_HOME 指向临时目录，写入一个会话文件后恢复
  const oldXdg35 = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp35;
  const sessDir35 = path.join(tmp35, 'omni', 'sessions');
  fs.mkdirSync(sessDir35, { recursive: true });
  const sid35 = '20260813-testproj-abcd';
  fs.writeFileSync(
    path.join(sessDir35, `${sid35}.jsonl`),
    [
      JSON.stringify({ t: 'meta', id: sid35, project: '/tmp', model: 'mock-model', created: 1, updated: 2, title: '旧标题' }),
      JSON.stringify({ t: 'm', m: { role: 'user', content: '你好' } }),
      '',
    ].join('\n')
  );
  let resumed35: { file: string; msgs: ChatCompletionMessageParam[] } | null = null;
  const s35j = createTuiState();
  await cmd35.runCommand({ state: s35j, out: {}, session: {}, input: {}, messages: [], onResume: (file: string, msgs: ChatCompletionMessageParam[]) => { resumed35 = { file, msgs }; } } as never, `/resume ${sid35}`);
  if (!resumed35 || resumed35.msgs.length !== 1 || resumed35.msgs[0].content !== '你好') {
    console.error(`✗ 场景 35 /resume 未恢复消息: ${JSON.stringify(resumed35)}`);
    process.exit(1);
  }
  if (!(s35j.cmdPanel?.lines ?? []).some((l) => String(l).includes('已恢复会话')) || s35j.sessionTitle !== '旧标题') {
    console.error(`✗ 场景 35 /resume 未提示/未还原标题: ${JSON.stringify(s35j.cmdPanel?.lines)}`);
    process.exit(1);
  }
  process.env.XDG_CONFIG_HOME = oldXdg35;
  // k) /settings doctor：输出环境诊断（Node 版本 + API Key + 端点；/doctor 已并入 /settings 二级菜单）
  const s35k = createTuiState();
  await cmd35.runCommand({
    state: s35k, out: {}, session: { paint: async () => {} }, input: {}, messages: [],
    cfg: { apiKey: 'sk-x', baseURL: 'http://127.0.0.1:1', sources: ['测试'], permission: 'safe', allowSubagents: true, maxSubagentSteps: 10, reasoningEffortOptions: ['low'], model: 'mock' } as never,
  } as never, '/settings doctor');
  const doctor35 = (s35k.cmdPanel?.lines ?? []).map((l) => String(l)).join('\n');
  if (!doctor35.includes('Node') || !doctor35.includes('API Key')) {
    console.error(`✗ 场景 35 /doctor 输出缺失: ${JSON.stringify(s35k.cmdPanel?.lines)}`);
    process.exit(1);
  }
  fs.rmSync(tmp35, { recursive: true, force: true });
  console.log('✓ 场景 35 通过：/status /context /rename /export /config /mcp /diff /redo（含 undo 栈 round-trip）/resume（含标题还原）/doctor');

  // 场景 36：@ 提及文件选择（输入框含 @ 时列出候选，Tab/Enter/点击插入）+ 圆角浮层共用
  const { detectMention: detectMention36, insertMention: insertMention36, listMentionCandidates: listMention36 } = await import('../src/tui/mention.js');
  // a) detectMention 单元：光标前最后一个 @ 后的无空白文本为查询；有空白/无 @ → null
  const dm36 = detectMention36('看看 @REA', 7);
  if (!dm36 || dm36.atIndex !== 3 || dm36.query !== 'REA') {
    console.error(`✗ 场景 36 detectMention 命中错误: ${JSON.stringify(dm36)}`);
    process.exit(1);
  }
  if (detectMention36('看看 @a b', 8) !== null) {
    console.error('✗ 场景 36 @ 后出现空白应视为提及结束');
    process.exit(1);
  }
  if (detectMention36('看看', 2) !== null || detectMention36('看看 @', 4) === null) {
    console.error('✗ 场景 36 无 @ 应 null / 空查询应命中（列出全部）');
    process.exit(1);
  }
  // b) listMentionCandidates：目录优先 + 隐藏文件过滤 + 子目录前缀
  const tmp36 = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-mention-'));
  fs.mkdirSync(path.join(tmp36, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp36, 'src', 'main.ts'), '');
  fs.writeFileSync(path.join(tmp36, 'README.md'), '');
  fs.writeFileSync(path.join(tmp36, 'package.json'), '');
  fs.writeFileSync(path.join(tmp36, '.hidden'), '');
  const all36 = listMention36(tmp36, '');
  if (JSON.stringify(all36) !== JSON.stringify(['src/', 'package.json', 'README.md'])) {
    console.error(`✗ 场景 36 候选排序/隐藏过滤错误: ${JSON.stringify(all36)}`);
    process.exit(1);
  }
  if (JSON.stringify(listMention36(tmp36, 'REA')) !== JSON.stringify(['README.md'])) {
    console.error(`✗ 场景 36 前缀过滤错误: ${JSON.stringify(listMention36(tmp36, 'REA'))}`);
    process.exit(1);
  }
  if (JSON.stringify(listMention36(tmp36, 'src/')) !== JSON.stringify(['src/main.ts'])) {
    console.error(`✗ 场景 36 子目录浏览错误: ${JSON.stringify(listMention36(tmp36, 'src/'))}`);
    process.exit(1);
  }
  // c) repaintTree 驱动：'看看 @REA' 列出候选；@xyz 无匹配 / @a b 空白 → 隐藏
  const s36 = createTuiState();
  s36.version = '0.1.0';
  s36.model = 'mock';
  s36.cwd = tmp36;
  pushLine(s36, { kind: 'user', text: '你好' });
  s36.status = '任务完成';
  const t36 = await createTestRenderer({ width: 64, height: 20 });
  const tree36 = mountTree(t36.renderer, s36, { withInput: true });
  await t36.renderOnce();
  const repaint36 = async (): Promise<void> => {
    repaintTree(t36.renderer, tree36, s36, { withInput: true });
    await t36.renderOnce();
  };
  tree36.input?.setText('看看 @REA');
  await repaint36();
  if (!s36.mention || s36.mention.items.length !== 1 || s36.mention.items[0] !== 'README.md') {
    console.error(`✗ 场景 36 repaint 未列出提及候选: ${JSON.stringify(s36.mention)}`);
    process.exit(1);
  }
  tree36.input?.setText('看看 @xyz');
  await repaint36();
  if (s36.mention !== null) {
    console.error('✗ 场景 36 无匹配应隐藏提及列表');
    process.exit(1);
  }
  tree36.input?.setText('看看 @a b');
  await repaint36();
  if (s36.mention !== null) {
    console.error('✗ 场景 36 @ 后空白不应显示提及列表');
    process.exit(1);
  }
  // d) 渲染：📁/📄 图标 + 路径 + 圆角方框（与 / 命令联想共用浮层，互斥出现）
  tree36.input?.setText('看看 @');
  await repaint36();
  const frame36 = t36.captureCharFrame();
  console.log('=== 场景 36：@ 提及文件选择（圆角浮层）===');
  console.log(frame36);
  const checks36 = ['📁 src/', '📄 README.md', '📄 package.json'];
  const missing36 = checks36.filter((c) => !frame36.includes(c));
  if (missing36.length) {
    console.error(`✗ 场景 36 提及列表渲染缺: ${missing36.join(', ')}`);
    process.exit(1);
  }
  if (!frame36.includes('╭') || !frame36.includes('╰')) {
    console.error('✗ 场景 36 提及浮层未渲染圆角边框（应见 ╭╰）');
    process.exit(1);
  }
  if (!tree36.suggestBox || !tree36.suggestBox.visible || tree36.suggestBox.borderStyle !== 'rounded') {
    console.error('✗ 场景 36 提及浮层未显示或未用圆角边框');
    process.exit(1);
  }
  if (s36.cmdSuggest !== null) {
    console.error('✗ 场景 36 提及出现时不应同时显示命令联想');
    process.exit(1);
  }
  // 浮层底在灰色块（inputLines=1 → 底部块顶 = 20 - 7 - 1 = 12）上方 1 行以上
  const rect36 = tree36.suggestRect;
  if (!rect36 || rect36.bottom >= 12) {
    console.error(`✗ 场景 36 提及浮层未悬停在输入框上方: ${JSON.stringify(rect36)}`);
    process.exit(1);
  }
  // e) Esc 关闭后同文本不复活；文本变化恢复
  s36.mentionDismissedKey = '3:REA'; // 模拟 interactive.ts 的 Esc 分支
  tree36.input?.setText('看看 @REA');
  await repaint36();
  if (s36.mention !== null) {
    console.error('✗ 场景 36 Esc 关闭后提及复活（应保持隐藏直到文本变化）');
    process.exit(1);
  }
  tree36.input?.setText('看看 @RE');
  await repaint36();
  if (!s36.mention || s36.mention.items[0] !== 'README.md') {
    console.error('✗ 场景 36 文本变化后提及未恢复');
    process.exit(1);
  }
  // f) insertMention：文件插入加尾空格结束提及；目录保留 / 继续浏览
  tree36.input?.setText('看看 @REA');
  await repaint36();
  const m36 = s36.mention;
  if (!m36) {
    console.error('✗ 场景 36 insert 前置失败（无提及候选）');
    process.exit(1);
  }
  insertMention36(tree36.input!, m36, 0);
  if (tree36.input?.plainText !== '看看 @README.md ') {
    console.error(`✗ 场景 36 文件插入错误: ${JSON.stringify(tree36.input?.plainText)}（应 '看看 @README.md '）`);
    process.exit(1);
  }
  tree36.input?.setText('看看 @src');
  await repaint36();
  const m36b = s36.mention;
  if (!m36b || m36b.items[0] !== 'src/') {
    console.error(`✗ 场景 36 目录候选缺失: ${JSON.stringify(s36.mention)}`);
    process.exit(1);
  }
  insertMention36(tree36.input!, m36b, 0);
  if (tree36.input?.plainText !== '看看 @src/') {
    console.error(`✗ 场景 36 目录插入错误: ${JSON.stringify(tree36.input?.plainText)}（应 '看看 @src/'）`);
    process.exit(1);
  }
  fs.rmSync(tmp36, { recursive: true, force: true });
  console.log('✓ 场景 36 通过：@ 提及（检测/候选排序/前缀与子目录过滤/渲染/圆角边框/Esc 不复活/文件与目录插入）');

  // 场景 37：/session 会话管理 —— 列出/继续当前目录（同目录）历史会话 + 面板选择
  console.log('=== 场景 37：/session 会话管理 ===');
  const cmd37 = await import('../src/tui/commands.js');
  if (!cmd37.findCommand('session')) {
    console.error('✗ 场景 37 /session 命令未注册');
    process.exit(1);
  }
  const tmp37 = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-session-'));
  const oldXdg37 = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp37;
  const sessDir37 = path.join(tmp37, 'omni', 'sessions');
  fs.mkdirSync(sessDir37, { recursive: true });
  const cwd37 = process.cwd(); // 「同目录」= 创建会话时的 cwd 与当前一致
  // 当前目录的会话（标题「本项目会话」）+ 其它目录的会话
  const sid37 = '20260813-omni-aaaa';
  const sid37b = '20260813-elsewhere-bbbb';
  fs.writeFileSync(
    path.join(sessDir37, `${sid37}.jsonl`),
    [
      JSON.stringify({ t: 'meta', id: sid37, project: cwd37, model: 'mock-model', created: 1, updated: 2, title: '本项目会话' }),
      JSON.stringify({ t: 'm', m: { role: 'user', content: '你好' } }),
      JSON.stringify({ t: 'm', m: { role: 'assistant', content: '回答一' } }),
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(sessDir37, `${sid37b}.jsonl`),
    [
      JSON.stringify({ t: 'meta', id: sid37b, project: '/elsewhere', model: 'mock-model', created: 1, updated: 2 }),
      JSON.stringify({ t: 'm', m: { role: 'user', content: '别处' } }),
      '',
    ].join('\n')
  );
  // a) 面板（/session 无参，当前无会话）：只列当前目录的会话（排除其它目录）
  const s37 = createTuiState();
  await cmd37.openSessionMenu(s37, null);
  if (
    !s37.menu || s37.menu.id !== 'session' || s37.menu.options.length !== 1 ||
    !s37.menu.options[0].label.includes('本项目会话')
  ) {
    console.error(`✗ 场景 37 面板未只列同目录会话: ${JSON.stringify(s37.menu)}`);
    process.exit(1);
  }
  // b) Enter 确认 → 记录意图（sessionPick），交互层下一轮异步加载恢复
  const { handleMenuKey: handleMenuKey37 } = cmd37;
  if (!handleMenuKey37({ name: 'return' } as never, s37) || s37.menu !== null || s37.sessionPick !== sid37) {
    console.error(`✗ 场景 37 面板确认未记录会话意图: pick=${s37.sessionPick} menu=${JSON.stringify(s37.menu)}`);
    process.exit(1);
  }
  // b2) 面板排除**当前正在进行的会话**（sessionPath 指向它时不列入，继续它无意义）
  const s37b2 = createTuiState();
  await cmd37.openSessionMenu(s37b2, path.join(sessDir37, `${sid37}.jsonl`));
  if (s37b2.menu !== null || !(s37b2.cmdPanel?.lines ?? []).some((l) => String(l).includes('没有可继续的历史会话'))) {
    console.error(`✗ 场景 37 面板未排除当前会话: menu=${JSON.stringify(s37b2.menu)} panel=${JSON.stringify(s37b2.cmdPanel?.lines)}`);
    process.exit(1);
  }
  // c) /session all：列出全部（跨目录）
  const s37c = createTuiState();
  await cmd37.runCommand({ state: s37c, out: {}, session: {}, input: {}, messages: [] } as never, '/session all');
  if (!(s37c.cmdPanel?.lines ?? []).some((l) => String(l).includes(sid37)) || !(s37c.cmdPanel?.lines ?? []).some((l) => String(l).includes(sid37b))) {
    console.error(`✗ 场景 37 /session all 未列出全部会话: ${JSON.stringify(s37c.cmdPanel?.lines)}`);
    process.exit(1);
  }
  // d) /session <id>：加载并继续（onResume 回调 + 标题还原）
  let resumed37: { file: string; msgs: ChatCompletionMessageParam[] } | null = null;
  const s37d = createTuiState();
  await cmd37.runCommand({
    state: s37d, out: {}, session: {}, input: {}, messages: [],
    onResume: (file: string, msgs: ChatCompletionMessageParam[]) => { resumed37 = { file, msgs }; },
  } as never, `/session ${sid37}`);
  if (!resumed37 || resumed37.msgs.length !== 2 || resumed37.msgs[0].content !== '你好' || !(s37d.cmdPanel?.lines ?? []).some((l) => String(l).includes('已继续会话')) || s37d.sessionTitle !== '本项目会话') {
    console.error(`✗ 场景 37 /session <id> 未恢复: ${JSON.stringify(resumed37)} panel=${JSON.stringify(s37d.cmdPanel?.lines)}`);
    process.exit(1);
  }
  // e) id 前缀匹配：唯一前缀命中 → 该会话；歧义前缀（匹配多个）→ 列出候选不静默选
  const { findSessionCandidates: findSessionCandidates37 } = await import('../src/agent/session.js');
  const cands37 = await findSessionCandidates37(sid37.slice(0, 10));
  if (cands37.length !== 1 || cands37[0].id !== sid37 || cands37[0].path !== path.join(sessDir37, `${sid37}.jsonl`)) {
    console.error(`✗ 场景 37 会话前缀匹配失败: ${JSON.stringify(cands37.map((c) => c.id))}`);
    process.exit(1);
  }
  // e2) 歧义前缀（两个会话同前缀）→ /session 列出候选，不恢复任何会话
  let resumedAmb37 = false;
  const s37e2 = createTuiState();
  await cmd37.runCommand({
    state: s37e2, out: {}, session: {}, input: {}, messages: [],
    onResume: () => { resumedAmb37 = true; },
  } as never, '/session 20260813');
  if (resumedAmb37 || !(s37e2.cmdPanel?.lines ?? []).some((l) => String(l).includes('匹配 2 个会话')) || !(s37e2.cmdPanel?.lines ?? []).some((l) => String(l).includes(sid37))) {
    console.error(`✗ 场景 37 歧义前缀未列出候选: resumed=${resumedAmb37} panel=${JSON.stringify(s37e2.cmdPanel?.lines)}`);
    process.exit(1);
  }
  // f) 不存在的 id → warn 提示
  const s37f = createTuiState();
  await cmd37.runCommand({ state: s37f, out: {}, session: {}, input: {}, messages: [] } as never, '/session nope-xyz');
  if (!(s37f.cmdPanel?.lines ?? []).some((l) => String(l).includes('不存在'))) {
    console.error(`✗ 场景 37 /session 未知 id 未提示: ${JSON.stringify(s37f.cmdPanel?.lines)}`);
    process.exit(1);
  }
  // g) 当前目录无会话 → 不打开面板，提示用法
  const tmp37b = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-session-empty-'));
  const oldCwd37 = process.cwd();
  process.chdir(tmp37b);
  const s37g = createTuiState();
  await cmd37.openSessionMenu(s37g, null);
  process.chdir(oldCwd37);
  if (s37g.menu !== null || !(s37g.cmdPanel?.lines ?? []).some((l) => String(l).includes('当前目录没有历史会话'))) {
    console.error(`✗ 场景 37 无同目录会话未提示: menu=${JSON.stringify(s37g.menu)} panel=${JSON.stringify(s37g.cmdPanel?.lines)}`);
    process.exit(1);
  }
  process.env.XDG_CONFIG_HOME = oldXdg37;
  fs.rmSync(tmp37, { recursive: true, force: true });
  fs.rmSync(tmp37b, { recursive: true, force: true });
  // h) 面板窗口滚动（修复「/session 显示不全」）：列表全量进 options（不再截 9 条），
  //    渲染层按窗口滚动（menuPanelRows maxVisible）——窗口外条目 ↑/↓ 滚动到达
  const rows37 = await import('../src/tui/rows.js');
  const tmp37c = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-session-many-'));
  process.env.XDG_CONFIG_HOME = tmp37c;
  const sessDir37c = path.join(tmp37c, 'omni', 'sessions');
  fs.mkdirSync(sessDir37c, { recursive: true });
  for (let i = 0; i < 20; i++) {
    // 第 0 个会话故意用超长模型名（用户反馈「模型过长超出显示范围」的复现素材）
    fs.writeFileSync(
      path.join(sessDir37c, `20260813-many-${String(i).padStart(2, '0')}xx.jsonl`),
      [
        JSON.stringify({ t: 'meta', id: `many-${i}`, project: process.cwd(), model: i === 0 ? 'super-long-model-name-'.repeat(6) : 'mock-model', created: i, updated: i, title: `会话 ${i}` }),
        JSON.stringify({ t: 'm', m: { role: 'user', content: `消息 ${i}` } }),
        '',
      ].join('\n')
    );
  }
  const s37h = createTuiState();
  await cmd37.openSessionMenu(s37h, null);
  if (!s37h.menu || s37h.menu.options.length !== 20) {
    console.error(`✗ 场景 37 面板未全量列出 20 个会话: options=${s37h.menu?.options.length}`);
    process.exit(1);
  }
  // h1) 窗口渲染：maxVisible=5 → 标题 + 5 选项 + 下方提示 + 操作提示 + 底边 = 9 行；menuIdx 逐行标记
  const rowsH = rows37.menuPanelRows(s37h.menu, 44, 'zh', 5);
  if (rowsH.length !== 9) {
    console.error(`✗ 场景 37 窗口行数错误: ${rowsH.length}（期望 9）`);
    process.exit(1);
  }
  const idxH = rowsH.map((r: { menuIdx?: number }) => r.menuIdx ?? -1);
  if (JSON.stringify(idxH) !== JSON.stringify([-1, 0, 1, 2, 3, 4, -1, -1, -1])) {
    console.error(`✗ 场景 37 窗口行映射错误: ${JSON.stringify(idxH)}`);
    process.exit(1);
  }
  if (!String(rowsH[6]!.text).includes('↓ 还有 15 个')) {
    console.error(`✗ 场景 37 窗口下方提示缺失: ${String(rowsH[6]!.text)}`);
    process.exit(1);
  }
  // h2) 滚动收敛：↓ 15 次后选中项 15，渲染时窗口跟随（scrollTop 11，选项 15 在窗口内）+ 上下提示
  for (let i = 0; i < 15; i++) handleMenuKey37({ name: 'down' } as never, s37h);
  const rowsH2 = rows37.menuPanelRows(s37h.menu, 44, 'zh', 5);
  if (s37h.menu.selectedIndex !== 15 || s37h.menu.scrollTop !== 11 || rowsH2.length !== 10) {
    console.error(`✗ 场景 37 窗口未跟随选中项: idx=${s37h.menu.selectedIndex} top=${s37h.menu.scrollTop} rows=${rowsH2.length}`);
    process.exit(1);
  }
  const idxH2 = rowsH2.map((r: { menuIdx?: number }) => r.menuIdx ?? -1);
  if (JSON.stringify(idxH2) !== JSON.stringify([-1, -1, 11, 12, 13, 14, 15, -1, -1, -1])) {
    console.error(`✗ 场景 37 滚动后行映射错误: ${JSON.stringify(idxH2)}`);
    process.exit(1);
  }
  if (!String(rowsH2[1]!.text).includes('↑ 还有 11 个') || !String(rowsH2[7]!.text).includes('↓ 还有 4 个')) {
    console.error(`✗ 场景 37 滚动后上下提示缺失: ${String(rowsH2[1]!.text)} / ${String(rowsH2[7]!.text)}`);
    process.exit(1);
  }
  // h3) 数字键 = 窗口内第 N 项：scrollTop 5 时按 2 → selectedIndex 6（列表按 updated 倒序：many-19 → many-0，第 6 个 = many-13）
  const s37h3 = createTuiState();
  await cmd37.openSessionMenu(s37h3, null);
  s37h3.menu!.scrollTop = 5;
  if (!handleMenuKey37({ name: '2' } as never, s37h3) || s37h3.menu !== null || s37h3.sessionPick !== 'many-13') {
    console.error(`✗ 场景 37 数字键窗口内语义错误: pick=${s37h3.sessionPick} menu=${JSON.stringify(s37h3.menu)}`);
    process.exit(1);
  }
  // h4) 渲染层集成：repaintTree 后浮层 menuRowMap 含窗口行映射（点击命中窗口内选项）
  const t37h = await createTestRenderer({ width: 64, height: 20 });
  const tree37h = mountTree(t37h.renderer, s37h, { withInput: true });
  await repaintTree(t37h.renderer, tree37h, s37h, 64, 20);
  if (JSON.stringify(tree37h.menuRowMap) !== JSON.stringify([-1, -1, 11, 12, 13, 14, 15, -1, -1, -1])) {
    console.error(`✗ 场景 37 渲染层 menuRowMap 错误: ${JSON.stringify(tree37h.menuRowMap)}`);
    process.exit(1);
  }
  // h5) 浮层细胞池容量防回归（修复「有上下但展示不全」：menuCells 池只有 8 个 cell，
  //     窗口滚后面板行数 = 标题1+窗口(≤12)+上下提示≤2+操作提示1+底边1 ≤ 17，超池不渲染）
  if (tree37h.menuCells.length < 17) {
    console.error(`✗ 场景 37 菜单浮层细胞池不足: ${tree37h.menuCells.length}（需要 ≥17）`);
    process.exit(1);
  }
  // h6) 帧级断言：窗口内选项、上下提示、底边全部真实渲染（池容量足够的直接证据）。
  //     注意窗口 options[11..15] = 会话 8..4（升序 title 与降序 updated 反向映射）——
  //     「会话 15/9/3」等窗口外标签不得泄漏进帧
  await t37h.renderOnce();
  const frame37h = t37h.captureCharFrame() as string;
  for (const expect of ['会话 8 ·', '会话 4 ·', '↑ 还有 11 个', '↓ 还有 4 个', '╰']) {
    if (!frame37h.includes(expect)) {
      console.error(`✗ 场景 37 菜单帧缺「${expect}」: frame=${JSON.stringify(frame37h)}`);
      process.exit(1);
    }
  }
  for (const outside of ['会话 9 ·', '会话 3 ·', '会话 15 ·']) {
    if (frame37h.includes(outside)) {
      console.error(`✗ 场景 37 窗口外选项泄漏进帧（池/窗口不收敛）: ${outside} frame=${JSON.stringify(frame37h)}`);
      process.exit(1);
    }
  }
  // h7) 面板不显示模型名（用户确认「session 不需要显示模型名称」）+ 超长文本不撑破布局：
  //     cardContentLine 对超宽内容兜底截断（省略号），行总宽恒 = contentWidth
  const s37h7 = createTuiState();
  await cmd37.openSessionMenu(s37h7, null);
  if (
    !s37h7.menu ||
    s37h7.menu.options.some((o) => o.label.includes('super-long-model-name')) ||
    !s37h7.menu.options.some((o) => o.label.includes('会话 0 · 1 条'))
  ) {
    console.error(`✗ 场景 37 面板仍显示模型名或 label 格式错误: ${JSON.stringify(s37h7.menu?.options)}`);
    process.exit(1);
  }
  const fmt37 = await import('../src/output/format.js');
  const lc37 = fmt37.cardContentLine('超长模型名占位文本'.repeat(50), fmt37.cardInnerWidth(44));
  if (visualWidth(lc37) !== 44 || !lc37.includes('…') || !lc37.endsWith('│')) {
    console.error(`✗ 场景 37 cardContentLine 未截断超宽文本: w=${visualWidth(lc37)} line=${JSON.stringify(lc37)}`);
    process.exit(1);
  }
  process.env.XDG_CONFIG_HOME = oldXdg37;
  fs.rmSync(tmp37c, { recursive: true, force: true });
  console.log('✓ 场景 37 通过：/session（面板只列同目录/确认意图/列出全部/继续恢复/前缀匹配/未知提示/空目录提示/窗口滚动全量可达）');

  // 场景 38：执行型命令面板自动收起（无需按 Esc）——autoClose 标记 + scheduleCmdPanelAutoClose 定时收起
  console.log('=== 场景 38：执行型命令面板自动收起 ===');
  const cmd38 = await import('../src/tui/commands.js');
  // a) autoClose 标记：执行型（动作+确认）置位；列表型（需阅读输出）不置位
  const autoCloseNames = ['undo', 'redo', 'init', 'compact', 'rename', 'export', 'model'];
  const listingNames = ['status', 'help', 'context', 'agents', 'diff', 'config', 'review', 'skill', 'mcp', 'resume', 'session', 'permission', 'variants'];
  const missingAuto38 = autoCloseNames.filter((n) => !cmd38.findCommand(n)?.autoClose);
  if (missingAuto38.length) {
    console.error(`✗ 场景 38 执行型命令缺 autoClose 标记: ${missingAuto38.join(', ')}`);
    process.exit(1);
  }
  const wrongAuto38 = listingNames.filter((n) => cmd38.findCommand(n)?.autoClose);
  if (wrongAuto38.length) {
    console.error(`✗ 场景 38 列表型命令误置 autoClose: ${wrongAuto38.join(', ')}`);
    process.exit(1);
  }
  // b) scheduleCmdPanelAutoClose：短暂延迟后自动收起（面板身份不变才关，并重绘）
  const s38 = createTuiState();
  pushCmdLine(s38, '确认行', '/undo');
  let painted38 = 0;
  await cmd38.scheduleCmdPanelAutoClose(s38, { paint: () => { painted38++; } } as never, 30);
  if (!s38.cmdPanel) {
    console.error('✗ 场景 38 调度后面板不应立即关闭');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 60));
  if (s38.cmdPanel !== null || painted38 < 1) {
    console.error(`✗ 场景 38 自动收起未生效（panel=${JSON.stringify(s38.cmdPanel)} painted=${painted38}）`);
    process.exit(1);
  }
  // b2) 期间打开新面板（身份变化）→ 旧定时器不误关新面板
  const s38b = createTuiState();
  pushCmdLine(s38b, 'A', '/x');
  await cmd38.scheduleCmdPanelAutoClose(s38b, { paint: () => {} } as never, 30);
  const newPanel38 = { title: '/y', lines: ['B'], scroll: 0 };
  s38b.cmdPanel = newPanel38; // 模拟期间打开新命令面板（身份变化）
  await new Promise((r) => setTimeout(r, 60));
  if (s38b.cmdPanel !== newPanel38) {
    console.error('✗ 场景 38 新面板被旧定时器误关');
    process.exit(1);
  }
  // b3) 无会话上下文（快照惯例 session={}）→ 不调度，面板保持（测试/无会话不自动关）
  const s38c = createTuiState();
  pushCmdLine(s38c, 'C', '/x');
  await cmd38.scheduleCmdPanelAutoClose(s38c, undefined, 30);
  await new Promise((r) => setTimeout(r, 60));
  if (!s38c.cmdPanel) {
    console.error('✗ 场景 38 无会话上下文不应调度（面板应保持）');
    process.exit(1);
  }
  // c) 空面板不调度（静默命令路径不弹面板）
  const s38d = createTuiState();
  let painted38d = 0;
  await cmd38.scheduleCmdPanelAutoClose(s38d, { paint: () => { painted38d++; } } as never, 30);
  await new Promise((r) => setTimeout(r, 40));
  if (painted38d !== 0) {
    console.error('✗ 场景 38 空面板不应调度');
    process.exit(1);
  }
  // d) runCommand 接线：执行型命令（/undo）跑完后面板立即存在（1.5s 后自动收起，这里只验证不提前关）
  const s38e = createTuiState();
  await cmd38.runCommand({ state: s38e, out: {}, session: { paint: () => {} }, input: {}, messages: [] } as never, '/undo');
  if (!s38e.cmdPanel || !s38e.cmdPanel.lines.some((l) => String(l).includes('没有可撤销'))) {
    console.error(`✗ 场景 38 /undo 面板未显示: ${JSON.stringify(s38e.cmdPanel?.lines)}`);
    process.exit(1);
  }
  console.log('✓ 场景 38 通过：执行型命令 autoClose 标记 + 自动收起（身份/无会话/空面板边界）');

  // 场景 39：/settings statusline —— 底部状态行配置（多选 + 排序 + 保存生效 + 持久化）
  console.log('=== 场景 39：/settings statusline（状态行配置）===');
  const cmd39 = await import('../src/tui/commands.js');
  const layout39 = await import('../src/tui/layout.js');
  const { persistStatuslineToConfig } = await import('../src/config/write.js');
  // a) /settings 已注册 + 联想可发现（settings 出现在联想列表）
  const settingsCmd = cmd39.findCommand('settings');
  if (!settingsCmd || !cmd39.commandSuggestions('set').some((c) => c.name === 'settings')) {
    console.error('✗ 场景 39 /settings 未注册或不可联想');
    process.exit(1);
  }
  // b) openStatuslinePanel：面板列出全部段，勾选态来自当前 state.statusline（默认全勾）
  const s39 = createTuiState();
  cmd39.openStatuslinePanel(s39);
  if (!s39.settingsPanel || s39.settingsPanel.items.length !== 5 || !s39.settingsPanel.items.every((it) => it.enabled)) {
    console.error(`✗ 场景 39 状态行面板初始化错误: ${JSON.stringify(s39.settingsPanel)}`);
    process.exit(1);
  }
  // 自定义 statusline（去掉 cache）→ 面板勾选态反映它（items 按段定义顺序列出，顺序由 ←/→ 编辑）
  s39.statusline = ['tokens', 'rounds', 'llm', 'speed'];
  cmd39.openStatuslinePanel(s39);
  const byId39 = Object.fromEntries(s39.settingsPanel!.items.map((it) => [it.id, it.enabled]));
  if (byId39.cache !== false || byId39.tokens !== true || byId39.rounds !== true || s39.settingsPanel!.items[0]!.id !== 'rounds') {
    console.error(`✗ 场景 39 面板未反映自定义 statusline: ${JSON.stringify(s39.settingsPanel)}`);
    process.exit(1);
  }
  // c) 键盘操作：↑/↓ 移动高亮 · 空格勾选/取消 · ←/→ 排序 · Enter 保存生效 · Esc 取消
  const key39 = (name: string) => ({ name, sequence: '', preventDefault: () => {}, stopPropagation: () => {} } as never);
  // 当前 statusline=['tokens','rounds','llm','speed']（cache 未勾选）；面板 items 按
  // STATUSLINE_SEGMENTS 顺序 = [rounds✓, llm✓, speed✓, cache☐, tokens✓]，selected=0
  cmd39.handleSettingsPanelKey(key39('down'), s39); // 1=llm
  cmd39.handleSettingsPanelKey(key39('down'), s39); // 2=speed
  cmd39.handleSettingsPanelKey(key39('down'), s39); // 3=cache
  cmd39.handleSettingsPanelKey(key39('down'), s39); // 4=tokens
  cmd39.handleSettingsPanelKey(key39('space'), s39); // 空格取消勾选 tokens
  if (s39.settingsPanel!.items.find((it) => it.id === 'tokens')!.enabled) {
    console.error('✗ 场景 39 空格未取消勾选');
    process.exit(1);
  }
  // ← 把 tokens 左移一位 → [rounds, llm, speed, tokens, cache]，selected=3(tokens)
  cmd39.handleSettingsPanelKey(key39('left'), s39);
  const orderAfterLeft = s39.settingsPanel!.items.map((it) => it.id);
  if (orderAfterLeft[3] !== 'tokens' || orderAfterLeft[4] !== 'cache') {
    console.error(`✗ 场景 39 ← 排序错误: ${JSON.stringify(orderAfterLeft)}`);
    process.exit(1);
  }
  // → 移回 → [rounds, llm, speed, cache, tokens]，selected=4(tokens)
  cmd39.handleSettingsPanelKey(key39('right'), s39);
  const orderAfterRight = s39.settingsPanel!.items.map((it) => it.id);
  if (orderAfterRight[4] !== 'tokens') {
    console.error(`✗ 场景 39 → 排序错误: ${JSON.stringify(orderAfterRight)}`);
    process.exit(1);
  }
  // Esc 取消：关闭面板、不改变 state.statusline、不落盘意图
  cmd39.handleSettingsPanelKey(key39('escape'), s39);
  if (s39.settingsPanel !== null || s39.statuslineSave !== null || JSON.stringify(s39.statusline) !== JSON.stringify(['tokens', 'rounds', 'llm', 'speed'])) {
    console.error('✗ 场景 39 Esc 取消应关闭面板且不改配置');
    process.exit(1);
  }
  // d) Enter 保存生效：state.statusline 按「启用 + 当前顺序」更新，statuslineSave 记录待落盘
  s39.statusline = ['rounds', 'llm', 'speed', 'cache', 'tokens']; // 恢复默认全段
  cmd39.openStatuslinePanel(s39); // items = [rounds✓ llm✓ speed✓ cache✓ tokens✓]（STATUSLINE_SEGMENTS 顺序），selected=0
  cmd39.handleSettingsPanelKey(key39('down'), s39); // selected=1 → llm
  cmd39.handleSettingsPanelKey(key39('space'), s39); // 取消 llm
  cmd39.handleSettingsPanelKey(key39('down'), s39); // selected=2 → speed
  cmd39.handleSettingsPanelKey(key39('right'), s39); // speed 与 cache 交换 → [rounds llm cache speed tokens]，selected=3(cache)
  cmd39.handleSettingsPanelKey(key39('return'), s39);
  const saved39 = s39.statusline;
  if (s39.settingsPanel !== null || !s39.statuslineSave || JSON.stringify(s39.statuslineSave) !== JSON.stringify(saved39)) {
    console.error(`✗ 场景 39 Enter 保存后状态错误: panel=${JSON.stringify(s39.settingsPanel)} save=${JSON.stringify(s39.statuslineSave)}`);
    process.exit(1);
  }
  // 期望：llm 被取消（空格）；speed 与 cache 交换后启用项顺序 = rounds cache speed tokens
  // （cache 仍启用——排序不改变勾选态；←/→ 只移动顺序）
  if (JSON.stringify(saved39) !== JSON.stringify(['rounds', 'cache', 'speed', 'tokens'])) {
    console.error(`✗ 场景 39 保存结果错误（应 rounds/cache/speed/tokens）: ${JSON.stringify(saved39)}`);
    process.exit(1);
  }
  // buildFooterStats 按新配置拼行（去掉 llm；cache 移到 speed 前）
  s39.stats = { turns: 7, steps: 41, llmMs: 658000, toolsMs: 8600, firstTokenSum: 19500, firstTokenCount: 3, cached: 9700 };
  s39.tokens = { prompt: 10000, completion: 73700, total: 83700 };
  const statsLine39 = layout39.buildFooterStats(s39);
  if (
    !statsLine39.includes('7 轮 · 41 步') ||
    !statsLine39.includes('缓存命中 97%') ||
    !statsLine39.includes('首 token 平均 6.5s · 112 tok/s') ||
    !statsLine39.includes('输入 10.0K tok · 输出 73.7K tok') ||
    statsLine39.includes('LLM')
  ) {
    console.error(`✗ 场景 39 buildFooterStats 未按新配置拼行: ${JSON.stringify(statsLine39)}`);
    process.exit(1);
  }
  // 单段配置（只留缓存命中）→ 只拼该段
  s39.statusline = ['cache'];
  if (layout39.buildFooterStats(s39) !== '缓存命中 97%') {
    console.error(`✗ 场景 39 单段配置拼行错误: ${JSON.stringify(layout39.buildFooterStats(s39))}`);
    process.exit(1);
  }
  // 全部取消 → 空串（状态行不显示）
  s39.statusline = [];
  if (layout39.buildFooterStats(s39) !== '') {
    console.error('✗ 场景 39 空 statusline 应返回空串（不显示状态行）');
    process.exit(1);
  }
  // e) 渲染：状态行面板经菜单浮层渲染（✓/☐ 勾选 + 标题 + 操作提示）；
  //    用高视口（30 行）避免面板与底部灰色块重叠把行字符交错（渲染在菜单浮层上）
  const s39r = createTuiState();
  s39r.version = '0.1.0';
  s39r.model = 'mock';
  s39r.statusline = ['rounds', 'llm']; // cache/tokens/speed 未勾选 → ☐
  cmd39.openStatuslinePanel(s39r);
  const r39 = await render(s39r, 30);
  const frame39 = r39.frame;
  if (
    !frame39.includes('设置：状态行') ||
    !frame39.includes('› ✓ 轮次/步数') ||
    !frame39.includes('✓ LLM/工具耗时') ||
    !frame39.includes('☐ 首token/速率') ||
    !frame39.includes('☐ 缓存命中') ||
    !frame39.includes('☐ 输入/输出') ||
    !frame39.includes('空格 勾选/取消')
  ) {
    console.error('✗ 场景 39 状态行面板渲染错误（缺标题/勾选项/提示行）');
    console.log(frame39);
    process.exit(1);
  }
  // f) persistStatuslineToConfig：写入配置文件 statusline 字段（纯 JSON 自动改写；JSONC 跳过）
  const dir39 = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-snap39-'));
  const file39 = path.join(dir39, 'omni.json');
  fs.writeFileSync(file39, JSON.stringify({ model: 'mock' }));
  const cfg39 = { sources: [file39] } as never;
  const res39 = persistStatuslineToConfig(['tokens', 'cache'], cfg39);
  if (!res39.ok || !res39.file) {
    console.error(`✗ 场景 39 状态行持久化失败: ${JSON.stringify(res39)}`);
    process.exit(1);
  }
  const written39 = JSON.parse(fs.readFileSync(file39, 'utf8'));
  if (JSON.stringify(written39.statusline) !== JSON.stringify(['tokens', 'cache']) || written39.model !== 'mock') {
    console.error(`✗ 场景 39 配置文件 statusline 字段错误: ${JSON.stringify(written39)}`);
    process.exit(1);
  }
  // JSONC（带注释）→ 不自动改写，返回提示
  const file39c = path.join(dir39, 'omni.jsonc');
  fs.writeFileSync(file39c, '// 注释\n{ "model": "mock", }');
  const res39c = persistStatuslineToConfig(['tokens'], { sources: [file39c] } as never);
  if (res39c.ok || !res39c.message.includes('JSONC')) {
    console.error(`✗ 场景 39 JSONC 配置不应自动改写: ${JSON.stringify(res39c)}`);
    process.exit(1);
  }
  fs.rmSync(dir39, { recursive: true, force: true });
  console.log('✓ 场景 39 通过：/settings statusline（注册/面板勾选与排序/空格 勾选/←→ 排序/Enter 保存生效/持久化/渲染）');

  // 场景 40：待发送消息管理（queue/steer 统一列表）——入队顺序（steer 插最前）/选择/
  // 排序/删除/编辑（handlePendingKey）/消费顺序（shift 天然打断优先）+ 渲染徽标与选中高亮
  console.log('=== 场景 40：待发送消息管理（queue/steer）===');
  const s40 = createTuiState();
  // a) 入队：queue 追加末尾、steer unshift 到最前（打断优先）
  enqueuePending(s40, 'queue', '消息A');
  enqueuePending(s40, 'queue', '消息B');
  enqueuePending(s40, 'steer', '打断C');
  if (JSON.stringify(s40.pending.map((m) => m.text)) !== JSON.stringify(['打断C', '消息A', '消息B'])) {
    console.error(`✗ 场景 40 入队顺序错误（steer 应插最前）: ${JSON.stringify(s40.pending.map((m) => m.text))}`);
    process.exit(1);
  }
  if (JSON.stringify(s40.pending.map((m) => m.mode)) !== JSON.stringify(['steer', 'queue', 'queue'])) {
    console.error(`✗ 场景 40 消息 mode 未保留: ${JSON.stringify(s40.pending.map((m) => m.mode))}`);
    process.exit(1);
  }
  // b) 消费顺序：shift() 天然按 打断优先 → 排队顺序（回合结束 auto-send 用）
  if (s40.pending.shift()!.mode !== 'steer' || s40.pending.shift()!.text !== '消息A') {
    console.error('✗ 场景 40 消费顺序错误（steer 应最先）');
    process.exit(1);
  }
  // c) 选择 + 循环移动高亮（handlePendingKey，无输入框依赖）
  s40.pendingSelected = 0; // 当前列表只剩 [消息B]
  const kUp = { name: 'up', sequence: '\u001b[A', preventDefault: () => {}, stopPropagation: () => {} };
  const kDown = { name: 'down', sequence: '\u001b[B', preventDefault: () => {}, stopPropagation: () => {} };
  const kLeft = { name: 'left', sequence: '\u001b[D', preventDefault: () => {}, stopPropagation: () => {} };
  const kRight = { name: 'right', sequence: '\u001b[C', preventDefault: () => {}, stopPropagation: () => {} };
  const kEsc = { name: 'escape', sequence: '\u001b', preventDefault: () => {}, stopPropagation: () => {} };
  const kBack = { name: 'backspace', sequence: '\u0008', preventDefault: () => {}, stopPropagation: () => {} };
  const kEnt = { name: 'return', sequence: '\r', preventDefault: () => {}, stopPropagation: () => {} };
  // 单条时 ↑/↓ 循环不动；加一条后循环
  enqueuePending(s40, 'queue', '消息D');
  s40.pendingSelected = 0;
  handlePendingKey(kUp, s40);
  if (s40.pendingSelected !== 1) {
    console.error(`✗ 场景 40 ↑ 循环移动失败（应到 1）: ${s40.pendingSelected}`);
    process.exit(1);
  }
  handlePendingKey(kDown, s40);
  if (s40.pendingSelected !== 0) {
    console.error(`✗ 场景 40 ↓ 循环移动失败（应回 0）: ${s40.pendingSelected}`);
    process.exit(1);
  }
  // d) ←/→ 排序（移动选中项）
  handlePendingKey(kRight, s40); // 选中 0 → 移到 1
  if (JSON.stringify(s40.pending.map((m) => m.text)) !== JSON.stringify(['消息D', '消息B']) || s40.pendingSelected !== 1) {
    console.error(`✗ 场景 40 → 排序失败: ${JSON.stringify(s40.pending.map((m) => m.text))} sel=${s40.pendingSelected}`);
    process.exit(1);
  }
  handlePendingKey(kLeft, s40); // 选中 1 → 移回 0
  if (JSON.stringify(s40.pending.map((m) => m.text)) !== JSON.stringify(['消息B', '消息D']) || s40.pendingSelected !== 0) {
    console.error(`✗ 场景 40 ← 排序失败: ${JSON.stringify(s40.pending.map((m) => m.text))} sel=${s40.pendingSelected}`);
    process.exit(1);
  }
  // e) Enter 编辑：返回文本并移除该条（调用方 setText 进输入框后重新提交即再入列）
  s40.pendingSelected = 0;
  const edit40 = handlePendingKey(kEnt, s40);
  if (!edit40 || edit40.kind !== 'edit' || edit40.text !== '消息B' || s40.pending.length !== 1 || s40.pendingSelected !== -1) {
    console.error(`✗ 场景 40 Enter 编辑失败: ${JSON.stringify(edit40)} pending=${JSON.stringify(s40.pending.map((m) => m.text))} sel=${s40.pendingSelected}`);
    process.exit(1);
  }
  // f) Backspace 删除最后一条 → 列表清空、选择态复位
  s40.pendingSelected = 0;
  const del40 = handlePendingKey(kBack, s40);
  if (!del40 || del40.kind !== 'consumed' || s40.pending.length !== 0 || s40.pendingSelected !== -1) {
    console.error(`✗ 场景 40 删除失败: ${JSON.stringify(del40)} len=${s40.pending.length} sel=${s40.pendingSelected}`);
    process.exit(1);
  }
  // g) Esc 退出选择（不清列表）；普通按键退出选择并放行（deselect）
  enqueuePending(s40, 'queue', '消息E');
  enqueuePending(s40, 'queue', '消息F');
  s40.pendingSelected = 1;
  const esc40 = handlePendingKey(kEsc, s40);
  if (!esc40 || esc40.kind !== 'consumed' || s40.pendingSelected !== -1 || s40.pending.length !== 2) {
    console.error('✗ 场景 40 Esc 退出选择失败');
    process.exit(1);
  }
  s40.pendingSelected = 1;
  const ch40 = handlePendingKey({ name: 'a', sequence: 'a', preventDefault: () => {}, stopPropagation: () => {} }, s40);
  if (!ch40 || ch40.kind !== 'deselect' || s40.pendingSelected !== -1) {
    console.error(`✗ 场景 40 普通按键应退出选择并放行: ${JSON.stringify(ch40)}`);
    process.exit(1);
  }
  // h) 渲染：2 条消息（queue + steer）带徽标；选中第 2 条高亮 ›；待发送区钉在灰块上方
  const s40r = createTuiState();
  s40r.version = '0.1.0';
  s40r.model = 'mock';
  pushLine(s40r, { kind: 'user', text: '你好' });
  enqueuePending(s40r, 'queue', '普通排队');
  enqueuePending(s40r, 'steer', '打断优先');
  s40r.pendingSelected = 1;
  const t40 = await createTestRenderer({ width: 64, height: 24 });
  const tree40 = mountTree(t40.renderer, s40r, { withInput: true });
  await t40.renderOnce();
  const frame40 = t40.captureCharFrame();
  if (
    !frame40.includes('⏳ 待发送（2 · ⚡ 1 打断）') ||
    !frame40.includes('⚡ 打断优先') ||
    !frame40.includes('› · 普通排队')
  ) {
    console.error('✗ 场景 40 待发送渲染缺失（标题/徽标/选中高亮）');
    console.log(frame40);
    process.exit(1);
  }
  // 命中区域：选中行（下标 1）的 rect 指向 › ⚡ 打断优先 所在行
  const y40 = [...tree40.pendingRects.entries()].find(([, idx]) => idx === 1)?.[0];
  if (y40 === undefined || !frame40.split('\n')[y40]?.includes('普通排队')) {
    console.error(`✗ 场景 40 pendingRects 未命中选中消息行（y=${y40}）`);
    console.log(frame40);
    process.exit(1);
  }
  // 消费：interactive 主循环用 shift()，steer 先出
  if (s40r.pending.shift()!.mode !== 'steer' || s40r.pending.shift()!.mode !== 'queue') {
    console.error('✗ 场景 40 消费顺序错误');
    process.exit(1);
  }
  console.log('✓ 场景 40 通过：待发送管理（steer 插最前/↑↓ 循环/←→ 排序/Enter 编辑/Backspace 删除/Esc 与普通键退出/徽标渲染/命中区域/消费顺序）');

  // 场景 41：read_file opencode 风格 + 并行多读合并 + write_file diff 展示
  // —— read_file 收起态只一行 `→ Read 路径`（无执行/结果缩略行）；并行多读合并成
  // `→ Read N files`（点击展开逐条 ⤷）；write_file 收起态**只显示命令**（改动摘要/
  // 对比点展开才显示——用户要求），展开 = 新增文件全文（逐行绿）/ 修改左右对比
  // （左原右新、删除红新增绿、│ 分隔）
  console.log('=== 场景 41：read_file 一行式 + 多读合并 + write_file diff ===');

  // a) countDiffLines / sideBySideDiff 单元断言（LCS 行对齐：替换配对、纯新增/删除）
  {
    const st = countDiffLines('a\nb\nc', 'a\nx\nc\nd');
    if (st.add !== 2 || st.rem !== 1) {
      console.error(`✗ 场景 41 countDiffLines 统计错误: ${JSON.stringify(st)}`);
      process.exit(1);
    }
    const { rows, truncated } = sideBySideDiff('a\nb\nc', 'a\nx\nc\nd', 8, 8);
    if (truncated || rows.length !== 4) {
      console.error(`✗ 场景 41 sideBySideDiff 行数错误: ${rows.length} truncated=${truncated}`);
      process.exit(1);
    }
    // 行序：= a / 替换 b→x（rem|add 配对同一行）/ = c / 纯新增 d
    const kinds = rows.map((r) => `${r.lk}${r.rk}`);
    if (kinds.join(',') !== 'ctxctx,remadd,ctxctx,ctxadd') {
      console.error(`✗ 场景 41 sideBySideDiff 对齐错误: ${kinds.join(',')}`);
      process.exit(1);
    }
    if (!rows[1].left.includes('b') || !rows[1].right.includes('x')) {
      console.error(`✗ 场景 41 替换行配对错误: ${JSON.stringify(rows[1])}`);
      process.exit(1);
    }
    // 两半列宽补齐：左/右文本与列宽一致（│ 对齐依赖）
    for (const r of rows) {
      if (r.left.length !== 8 || r.right.length !== 8) {
        console.error(`✗ 场景 41 diff 半列未按列宽补齐: ${JSON.stringify(r)}`);
        process.exit(1);
      }
    }
  }

  // b) read_file 收起态：只一行 `→ Read 路径`（top/cmd/bottom，无执行/结果缩略行）
  {
    const lines = toolCardLines(
      { name: 'read_file', summary: '→ Read AGENTS.md', status: 'ok', output: ['内容首行'], expanded: false, chars: 12, paths: ['AGENTS.md'] },
      60
    );
    const roles = lines.map((l) => l.role);
    if (roles.join(',') !== 'top,cmd,bottom') {
      console.error(`✗ 场景 41 read 收起态应只有 top/cmd/bottom: ${roles.join(',')}`);
      process.exit(1);
    }
    if (!lines[1].text.includes('→ Read AGENTS.md') || lines.some((l) => l.text.includes('执行成功'))) {
      console.error(`✗ 场景 41 read 收起态应显示 → Read 路径且无执行缩略行: ${lines.map((l) => l.text).join('|')}`);
      process.exit(1);
    }
  }

  // c) 合并多读展开：⤷ 路径逐条 + 输出预览 + 收起提示
  {
    const lines = toolCardLines(
      { name: 'read_file', summary: '→ Read 2 files', status: 'ok', output: ['内容首行'], expanded: true, chars: 12, paths: ['a.ts', 'b.ts'] },
      60
    );
    const text = lines.map((l) => l.text).join('\n');
    if (
      !text.includes('→ Read 2 files') ||
      !text.includes('⤷ a.ts') ||
      !text.includes('⤷ b.ts') ||
      !text.includes('内容首行') ||
      !text.includes('点击收起')
    ) {
      console.error('✗ 场景 41 合并多读展开缺路径/预览/收起提示');
      console.log(text);
      process.exit(1);
    }
    for (const ln of lines) {
      if (visualWidth(ln.text) !== 60) {
        console.error(`✗ 场景 41 多读展开行宽错误: w=${visualWidth(ln.text)} ${JSON.stringify(ln.text)}`);
        process.exit(1);
      }
    }
  }

  // d) write_file 新建：收起态显示变更统计（新增文件·全文 N 行，opencode 风格）；展开 = 全文逐行 add（绿）
  {
    const card = {
      name: 'write_file',
      summary: '✏️ new.txt',
      status: 'ok',
      output: [],
      expanded: false,
      chars: 5,
      diff: { path: 'new.txt', original: null, content: 'line1\nline2' },
    };
    const collapsed = toolCardLines(card, 60);
    const roles = collapsed.map((l) => l.role);
    if (roles.join(',') !== 'top,cmd,exec,bottom' || !collapsed.some((l) => l.text.includes('✏️ new.txt')) || !collapsed.some((l) => l.text.includes('新增文件 · 全文 2 行'))) {
      console.error(`✗ 场景 41 新建收起态应显示命令+变更统计: ${collapsed.map((l) => l.text).join('|')}`);
      process.exit(1);
    }
    const expanded = toolCardLines({ ...card, expanded: true }, 60);
    const diffRows = expanded.filter((l) => l.role === 'diff');
    if (diffRows.length !== 2 || !diffRows.every((l) => l.diffRole === 'add')) {
      console.error('✗ 场景 41 新建展开态应全文逐行 diffRole=add');
      process.exit(1);
    }
  }

  // e) write_file 修改：收起态 +A −D 摘要（opencode 风格）；展开左右对比（rem/add 半列 + │ 分隔）
  {
    const card = {
      name: 'write_file',
      summary: '✏️ old.txt',
      status: 'ok',
      output: [],
      expanded: false,
      chars: 8,
      diff: { path: 'old.txt', original: 'a\nb\nc', content: 'a\nx\nc\nd' },
    };
    const collapsed = toolCardLines(card, 60);
    if (collapsed.map((l) => l.role).join(',') !== 'top,cmd,exec,bottom' || !collapsed.some((l) => l.text.includes('修改 · +2 −1 行'))) {
      console.error(`✗ 场景 41 修改收起态应显示命令+变更统计: ${collapsed.map((l) => l.text).join('|')}`);
      process.exit(1);
    }
    const expanded = toolCardLines({ ...card, expanded: true }, 60);
    const dr = expanded.filter((l) => l.diff !== undefined);
    if (dr.length !== 4) {
      console.error(`✗ 场景 41 修改展开 diff 行数错误: ${dr.length}`);
      console.log(expanded.map((l) => `${l.role} ${JSON.stringify(l.text)}`).join('\n'));
      process.exit(1);
    }
    const repl = dr[1];
    if (repl.diff!.lk !== 'rem' || repl.diff!.rk !== 'add') {
      console.error('✗ 场景 41 替换行左右半类型错误');
      process.exit(1);
    }
    if (!repl.text.includes('│')) {
      console.error('✗ 场景 41 diff 行缺 │ 分隔');
      process.exit(1);
    }
  }

  // f) 渲染级（buildBody 真实路径）：diff 行逐 chunk 着色——替换行左红右绿、
  // 中间 │ 分隔、整行宽度 == 内容宽；新建全文行整行绿
  {
    const s41 = createTuiState();
    s41.version = '0.1.0';
    s41.model = 'mock';
    pushLine(s41, {
      kind: 'tool',
      text: '✏️ old.txt',
      card: {
        id: 41,
        name: 'write_file',
        summary: '✏️ old.txt',
        status: 'ok',
        output: [],
        expanded: true,
        chars: 8,
        diff: { path: 'old.txt', original: 'a\nb\nc', content: 'a\nx\nc\nd' },
      },
    });
    const rows41 = buildBody(s41, 60);
    const diffRows41 = rows41.filter((r) => r.cardId === 41 && r.chunks && r.chunks.length === 3);
    if (diffRows41.length !== 4) {
      console.error(`✗ 场景 41 渲染 diff 行数错误: ${diffRows41.length}`);
      process.exit(1);
    }
    // 替换行（第 2 条）：左 chunk 红 fg（diffRem）、右 chunk 绿 fg（diffAdd）
    const replR = diffRows41[1];
    if (replR.chunks![0].fg !== '#b91c1c' || replR.chunks![2].fg !== '#15803d') {
      console.error(`✗ 场景 41 替换行左红右绿缺失: ${JSON.stringify(replR.chunks!.map((c) => c.fg))}`);
      process.exit(1);
    }
    // 未改动行：左右都取 cardDim（非红非绿）
    if (diffRows41[0].chunks![0].fg === '#b91c1c' || diffRows41[0].chunks![0].fg === '#15803d') {
      console.error(`✗ 场景 41 未改动行误着色: ${JSON.stringify(diffRows41[0].chunks!.map((c) => c.fg))}`);
      process.exit(1);
    }
    for (const r of diffRows41) {
      if (visualWidth(r.text) !== 60) {
        console.error(`✗ 场景 41 渲染 diff 行宽错误: w=${visualWidth(r.text)} ${JSON.stringify(r.text)}`);
        process.exit(1);
      }
    }
  }
  console.log('✓ 场景 41 通过：read_file 一行式/多读合并/新建全文/write diff 左右对比（LCS 对齐 + 逐 chunk 红绿着色）');

  // 场景 42：当次 token 使用统计模块（/settings tokens 开关）
  // —— 每一次发送消息、返回消息结束后，插入当次 token 统计：输入/输出/缓存。
  // 默认收起显示汇总；点开显示每次 LLM 请求的明细（一行一条，加起来 = 汇总）；
  // /settings tokens 命令控制是否展示（关闭时历史与新轮都不显示，数据保留重开恢复）。
  console.log('=== 场景 42：当次 token 统计模块（/settings tokens）===');
  const { TuiOutput: TuiOutput42 } = await import('../src/tui/output.js');
  const { hitTestTokens } = await import('../src/tui/rows.js');
  const s42 = createTuiState();
  s42.version = '0.1.0';
  s42.model = 'mock';
  const t42 = await createTestRenderer({ width: 64, height: 20 });
  const tree42 = mountTree(t42.renderer, s42, { withInput: true });
  await t42.renderOnce();
  const sess42: TuiSession = {
    paint: async () => {
      repaintTree(t42.renderer, tree42, s42, { withInput: true });
      await t42.renderOnce();
    },
    stop: async () => {},
    input: null,
    onKeyPress: () => () => {},
  };
  const out42 = new TuiOutput42(s42, { showThinking: true }, sess42);
  // a) 一轮完整事件流：用户消息 → 轮开始（重置收集）→ 3 次 LLM 请求（多步工具调用
  //    每步各一次）→ 回答 → 轮结束 → 插入 tokens 模块（默认收起 = 只显示汇总）
  out42.onUserMessage('统计一下 token');
  out42.onTurnStart();
  out42.onUsage({ prompt: 1300, completion: 350, total: 1650, cached: 1000 });
  out42.onUsage({ prompt: 300, completion: 150, total: 450, cached: 30 });
  out42.onUsage({ prompt: 200, completion: 100, total: 300, cached: 50 });
  out42.onAnswer('统计结果如上。');
  out42.onAnswerEnd();
  out42.onTurnEnd();
  await out42.flush();
  const tokLines42 = s42.lines.filter((l) => l.kind === 'tokens');
  if (tokLines42.length !== 1 || !tokLines42[0]!.tokens || tokLines42[0]!.tokens.usages.length !== 3 || tokLines42[0]!.tokens.expanded !== false) {
    console.error(`✗ 场景 42 轮结束未插入收起态 tokens 模块: ${JSON.stringify(tokLines42.map((l) => l.tokens))}`);
    process.exit(1);
  }
  // b) 收起态渲染：一行汇总 `⚡ 3 次 LLM 请求 · 输入 1.8K · 输出 600 · 缓存 1.1K`（1300+300+200 / 350+150+100 / 1000+30+50）
  const frame42a = t42.captureCharFrame();
  if (!frame42a.includes('⚡ 3 次 LLM 请求 · 输入 1.8K · 输出 600 · 缓存 1.1K')) {
    console.error(`✗ 场景 42 收起态汇总行缺失: ${frame42a.split('\n').filter((l) => l.includes('⚡')).join('|')}`);
    process.exit(1);
  }
  // 收起态不显示逐次明细
  if (frame42a.includes('输入 1300') || frame42a.includes('输入 300')) {
    console.error('✗ 场景 42 收起态不应显示逐次明细');
    process.exit(1);
  }
  // c) 点击汇总行 → 展开：每次 LLM 请求一行明细（输入/输出/缓存，加起来 = 汇总）
  const { hitTestApproval: hta42, hitTestCard: htc42, hitTestThinking: htt42 } = await import('../src/tui/render.js');
  (tree42.root as unknown as { onMouseEvent?: (e: unknown) => void }).onMouseEvent = (e: unknown) => {
    const ev = e as { type?: string; button?: number; x?: number; y?: number };
    if (ev.type === 'down' && ev.button === 0 && typeof ev.y === 'number') {
      if (hta42(s42, tree42.approvalRect, ev.y)) {
        void sess42.paint();
        return;
      }
      const picker = s42.cmdSuggest ?? s42.mention;
      if (picker && tree42.suggestRect && tree42.input) {
        void sess42.paint();
        return;
      }
      if (s42.pending.length > 0 && tree42.pendingRects.get(ev.y) !== undefined) {
        void sess42.paint();
        return;
      }
      if (htt42(s42, tree42.thinkingRects, ev.y)) void sess42.paint();
      else if (hitTestTokens(s42, tree42.tokensRects, ev.y)) void sess42.paint();
      else if (htc42(s42, tree42.cardRects, ev.y)) void sess42.paint();
    }
  };
  const tokY42 = [...tree42.tokensRects.keys()][0];
  if (tokY42 === undefined) {
    console.error('✗ 场景 42 tokensRects 未记录汇总行');
    process.exit(1);
  }
  await t42.mockMouse.click(10, tokY42);
  await sess42.paint();
  if (!tokLines42[0]!.tokens!.expanded) {
    console.error('✗ 场景 42 点击汇总行未展开');
    process.exit(1);
  }
  const frame42b = t42.captureCharFrame();
  const detail42 = frame42b.split('\n').filter((l) => l.includes('⚡') || /^\s+- LLM 请求/.test(l));
  if (detail42.length !== 4) {
    console.error(`✗ 场景 42 展开后明细行数错误（应 1 汇总 + 3 明细 = 4 行）: ${JSON.stringify(detail42)}`);
    process.exit(1);
  }
  for (const want of ['- LLM 请求：输入 1.3K · 输出 350 · 缓存 1.0K', '- LLM 请求：输入 300 · 输出 150 · 缓存 30', '- LLM 请求：输入 200 · 输出 100 · 缓存 50']) {
    if (!frame42b.includes(want)) {
      console.error(`✗ 场景 42 展开明细缺失: ${want}`);
      process.exit(1);
    }
  }
  // 汇总行与回答文本之间应有 1 行空白间距（tokens 是独立组，other→tokens 切换插 1 行）
  const frame42Lines = frame42b.split('\n');
  const sum42Row = frame42Lines.findIndex((l) => l.includes('⚡ 3 次 LLM 请求'));
  if (sum42Row < 2 || frame42Lines[sum42Row - 1]!.trim() !== '' || !frame42Lines[sum42Row - 2]!.includes('统计结果如上')) {
    console.error('✗ 场景 42 汇总行上方缺少间距（应紧邻的回答文本后留 1 行空白）');
    process.exit(1);
  }
  // d) 再点击 → 收起（往返）
  await t42.mockMouse.click(10, tokY42);
  await sess42.paint();
  if (tokLines42[0]!.tokens!.expanded) {
    console.error('✗ 场景 42 再次点击未收起');
    process.exit(1);
  }
  const frame42c = t42.captureCharFrame();
  if (frame42c.includes('- LLM 请求')) {
    console.error('✗ 场景 42 收起后明细仍显示');
    process.exit(1);
  }
  // e) /tokens 命令：切换显示开关（关闭时 tokens 行不渲染、数据保留；再开恢复）
  const s42t = createTuiState();
  pushLine(s42t, { kind: 'tokens', text: '', tokens: { usages: [{ prompt: 1300, completion: 350, total: 1650, cached: 1000 }], expanded: false } });
  const rows42on = computeRows(s42t, { height: 20, width: 64 }, { withInput: true });
  if (!rows42on.some((r) => r.text.includes('⚡ 1 次 LLM 请求'))) {
    console.error('✗ 场景 42 showTokens=true 应渲染 tokens 行');
    process.exit(1);
  }
  const s42off = createTuiState();
  s42off.showTokens = false;
  pushLine(s42off, { kind: 'tokens', text: '', tokens: { usages: [{ prompt: 1300, completion: 350, total: 1650, cached: 1000 }], expanded: false } });
  const rows42off = computeRows(s42off, { height: 20, width: 64 }, { withInput: true });
  if (rows42off.some((r) => r.text.includes('⚡ 1 次 LLM 请求'))) {
    console.error('✗ 场景 42 showTokens=false 不应渲染 tokens 行');
    process.exit(1);
  }
  if (s42off.lines.some((l) => l.kind === 'tokens') !== true) {
    console.error('✗ 场景 42 关闭时数据应保留在 state.lines');
    process.exit(1);
  }
  // /settings tokens 命令分发：切换 showTokens（/tokens 已并入 /settings 二级菜单）
  const { runCommand: runCmd42 } = await import('../src/tui/commands.js');
  const s42c = createTuiState();
  if (s42c.showTokens !== true) {
    console.error('✗ 场景 42 showTokens 默认应为 true');
    process.exit(1);
  }
  await runCmd42({ state: s42c, out: {}, session: {}, input: {}, messages: [] } as never, '/settings tokens');
  if (s42c.showTokens !== false) {
    console.error('✗ 场景 42 /settings tokens 未关闭 showTokens');
    process.exit(1);
  }
  await runCmd42({ state: s42c, out: {}, session: {}, input: {}, messages: [] } as never, '/settings tokens');
  if (s42c.showTokens !== true) {
    console.error('✗ 场景 42 /settings tokens 未重新打开 showTokens');
    process.exit(1);
  }
  console.log('✓ 场景 42 通过：当次 token 统计（收起汇总/点击展开逐次明细/往返切换//settings tokens 开关）');

  // 场景 43：/settings language 语言切换 + 界面 chrome 本地化（footer/菜单/面板/联想/tokens/状态栏）
  const { t: ti18n, tf: tfi18n } = await import('../src/tui/i18n.js');
  const { buildFooterStats } = await import('../src/tui/layout.js');
  const { findCommand: findCommand43, handleMenuKey: handleMenuKey43, openLanguageMenu, openPermissionMenu: openPermissionMenu43, openSettingsMenu } = await import('../src/tui/commands.js');
  const { approvalPanelRows, cmdPanelRows, menuPanelRows, settingsPanelRows } = await import('../src/tui/rows.js');
  const { persistLanguageToConfig } = await import('../src/config/write.js');
  // a) i18n 字典：中英对照 + 缺失回退（都缺 → key 本身）
  if (ti18n('zh', 'menu.hint') !== '↑/↓ 或数字选择 · Enter 确认 · Esc 取消' || ti18n('en', 'menu.hint') !== '↑/↓ select · Enter confirm · Esc cancel') {
    console.error(`✗ 场景 43 i18n menu.hint 中英不符: ${JSON.stringify([ti18n('zh', 'menu.hint'), ti18n('en', 'menu.hint')])}`);
    process.exit(1);
  }
  if (tfi18n('en', 'tokens.summary', { n: 3, in: '1.8K', out: '600', cached: '1.1K' }) !== '⚡ 3 LLM requests · In 1.8K · Out 600 · Cached 1.1K') {
    console.error('✗ 场景 43 tokens.summary 英文插值错误');
    process.exit(1);
  }
  if (ti18n('en', 'no.such.key') !== 'no.such.key') {
    console.error('✗ 场景 43 缺失 key 未回退 key 本身');
    process.exit(1);
  }
  // b) footer 统计行按语言：buildFooterStats 读 state.language 选 build/buildEn
  const s43f = createTuiState();
  s43f.stats = { turns: 1, steps: 2, llmMs: 1000, toolsMs: 500, firstTokenSum: 1000, firstTokenCount: 2, cached: 900 };
  s43f.tokens = { prompt: 3000, completion: 500, total: 3500, cached: 900 };
  s43f.statusline = ['rounds', 'llm'];
  const zhLine43 = buildFooterStats(s43f);
  if (!zhLine43.includes('1 轮 · 2 步') || !zhLine43.includes('工具调用')) {
    console.error(`✗ 场景 43 中文统计行错误: ${zhLine43}`);
    process.exit(1);
  }
  s43f.language = 'en';
  const enLine43 = buildFooterStats(s43f);
  if (!enLine43.includes('1 turns · 2 steps') || !enLine43.includes('Tools') || zhLine43 === enLine43) {
    console.error(`✗ 场景 43 英文统计行错误: ${enLine43}`);
    process.exit(1);
  }
  // c) 设置菜单含语言/主题/tokens/doctor 项 + 打开语言面板：高亮当前语言
  const s43 = createTuiState();
  openSettingsMenu(s43);
  if (!s43.menu || s43.menu.id !== 'settings' || s43.menu.options.length !== 5 || s43.menu.options[1]?.value !== 'language' || s43.menu.options[2]?.value !== 'theme' || s43.menu.options[3]?.value !== 'tokens' || s43.menu.options[4]?.value !== 'doctor') {
    console.error(`✗ 场景 43 设置菜单缺语言/主题/tokens/doctor 项: ${JSON.stringify(s43.menu)}`);
    process.exit(1);
  }
  openLanguageMenu(s43);
  if (!s43.menu || s43.menu.id !== 'language' || s43.menu.options.length !== 2 || s43.menu.selectedIndex !== 0 || s43.menu.options[1]?.label !== 'English') {
    console.error(`✗ 场景 43 语言面板错误: ${JSON.stringify(s43.menu)}`);
    process.exit(1);
  }
  // d) 数字 2 确认 → 切到英文 + languageSave + confirm 消息（面板）；再切回中文
  handleMenuKey43(key('2'), s43);
  if (s43.language !== 'en' || s43.languageSave !== 'en' || s43.menu !== null) {
    console.error(`✗ 场景 43 语言切换未生效: ${JSON.stringify({ language: s43.language, languageSave: s43.languageSave, menu: s43.menu })}`);
    process.exit(1);
  }
  if (!s43.cmdPanel?.lines.some((l) => l.includes('已切换语言 → English'))) {
    console.error('✗ 场景 43 缺 confirm 消息（面板）');
    process.exit(1);
  }
  openLanguageMenu(s43);
  if (s43.menu?.selectedIndex !== 1) {
    console.error(`✗ 场景 43 语言面板未高亮当前语言: ${s43.menu?.selectedIndex}`);
    process.exit(1);
  }
  handleMenuKey43(key('up'), s43);
  handleMenuKey43(key('return'), s43);
  if (s43.language !== 'zh' || s43.languageSave !== 'zh') {
    console.error('✗ 场景 43 切回中文失败');
    process.exit(1);
  }
  // e) 英文菜单渲染：permission 面板（en）→ menuPanelRows 英文标题/选项/hint
  const s43e = createTuiState();
  s43e.version = '0.1.0';
  s43e.model = 'mock';
  s43e.language = 'en';
  openPermissionMenu43(s43e);
  const texts43e = menuPanelRows(s43e.menu!, 44, 'en')
    .map((r) => r.text)
    .join('\n');
  for (const want of ['Security', 'Read (read-only)', 'Safe (default)', 'Ask (all commands)', 'Full (no checks)', 'Enter confirm', 'Esc cancel']) {
    if (!texts43e.includes(want)) {
      console.error(`✗ 场景 43 英文权限菜单缺: ${want}\n${texts43e}`);
      process.exit(1);
    }
  }
  // f) 命令面板/审批卡/设置面板英文提示（lang 参数）
  const cRows43 = cmdPanelRows({ title: 'test', lines: ['l1', 'l2', 'l3'], scroll: 0 }, 60, 20, 'en');
  if (!cRows43[cRows43.length - 2]!.text.includes('Esc close')) {
    console.error('✗ 场景 43 cmdPanelRows 英文提示错误');
    process.exit(1);
  }
  const aRows43 = approvalPanelRows({ tool: 'run_command', summary: 's', reason: 'r' }, 44, 'en');
  if (!aRows43.some((r) => r.text.includes('[y] Approve'))) {
    console.error('✗ 场景 43 approvalPanelRows 英文提示错误');
    process.exit(1);
  }
  const stRows43 = settingsPanelRows({ items: [{ id: 'rounds', label: 'Rounds/Steps', enabled: true }], selected: 0 }, 44, 'en');
  if (!stRows43.some((r) => r.text.includes('Settings: Status line')) || !stRows43.some((r) => r.text.includes('Space ·'))) {
    console.error('✗ 场景 43 settingsPanelRows 英文错误');
    process.exit(1);
  }
  // g) 联想 descriptionEn：25 条命令都配了英文描述（英文模式渲染层取 descriptionEn）
  //    /theme /tokens /doctor 已并入 /settings（二级菜单）——设置命令带完整英文描述
  const settingsCmd43 = findCommand43('settings');
  if (!settingsCmd43?.descriptionEn || settingsCmd43.descriptionEn !== 'Settings (/settings statusline · /settings language · /settings theme · /settings tokens · /settings doctor)') {
    console.error('✗ 场景 43 settings 命令缺 descriptionEn');
    process.exit(1);
  }
  if (!settingsCmd43.description.includes('设置')) {
    console.error('✗ 场景 43 settings 命令 description 应为中文');
    process.exit(1);
  }
  if (findCommand43('theme') || findCommand43('tokens') || findCommand43('doctor')) {
    console.error('✗ 场景 43 /theme /tokens /doctor 不应再是一级命令（应并入 /settings 二级菜单）');
    process.exit(1);
  }
  if (ti18n('zh', 'settings.theme') !== '主题（亮色 / 深色 / 跟随系统）' || ti18n('en', 'settings.theme') !== 'Theme (light / dark / system)' || ti18n('zh', 'settings.tokens') !== '当次 token 统计（输入/输出/缓存）' || ti18n('en', 'settings.tokens') !== 'Per-turn token stats (in/out/cache)' || ti18n('zh', 'settings.doctor') !== '环境诊断（Node/Bun/API/配置）' || ti18n('en', 'settings.doctor') !== 'Environment diagnostics (Node/Bun/API/config)') {
    console.error('✗ 场景 43 settings.theme / settings.tokens / settings.doctor i18n 键缺失');
    process.exit(1);
  }
  // h) buildBody tokens 英文：language=en 时 tokens 模块英文
  const s43t = createTuiState();
  s43t.language = 'en';
  pushLine(s43t, { kind: 'tokens', text: '', tokens: { usages: [{ prompt: 1300, completion: 350, total: 1650, cached: 1000 }], expanded: false } });
  const rows43t = buildBody(s43t, 60);
  if (!rows43t.some((r) => r.text.includes('⚡ 1 LLM requests · In 1.3K'))) {
    console.error(`✗ 场景 43 tokens 英文渲染错误: ${rows43t.map((r) => r.text).join('|')}`);
    process.exit(1);
  }
  // i) persistLanguageToConfig 落盘（纯 JSON 配置文件追加 language 字段，保留其余字段）
  const tmp43 = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-lang-'));
  const json43 = path.join(tmp43, 'omni.json');
  fs.writeFileSync(json43, JSON.stringify({ model: 'a', statusline: ['rounds'] }));
  const res43 = persistLanguageToConfig('en', { sources: [json43] } as never);
  if (!res43.ok || res43.file !== json43) {
    console.error(`✗ 场景 43 语言落盘失败: ${JSON.stringify(res43)}`);
    process.exit(1);
  }
  const written43 = JSON.parse(fs.readFileSync(json43, 'utf8'));
  if (written43.language !== 'en' || written43.model !== 'a' || written43.statusline.length !== 1) {
    console.error(`✗ 场景 43 落盘内容错误: ${JSON.stringify(written43)}`);
    process.exit(1);
  }
  // j) 端到端渲染帧：en 语言下 footer 模型行英文 + placeholder 英文（mount 时按语言取）
  const s43r = createTuiState();
  s43r.version = '0.1.0';
  s43r.model = 'mock';
  s43r.language = 'en';
  const t43 = await createTestRenderer({ width: 64, height: 20 });
  const tree43 = mountTree(t43.renderer, s43r, { withInput: true });
  await t43.renderOnce();
  const frame43 = t43.captureCharFrame();
  if (!frame43.includes('Model mock')) {
    console.error('✗ 场景 43 英文 footer 模型行缺失: ' + frame43.split('\n').filter((l) => l.includes('Model')).join('|'));
    process.exit(1);
  }
  if (!frame43.includes('Type a message')) {
    console.error('✗ 场景 43 英文 placeholder 缺失');
    process.exit(1);
  }
  // k) 菜单浮层鼠标点击（用户反馈「语言切换，点击也没有可选择的语言选项」——
  //    此前菜单打开时鼠标被整体忽略）：真实代码路径 handleTuiMouseEvent 点击选项行
  //    = 选中并确认（等同数字键 + Enter）；提示/底边行与面板外部点击不触发、不穿透
  const { handleTuiMouseEvent } = await import('../src/tui/render.js');
  const noopPaint = async (): Promise<void> => {};
  openLanguageMenu(s43); // d) 段已切回 zh：高亮 0（中文）
  repaintTree(t43.renderer, tree43, s43, { withInput: true });
  await t43.renderOnce();
  const overlayTop43 = (tree43.menuOverlay!.top ?? 0) as number;
  if (JSON.stringify(tree43.menuRowMap) !== JSON.stringify([-1, 0, 1, -1, -1])) {
    console.error(`✗ 场景 43 菜单行映射错误: ${JSON.stringify(tree43.menuRowMap)}`);
    process.exit(1);
  }
  // 点击 English 行（无边框浮层：标题 top、中文 top+1、English top+2）→ 选中并确认切换
  handleTuiMouseEvent({ type: 'down', button: 0, x: 30, y: overlayTop43 + 2 }, tree43, s43, 64, noopPaint);
  if (s43.language !== 'en' || s43.languageSave !== 'en' || s43.menu !== null) {
    console.error(`✗ 场景 43 菜单点击未选中确认 English: ${JSON.stringify({ language: s43.language, languageSave: s43.languageSave, menu: s43.menu })}`);
    process.exit(1);
  }
  // 点击底边行（top+4）：rowMap=-1 不触发切换，菜单保持
  openLanguageMenu(s43);
  repaintTree(t43.renderer, tree43, s43, { withInput: true });
  await t43.renderOnce();
  const top43b = (tree43.menuOverlay!.top ?? 0) as number;
  handleTuiMouseEvent({ type: 'down', button: 0, x: 30, y: top43b + 4 }, tree43, s43, 64, noopPaint);
  if (s43.menu === null || s43.language !== 'en') {
    console.error('✗ 场景 43 点击底边行不应触发切换');
    process.exit(1);
  }
  // 点击面板外部（y=0）：不穿透、不误触、菜单保持
  handleTuiMouseEvent({ type: 'down', button: 0, x: 30, y: 0 }, tree43, s43, 64, noopPaint);
  if (s43.menu === null) {
    console.error('✗ 场景 43 点击外部不应关闭菜单');
    process.exit(1);
  }
  // l) 主题菜单点击回归（真实鼠标事件链路：mockMouse 派发 → 冒泡到 root.onMouseEvent →
  //    handleTuiMouseEvent → 菜单确认）：点击「亮色」行 → themeMode 切换（confirmMenu 通用路径）
  (tree43.root as unknown as { onMouseEvent?: (e: unknown) => void }).onMouseEvent = (e: unknown) => {
    handleTuiMouseEvent(e as never, tree43, s43, 64, noopPaint);
  };
  const { openThemeMenu: openThemeMenu43 } = await import('../src/tui/commands.js');
  openThemeMenu43(s43);
  repaintTree(t43.renderer, tree43, s43, { withInput: true });
  await t43.renderOnce();
  const top43c = (tree43.menuOverlay!.top ?? 0) as number;
  // 主题菜单：标题 top、跟随系统 top+1、亮色 top+2、深色 top+3、提示 top+4、底边 top+5
  if (JSON.stringify(tree43.menuRowMap) !== JSON.stringify([-1, 0, 1, 2, -1, -1])) {
    console.error(`✗ 场景 43 主题菜单行映射错误: ${JSON.stringify(tree43.menuRowMap)}`);
    process.exit(1);
  }
  await t43.mockMouse.click(30, top43c + 2);
  if (s43.themeMode !== 'light') {
    console.error(`✗ 场景 43 菜单点击未切换主题: ${s43.themeMode}`);
    process.exit(1);
  }
  // m) 设置菜单点击转换链路（此前快照只测 openLanguageMenu/openStatuslinePanel 直达路径，
  //    未测 settings 菜单点击——用户反馈「点状态行没反应/点语言打开状态行操作页」的盲区）：
  //    点「状态行」→ settingsPanel 接管（设置菜单关闭）；点「语言」→ menu 转换为语言面板
  //    （不误关）；语言面板内再点击切换生效
  const { openSettingsMenu: openSettingsMenu43 } = await import('../src/tui/commands.js');
  openSettingsMenu43(s43); // 当前语言 en：菜单标题/选项应为英文
  repaintTree(t43.renderer, tree43, s43, { withInput: true });
  await t43.renderOnce();
  const top43d = (tree43.menuOverlay!.top ?? 0) as number;
  if (JSON.stringify(tree43.menuRowMap) !== JSON.stringify([-1, 0, 1, 2, 3, 4, -1, -1])) {
    console.error(`✗ 场景 43 设置菜单行映射错误: ${JSON.stringify(tree43.menuRowMap)}`);
    process.exit(1);
  }
  // 点「状态行」（top+1）→ 设置菜单关闭 + settingsPanel 打开
  handleTuiMouseEvent({ type: 'down', button: 0, x: 30, y: top43d + 1 }, tree43, s43, 64, noopPaint);
  if (s43.menu !== null || s43.settingsPanel === null || s43.settingsPanel.items.length !== 5) {
    console.error(`✗ 场景 43 点状态行未打开状态行编辑器: ${JSON.stringify({ menu: s43.menu, items: s43.settingsPanel?.items.length })}`);
    process.exit(1);
  }
  // 点「语言」（重新打开设置菜单，top+2）→ menu 转换为语言面板（不误关）
  s43.settingsPanel = null;
  openSettingsMenu43(s43);
  repaintTree(t43.renderer, tree43, s43, { withInput: true });
  await t43.renderOnce();
  const top43e = (tree43.menuOverlay!.top ?? 0) as number;
  handleTuiMouseEvent({ type: 'down', button: 0, x: 30, y: top43e + 2 }, tree43, s43, 64, noopPaint);
  if (s43.menu === null || s43.menu.id !== 'language') {
    console.error(`✗ 场景 43 点语言未转换到语言面板: ${JSON.stringify(s43.menu)}`);
    process.exit(1);
  }
  // 语言面板内点「中文」（top+1，当前 en 高亮 English）→ 切换回 zh
  repaintTree(t43.renderer, tree43, s43, { withInput: true });
  await t43.renderOnce();
  const top43f = (tree43.menuOverlay!.top ?? 0) as number;
  handleTuiMouseEvent({ type: 'down', button: 0, x: 30, y: top43f + 1 }, tree43, s43, 64, noopPaint);
  if (s43.language !== 'zh' || s43.menu !== null) {
    console.error(`✗ 场景 43 语言面板内点击未切换: ${JSON.stringify({ language: s43.language, menu: s43.menu })}`);
    process.exit(1);
  }
  // 点「主题」（重新打开设置菜单，top+3）→ menu 转换为主题面板（/theme 并入 /settings 二级菜单）
  openSettingsMenu43(s43);
  repaintTree(t43.renderer, tree43, s43, { withInput: true });
  await t43.renderOnce();
  const top43h = (tree43.menuOverlay!.top ?? 0) as number;
  handleTuiMouseEvent({ type: 'down', button: 0, x: 30, y: top43h + 3 }, tree43, s43, 64, noopPaint);
  if (s43.menu === null || s43.menu.id !== 'theme') {
    console.error(`✗ 场景 43 点主题未转换到主题面板: ${JSON.stringify(s43.menu)}`);
    process.exit(1);
  }
  // 点「当次 token 统计」（重新打开设置菜单，top+4）→ 无编辑器面板：选择即切换开关 + 菜单关闭
  const tokensBefore43 = s43.showTokens;
  openSettingsMenu43(s43);
  repaintTree(t43.renderer, tree43, s43, { withInput: true });
  await t43.renderOnce();
  const top43i = (tree43.menuOverlay!.top ?? 0) as number;
  handleTuiMouseEvent({ type: 'down', button: 0, x: 30, y: top43i + 4 }, tree43, s43, 64, noopPaint);
  if (s43.menu !== null || s43.showTokens === tokensBefore43) {
    console.error(`✗ 场景 43 点 tokens 未切换开关并关闭菜单: ${JSON.stringify({ menu: s43.menu, showTokens: s43.showTokens, before: tokensBefore43 })}`);
    process.exit(1);
  }
  // 点「环境诊断」（重新打开设置菜单，top+5）→ 无编辑器面板且需 ctx 执行：
  // 只记录 doctorPending 意图 + 关闭菜单（interactive 每轮命令分发前消费执行诊断）
  openSettingsMenu43(s43);
  repaintTree(t43.renderer, tree43, s43, { withInput: true });
  await t43.renderOnce();
  const top43j = (tree43.menuOverlay!.top ?? 0) as number;
  handleTuiMouseEvent({ type: 'down', button: 0, x: 30, y: top43j + 5 }, tree43, s43, 64, noopPaint);
  if (s43.menu !== null || s43.doctorPending !== true) {
    console.error(`✗ 场景 43 点 doctor 未记录意图并关闭菜单: ${JSON.stringify({ menu: s43.menu, doctorPending: s43.doctorPending })}`);
    process.exit(1);
  }
  // n) 输入区 placeholder 随语言即时刷新（此前 mount 时取一次、切语言后重启才生效）：
  //    m) 段已切回 zh → 重绘后 placeholder 立即变中文（不再等重启）
  repaintTree(t43.renderer, tree43, s43, { withInput: true });
  await t43.renderOnce();
  const frame43n = t43.captureCharFrame();
  if (!frame43n.includes('输入消息') || frame43n.includes('Type a message')) {
    console.error('✗ 场景 43 切回中文后 placeholder 未即时刷新');
    process.exit(1);
  }
  // o) 鼠标点选确认后的提示面板自动收起（用户反馈「切换完语言，提示始终显示不消失」——
  //    键盘确认由 interactive 菜单分支调度 autoClose，鼠标点选路径此前漏调度）：
  //    鼠标点 English → 确认提示进面板 → 短暂停留后自动收起
  openLanguageMenu(s43); // 当前 zh：高亮 0（中文）
  repaintTree(t43.renderer, tree43, s43, { withInput: true });
  await t43.renderOnce();
  const top43g = (tree43.menuOverlay!.top ?? 0) as number;
  handleTuiMouseEvent(
    { type: 'down', button: 0, x: 30, y: top43g + 2 },
    tree43,
    s43,
    64,
    noopPaint,
    { paint: async () => {} },
    30, // 快速版 delayMs：等 60ms 断言自动收起
  );
  if (s43.language !== 'en' || s43.cmdPanel === null) {
    console.error(`✗ 场景 43 鼠标点 English 未切换+未弹提示面板: ${JSON.stringify({ language: s43.language, cmdPanel: s43.cmdPanel })}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 60));
  if (s43.cmdPanel !== null) {
    console.error('✗ 场景 43 鼠标确认后的提示面板未自动收起');
    process.exit(1);
  }
  console.log('✓ 场景 43 通过：/settings language 语言切换（菜单/确认/持久化/footer/面板/联想/tokens/状态栏/鼠标点击）');

  // 场景 44：/trace 右侧轨迹面板 —— 事件投影（foldTrace）+ 面板行（tracePanelLines）+ 渲染/点击/命令分发
  const { foldTrace, buildTraceTextLines, fmtMs } = await import('../src/agent/trace.js');
  const { traceDetailLines, tracePanelLines, refreshTrace, TRACE_TEXT_COLS } = await import('../src/tui/trace.js');
  // 两回合事件序列（turn/start → user → request → tool 配对 → assistant → turn/end；轮 2 interrupt 中止）
  const evs44: TrajEvent[] = [
    { s: 1, time: 1000, k: 'turn/start', turn: 1 },
    { s: 2, time: 1100, k: 'user/message', text: '列一下当前目录', source: 'user' },
    { s: 3, time: 1200, k: 'request/header', step: 1, model: 'mock', tools: ['list_directory'], messages: 2 },
    { s: 4, time: 1250, k: 'tool/call', step: 1, callId: 'call_1', name: 'list_directory', args: '{"path":"."}' },
    { s: 5, time: 2000, k: 'tool/result', callId: 'call_1', ok: true, chars: 320 },
    { s: 6, time: 2100, k: 'assistant/message', step: 2, text: '当前目录共 3 个文件', usage: { input: 500, cached: 100, output: 60 }, llmMs: 1500, firstTokenMs: 200 },
    { s: 7, time: 2200, k: 'turn/end', turn: 1, reason: 'completed' },
    { s: 8, time: 3000, k: 'turn/start', turn: 2 },
    { s: 9, time: 3100, k: 'user/message', text: '改为查询文件内容', source: 'interrupt' },
    { s: 10, time: 3200, k: 'turn/end', turn: 2, reason: 'aborted' },
  ];
  // a) 投影：foldTrace 折叠（turn 标记 / user 缩进 / tool 按 callId 配对 / answer 副信息）
  const rows44 = foldTrace(evs44);
  const turns44 = rows44.filter((r) => r.kind === 'turn');
  const tool44 = rows44.find((r) => r.kind === 'tool');
  const ans44 = rows44.find((r) => r.kind === 'answer');
  const usr44 = rows44.filter((r) => r.kind === 'user');
  if (rows44.length !== 7 || turns44.length !== 2) {
    console.error(`✗ 场景 44 foldTrace 行数错误: ${JSON.stringify(rows44.map((r) => `${r.kind}:${r.text}`))}`);
    process.exit(1);
  }
  if (turns44[0]!.done !== '✓' || turns44[1]!.done !== '⚠') {
    console.error(`✗ 场景 44 turn 结束标记错误: ${JSON.stringify(turns44.map((t) => t.done))}（应 ✓/⚠）`);
    process.exit(1);
  }
  if (!usr44[0]!.text.startsWith('列一下当前目录') || !usr44[1]!.text.startsWith('⚡ 改为查询文件内容')) {
    console.error(`✗ 场景 44 user 行（interrupt ⚡ 前缀）错误: ${JSON.stringify(usr44.map((u) => u.text))}`);
    process.exit(1);
  }
  if (!tool44 || tool44.sub !== `✓ 320 字符 · ${fmtMs(750)}`) {
    console.error(`✗ 场景 44 tool 配对耗时错误: ${JSON.stringify(tool44)}`);
    process.exit(1);
  }
  if (!ans44 || !ans44.sub!.includes('入 500 · 出 60 · 缓存 100') || !ans44.sub!.includes('LLM 1.5s · 首 token 0.2s')) {
    console.error(`✗ 场景 44 answer 副信息错误: ${JSON.stringify(ans44.sub)}`);
    process.exit(1);
  }
  // a2) detail 生成（点击展开详情的内容）：tool 完整 args / request 完整工具列表；
  // 单行正文无 detail（无需展开）
  const req44 = rows44.find((r) => r.kind === 'request');
  if (!tool44!.detail || tool44!.detail[0] !== '{"path":"."}') {
    console.error(`✗ 场景 44 tool detail 应为完整 args JSON: ${JSON.stringify(tool44!.detail)}`);
    process.exit(1);
  }
  if (!req44!.detail || req44!.detail[0] !== '调用工具: list_directory') {
    console.error(`✗ 场景 44 request detail 应为完整工具列表: ${JSON.stringify(req44!.detail)}`);
    process.exit(1);
  }
  if (usr44[0]!.detail !== undefined || ans44!.detail !== undefined) {
    console.error(`✗ 场景 44 单行正文不应生成 detail: ${JSON.stringify({ u: usr44[0]!.detail, a: ans44!.detail })}`);
    process.exit(1);
  }
  // 多行正文：首行作 text、剩余行作 detail（点击展开查看全文）
  const evs44m: TrajEvent[] = [
    { s: 1, time: 1000, k: 'turn/start', turn: 1 },
    { s: 2, time: 1100, k: 'user/message', text: '第一行\n第二行\n第三行', source: 'user' },
    { s: 3, time: 2000, k: 'assistant/message', step: 1, text: '正文首行\n续行一\n续行二', usage: { input: 10, output: 5 }, llmMs: 100, firstTokenMs: 50 },
    { s: 4, time: 2100, k: 'turn/end', turn: 1, reason: 'completed' },
  ];
  const rows44m = foldTrace(evs44m);
  const usr44m = rows44m.find((r) => r.kind === 'user')!;
  const ans44m = rows44m.find((r) => r.kind === 'answer')!;
  if (usr44m.detail?.join('|') !== '第二行|第三行' || ans44m.detail?.join('|') !== '续行一|续行二') {
    console.error(`✗ 场景 44 多行正文 detail 错误: ${JSON.stringify({ u: usr44m.detail, a: ans44m.detail })}`);
    process.exit(1);
  }
  // b) buildTraceTextLines（console /trace 账本）：full 模式含副信息行
  const led44 = buildTraceTextLines(evs44, { full: true });
  if (!led44.some((l) => l.startsWith('轮 1 ✓')) || !led44.some((l) => l.includes('list_directory .')) || !led44.some((l) => l.includes('入 500'))) {
    console.error(`✗ 场景 44 账本文本错误: ${JSON.stringify(led44)}`);
    process.exit(1);
  }
  if (!led44.some((l) => l.includes('{"path":"."}'))) {
    console.error(`✗ 场景 44 账本 full 应包含 tool 完整 args: ${JSON.stringify(led44)}`);
    process.exit(1);
  }
  // c) tracePanelLines：空状态（empty + hint）
  const s44e = createTuiState();
  const pl44e = tracePanelLines(s44e, 16);
  if (!pl44e.lines.some((l) => l.text.includes('暂无轨迹')) || !pl44e.lines.some((l) => l.text.includes('Esc 收起'))) {
    console.error(`✗ 场景 44 空面板错误: ${JSON.stringify(pl44e.lines.map((l) => l.text))}`);
    process.exit(1);
  }
  // d) 有数据：标题「轨迹（N 条）」+ 内容窗口 + 底部 hint；窗口外选中行保持可见（滚动收敛）
  const s44 = createTuiState();
  refreshTrace(s44, evs44);
  if (s44.traceRows.length !== 7) {
    console.error(`✗ 场景 44 refreshTrace 行数错误: ${s44.traceRows.length}`);
    process.exit(1);
  }
  const pl44 = tracePanelLines(s44, 16); // budget = 16-5-2 = 9 → contentRows 9 全部可见
  if (!pl44.lines[0]!.text.includes('轨迹（7 条）') || pl44.rowMap[0] !== -1) {
    console.error(`✗ 场景 44 面板标题错误: ${JSON.stringify(pl44.lines[0])}`);
    process.exit(1);
  }
  if (!pl44.lines.some((l) => l.text.includes('❯ 列一下当前目录')) || !pl44.lines.some((l) => l.text.includes('⚙ list_directory .'))) {
    console.error(`✗ 场景 44 面板行渲染错误: ${JSON.stringify(pl44.lines.map((l) => l.text))}`);
    process.exit(1);
  }
  // 选中可见收敛：全部可见时选中任何行都不应触发滚动（scroll 保持 0）
  s44.traceSelected = 6;
  const pl44b = tracePanelLines(s44, 16);
  if (pl44b.lines.some((l) => l.text.startsWith('↑ 还有'))) {
    console.error('✗ 场景 44 全量可见时不应出现上滚提示（选中行已在窗口内）');
    process.exit(1);
  }
  // 收紧窗口（budget 3 → contentRows 1）：选中末行 → scroll 钳到 T-1-s 保证选中行可见
  const s44s = createTuiState();
  refreshTrace(s44s, evs44);
  s44s.traceSelected = 6; // 末行（轮 2 的 user ⚡ 行）
  const pl44c = tracePanelLines(s44s, 8, 3); // contentRows = 1
  const sel44c = pl44c.lines.find((l) => l.text.startsWith('› '));
  if (!sel44c || !sel44c.text.includes('改为查询文件内容')) {
    console.error(`✗ 场景 44 选中行未滚入窗口（应显示末行 ⚡ user）: ${JSON.stringify(pl44c.lines.map((l) => l.text))}`);
    process.exit(1);
  }
  // 选中行 + 有 detail：列表页**不内嵌**详情（点击进入详情页展示——用户要求页面导航），
  // 详情内容只出现在 traceDetailLines
  const evs44e: TrajEvent[] = [
    { s: 1, time: 1000, k: 'turn/start', turn: 1 },
    { s: 2, time: 1100, k: 'user/message', text: '跑一下', source: 'user' },
    { s: 3, time: 2000, k: 'turn/end', turn: 1, reason: 'error', detail: 'API 401 Invalid token' },
  ];
  const s44d = createTuiState();
  refreshTrace(s44d, evs44e);
  s44d.traceSelected = 0; // turn 1 ✗ 带 detail
  const pl44d = tracePanelLines(s44d, 16);
  if (!pl44d.lines[1]!.text.includes('✗') || !pl44d.lines[1]!.text.includes('轮 1')) {
    console.error(`✗ 场景 44 列表页选中行错误: ${JSON.stringify(pl44d.lines.map((l) => l.text))}`);
    process.exit(1);
  }
  if (pl44d.lines.some((l) => l.text.includes('API 401'))) {
    console.error(`✗ 场景 44 列表页不应内嵌详情（详情在详情页）: ${JSON.stringify(pl44d.lines.map((l) => l.text))}`);
    process.exit(1);
  }
  // d2) 详情页（traceDetailLines）：返回行（rowMap -2）+ 行标题 + 完整内容（折行不截断）——
  // 长内容按列宽折行显示全部；点击返回行回列表
  const evs44f: TrajEvent[] = [
    { s: 1, time: 1000, k: 'turn/start', turn: 1 },
    { s: 2, time: 1100, k: 'user/message', text: '问题一', source: 'user' },
    { s: 3, time: 1200, k: 'request/header', step: 1, model: 'mock', tools: ['list_directory'], messages: 2 },
    { s: 4, time: 1250, k: 'tool/call', step: 1, callId: 'c1', name: 'list_directory', args: '{"path":"."}' },
    { s: 5, time: 2000, k: 'tool/result', callId: 'c1', ok: true, chars: 320 },
    { s: 6, time: 2100, k: 'assistant/message', step: 2, text: '回答一', usage: { input: 500, output: 60 }, llmMs: 1500, firstTokenMs: 200 },
    { s: 7, time: 2200, k: 'turn/end', turn: 1, reason: 'completed' },
    { s: 8, time: 3000, k: 'turn/start', turn: 2 },
    { s: 9, time: 3100, k: 'user/message', text: '问题二', source: 'user' },
    { s: 10, time: 3200, k: 'turn/end', turn: 2, reason: 'error', detail: 'API 401 Invalid token' },
  ];
  const s44f = createTuiState();
  refreshTrace(s44f, evs44f);
  if (s44f.traceRows.length !== 7) {
    console.error(`✗ 场景 44 窗口满用例行数错误: ${s44f.traceRows.length}`);
    process.exit(1);
  }
  // turn 2 ✗（下标 5）详情页：返回行 + 轮 2 ✗ 标题 + API 401 完整内容
  const dl44 = traceDetailLines(s44f, 5, 32);
  if (!dl44.lines[0]!.text.includes('返回') || dl44.rowMap[0] !== -2) {
    console.error(`✗ 场景 44 详情页返回行错误: ${JSON.stringify(dl44.lines[0])} rowMap=${dl44.rowMap[0]}`);
    process.exit(1);
  }
  if (!dl44.lines[1]!.text.includes('轮 2 ✗')) {
    console.error(`✗ 场景 44 详情页标题错误: ${JSON.stringify(dl44.lines.map((l) => l.text))}`);
    process.exit(1);
  }
  if (!dl44.lines.some((l) => l.text.includes('API 401 Invalid token'))) {
    console.error(`✗ 场景 44 详情页缺完整内容: ${JSON.stringify(dl44.lines.map((l) => l.text))}`);
    process.exit(1);
  }
  // 长内容折行不截断（30 个汉字 + 超长参数 → 多行完整显示）
  const s44g = createTuiState();
  refreshTrace(s44g, [
    { s: 1, time: 1000, k: 'turn/start', turn: 1 },
    { s: 2, time: 1100, k: 'user/message', text: '首行\n' + '长'.repeat(40), source: 'user' },
    { s: 3, time: 2000, k: 'turn/end', turn: 1, reason: 'completed' },
  ]);
  const dl44g = traceDetailLines(s44g, 1, 32); // user 行：完整正文 = 首行 + 40 个「长」
  const dlText = dl44g.lines.map((l) => l.text).join('\n');
  if (dlText.includes('…') || dl44g.lines.length < 3) {
    console.error(`✗ 场景 44 详情页长内容应折行显示全部（不截断）: ${JSON.stringify(dl44g.lines.map((l) => l.text))}`);
    process.exit(1);
  }
  if (!dlText.includes('长'.repeat(40))) {
    // 折行后 40 个「长」被换行断开——按字符总数校验内容完整（不截断）
    const longCount = (dlText.match(/长/g) ?? []).length;
    if (longCount !== 40) {
      console.error(`✗ 场景 44 详情页长内容缺失: 长×${longCount}（应 40）: ${JSON.stringify(dl44g.lines.map((l) => l.text))}`);
      process.exit(1);
    }
  }
  // 渲染集成：traceDetail 打开 → 帧含返回行 + 内容；点击返回行 → 回列表页
  s44f.traceOpen = true;
  s44f.traceDetail = { rowIdx: 5 };
  const t44d = await createTestRenderer({ width: 64, height: 20 });
  const tree44d = mountTree(t44d.renderer, s44f, { withInput: true });
  await t44d.renderOnce();
  const frame44d = t44d.captureCharFrame();
  if (!frame44d.includes('返回') || !frame44d.includes('API 401 Invalid token') || frame44d.includes('轨迹（7 条）')) {
    console.error(`✗ 场景 44 详情页渲染错误:\n${frame44d}`);
    process.exit(1);
  }
  const { handleTuiMouseEvent: htm44d } = await import('../src/tui/render.js');
  // 返回行在面板第 1 行（y = traceRect.top）
  htm44d({ type: 'down', button: 0, x: tree44d.traceLeft + 5, y: tree44d.traceRect!.top }, tree44d, s44f, 64, noopPaint);
  if (s44f.traceDetail !== null) {
    console.error('✗ 场景 44 点击返回行未回列表页');
    process.exit(1);
  }
  // 详情页内容行点击无操作（不关闭/不跳转）
  s44f.traceDetail = { rowIdx: 5 };
  htm44d({ type: 'down', button: 0, x: tree44d.traceLeft + 5, y: tree44d.traceRect!.top + 2 }, tree44d, s44f, 64, noopPaint);
  if (s44f.traceDetail === null) {
    console.error('✗ 场景 44 详情页内容行点击不应返回');
    process.exit(1);
  }
  s44f.traceDetail = null;
  // e) 渲染集成：traceOpen → traceBox 可见 + 帧内含面板 + traceRect/traceLeft/rowMap；关闭 → 隐藏
  const s44r = createTuiState();
  refreshTrace(s44r, evs44);
  s44r.traceOpen = true;
  const t44 = await createTestRenderer({ width: 64, height: 20 });
  const tree44 = mountTree(t44.renderer, s44r, { withInput: true });
  await t44.renderOnce();
  if (!tree44.traceBox || !tree44.traceBox.visible) {
    console.error('✗ 场景 44 traceBox 未显示');
    process.exit(1);
  }
  const frame44 = t44.captureCharFrame();
  if (!frame44.includes('轨迹（7 条）') || !frame44.includes('list_directory')) {
    console.error('✗ 场景 44 帧内无轨迹面板内容');
    process.exit(1);
  }
  if (tree44.traceLeft !== 64 - 36 - 1) {
    console.error(`✗ 场景 44 traceLeft 错误: ${tree44.traceLeft}（应 ${64 - 36 - 1}）`);
    process.exit(1);
  }
  if (!tree44.traceRect || tree44.traceRect.top !== 2 || tree44.traceRect.bottom < tree44.traceRect.top) {
    console.error(`✗ 场景 44 traceRect 错误: ${JSON.stringify(tree44.traceRect)}（应 top=2、bottom ≥ top）`);
    process.exit(1);
  }
  if (tree44.traceRowMap.some((v) => v !== -1 && (v < 0 || v >= 7))) {
    console.error(`✗ 场景 44 traceRowMap 下标越界: ${JSON.stringify(tree44.traceRowMap)}`);
    process.exit(1);
  }
  // 内容宽度收缩：traceOpen 时 computeRows 内容区右移（长行重新折行，面板不盖对话流）
  const s44w = createTuiState();
  pushLine(s44w, { kind: 'user', text: 'a'.repeat(50) });
  const rows44none = computeRows(s44w, { height: 20, width: 64 }, { withInput: true });
  s44w.traceOpen = true;
  const rows44open = computeRows(s44w, { height: 20, width: 64 }, { withInput: true });
  const maxW44none = Math.max(...rows44none.map((r) => visualWidth(r.text)));
  const maxW44open = Math.max(...rows44open.map((r) => visualWidth(r.text)));
  if (maxW44none < 50 || maxW44open > 64 - 2 - (36 + 2) || maxW44open >= maxW44none) {
    console.error(`✗ 场景 44 traceOpen 内容宽度未收缩: none=${maxW44none} open=${maxW44open}（应 none≥50、open ≤ ${64 - 2 - 38}）`);
    process.exit(1);
  }
  // f) 鼠标点击：列表页命中轨迹行 → **推入详情页**；详情页点返回行 → 回列表；
  // 标题行（rowMap -1）不触发；面板外点击不命中
  const { handleTuiMouseEvent: htm44 } = await import('../src/tui/render.js');
  const y44row = tree44.traceRect!.top + 2; // 面板第 3 行（rowMap ≥ 0）
  htm44({ type: 'down', button: 0, x: tree44.traceLeft + 5, y: y44row }, tree44, s44r, 64, noopPaint);
  if (s44r.traceDetail === null || s44r.traceDetail.rowIdx < 0) {
    console.error('✗ 场景 44 点击轨迹行未推入详情页');
    process.exit(1);
  }
  // 详情页：点返回行（面板第 1 行）→ 回列表页
  htm44({ type: 'down', button: 0, x: tree44.traceLeft + 5, y: tree44.traceRect!.top }, tree44, s44r, 64, noopPaint);
  if (s44r.traceDetail !== null) {
    console.error('✗ 场景 44 详情页点击返回行未回列表');
    process.exit(1);
  }
  // 列表页：点标题行（面板第 1 行，rowMap -1）不触发——选中/详情状态保持不变
  const selBefore44 = s44r.traceSelected;
  htm44({ type: 'down', button: 0, x: tree44.traceLeft + 5, y: tree44.traceRect!.top }, tree44, s44r, 64, noopPaint);
  if (s44r.traceDetail !== null || s44r.traceSelected !== selBefore44) {
    console.error(`✗ 场景 44 点击标题行不应触发: detail=${JSON.stringify(s44r.traceDetail)} sel=${s44r.traceSelected}（点击前 ${selBefore44}）`);
    process.exit(1);
  }
  htm44({ type: 'down', button: 0, x: tree44.traceLeft - 1, y: y44row }, tree44, s44r, 64, noopPaint);
  if (s44r.traceDetail !== null) {
    console.error('✗ 场景 44 面板左侧区域点击不应命中面板');
    process.exit(1);
  }
  // g) /trace 命令分发：toggle + 关闭时清选中/滚动/详情页；无 events 时也能安全 toggle
  const { runCommand: runCmd44, findCommand: findCmd44 } = await import('../src/tui/commands.js');
  if (!findCmd44('trace')) {
    console.error('✗ 场景 44 /trace 命令未注册');
    process.exit(1);
  }
  const s44c = createTuiState();
  await runCmd44({ state: s44c, out: {}, session: {}, input: {}, messages: [] } as never, '/trace');
  if (!s44c.traceOpen) {
    console.error('✗ 场景 44 /trace 未打开面板');
    process.exit(1);
  }
  s44c.traceSelected = 3;
  s44c.traceScroll = 5;
  s44c.traceDetail = { rowIdx: 2 };
  await runCmd44({ state: s44c, out: {}, session: {}, input: {}, messages: [] } as never, '/trace');
  if (s44c.traceOpen || s44c.traceSelected !== -1 || s44c.traceScroll !== 0 || s44c.traceDetail !== null) {
    console.error(`✗ 场景 44 /trace 关闭未清选中/滚动/详情页: ${JSON.stringify({ open: s44c.traceOpen, sel: s44c.traceSelected, scroll: s44c.traceScroll, detail: s44c.traceDetail })}`);
    process.exit(1);
  }
  console.log('✓ 场景 44 通过：/trace 右侧轨迹面板（foldTrace 投影/账本/面板行/选中收敛/渲染收缩/页面导航点击/命令分发）');

  // 场景 45：ask_user 提问面板（输入区上方：选项 A-D / 自定义输入 / Esc 取消）
  const { createAskUserTool } = await import('../src/tools/ask.js');
  // a) TuiOutput.askUser：队列串行——两个提问排队，第一个 resolve 后自动展示第二个
  {
    const s45 = createTuiState();
    const out45 = new TuiOutput(s45, { showThinking: true }, { paint: async () => {} } as never);
    const r1 = out45.askUser('方案选择', ['方案A', '方案B', '方案C'], false);
    const r2 = out45.askUser('第二个问题', ['甲', '乙'], true);
    if (
      !s45.ask ||
      s45.ask.question !== '方案选择' ||
      s45.ask.options.length !== 3 ||
      s45.ask.multiple !== false ||
      s45.ask.cursor !== 0 ||
      s45.ask.selected.size !== 0
    ) {
      console.error(`✗ 场景 45 首个提问构造错误: ${JSON.stringify(s45.ask)}`);
      process.exit(1);
    }
    s45.askResolve?.({ choice: '方案B', custom: false, choices: ['方案B'] });
    const v1 = await r1;
    if (v1?.choice !== '方案B' || v1.custom || v1.choices.length !== 1) {
      console.error(`✗ 场景 45 首个提问结果错误: ${JSON.stringify(v1)}`);
      process.exit(1);
    }
    if (!s45.ask || s45.ask.question !== '第二个问题' || s45.ask.multiple !== true) {
      console.error(`✗ 场景 45 队列未展示下一条（multiple 传递错误）: ${JSON.stringify(s45.ask)}`);
      process.exit(1);
    }
    s45.askResolve?.(null);
    const v2 = await r2;
    if (v2 !== null || s45.ask !== null) {
      console.error(`✗ 场景 45 取消提问结果错误: ${JSON.stringify(v2)}`);
      process.exit(1);
    }
  }
  // b) 渲染：竖向勾选列表——❓ 问题（单选/多选）+ [x] 选项行 + 自定义行 + ✓ 确认行 +
  //    提示行；askRects 行 y → {kind: opt/custom/confirm}；computeRows 预算收缩 options+4
  {
    const s45 = createTuiState();
    s45.model = 'mock';
    s45.ask = { question: '如何推进？', options: ['先调研', '直接实现', '先问清楚'], multiple: false, selected: new Set([1]), custom: '', cursor: 0 };
    const t45 = await createTestRenderer({ width: 80, height: 24 });
    const tree45 = mountTree(t45.renderer, s45, { withInput: true });
    await t45.renderOnce();
    if (!tree45.askBox || !tree45.askBox.visible) {
      console.error('✗ 场景 45 askBox 未显示');
      process.exit(1);
    }
    const frame45 = t45.captureCharFrame();
    if (
      !frame45.includes('如何推进') ||
      !frame45.includes('单选') ||
      !frame45.includes('[ ] A) 先调研') ||
      !frame45.includes('[x] B) 直接实现') ||
      !frame45.includes('自定义') ||
      !frame45.includes('确认') ||
      !frame45.includes('Esc 取消')
    ) {
      console.error(`✗ 场景 45 ask 面板渲染缺内容:\n${frame45}`);
      process.exit(1);
    }
    // 高亮行 › 前缀
    if (!frame45.includes('› [ ] A) 先调研')) {
      console.error(`✗ 场景 45 高亮行 › 前缀缺失:\n${frame45}`);
      process.exit(1);
    }
    // askRects：面板底 = 24-5-1 = 18；行数 = 1+3+1+1+1 = 7 → 顶 11。
    // 选项 i 在 y = 11+1+i（12/13/14）、自定义 15、确认 16
    const rOpt = tree45.askRects.get(13);
    if (!rOpt || rOpt.kind !== 'opt' || rOpt.idx !== 1) {
      console.error(`✗ 场景 45 askRects 选项行映射错误: y13 → ${JSON.stringify(rOpt)}: ${JSON.stringify([...tree45.askRects])}`);
      process.exit(1);
    }
    const rCus = tree45.askRects.get(15);
    if (!rCus || rCus.kind !== 'custom') {
      console.error(`✗ 场景 45 askRects 自定义行映射错误: y15 → ${JSON.stringify(rCus)}`);
      process.exit(1);
    }
    const rCfm = tree45.askRects.get(16);
    if (!rCfm || rCfm.kind !== 'confirm') {
      console.error(`✗ 场景 45 askRects 确认行映射错误: y16 → ${JSON.stringify(rCfm)}`);
      process.exit(1);
    }
    // 内容区预算收缩：ask 打开时 cap 减 options+4 行（❓ 1 + 选项 3 + 自定义 1 + 确认 1 + 提示 1）
    const s45b = createTuiState();
    for (let i = 0; i < 20; i++) pushLine(s45b, { kind: 'user', text: `行 ${i}` });
    const capNone = computeRows(s45b, { height: 24, width: 80 }, { withInput: true }).length;
    s45b.ask = { question: 'q', options: ['a', 'b', 'c'], multiple: false, selected: new Set(), custom: '', cursor: 0 };
    const capAsk = computeRows(s45b, { height: 24, width: 80 }, { withInput: true }).length;
    if (capAsk !== capNone - 7) {
      console.error(`✗ 场景 45 ask 预算未收缩: none=${capNone} ask=${capAsk}（应差 7 = 3 选项+4）`);
      process.exit(1);
    }
    // ask 关闭后恢复
    s45b.ask = null;
    const capBack = computeRows(s45b, { height: 24, width: 80 }, { withInput: true }).length;
    if (capBack !== capNone) {
      console.error(`✗ 场景 45 ask 关闭后预算未恢复: ${capBack}（应 ${capNone}）`);
      process.exit(1);
    }
  }
  // c) 按键：↑/↓ 移动光标、空格勾选（单选互斥/多选叠加）、Enter 提交（submitAsk 组装
  //    choices + 清空输入框）、输入框有内容时空格放行、Esc 取消 + askKeyJustConsumed
  {
    const s45 = createTuiState();
    const mkAsk = (multiple = false) => {
      s45.ask = { question: 'q', options: ['一', '二', '三'], multiple, selected: new Set(), custom: '', cursor: 0 };
    };
    let resolved: unknown = 'pending';
    s45.askResolve = (r) => {
      resolved = r;
      s45.ask = null; // 模拟 TuiOutput 的 resolver（真实链路里它清 ask + 播放下一条）
    };
    const t45 = await createTestRenderer({ width: 80, height: 24 });
    const tree45 = mountTree(t45.renderer, s45, { withInput: true });
    const { onAskKeyPress } = await import('../src/tui/render.js');
    const key45 = (name: string) => ({ name, preventDefault: () => {} }) as never;
    // 单选：↓ 移到选项二 → 空格勾选 → 空格再按取消 → 空格勾选 → Enter 提交
    mkAsk();
    onAskKeyPress(key45('down'), s45, tree45, () => {});
    onAskKeyPress(key45('space'), s45, tree45, () => {});
    if (!s45.ask!.selected.has(1) || s45.ask!.selected.size !== 1) {
      console.error(`✗ 场景 45 空格勾选失败: ${JSON.stringify([...s45.ask!.selected])}`);
      process.exit(1);
    }
    onAskKeyPress(key45('space'), s45, tree45, () => {});
    if (s45.ask!.selected.size !== 0) {
      console.error(`✗ 场景 45 空格再按未取消: ${JSON.stringify([...s45.ask!.selected])}`);
      process.exit(1);
    }
    onAskKeyPress(key45('space'), s45, tree45, () => {});
    onAskKeyPress(key45('return'), s45, tree45, () => {});
    if ((resolved as { choice: string } | null)?.choice !== '二' || (resolved as { choice: string } | null)?.custom !== false) {
      console.error(`✗ 场景 45 Enter 提交失败: ${JSON.stringify(resolved)}`);
      process.exit(1);
    }
    // 单选互斥：勾选选项一后再勾选项三 → 只剩三
    mkAsk();
    resolved = 'pending';
    onAskKeyPress(key45('space'), s45, tree45, () => {});
    onAskKeyPress(key45('down'), s45, tree45, () => {});
    onAskKeyPress(key45('down'), s45, tree45, () => {});
    onAskKeyPress(key45('space'), s45, tree45, () => {});
    if (!s45.ask!.selected.has(2) || s45.ask!.selected.size !== 1) {
      console.error(`✗ 场景 45 单选互斥失败: ${JSON.stringify([...s45.ask!.selected])}`);
      process.exit(1);
    }
    // 多选叠加：multiple=true 勾选两个 + 自定义内容 → 提交含自定义 + 输入框清空
    mkAsk(true);
    resolved = 'pending';
    onAskKeyPress(key45('space'), s45, tree45, () => {});
    onAskKeyPress(key45('down'), s45, tree45, () => {});
    onAskKeyPress(key45('space'), s45, tree45, () => {});
    if (s45.ask!.selected.size !== 2) {
      console.error(`✗ 场景 45 多选叠加失败: ${JSON.stringify([...s45.ask!.selected])}`);
      process.exit(1);
    }
    tree45.input!.setText('我的补充');
    s45.ask!.custom = '我的补充'; // repaintTree 每帧同步（快照手动模拟）
    onAskKeyPress(key45('return'), s45, tree45, () => {});
    const mr = resolved as { choice: string; custom: boolean; choices: string[] } | null;
    if (mr?.choice !== '一、二、我的补充' || mr.custom !== true || mr.choices.length !== 3 || tree45.input!.plainText !== '') {
      console.error(`✗ 场景 45 多选+自定义提交失败: ${JSON.stringify({ mr, input: tree45.input!.plainText })}`);
      process.exit(1);
    }
    // 无任何选择 Enter 不提交（面板保持）
    mkAsk();
    resolved = 'pending';
    onAskKeyPress(key45('return'), s45, tree45, () => {});
    if (resolved !== 'pending' || !s45.ask) {
      console.error(`✗ 场景 45 无选择 Enter 不应提交: ${JSON.stringify(resolved)}`);
      process.exit(1);
    }
    // 输入框有内容时空格放行（打字优先——自定义输入含空格不被吞）
    mkAsk();
    tree45.input!.setText('x');
    s45.ask!.custom = 'x';
    let prevented = false;
    const key45b = (name: string) => ({ name, preventDefault: () => { prevented = true; } }) as never;
    onAskKeyPress(key45b('space'), s45, tree45, () => {});
    if (prevented || s45.ask!.selected.size !== 0) {
      console.error(`✗ 场景 45 输入框有内容时空格应放行: ${JSON.stringify({ prevented, sel: [...s45.ask!.selected] })}`);
      process.exit(1);
    }
    tree45.input!.setText('');
    s45.ask!.custom = '';
    // Esc 取消（含 askKeyJustConsumed）
    onAskKeyPress(key45('escape'), s45, tree45, () => {});
    if (resolved !== null || !s45.askKeyJustConsumed) {
      console.error(`✗ 场景 45 Esc 未取消提问: ${JSON.stringify({ resolved, consumed: s45.askKeyJustConsumed })}`);
      process.exit(1);
    }
    s45.ask = null;
  }
  // d) 鼠标点击：选项行勾选（单选互斥+光标移动）、自定义行移光标、确认行提交
  {
    const s45 = createTuiState();
    s45.ask = { question: 'q', options: ['甲', '乙'], multiple: false, selected: new Set(), custom: '', cursor: 0 };
    let resolved: unknown = 'pending';
    s45.askResolve = (r) => {
      resolved = r;
      s45.ask = null;
    };
    const t45 = await createTestRenderer({ width: 80, height: 24 });
    const tree45 = mountTree(t45.renderer, s45, { withInput: true });
    await t45.renderOnce();
    const { handleTuiMouseEvent: htm45 } = await import('../src/tui/render.js');
    // 点击选项 2 行 → 勾选「乙」+ 光标移动
    const yOpt2 = [...tree45.askRects.entries()].find(([, v]) => v.kind === 'opt' && v.idx === 1)?.[0];
    if (yOpt2 === undefined) {
      console.error(`✗ 场景 45 askRects 无选项 2 行: ${JSON.stringify([...tree45.askRects])}`);
      process.exit(1);
    }
    htm45({ type: 'down', button: 0, x: 10, y: yOpt2 }, tree45, s45, 80, noopPaint);
    if (!s45.ask!.selected.has(1) || s45.ask!.cursor !== 1) {
      console.error(`✗ 场景 45 点击选项行未勾选: ${JSON.stringify({ sel: [...s45.ask!.selected], cursor: s45.ask!.cursor })}`);
      process.exit(1);
    }
    // 点击确认行 → 提交（勾选「乙」）
    const yCfm = [...tree45.askRects.entries()].find(([, v]) => v.kind === 'confirm')?.[0];
    if (yCfm === undefined) {
      console.error(`✗ 场景 45 askRects 无确认行`);
      process.exit(1);
    }
    htm45({ type: 'down', button: 0, x: 10, y: yCfm }, tree45, s45, 80, noopPaint);
    if ((resolved as { choice: string } | null)?.choice !== '乙' || s45.ask !== null) {
      console.error(`✗ 场景 45 点击确认行未提交: ${JSON.stringify(resolved)}`);
      process.exit(1);
    }
    // 点击自定义行 → 光标移到自定义（可键入）
    s45.ask = { question: 'q', options: ['甲', '乙'], multiple: false, selected: new Set(), custom: '', cursor: 0 };
    resolved = 'pending';
    const yCus = [...tree45.askRects.entries()].find(([, v]) => v.kind === 'custom')?.[0];
    if (yCus === undefined) {
      console.error(`✗ 场景 45 askRects 无自定义行`);
      process.exit(1);
    }
    htm45({ type: 'down', button: 0, x: 10, y: yCus }, tree45, s45, 80, noopPaint);
    if (s45.ask!.cursor !== 2 || resolved !== 'pending') {
      console.error(`✗ 场景 45 点击自定义行未移光标: ${JSON.stringify({ cursor: s45.ask!.cursor })}`);
      process.exit(1);
    }
  }
  // e) 工具链路：createAskUserTool——单选/多选/自定义/取消/无回调/参数校验 + multiple 传递
  {
    let gotMultiple: boolean | undefined;
    const tool45 = createAskUserTool(async (_q, _o, multiple) => {
      gotMultiple = multiple;
      return { choice: 'b', custom: false, choices: ['b'] };
    });
    const r1 = await tool45.execute({ question: 'q', options: ['a', 'b', 'c'] });
    if (r1 !== '用户选择了选项：b' || gotMultiple !== false) {
      console.error(`✗ 场景 45 工具单选结果/multiple 传递错误: ${JSON.stringify({ r1, gotMultiple })}`);
      process.exit(1);
    }
    const tool45m = createAskUserTool(async () => ({ choice: 'a、c', custom: false, choices: ['a', 'c'] }));
    const r1m = await tool45m.execute({ question: 'q', options: ['a', 'b', 'c'], multiple: true });
    if (r1m !== '用户选择了选项：a、c') {
      console.error(`✗ 场景 45 工具多选结果错误: ${r1m}`);
      process.exit(1);
    }
    const tool45b = createAskUserTool(async () => ({ choice: '自定义答案', custom: true, choices: ['自定义答案'] }));
    const r2 = await tool45b.execute({ question: 'q', options: ['a', 'b'] });
    if (r2 !== '用户选择了：自定义答案（含自定义输入）') {
      console.error(`✗ 场景 45 工具自定义结果错误: ${r2}`);
      process.exit(1);
    }
    const tool45c = createAskUserTool(async () => null);
    const r3 = await tool45c.execute({ question: 'q', options: ['a', 'b'] });
    if (!r3.includes('用户取消')) {
      console.error(`✗ 场景 45 工具取消结果错误: ${r3}`);
      process.exit(1);
    }
    const tool45d = createAskUserTool(undefined);
    const r4 = await tool45d.execute({ question: 'q', options: ['a', 'b'] });
    if (!r4.includes('无法输入')) {
      console.error(`✗ 场景 45 无回调结果错误: ${r4}`);
      process.exit(1);
    }
    const tool45e = createAskUserTool(async () => ({ choice: 'x', custom: false, choices: ['x'] }));
    const r5 = await tool45e.execute({ question: 'q', options: ['a'] });
    if (!r5.includes('错误')) {
      console.error(`✗ 场景 45 参数校验错误: ${r5}`);
      process.exit(1);
    }
  }
  console.log('✓ 场景 45 通过：ask_user 竖向勾选列表（队列串行/渲染与预算/↑↓空格勾选/Enter 提交/自定义/鼠标/工具结果）');

  console.log('\n✓✓ TUI 快照断言全部通过');
  process.exit(0);
}

main().catch((e) => {
  console.error('ERR:', e);
  process.exit(1);
});
