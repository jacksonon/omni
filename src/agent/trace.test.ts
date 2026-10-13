/**
 * 轨迹投影层单元测试：纯函数 foldTrace / withSeparators / openSubagents /
 * buildTraceTextLines / fmtMs（事件序列 → 人类可读轨迹行）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TrajEvent } from './events.js';
import {
  buildTraceTextLines,
  fmtMs,
  foldTrace,
  formatOpenSubagents,
  openSubagents,
  withSeparators,
  type TraceRow,
} from './trace.js';

test('fmtMs：<10s 一位小数 / <60s 整数 / ≥60s 分:秒', () => {
  assert.equal(fmtMs(0), '0.0s');
  assert.equal(fmtMs(500), '0.5s');
  assert.equal(fmtMs(9999), '10.0s');
  assert.equal(fmtMs(10000), '10s');
  assert.equal(fmtMs(59999), '60s');
  assert.equal(fmtMs(60000), '1m');
  assert.equal(fmtMs(65000), '1m5s');
  assert.equal(fmtMs(125000), '2m5s');
});

test('foldTrace：一轮完整事件折叠为有序轨迹行', () => {
  const events: TrajEvent[] = [
    { s: 1, time: 0, k: 'turn/start', turn: 1 },
    { s: 2, time: 1, k: 'user/message', text: 'hello\nworld', source: 'user' },
    { s: 3, time: 2, k: 'request/header', step: 1, model: 'm', tools: ['read_file'], messages: 2 },
    { s: 4, time: 1000, k: 'tool/call', step: 1, callId: 'c1', name: 'read_file', args: '{"path":"a.ts"}' },
    { s: 5, time: 1500, k: 'tool/result', callId: 'c1', ok: true, chars: 42 },
    { s: 6, time: 1600, k: 'assistant/message', step: 1, text: 'done\nsecond', usage: { input: 10, cached: 0, output: 5 }, llmMs: 2000, firstTokenMs: 300 },
    { s: 7, time: 2000, k: 'turn/end', turn: 1, reason: 'completed' },
    { s: 8, time: 2100, k: 'compact', removed: 4 },
  ];
  const rows = foldTrace(events);
  assert.deepEqual(rows.map((r) => r.kind), ['turn', 'user', 'request', 'tool', 'answer', 'compact']);

  assert.equal(rows[0].done, '✓');
  assert.equal(rows[1].text, 'hello');
  assert.deepEqual(rows[1].detail, ['world']);
  assert.equal(rows[2].text, 'read_file · 2 条消息');
  assert.deepEqual(rows[2].detail, ['调用工具: read_file']);
  assert.equal(rows[3].text, 'read_file a.ts');
  assert.equal(rows[3].durMs, 500);
  assert.equal(rows[3].sub, '✓ 42 字符 · 0.5s');
  assert.equal(rows[4].durMs, 2000);
  assert.equal(rows[4].sub, '入 10 · 出 5 · LLM 2.0s · 首 token 0.3s');
  assert.deepEqual(rows[4].detail, ['second']);
  assert.equal(rows[5].text, '上下文压缩 · 移除 4 条');
});

test('foldTrace：中断用户消息带 ↑ 标记；未配对工具步 durMs 为 null', () => {
  const events: TrajEvent[] = [
    { s: 1, time: 0, k: 'turn/start', turn: 1 },
    { s: 2, time: 1, k: 'user/message', text: 'stop', source: 'interrupt' },
    { s: 3, time: 2, k: 'tool/call', step: 1, callId: 'c9', name: 'run_command', args: '{"command":"ls"}' },
  ];
  const rows = foldTrace(events);
  assert.equal(rows[1].text, '↑ stop');
  assert.equal(rows[2].kind, 'tool');
  assert.equal(rows[2].text, 'run_command ls');
  assert.equal(rows[2].durMs, null);
  assert.equal(rows[0].done, undefined); // 未配对 turn/end = 进行中
});

test('foldTrace：turn/end reason 映射为结束标记', () => {
  const ev = (reason: 'completed' | 'aborted' | 'error' | 'max-steps'): TraceRow[] =>
    foldTrace([
      { s: 1, time: 0, k: 'turn/start', turn: 1 },
      { s: 2, time: 1, k: 'turn/end', turn: 1, reason },
    ]);
  assert.equal(ev('completed')[0].done, '✓');
  assert.equal(ev('aborted')[0].done, '⚠');
  assert.equal(ev('error')[0].done, '✗');
  assert.equal(ev('max-steps')[0].done, '⌛');
});

test('withSeparators：不同 kind 之间插空行，连续 turn 不插', () => {
  const rows: TraceRow[] = [
    { kind: 'turn', turn: 1, text: '轮 1' },
    { kind: 'turn', turn: 2, text: '轮 2' },
    { kind: 'user', turn: 2, text: 'hi' },
    { kind: 'empty', turn: 2, text: '' },
    { kind: 'user', turn: 2, text: 'there' },
  ];
  const out = withSeparators(rows);
  assert.deepEqual(out.map((r) => r.kind), ['turn', 'turn', 'empty', 'user', 'user']);
});

test('openSubagents：start 未配对即运行中，step 刷新进度，end 移除', () => {
  const events: TrajEvent[] = [
    { s: 1, time: 0, k: 'subagent/start', id: 'a', parentId: null, depth: 0, name: 'x', task: 'task a' },
    { s: 2, time: 1, k: 'subagent/step', id: 'a', depth: 0, step: 2, maxSteps: 5 },
    { s: 3, time: 2, k: 'subagent/end', id: 'a', depth: 0, ok: true, summary: 'done', steps: 3, durationMs: 1000 },
    { s: 4, time: 3, k: 'subagent/start', id: 'b', parentId: 'root', depth: 1, name: 'y', task: 'task b' },
  ];
  const running = openSubagents(events);
  assert.equal(running.length, 1);
  assert.equal(running[0].id, 'b');
  assert.equal(running[0].depth, 1);
  assert.deepEqual(formatOpenSubagents(running), ['  · y：task b']);
});

test('buildTraceTextLines：文本账本格式 + 空行分隔', () => {
  const events: TrajEvent[] = [
    { s: 1, time: 0, k: 'turn/start', turn: 1 },
    { s: 2, time: 1, k: 'user/message', text: 'hi', source: 'user' },
    { s: 3, time: 2, k: 'turn/end', turn: 1, reason: 'completed' },
  ];
  const lines = buildTraceTextLines(events);
  assert.deepEqual(lines, ['轮 1 ✓', '', '  ❯ hi']);
});

test('buildTraceTextLines：full 模式展开工具详情', () => {
  const events: TrajEvent[] = [
    { s: 1, time: 0, k: 'turn/start', turn: 1 },
    { s: 2, time: 1, k: 'tool/call', step: 1, callId: 'c1', name: 'read_file', args: '{"path":"a.ts"}' },
    { s: 3, time: 2, k: 'tool/result', callId: 'c1', ok: false, chars: 7 },
  ];
  const lines = buildTraceTextLines(events, { full: true });
  assert.ok(lines.some((l) => l.includes('read_file a.ts')));
  assert.ok(lines.some((l) => l.includes('✗ 7 字符')));
  assert.ok(lines.some((l) => l.includes('{"path":"a.ts"}')));
});