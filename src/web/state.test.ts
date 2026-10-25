import test from 'node:test';
import assert from 'node:assert/strict';
import { activeSnapshot, approvals, asks, cancelPending, currentEventSeq, emitEvent, eventsSince, pendingRegistry, pendingSnapshot } from './state.js';
import { withCurrentOutput, routingOutput } from './routing-output.js';
import { WebOutput } from './output.js';

test('event cursors report replay gaps and retain current streaming snapshot', () => {
  const before = currentEventSeq();
  emitEvent('user.message', { sessionId: 'snapshot-test', text: 'hello' });
  emitEvent('thinking.chunk', { sessionId: 'snapshot-test', text: 'working' });
  assert.equal(activeSnapshot().find((s) => s.sessionId === 'snapshot-test')?.thinking, 'working');
  assert.equal(eventsSince(before).events.length, 2);
  for (let i = 0; i < 1001; i++) emitEvent('meta.add', { sessionId: 'snapshot-test', text: String(i) });
  assert.equal(eventsSince(before).reset, true);
  assert.equal(eventsSince(currentEventSeq() + 100).reset, true);
  emitEvent('run.end', { sessionId: 'snapshot-test', reason: 'completed' });
  assert.equal(activeSnapshot().some((s) => s.sessionId === 'snapshot-test'), false);
});

test('pending snapshot is serializable and cancellation releases only its session', async () => {
  const request = { tool: 'run_command', summary: 'example', reason: 'test' };
  const a = pendingRegistry.addApproval('cancel-me', request);
  const b = pendingRegistry.addAsk('cancel-me', 'Question?', ['yes'], false);
  const other = pendingRegistry.addApproval('keep-me', request);
  const snap = JSON.parse(JSON.stringify(pendingSnapshot()));
  assert.equal(snap.approvals[0].summary, 'example');
  assert.equal(snap.asks[0].question, 'Question?');
  cancelPending('cancel-me');
  assert.equal(await a, false);
  assert.equal(await b, null);
  assert.equal(asks.size, 0);
  assert.equal(approvals.size, 1);
  cancelPending('keep-me');
  assert.equal(await other, false);
});

test('concurrent async tool callbacks keep their own approval session', async () => {
  const seen: string[] = [];
  const pending = {
    addApproval: async (sessionId: string) => { seen.push(sessionId); return true; },
    addAsk: async () => null,
  };
  const first = new WebOutput('first', () => {}, pending);
  const second = new WebOutput('second', () => {}, pending);
  let release!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  const req = { tool: 'run_command', summary: '', reason: '' };
  const a = withCurrentOutput(first, async () => { await wait; return routingOutput.requestApproval(req); });
  const b = withCurrentOutput(second, async () => { release(); return routingOutput.requestApproval(req); });
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.deepEqual(seen.sort(), ['first', 'second']);
});
