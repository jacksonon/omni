import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestLedger } from './requests.js';

test('message retries during and after execution share one action', async () => {
  const ledger = new RequestLedger<number>();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const action = async () => { calls++; await gate; return 202; };
  const a = ledger.run('session:request', { text: 'hello' }, action);
  const b = ledger.run('session:request', { text: 'hello' }, action);
  release();
  assert.deepEqual(await Promise.all([a, b]), [202, 202]);
  assert.equal(await ledger.run('session:request', { text: 'hello' }, action), 202);
  assert.equal(calls, 1);
  await assert.rejects(ledger.run('session:request', { text: 'different' }, action), /requestId/);
});

test('failed actions can be retried and pending entries survive capacity pressure', async () => {
  const ledger = new RequestLedger<number>(1);
  await assert.rejects(ledger.run('bad', {}, async () => { throw new Error('offline'); }), /offline/);
  assert.equal(await ledger.run('bad', {}, async () => 1), 1);
  let release!: () => void;
  const pending = ledger.run('pending', {}, () => new Promise<number>((r) => { release = () => r(2); }));
  await Promise.resolve();
  await assert.rejects(ledger.run('other', {}, async () => 3), /请求过多/);
  release();
  assert.equal(await pending, 2);
});
