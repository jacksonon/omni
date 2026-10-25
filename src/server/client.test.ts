import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ServerClient, serverConnection, type ServerEvent } from './client.js';
import type { Output } from '../output/types.js';

function output(log: unknown[]): Output {
  return {
    thinking: { shown: false, write: text => { log.push(['think', text]); }, finish: () => {} },
    banner() {}, onRound() {}, onStreamStart() {}, onAnswer: text => log.push(['answer', text]), onAnswerEnd() {},
    onUsage: usage => log.push(['usage', usage.completion]), onRequestFailed: error => log.push(['error', String(error)]), onThinkingSaved() {},
    onToolStep: (_step, _max, name, _preview, _args, seq) => log.push(['tool', name, seq]),
    onToolResult: (_ok, _chars, _preview, _detail, seq) => log.push(['result', seq]),
    onToolOutput: (text, seq) => log.push(['full', text, seq]), onMaxSteps() {},
    onUserMessage: text => log.push(['user', text]), onTurnEnd() {}, onWaitForInput() {}, clearScrollback() {}, showHelp() {},
    requestApproval: async () => true, askUser: async (_question, options) => ({ choice: options[0]!, choices: [options[0]!], custom: false }),
  };
}

async function harness(onMessage: (emit: (type: string, data?: Record<string, unknown>) => void) => void) {
  const events: ServerEvent[] = [];
  const posts: { path: string; body: any }[] = [];
  let seq = 0;
  let snapshots = 0;
  let reset = false;
  let dropFirst = false;
  const seen = new Set<string>();
  const emit = (type: string, data: Record<string, unknown> = {}) => events.push({ seq: ++seq, type, data: { sessionId: 's1', ...data } });
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    const url = new URL(req.url!, 'http://localhost');
    let body: any = null;
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      body = JSON.parse(raw);
      posts.push({ path: url.pathname, body });
    }
    const json = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/snapshot') {
      snapshots += 1;
      json({ seq, status: { model: 'test', runningSessions: [] }, approvals: [], asks: [] });
    } else if (url.pathname === '/api/events/poll') {
      if (reset) { reset = false; json({ seq: 0, events: [], reset: true }); return; }
      await new Promise(resolve => setTimeout(resolve, 3));
      const since = Number(url.searchParams.get('since'));
      json({ seq, events: events.filter(event => event.seq > since) });
    } else if (url.pathname === '/api/sessions') json({ id: 's1' });
    else if (url.pathname.endsWith('/messages') && req.method === 'GET') json({ messages: [{ role: 'assistant', content: 'complete' }] });
    else if (url.pathname.endsWith('/messages')) {
      if (!seen.has(body.requestId)) { seen.add(body.requestId); onMessage(emit); }
      if (dropFirst) { dropFirst = false; req.socket.destroy(); return; }
      json({ ok: true });
    } else if (url.pathname.endsWith('/cancel')) { emit('run.end', { reason: 'aborted' }); json({ ok: true }); }
    else if (url.pathname.endsWith('/steer')) { emit('user.message', { text: body.text, mode: 'steer' }); emit('run.end', { reason: 'completed' }); json({ ok: true }); }
    else { json({ ok: true }); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const client = new ServerClient({ url: `http://127.0.0.1:${address.port}`, token: 'test-token' });
  const session = await client.createSession();
  return {
    client, session, posts, emit, get snapshots() { return snapshots; }, get runs() { return seen.size; },
    drop() { dropFirst = true; }, reset() { reset = true; },
    async close() { await session.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('shared transport maps streamed tools, full output and usage without duplicate user echo', async () => {
  const h = await harness(emit => {
    emit('user.message', { text: 'hello' });
    emit('thinking.chunk', { text: 'thinking' });
    emit('tool.start', { step: 0, maxSteps: 4, name: 'read_file', seq: 7, argsPreview: 'a' });
    emit('tool.full', { text: 'complete tool output', seq: 7 });
    emit('tool.result', { ok: true, chars: 20, seq: 7 });
    emit('answer.chunk', { text: 'answer' });
    emit('usage', { completion: 12, prompt: 30, total: 42 });
    emit('run.end', { reason: 'completed' });
  });
  const log: unknown[] = [];
  try {
    await h.session.start(output(log));
    assert.equal(await h.session.run('hello', { echoed: true }), 'completed');
    assert.deepEqual(log, [['think', 'thinking'], ['tool', 'read_file', 7], ['full', 'complete tool output', 7], ['result', 7], ['answer', 'answer'], ['usage', 12]]);
    assert.equal(h.session.messages.length, 1);
  } finally { await h.close(); }
});

test('lost send response retries same request id and executes once', async () => {
  const h = await harness(emit => { emit('answer.chunk', { text: 'once' }); emit('run.end', { reason: 'completed' }); });
  try {
    h.drop();
    await h.session.start(output([]));
    await h.session.run('hello');
    const sends = h.posts.filter(post => post.path.endsWith('/messages'));
    assert.equal(sends.length, 2);
    assert.equal(sends[0]!.body.requestId, sends[1]!.body.requestId);
    assert.equal(h.runs, 1);
  } finally { await h.close(); }
});

test('abort cancels remote task and steer rearms the same round', async () => {
  const h = await harness(() => {});
  try {
    await h.session.start(output([]));
    const controller = new AbortController();
    const run = h.session.run('cancel', { runOpts: { tools: [], abortSignal: controller.signal } });
    setTimeout(() => controller.abort(), 20);
    assert.equal(await run, 'aborted');
    let interrupt: string | null = 'steer text';
    let next = new AbortController();
    const opts = { tools: [], abortSignal: next.signal, takeInterrupt: () => { const text = interrupt; interrupt = null; return text; }, rearmAbort: () => { next = new AbortController(); opts.abortSignal = next.signal; } };
    const steered = h.session.run('steer', { runOpts: opts });
    setTimeout(() => next.abort(), 20);
    assert.equal(await steered, 'completed');
    assert.equal(h.posts.find(post => post.path.endsWith('/steer'))?.body.text, 'steer text');
    assert.equal(opts.abortSignal.aborted, false);
  } finally { await h.close(); }
});

test('approval and ask responses run asynchronously while events continue', async () => {
  const h = await harness(emit => {
    emit('approval.request', { approvalId: 'a1', tool: 'write_file', summary: 'write', reason: 'ask' });
    emit('approval.request', { approvalId: 'a1', tool: 'write_file', summary: 'write', reason: 'ask' });
    emit('ask.request', { askId: 'q1', question: 'pick', options: ['one', 'two'] });
    setTimeout(() => emit('run.end', { reason: 'completed' }), 30);
  });
  try {
    await h.session.start(output([]));
    await h.session.run('question');
    assert.equal(h.posts.filter(post => post.path.endsWith('/approval')).length, 1);
    assert.deepEqual(h.posts.find(post => post.path.endsWith('/ask'))?.body.choices, ['one']);
  } finally { await h.close(); }
});

test('buffer reset restores snapshot and terminates a missing completed run', async () => {
  const h = await harness(() => {});
  try {
    await h.session.start(output([]));
    const run = h.session.run('resync');
    setTimeout(() => h.reset(), 20);
    assert.equal(await run, 'interrupted');
    assert.ok(h.snapshots >= 2);
  } finally { await h.close(); }
});

test('explicit server URLs reject credentials and insecure remote links', () => {
  assert.throws(() => serverConnection('http://user:secret@localhost:3080'), /凭据/);
  assert.throws(() => serverConnection('http://example.com:3080'), /HTTPS/);
  assert.throws(() => serverConnection('https://example.com/?token=secret'), /查询参数/);
  assert.equal(serverConnection('http://127.0.0.1:3080/w/a/').url, 'http://127.0.0.1:3080/w/a');
});
