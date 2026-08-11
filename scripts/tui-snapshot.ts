/**
 * TUI 快照验证（无 TTY 可用）：用 @opentui/core/testing 的 createTestRenderer 内存渲染。
 *
 * 与真实 CLI 共用 src/tui/render.ts 的 mountTree/repaintTree（同一渲染路径），
 * 断言：思考/工具卡片/回答/用户消息/输入框/状态栏渲染 + 溢出自动跟随最新 + 增量重绘生效。
 *
 * 运行：npm run tui:snapshot（或 bun run ./scripts/tui-snapshot.ts）
 */
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { findSummarizeSplit, selectRelevantFiles } from '../src/agent/context.js';
import { gateTool } from '../src/safety/policy.js';
import { CODE_FG, INLINE_CODE_FG, markdownToRows } from '../src/tui/markdown.js';
import { computeRows, hitTestApproval, hitTestCard, mountTree, repaintTree, type CardRect } from '../src/tui/render.js';
import { createTuiState, pushLine, type TuiState } from '../src/tui/state.js';
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
async function render(state: TuiState): Promise<{ t: TestRendererSetup; frame: string }> {
  const t = await createTestRenderer({ width: 64, height: 20 });
  mountTree(t.renderer, state, { withInput: true });
  await t.renderOnce();
  return { t, frame: t.captureCharFrame() };
}

