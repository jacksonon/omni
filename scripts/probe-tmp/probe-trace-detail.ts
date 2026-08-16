/**
 * probe-trace-detail：详情页（页面导航）回归——tracePanelLines 列表页不内嵌详情；
 * traceDetailLines 返回行（-2）+ 标题 + 完整内容折行；点击推入详情/返回行回列表。
 */
import { createTestRenderer } from '@opentui/core/testing';
import { mountTree, repaintTree, handleTuiMouseEvent } from '../../src/tui/render.js';
import { createTuiState } from '../../src/tui/state.js';
import { refreshTrace, traceDetailLines, tracePanelLines } from '../../src/tui/trace.js';
import type { TrajEvent } from '../../src/agent/events.js';

async function main(): Promise<void> {
  let fails = 0;
  const evs: TrajEvent[] = [
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
  const s = createTuiState();
  refreshTrace(s, evs);
  // 1) 列表页不内嵌详情（API 401 只在详情页）
  const pl = tracePanelLines(s, 12, 7);
  if (pl.lines.some((l) => l.text.includes('API 401'))) {
    console.error('✗ 列表页不应内嵌详情');
    fails++;
  }
  // 2) 详情页：返回行 -2 + 标题 + 完整内容
  const dl = traceDetailLines(s, 5, 32);
  if (dl.rowMap[0] !== -2 || !dl.lines[1]!.text.includes('轮 2 ✗') || !dl.lines.some((l) => l.text.includes('API 401 Invalid token'))) {
    console.error('✗ 详情页组装错误', JSON.stringify(dl));
    fails++;
  }
  // 3) 渲染 + 点击：推入详情页 → 点返回行回列表
  s.traceOpen = true;
  const t = await createTestRenderer({ width: 64, height: 20 });
  const tree = mountTree(t.renderer, s, { withInput: true });
  await repaintTree(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  if (!frame.includes('轨迹（7 条）')) {
    console.error('✗ 列表帧缺标题');
    fails++;
  }
  const yRow = tree.traceRect!.top + 2;
  handleTuiMouseEvent({ type: 'down', button: 0, x: tree.traceLeft + 5, y: yRow }, tree, s, 64, async () => {});
  if (!s.traceDetail) {
    console.error('✗ 点击未推入详情页');
    fails++;
  }
  handleTuiMouseEvent({ type: 'down', button: 0, x: tree.traceLeft + 5, y: tree.traceRect!.top }, tree, s, 64, async () => {});
  if (s.traceDetail) {
    console.error('✗ 点击返回行未回列表');
    fails++;
  }
  console.log(fails === 0 ? '✓ probe-trace-detail 全过（详情页导航）' : `✗ ${fails} 失败`);
  process.exit(fails === 0 ? 0 : 1);
}
void main();
