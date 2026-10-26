import test from 'node:test';
import assert from 'node:assert/strict';
import { PetState, selectPetTask } from './state.js';

test('并行工具和两项交互各自配对；完成水位避免清除后来的未读', () => {
  const s = new PetState(), id = 'one';
  const emit = (type: string, data = {}) => s.apply(type, { sessionId: id, ...data });
  emit('turn.step'); // 不依赖思考正文开关
  assert.equal(s.snapshot()[0]!.phase, 'thinking');
  emit('tool.start', { seq: 1 }); emit('tool.start', { seq: 2 });
  emit('approval.request', { approvalId: 'a' }); emit('ask.request', { askId: 'b' });
  emit('approval.resolved', { approvalId: 'a' });
  assert.equal(s.snapshot()[0]!.phase, 'needs-input');
  emit('ask.resolved', { askId: 'b' }); emit('tool.result', { seq: 2, ok: false });
  assert.equal(s.snapshot()[0]!.phase, 'working');
  emit('tool.result', { seq: 1 }); emit('answer.chunk', { text: 'private answer' });
  emit('run.end', { reason: 'completed' });
  const prior = s.snapshot()[0]!;
  emit('user.message', { text: 'next' }); emit('run.end', { reason: 'error' });
  assert.equal(s.read(id, prior.revision), false);
  assert.equal(s.snapshot()[0]!.unread, true);
  assert.equal(s.read(id, s.snapshot()[0]!.revision), true);
  assert.equal(JSON.stringify(s.snapshot()).includes('private answer'), false);
});
test('跨会话优先级、取消、删除和状态更新去重', () => {
  const s = new PetState();
  s.apply('turn.step', { sessionId: 'run' }, 1);
  assert.equal(s.apply('answer.chunk', { sessionId: 'run' }, 2), true);
  assert.equal(s.apply('answer.chunk', { sessionId: 'run', text: 'more' }, 3), false);
  s.apply('run.end', { sessionId: 'done', reason: 'completed' }, 4);
  s.apply('ask.request', { sessionId: 'ask', askId: 'question' }, 5);
  assert.equal(selectPetTask(s.snapshot())?.sessionId, 'ask');
  s.apply('run.end', { sessionId: 'ask', reason: 'aborted' }, 6);
  assert.equal(selectPetTask(s.snapshot())?.sessionId, 'done');
  s.apply('session.deleted', { sessionId: 'done' });
  assert.equal(selectPetTask(s.snapshot(), 'run')?.phase, 'answering');
});
