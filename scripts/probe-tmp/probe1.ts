import { createTestRenderer } from '@opentui/core/testing';
import { mountTree, repaintTree } from '../../src/tui/render.js';
import { createTuiState, pushLine } from '../../src/tui/state.js';

async function frame(state: ReturnType<typeof createTuiState>, height: number, width: number, label: string): Promise<void> {
  const t = await createTestRenderer({ width, height });
  const tree = mountTree(t.renderer, state, { withInput: true });
  await t.renderOnce();
  console.log(`\n===== ${label} (${width}x${height}) =====`);
  console.log(t.captureCharFrame());
}

async function main(): Promise<void> {
  // 1. 思考中（status bar spinner 思考中 + thinking 内容流式）
  const s1 = createTuiState();
  s1.version = '0.1.0';
  s1.model = 'mock';
  pushLine(s1, { kind: 'user', text: '你好' });
  pushLine(s1, { kind: 'thinking', text: '用户想让我看看项目结构\n先观察再动手，列一下目录' });
  s1.status = '⠋ 思考中';
  s1.spinnerIndex = 0;
  await frame(s1, 20, 64, '思考中（status=⠋ 思考中）');

  // 2. 工具执行中（running 卡片 + status 执行中…）
  const s2 = createTuiState();
  s2.version = '0.1.0';
  s2.model = 'mock';
  pushLine(s2, { kind: 'user', text: '你好' });
  pushLine(s2, { kind: 'thinking', text: '先看一下目录结构' });
  pushLine(s2, {
    kind: 'tool',
    text: '* List .',
    card: { id: 1, name: 'list_directory', summary: '* List .', status: 'running', output: [], expanded: false },
  });
  s2.status = '⠋ 执行中…';
  s2.spinnerIndex = 0;
  await frame(s2, 20, 64, '工具执行中（status=⠋ 执行中…）');

  // 3. 回答流式（generating，光标）
  const s3 = createTuiState();
  s3.version = '0.1.0';
  s3.model = 'mock';
  pushLine(s3, { kind: 'user', text: '你好' });
  pushLine(s3, { kind: 'thinking', text: '想一下怎么回答' });
  pushLine(s3, { kind: 'answer', text: '当前目录共 3 个文件。' });
  s3.generating = true;
  s3.status = '';
  await frame(s3, 20, 64, '回答流式');
}

void main();