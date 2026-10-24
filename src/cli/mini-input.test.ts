import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { emitKeypressEvents } from 'node:readline';
import { MiniInputBuffer, installMiniKeyNormalizer, isMiniSteerKey, miniExtendedKey, type MiniInputKey } from './mini-input.js';

test('mini：Node 拆分组合键后重组，释放事件不泄漏字符到草稿', () => {
  const input = new PassThrough();
  emitKeypressEvents(input);
  const remove = installMiniKeyNormalizer(input);
  const accepted: MiniInputKey[] = [];
  input.on('keypress', (_text, key: MiniInputKey) => {
    if (!key.miniBuffered) accepted.push({ ...key });
  });
  input.write('\x1b[27;5;13~\x1b[13;9:3ux');
  assert.equal(accepted.length, 2);
  assert.equal(isMiniSteerKey(accepted[0]), true);
  assert.equal(accepted[1]?.name, 'x');
  remove();
  input.destroy();
});

test('mini：Cmd/Ctrl+Enter 的 CSI-u、modifyOtherKeys 与释放事件', () => {
  for (const sequence of ['\x1b[13;9u', '\x1b[13;33u', '\x1b[13;5u', '\x1b[27;5;13~']) {
    assert.equal(isMiniSteerKey(miniExtendedKey(sequence)!), true, sequence);
  }
  assert.equal(isMiniSteerKey(miniExtendedKey('\x1b[13;3u')!), false); // Option+Enter 保留续行
  assert.equal(miniExtendedKey('\x1b[13;9:3u')?.release, true);
  assert.equal(miniExtendedKey('\x1b[27u')?.name, 'escape');
  assert.equal(miniExtendedKey('ordinary text'), null);
});

test('mini：queue FIFO，多个 steer 不覆盖，边界退回队列不丢消息', () => {
  const buffer = new MiniInputBuffer();
  buffer.enqueue('q1', 'queue');
  buffer.enqueue('q2', 'queue');
  buffer.enqueue('s1', 'steer');
  buffer.enqueue('s2', 'steer');
  assert.equal(buffer.takeInterrupt()?.text, 's1');
  buffer.deferInterrupts();
  assert.equal(buffer.hasInterrupt(), false);
  assert.deepEqual([buffer.shift()?.text, buffer.shift()?.text, buffer.shift()?.text], ['s2', 'q1', 'q2']);
});

test('mini：取回最后一条 queue 编辑不影响 steer 或其他 queue', () => {
  const buffer = new MiniInputBuffer();
  buffer.enqueue('q1', 'queue');
  buffer.enqueue('q2', 'queue');
  buffer.enqueue('s1', 'steer');
  assert.equal(buffer.editLastQueued(), 'q2');
  assert.deepEqual(buffer.pending().map(item => item.text), ['s1', 'q1']);
  assert.equal(buffer.editLastQueued(), 'q1');
  assert.equal(buffer.editLastQueued(), null);
  assert.equal(buffer.takeInterrupt()?.text, 's1');
});

test('mini：增强键盘模式仍能解码 Ctrl+C/Ctrl+T 等已有快捷键', () => {
  const cancel = miniExtendedKey('\x1b[99;5u');
  assert.equal(cancel?.name, 'c');
  assert.equal(cancel?.ctrl, true);
  assert.equal(miniExtendedKey('\x1b[116;5u')?.name, 't');
});