async function main(): Promise<void> {
  // 场景 1：少量内容，全部可见（含用户消息 + 输入框 + 状态栏）
  const s1 = createTuiState();
  fill(s1, 0);
  const r1 = await render(s1);
  console.log('=== 场景 1：基础布局（输入框模式）===');
  console.log(r1.frame);

  // 无根边框/标题：不应出现 ┌ 边框字符与 Omni 标题
  if (r1.frame.includes('┌') || r1.frame.includes('Omni v')) {
    console.error('✗ 场景 1 仍显示根边框或 Omni 标题（已移除）');
    process.exit(1);
  }
  // 新卡片：无工具名标题（去掉「查看目录」），收起态 = 命令(📁 .) + 执行缩略(✓ 执行成功 · 42 字符) + 结果缩略(输出首行)
  const checks1 = ['你是谁？', '📁 .', '执行成功 · 42 字符', '55 个文件/目录', '当前目录共 3 个文件', '任务完成', '输入消息，Enter 发送', '输入', '模型 mock', 'tok'];
  // 卡片每行总宽必须恰为内容宽度且右侧边框完整（宽度不一致会折行切断右边框）
  const rows1w = computeRows(s1, { height: 20, width: 64 }, { withInput: true });
  const cardRows1 = rows1w.filter((r) => r.cardId === 1);
  const contentW1 = 64 - 2;
  for (const r of cardRows1) {
    if (visualWidth(r.text) !== contentW1 || !/[╮│╯]$/.test(r.text)) {
      console.error(`✗ 场景 1 卡片行宽/右边框错误: w=${visualWidth(r.text)} text=${JSON.stringify(r.text)}`);
      process.exit(1);
    }
  }
  // 回归：emoji 摘要行的右侧边框必须完整（charWidth 与 OpenTUI 渲染宽度不一致时，
  // 📁 按 1 列算会让卡行实际宽 1 列、右侧边框被折行挤掉——帧级断言才能真正抓到）
  const emojiCardLine = r1.frame.split('\n').find((l) => l.includes('📁 .'));
  if (!emojiCardLine || !emojiCardLine.trimEnd().endsWith('│')) {
    console.error(`✗ 场景 1 emoji 摘要行右侧边框缺失: ${JSON.stringify(emojiCardLine)}`);
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
    text: '📄 AGENTS.md',
    card: { id: 2, name: 'read_file', summary: '📄 AGENTS.md', status: 'running', output: [], expanded: false },
  });
  repaintTree(t3.renderer, tree3, s3, { withInput: true });
  await t3.renderOnce();
  const frame3 = t3.captureCharFrame();
  console.log('=== 场景 3：增量重绘 ===');
  console.log(frame3);
  if (!frame3.includes('📄 AGENTS.md') || !frame3.includes('⏳ 执行中') || frame3.includes('读取文件')) {
    console.error('✗ 场景 3 未显示新增工具卡片或仍显示旧标题（repaintTree 未生效）');
    process.exit(1);
  }
  console.log('✓ 场景 3 通过：状态变更后 repaintTree 正确更新渲染树（新增无标题卡片开框渲染）');

  // 场景 4：TuiOutput 事件流 + flush() —— 验证最终状态在退出前上屏
  // （30ms 节流窗口内的最后一帧若不 flush 会丢失，这是 exit 前的关键修复）
  const s4 = createTuiState();
  const t4 = await createTestRenderer({ width: 64, height: 20 });
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
  out.onStreamStart();
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
  // 收起态：命令 + 执行缩略（✓ 执行成功 · 14 字符）+ 结果缩略（输出首行 退出码: 0）；无标题、无点击展开
  const checks4 = ['你是谁？', '任务完成 ✅', 'mock', '正在分析任务', '$ echo mock-ok', '执行成功 · 14 字符', '退出码: 0'];
  const missing4 = checks4.filter((c) => !frame4.includes(c));
  if (missing4.length) {
    console.error(`✗ 场景 4 缺少: ${missing4.join(', ')}（flush 或卡片未生效）`);
    process.exit(1);
  }
  for (const old of ['执行命令', '点击展开']) {
    if (frame4.includes(old)) {
      console.error(`✗ 场景 4 仍显示旧卡片文案: ${old}`);
      process.exit(1);
    }
  }
  // 收起态：结果缩略只取输出首行，第二行输出（echo 输出内容）不得泄漏
  if (frame4.includes('echo 输出内容')) {
    console.error('✗ 场景 4 收起态卡片泄漏了输出第二行');
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
  const checks4b = ['退出码: 0', 'echo 输出内容', '点击收起'];
  const missing4b = checks4b.filter((c) => !frame4b.includes(c));
  if (missing4b.length) {
    console.error(`✗ 场景 4b 展开后缺少输出: ${missing4b.join(', ')}`);
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
  const r7 = await render(s7);
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
  const r8 = await render(s8);
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
  // 与 repaintTree 相同逻辑重建 cardRects（无边框布局：内容行 i → 0-based 鼠标事件坐标 y = i）
  const rects11 = new Map<number, CardRect>();
  rows11.forEach((r, i) => {
    if (r.cardId !== undefined) {
      const y2 = i;
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
  const y11 = cardIdx11; // 卡片首行的 0-based 鼠标事件坐标（无边框布局 y = i）
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
  // b) toolCardLines 防御路径：即使摘要带 \n，每行仍保持完整边框（无内嵌换行）
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
  if (!cardLines[0].text.startsWith('╭') || !cardLines[cardLines.length - 1].text.startsWith('╰')) {
    console.error(`✗ 场景 12 卡片边框异常: ${cardLines.map((l) => l.text).join('|')}`);
    process.exit(1);
  }
  if (!cardLines.some((l) => l.text.includes('第一段')) || !cardLines.some((l) => l.text.includes('第二段'))) {
    console.error(`✗ 场景 12 摘要内容丢失: ${cardLines.map((l) => l.text).join('|')}`);
    process.exit(1);
  }
  // 收起态结构：top → cmd → exec（执行成功）→ result（无输出）→ bottom
  const roles12 = cardLines.map((l) => l.role);
  const expectRoles12 = ['top', 'cmd', 'cmd', 'exec', 'result', 'bottom'];
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
  console.log('=== 场景 12：多行命令摘要卡片（换行折叠 + 边框完整）===');
  console.log(r12.frame);
  if (!r12.frame.includes('退出码: 0') || !r12.frame.includes('sunny') || !r12.frame.includes('点击收起')) {
    console.error('✗ 场景 12 展开态输出缺失');
    process.exit(1);
  }
  console.log('✓ 场景 12 通过：多行命令折叠为单行摘要 + 卡片边框完整不乱码');

  // 场景 13：footer 信息行（模型 / 路径 / token 用量）——输入框下方灰色整块的两行
  const s13 = createTuiState();
  s13.version = '0.1.0';
  s13.model = 'grok-4.5';
  s13.cwd = '/Users/alice/very/long/path/to/projects/omni-agent';
  s13.tokens = { prompt: 1234, completion: 567, total: 1801 };
  pushLine(s13, { kind: 'user', text: '你好' });
  s13.status = '任务完成';
  const r13 = await render(s13);
  console.log('=== 场景 13：footer（模型/路径/token 用量）===');
  console.log(r13.frame);
  const checks13 = ['模型 grok-4.5', '⚡ 1.8k tok'];
  const missing13 = checks13.filter((c) => !r13.frame.includes(c));
  if (missing13.length) {
    console.error(`✗ 场景 13 footer 缺少: ${missing13.join(', ')}`);
    process.exit(1);
  }
  // 路径超长时中段省略：开头与结尾都保留
  if (!r13.frame.includes('/Users/alice') || !r13.frame.includes('omni-agent') || !r13.frame.includes('…')) {
    console.error('✗ 场景 13 路径未中段省略（应保留首尾 + …）');
    process.exit(1);
  }
  // token 用量累计：TuiOutput.onUsage 累加进 state
  const s13b = createTuiState();
  const t13b = await createTestRenderer({ width: 64, height: 20 });
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
  out13.onUsage({ prompt: 1000, completion: 200, total: 1200 });
  out13.onUsage({ prompt: 300, completion: 150, total: 450 });
  await out13.flush();
  const frame13 = t13b.captureCharFrame();
  if (!frame13.includes('⚡ 1.6k tok')) {
    console.error(`✗ 场景 13 onUsage 未累计（期望 ⚡ 1.6k tok）: ${JSON.stringify(s13b.tokens)}`);
    process.exit(1);
  }
  console.log('✓ 场景 13 通过：footer 模型/路径（中段省略）/token 用量（onUsage 累计）渲染正确');

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
  if (!tree16.input || JSON.stringify(bgInts(tree16.input.backgroundColor)) !== JSON.stringify([228, 228, 231])) {
    console.error('✗ 场景 16 亮色主题输入框底色未与灰色块一致');
    process.exit(1);
  }
  if (!tree16.blueBar || JSON.stringify(bgInts(tree16.blueBar.bg)) !== JSON.stringify([228, 228, 231])) {
    console.error('✗ 场景 16 亮色主题蓝色细线底色错误');
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

  // 场景 15：蓝色细线贴灰色块左缘、竖跨整块（含上下边距，与灰块等高），随输入框增高同步拉长
  const s15 = createTuiState();
  s15.version = '0.1.0';
  s15.model = 'mock';
  pushLine(s15, { kind: 'user', text: '你好' });
  const t15 = await createTestRenderer({ width: 64, height: 20 });
  const tree15 = mountTree(t15.renderer, s15, { withInput: true });
  await t15.renderOnce();
  if (!tree15.blueBar) {
    console.error('✗ 场景 15 蓝色细线未创建');
    process.exit(1);
  }
  // content getter 可能返回 StyledText（内部按 chunk 存储），统一取纯文本
  const barText15 = (): string => {
    const c = tree15.blueBar?.content as unknown;
    if (typeof c === 'string') return c;
    const chunks = (c as { chunks?: { text: string }[] })?.chunks;
    return (chunks ?? []).map((ch) => ch.text).join('');
  };
  // 初始 inputLines=1 → 细线 5 行（竖跨整个灰色块：上下 paddingY 2 + 输入 1 + 间距 1 + 模型 1）
  if (barText15() !== '▍\n▍\n▍\n▍\n▍') {
    console.error(`✗ 场景 15 初始细线行数错误: ${JSON.stringify(barText15())}（应 5 行，与灰色块等高）`);
    process.exit(1);
  }
  // 输入框增高到 3 行 → repaintTree 同步 → 细线 7 行（2 + 3 + 1 + 1）
  tree15.input?.setText('第一行\n第二行\n第三行');
  repaintTree(t15.renderer, tree15, s15, { withInput: true });
  await t15.renderOnce();
  if (barText15() !== '▍\n▍\n▍\n▍\n▍\n▍\n▍') {
    console.error(`✗ 场景 15 增高后细线行数错误: ${JSON.stringify(barText15())}（应 7 行）`);
    process.exit(1);
  }
  const frame15 = t15.captureCharFrame();
  if (!frame15.includes('第一行') || !frame15.includes('第三行') || !frame15.includes('模型 mock')) {
    console.error('✗ 场景 15 输入增高后渲染缺失');
    process.exit(1);
  }
  console.log('✓ 场景 15 通过：蓝色细线竖跨输入行+间距+模型行（inputLines 增高同步拉长）');

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
  console.log('=== 场景 17：/theme 命令面板（alert 浮层）===');
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
  console.log('✓ 场景 17 通过：/theme 面板（打开/↑↓/数字/Enter/Esc）+ 渲染 + system 跟随亮暗');

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
  const r18 = await render(s18);
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
  const thinkIdx18 = rows18b.findIndex((r) => r.text.includes('思考中'));
  if (userIdx18 < 0 || thinkIdx18 < 0 || thinkIdx18 - userIdx18 !== 2) {
    console.error(`✗ 场景 18 用户消息与思考之间缺空行（thinkIdx=${thinkIdx18} userIdx=${userIdx18}，应差 2）`);
    process.exit(1);
  }
  if (rows18b[userIdx18 + 1].text !== '' || rows18b[userIdx18 + 1].chunks) {
    console.error('✗ 场景 18 用户消息后的间距行不是空白行');
    process.exit(1);
  }
  console.log('✓ 场景 18 通过：表格 box-drawing 渲染 + 删除线 + 任务清单 + 用户消息↔思考间距');

  // 场景 19：/ 命令联想列表 —— 输入 / 显示列表（非模态），前缀过滤 / 无匹配隐藏 + 面板渲染
  const s19 = createTuiState();
  s19.version = '0.1.0';
  s19.model = 'mock';
  pushLine(s19, { kind: 'user', text: '你好' });
  s19.status = '任务完成';
  const t19 = await createTestRenderer({ width: 64, height: 20 });
  const tree19 = mountTree(t19.renderer, s19, { withInput: true });
  await t19.renderOnce();
  // a) 输入 '/' → 联想列出全部命令
  tree19.input?.setText('/');
  repaintTree(t19.renderer, tree19, s19, { withInput: true });
  await t19.renderOnce();
  if (!s19.cmdSuggest || s19.cmdSuggest.items.length !== 5) {
    console.error(`✗ 场景 19 输入 / 未列出全部命令: ${JSON.stringify(s19.cmdSuggest)}`);
    process.exit(1);
  }
  // b) 前缀过滤：'/the' → 只剩 theme（/th 会同时命中 theme 与 thinking）
  tree19.input?.setText('/the');
  repaintTree(t19.renderer, tree19, s19, { withInput: true });
  await t19.renderOnce();
  if (!s19.cmdSuggest || s19.cmdSuggest.items.length !== 1 || s19.cmdSuggest.items[0] !== 'theme') {
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
  tree19.input?.setText('/the');
  repaintTree(t19.renderer, tree19, s19, { withInput: true });
  await t19.renderOnce();
  if (!s19.cmdSuggest || s19.cmdSuggest.items.length !== 1) {
    console.error('✗ 场景 19 Esc 回归前置条件失败（/the 应列出 theme）');
    process.exit(1);
  }
  s19.cmdSuggestDismissedText = '/the'; // 模拟 interactive.ts 的 Esc 分支
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
  if (!s19.cmdSuggest || s19.cmdSuggest.items[0] !== 'theme') {
    console.error('✗ 场景 19 文本变化后联想未恢复');
    process.exit(1);
  }
  // Tab 填入的尾空格（`/theme `）→ 联想自动隐藏（commandSuggestions 不 trim）
  tree19.input?.setText('/theme ');
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
  const checks19 = ['/theme', '切换主题', '/thinking', '展开 / 折叠全部思考过程', '/exit', '/clear', '/help'];
  const missing19 = checks19.filter((c) => !frame19.includes(c));
  if (missing19.length) {
    console.error(`✗ 场景 19 联想列表渲染缺: ${missing19.join(', ')}`);
    process.exit(1);
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
  //     （0-based 屏幕行：灰色块顶 = 20 - 2 - (inputLines+4) = 13，浮层底应在其上方）
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
  const footerTop19 = 20 - 2 - (s19.inputLines + 4); // 灰色块顶部（0-based）
  if (tree19.suggestRect.bottom >= footerTop19) {
    console.error(`✗ 场景 19 联想浮层未浮在输入框上方: ${JSON.stringify(tree19.suggestRect)}（灰色块顶=${footerTop19}）`);
    process.exit(1);
  }
  // f) 独立浮层：联想打开时内容区预算不变（不占内容流、对话不因联想出现而跳动）
  const s19b = createTuiState();
  fill(s19b, 20);
  const rowsNone19 = computeRows(s19b, { height: 20, width: 64 }, { withInput: true });
  s19b.cmdSuggest = { query: '', items: ['theme', 'exit', 'clear', 'help'], selected: 0 };
  const rowsSug19 = computeRows(s19b, { height: 20, width: 64 }, { withInput: true });
  if (rowsNone19.length !== rowsSug19.length) {
    console.error(`✗ 场景 19 联想浮层不应挤动内容区（${rowsNone19.length} → ${rowsSug19.length}，应相同）`);
    process.exit(1);
  }
  console.log('✓ 场景 19 通过：/ 联想列表（全部列出/前缀过滤/无匹配隐藏/独立浮层渲染/不挤动内容区）');

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
  // c) 真实渲染：帧内无标题行 + footer 路径行保留 + 内容/输入框正常
  s20.cwd = '/Users/alice/work/omni';
  const r20 = await render(s20);
  console.log('=== 场景 20：会话标题（终端窗口标题，不显示在信息流）===');
  console.log(r20.frame);
  if (r20.frame.includes('— 测试会话标题 —') || r20.frame.includes('测试会话标题')) {
    console.error('✗ 场景 20 渲染帧不应包含会话标题（已改为窗口标题）');
    process.exit(1);
  }
  if (!r20.frame.includes('/Users/alice/work/omni')) {
    console.error('✗ 场景 20 footer 路径行缺失（应保留）');
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

  // 场景 21：/thinking 命令 —— 全局展开/折叠全部思考过程
  console.log('=== 场景 21：/thinking 折叠/展开思考 ===');
  const s21 = createTuiState();
  s21.version = '0.1.0';
  s21.model = 'mock';
  pushLine(s21, { kind: 'user', text: '你好' });
  pushLine(s21, { kind: 'thinking', text: '第一段思考内容\n第二行细节\n第三行结论' });
  pushLine(s21, { kind: 'thinking', text: '第二轮思考' });
  pushLine(s21, { kind: 'answer', text: '最终回答' });
  s21.status = '任务完成';
  // a) 默认展开：两个思考段落的全文都可见（当前行为不变）
  const rows21 = computeRows(s21, { height: 20, width: 64 }, { withInput: true });
  const thinkFull21 = rows21.filter((r) => r.text.includes('第一段思考内容') || r.text.includes('第二轮思考'));
  if (thinkFull21.length !== 2) {
    console.error(`✗ 场景 21 默认未展开思考全文: ${JSON.stringify(thinkFull21)}`);
    process.exit(1);
  }
  // b) 折叠：每个思考段落压成一行 `+ thinking`（+ 表示可展开；无行数/点击展开提示），全文隐藏
  s21.thinkingExpanded = false;
  const rows21b = computeRows(s21, { height: 20, width: 64 }, { withInput: true });
  if (rows21b.some((r) => r.text.includes('第一段思考内容') || r.text.includes('第二轮思考'))) {
    console.error('✗ 场景 21 折叠后思考全文仍可见');
    process.exit(1);
  }
  const collapsed21 = rows21b.filter((r) => r.text.trim() === '+ thinking');
  if (collapsed21.length !== 2) {
    console.error(`✗ 场景 21 折叠摘要行数错误（应有 2 段 + thinking）: ${JSON.stringify(collapsed21)}`);
    process.exit(1);
  }
  if (rows21b.some((r) => r.text.includes('💭') || r.text.includes('共 ') || r.text.includes('点击展开') || r.text.includes('几行'))) {
    console.error('✗ 场景 21 折叠摘要仍含云彩/行数/点击展开提示');
    process.exit(1);
  }
  // 回答不受折叠影响
  if (!rows21b.some((r) => r.text.includes('最终回答'))) {
    console.error('✗ 场景 21 折叠思考后回答丢失');
    process.exit(1);
  }
  // c) 真实渲染：折叠帧内无思考全文、有 + thinking 摘要与回答
  const r21 = await render(s21);
  console.log(r21.frame);
  if (r21.frame.includes('第一段思考内容') || r21.frame.includes('第二轮思考')) {
    console.error('✗ 场景 21 渲染帧折叠后仍含思考全文');
    process.exit(1);
  }
  if (!r21.frame.includes('+ thinking') || !r21.frame.includes('最终回答')) {
    console.error('✗ 场景 21 渲染帧缺折叠摘要(+ thinking)/回答');
    process.exit(1);
  }
  // d) 命令分发：/thinking 切换开关 + 推 meta 提示；再执行一次恢复展开
  const { findCommand, runCommand } = await import('../src/tui/commands.js');
  if (!findCommand('thinking')) {
    console.error('✗ 场景 21 /thinking 命令未注册');
    process.exit(1);
  }
  const s21c = createTuiState();
  s21c.thinkingExpanded = true;
  const fakeCtx21 = {
    state: s21c,
    out: {},
    session: {},
    input: {},
    messages: [],
  };
  await runCommand(fakeCtx21 as never, '/thinking');
  if (s21c.thinkingExpanded !== false) {
    console.error('✗ 场景 21 /thinking 未折叠');
    process.exit(1);
  }
  if (s21c.lines.some((l) => l.text.includes('已折叠') || l.text.includes('已展开'))) {
    console.error('✗ 场景 21 /thinking 不应推折叠/展开提示');
    process.exit(1);
  }
  await runCommand(fakeCtx21 as never, '/thinking');
  if (s21c.thinkingExpanded !== true) {
    console.error('✗ 场景 21 /thinking 未再次展开');
    process.exit(1);
  }
  // e) 折叠态下**单独展开某条思考**（点击摘要切换）：expandedThinking 集合驱动
  //    构造 thinkingRects（与 repaintTree 相同逻辑：可见行 i → 思考行下标）
  const { hitTestThinking } = await import('../src/tui/render.js');
  const buildRects21 = (rowsArr: Row[]): Map<number, number> => {
    const m = new Map<number, number>();
    rowsArr.forEach((r, i) => {
      if (r.thinkingIdx !== undefined) m.set(i, r.thinkingIdx);
    });
    return m;
  };
  s21.thinkingExpanded = false;
  s21.expandedThinking.clear();
  // 折叠态默认：li=1、li=2 两条思考都是摘要，且摘要行带 thinkingIdx
  const rows21e = computeRows(s21, { height: 20, width: 64 }, { withInput: true });
  const rects21e = buildRects21(rows21e);
  if (rects21e.size !== 2 || rows21e.some((r) => r.text.includes('第二轮思考'))) {
    console.error(`✗ 场景 21 折叠态摘要行未带 thinkingIdx: ${JSON.stringify([...rects21e])}`);
    process.exit(1);
  }
  // 点击第 1 条摘要（thinkingIdx=1）→ 只展开该条：全文可见、第 2 条仍折叠
  const sum1Row21 = rows21e.findIndex((r) => r.thinkingIdx === 1);
  if (sum1Row21 < 0 || !hitTestThinking(s21, rects21e, sum1Row21) || !s21.expandedThinking.has(1)) {
    console.error(`✗ 场景 21 点击折叠摘要未单独展开（sum1Row=${sum1Row21}）`);
    process.exit(1);
  }
  const rows21f = computeRows(s21, { height: 20, width: 64 }, { withInput: true });
  if (!rows21f.some((r) => r.text.includes('第一段思考内容')) || rows21f.some((r) => r.text.includes('第二轮思考'))) {
    console.error('✗ 场景 21 单独展开后内容错误（应只展开第 1 条）');
    process.exit(1);
  }
  // 展开态：第 1 条带 `- thinking` 头行（- 表示可收起），其余仍 + thinking 摘要
  if (!rows21f.some((r) => r.text.trim() === '- thinking')) {
    console.error('✗ 场景 21 展开态缺 - thinking 头行');
    process.exit(1);
  }
  const collapsed21f = rows21f.filter((r) => r.text.trim() === '+ thinking');
  if (collapsed21f.length !== 1) {
    console.error(`✗ 场景 21 单独展开后应只剩 1 条 + thinking 摘要: ${collapsed21f.length}`);
    process.exit(1);
  }
  // 展开后的行也带 thinkingIdx：再点击该行 → 收起（回到摘要）
  const rects21f = buildRects21(rows21f);
  const expRow21 = rows21f.findIndex((r) => r.text.includes('第一段思考内容'));
  if (expRow21 < 0 || rects21f.get(expRow21) !== 1) {
    console.error(`✗ 场景 21 展开行未带 thinkingIdx: ${JSON.stringify([...rects21f])}`);
    process.exit(1);
  }
  if (!hitTestThinking(s21, rects21f, expRow21) || s21.expandedThinking.has(1)) {
    console.error('✗ 场景 21 点击展开行未收起');
    process.exit(1);
  }
  const rows21g = computeRows(s21, { height: 20, width: 64 }, { withInput: true });
  if (rows21g.some((r) => r.text.includes('第一段思考内容')) || rows21g.filter((r) => r.text.trim() === '+ thinking').length !== 2 || rows21g.some((r) => r.text.trim() === '- thinking')) {
    console.error('✗ 场景 21 收起后未恢复两条 + thinking 摘要');
    process.exit(1);
  }
  // 空白行点击不命中（不消费、不误展开）：重建 rects 后点用户行（y=0）
  const rects21g = buildRects21(rows21g);
  if (hitTestThinking(s21, rects21g, 0)) {
    console.error('✗ 场景 21 空白区域误命中思考行');
    process.exit(1);
  }
  // /thinking 命令切换时清空单独展开标记（fakeCtx21 的 state = s21c）
  s21c.expandedThinking.add(1);
  await runCommand(fakeCtx21 as never, '/thinking');
  if (s21c.thinkingExpanded !== false || s21c.expandedThinking.size !== 0) {
    console.error('✗ 场景 21 /thinking 未清空单独展开标记');
    process.exit(1);
  }
  // 再折叠后展开：全文恢复可见
  s21.thinkingExpanded = true;
  const rows21d = computeRows(s21, { height: 20, width: 64 }, { withInput: true });
  if (!rows21d.some((r) => r.text.includes('第一段思考内容')) || rows21d.some((r) => r.text.trim() === '+ thinking')) {
    console.error('✗ 场景 21 重新展开后思考全文未恢复');
    process.exit(1);
  }
  console.log('✓ 场景 21 通过：/thinking 全局展开/折叠 + 折叠态点击单独展开/收起（+ thinking / - thinking 头行，无行数/提示文案）');

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
  console.log('=== 场景 23：权限分级 ===');
  // full：危险命令硬拦截，普通命令放行
  const g23a = gateTool('full', 'run_command', { command: 'git push origin main' });
  if (!('allow' in g23a) || g23a.allow !== false) {
    console.error('✗ 场景 23 full 级未硬拦截 git push');
    process.exit(1);
  }
  if (gateTool('full', 'run_command', { command: 'echo hi' }).allow !== true) {
    console.error('✗ 场景 23 full 级普通命令被误拦');
    process.exit(1);
  }
  // safe：危险命令转审批（不再硬拦），普通命令放行
  const g23b = gateTool('safe', 'run_command', { command: 'rm -rf /tmp/x' });
  if (!('needApproval' in g23b)) {
    console.error('✗ 场景 23 safe 级危险命令未转审批');
    process.exit(1);
  }
  if (gateTool('safe', 'run_command', { command: 'ls' }).allow !== true) {
    console.error('✗ 场景 23 safe 级普通命令被误拦');
    process.exit(1);
  }
  // ask：所有工具调用都需要审批
  if (!('needApproval' in gateTool('ask', 'read_file', { path: 'a.ts' }))) {
    console.error('✗ 场景 23 ask 级读工具未转审批');
    process.exit(1);
  }
  // read：写/执行直接拒绝（连询问都不给），读放行
  if (gateTool('read', 'run_command', { command: 'ls' }).allow !== false) {
    console.error('✗ 场景 23 read 级未拒绝 run_command');
    process.exit(1);
  }
  if (gateTool('read', 'write_file', { path: 'a.ts' }).allow !== false) {
    console.error('✗ 场景 23 read 级未拒绝 write_file');
    process.exit(1);
  }
  if (gateTool('read', 'read_file', { path: 'a.ts' }).allow !== true) {
    console.error('✗ 场景 23 read 级误拦 read_file');
    process.exit(1);
  }
  console.log('✓ 场景 23 通过：权限分级（full 硬拦 / safe 危险转审批 / ask 全询问 / read 只读）');

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

  console.log('\n✓✓ TUI 快照断言全部通过');
  process.exit(0);
}

main().catch((e) => {
  console.error('ERR:', e);
  process.exit(1);
});
