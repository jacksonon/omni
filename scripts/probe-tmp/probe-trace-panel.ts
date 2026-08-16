import { createTestRenderer } from '@opentui/core/testing';
import { mountTree } from '../../src/tui/render.js';
import { createTuiState } from '../../src/tui/state.js';
import { refreshTrace } from '../../src/tui/trace.js';
import type { TrajEvent } from '../../src/agent/events.js';

async function main(): Promise<void> {
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
  const s = createTuiState();
  refreshTrace(s, evs44);
  s.traceOpen = true;
  const t = await createTestRenderer({ width: 64, height: 20 });
  const tree = mountTree(t.renderer, s, { withInput: true });
  const { repaintTree: repaint } = await import('../../src/tui/render.js');
  await repaint(t.renderer, tree, s, { withInput: true });
  await t.renderOnce();
  console.log('traceRect', JSON.stringify(tree.traceRect), 'left', tree.traceLeft, 'visible', tree.traceBox?.visible, 'top', tree.traceBox?.top, 'left2', tree.traceBox?.left);
  console.log(t.captureCharFrame());
}
void main();
