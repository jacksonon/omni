import test from 'node:test';
import assert from 'node:assert/strict';
import { PresenceStore } from './presence.js';
test('独立任务租约过期、旧水位与重复心跳不会覆盖已读', () => {
  const s = new PresenceStore(), sessionId = 'local-12345678-1234-1234-1234-123456789abc';
  const t = { sessionId, pid: 1, phase: 'working', revision: 1, running: true, title: 'local' };
  s.update(t, 0); assert.equal(s.snapshot(14_999).length, 1); assert.equal(s.snapshot(15_001).length, 0);
  s.update({ ...t, running: false, phase: 'ready', unread: true, revision: 2 }, 20_000);
  s.read(sessionId, 1); assert.equal(s.snapshot(20_001)[0]!.unread, true);
  s.read(sessionId, 2); s.update({ ...t, running: false, phase: 'ready', unread: true, revision: 2 }, 20_002);
  assert.equal(s.snapshot(20_003)[0]!.unread, false);
  s.update(t, 20_004); assert.equal(s.snapshot(20_005)[0]!.phase, 'ready');
  assert.throws(() => s.update({ ...t, sessionId: '../elsewhere' }), /无效/);
});
