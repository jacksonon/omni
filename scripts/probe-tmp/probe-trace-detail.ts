/**
 * probe-trace-detail：复现「trace 点击展开详情不好使」——
 * 窗口满（total > contentRows）时选中带 detail 的行，detail 行超 maxRows 预算被
 * panelRows 截断（tracePanelLines 的窗口行数固定 contentRows，detail 行额外追加）。
 */
import { createTestRenderer } from '@opentui/core/testing';
import { mountTree } from '../../src/tui/render.js';
import { createTuiState } from '../../src/tui/state.js';
import { refreshTrace } from '../../src/tui/trace.js';
import type { TrajEvent } from '../../src/agent/events.js';

async function main(): Promise<void> {
  // 10 行事件：最后一行 turn/end error 带 detail；视口 20 → footerTop 12 → maxRows 7 → contentRows 5
  const evs: TrajEvent[] = [
    { s: 1, time: 1000, k: 'turn/start', turn: 1 },
    { s: 2, time: 1100, k: 'user/message', text: '问题一', source: 'user' },
    { s: 3, time: 1200, k: 'request/header', step: 1, model: 'mock', tools: ['list_directory'], messages: 2 },
    { s: 4, time: 1250, k: 'tool/call', step: 1, callId: 'c1', name: 'list_directory', args: '{"path":"."}' },
    { s: 5, time: 2000, k: 'tool/result', callId: 'c1', ok: true, chars: 320 },
    { s: 6, time: 2100, k: 'assistant/message', step: 2, text: '回答一', usage: { input: 500, cached: 100, output: 60 }, llmMs: 1500, firstTokenMs: 200 },
    { s: 7, time: 2200, k: 'turn/end', turn: 1, reason: 'completed' },
    { s: 8, time: 3000, k: 'turn/start', turn: 2 },
    { s: 9, time: 3100, k: 'user/message', text: '问题二', source: 'user' },
    { s: 10, time: 3200, k: 'turn/end', turn: 2, reason: 'error', detail: 'API 401 Invalid token' },
  ];
  const s = createTuiState();
  refreshTrace(s, evs); // 10 行
  s.traceOpen = true;
  s.traceSelected = 5; // 选中「轮 2 ✗」行（下标 5，唯一带 detail 的行；窗口 [2,7) 内）
  const t = await createTestRenderer({ width: 64, height: 20 });
  const tree = mountTree(t.renderer, s, { withInput: true });
  const { repaintTree } = await import('../../src/tui/render.js');
  await repaintTree(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  console.log('traceRect', JSON.stringify(tree.traceRect), 'rowMap', JSON.stringify(tree.traceRowMap));
  console.log(frame);
  const hasDetail = frame.includes('API 401');
  console.log(hasDetail ? '✓ detail 可见' : '✗ detail 被截断（点击展开详情不好使）');
  // 用 errno 语义退出：失败 exitCode 1
  process.exit(hasDetail ? 0 : 1);
}
void main();