/**
 * TUI 快照验证（无 TTY 可用）：用 @opentui/core/testing 的 createTestRenderer 内存渲染。
 *
 * 与真实 CLI 共用 src/tui/render.ts 的 mountTree/repaintTree（同一渲染路径），
 * 断言：头部/思考/工具步骤/回答/用户消息/输入框/状态栏渲染 + 溢出自动跟随最新 + 增量重绘生效。
 *
 * 运行：npm run tui:snapshot（或 bun run ./scripts/tui-snapshot.ts）
 */
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import { CODE_FG, INLINE_CODE_FG, markdownToRows } from '../src/tui/markdown.js';
import { computeRows, mountTree, repaintTree } from '../src/tui/render.js';
import { createTuiState, pushLine, type TuiState } from '../src/tui/state.js';

function fill(state: TuiState, fillLines: number): void {
  state.version = '0.1.0';
  state.model = 'mock';
  pushLine(state, { kind: 'user', text: '❯ 你是谁？' });
  pushLine(state, { kind: 'thinking', text: '用户想让我列出目录结构\n先观察再动手' });
  pushLine(state, { kind: 'step', text: '→ [1/20] list_directory({"path":"."})' });
  pushLine(state, { kind: 'result-ok', text: '✓ 返回 55 字符' });
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

  const checks1 = ['Omni', '你是谁？', 'list_directory', '返回 55 字符', '当前目录共 3 个文件', '任务完成', '输入消息，Enter 发送', '输入'];
  const missing1 = checks1.filter((c) => !r1.frame.includes(c));
  if (missing1.length) {
    console.error(`✗ 场景 1 缺少: ${missing1.join(', ')}`);
    process.exit(1);
  }
  console.log('✓ 场景 1 通过：头部/用户消息/思考/步骤/回答/输入框/状态栏全部渲染');

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
  pushLine(s3, { kind: 'step', text: '→ [2/20] read_file("AGENTS.md")' });
  repaintTree(t3.renderer, tree3, s3, { withInput: true });
  await t3.renderOnce();
  const frame3 = t3.captureCharFrame();
  console.log('=== 场景 3：增量重绘 ===');
  console.log(frame3);
  if (!frame3.includes('read_file')) {
    console.error('✗ 场景 3 未显示新增步骤（repaintTree 未生效）');
    process.exit(1);
  }
  console.log('✓ 场景 3 通过：状态变更后 repaintTree 正确更新渲染树');

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
  out.onRound(0, 20);
  out.onStreamStart();
  out.onAnswer('正在分析任务…');
  out.onToolStep(0, 20, 'run_command', '{"command":"echo mock-ok"}');
  out.onToolResult(true, 14);
  out.onAnswer('任务完成 ✅ 验证通过。');
  out.onAnswerEnd();
  out.onTurnEnd();
  await out.flush();
  const frame4 = t4.captureCharFrame();
  console.log('=== 场景 4：TuiOutput 事件驱动 + flush ===');
  console.log(frame4);
  const checks4 = ['你是谁？', '任务完成 ✅', 'run_command', 'mock', '正在分析任务'];
  const missing4 = checks4.filter((c) => !frame4.includes(c));
  if (missing4.length) {
    console.error(`✗ 场景 4 缺少: ${missing4.join(', ')}（flush 未生效）`);
    process.exit(1);
  }
  console.log('✓ 场景 4 通过：flush() 把节流窗口内的最终状态渲染上屏');

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
  const checks7 = ['你是谁？', 'list_directory', '已上滚'];
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
  pushLine(s8, { kind: 'user', text: '这是一条非常长的用户消息用来验证普通行的自动折行，'.repeat(5) + 'USEREND' });
  pushLine(s8, { kind: 'answer', text: '很长的单行内容，'.repeat(15) + '……ENDMARKER' });
  s8.status = '任务完成';
  const r8 = await render(s8);
  console.log('=== 场景 8：长行自动折行（内容宽度 60）===');
  console.log(r8.frame);
  const userRepeats8 = r8.frame.split('这是一条非常长的用户消息用来验证普通行的自动折行').length - 1;
  const answerRepeats8 = r8.frame.split('很长的单行内容').length - 1;
  if (userRepeats8 < 5) {
    console.error(`✗ 场景 8 普通长行被截断（只看到 ${userRepeats8}/5 段，应折行完整显示）`);
    process.exit(1);
  }
  if (answerRepeats8 < 15) {
    console.error(`✗ 场景 8 Markdown 长行被截断（只看到 ${answerRepeats8}/15 段，应折行完整显示）`);
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
  pushLine(s10, { kind: 'user', text: '❯ 多行输入测试' });
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

  console.log('\n✓✓ TUI 快照断言全部通过');
  process.exit(0);
}

main().catch((e) => {
  console.error('ERR:', e);
  process.exit(1);
});
