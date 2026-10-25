/** 离线共享服务验收：真 broker + 工作区进程 + mock API，不读取用户配置/密钥。 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSharedServer } from '../src/server/manager.js';
import { ServerClient, ServerSession } from '../src/server/client.js';
import { WebOutput } from '../src/web/output.js';
import type { ServerConnection } from '../src/server/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'omni-bot-probe-')));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let checks = 0;
function check(label: string, condition: unknown): void { assert.ok(condition, label); checks += 1; console.log(`✓ ${label}`); }
async function until<T>(fn: () => Promise<T | undefined | false>, label: string, timeout = 12_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = await fn(); if (found) return found as T;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(30);
  }
}
async function reservePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve())); return port;
}
async function collectReplay(connection: ServerConnection, since: number): Promise<{ id?: number; type: string; data: any }[]> {
  const controller = new AbortController();
  const events: { id?: number; type: string; data: any }[] = [];
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${connection.url}/api/events`, { headers: { authorization: `Bearer ${connection.token}`, 'last-event-id': String(since) }, signal: controller.signal });
    assert.equal(response.status, 200);
    const decoder = new TextDecoder(); let buffered = '';
    for await (const chunk of response.body as any) {
      buffered += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffered.indexOf('\n\n')) >= 0) {
        const frame = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        const type = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        const id = /^id: (\d+)$/m.exec(frame)?.[1];
        if (type && data) events.push({ type, data: JSON.parse(data), ...(id ? { id: Number(id) } : {}) });
      }
      if (events.some((e) => e.type === 'run.end')) break;
    }
  } catch (e) { if (!controller.signal.aborted) throw e; }
  finally { clearTimeout(timer); controller.abort(); }
  return events;
}

async function main(): Promise<void> {
  const mockPort = await reservePort();
  const xdg = path.join(TEMP, 'config'); const runtime = path.join(TEMP, 'runtime');
  const workspaceA = path.join(TEMP, 'project-a'), workspaceB = path.join(TEMP, 'project-b');
  for (const dir of [xdg, runtime, workspaceA, workspaceB]) mkdirSync(dir);
  process.env.XDG_CONFIG_HOME = xdg; process.env.OMNI_SERVER_RUNTIME_DIR = runtime;
  process.env.OMNI_BASE_URL = `http://127.0.0.1:${mockPort}/v1`;
  process.env.OMNI_API_KEY = 'sk-mock-only'; process.env.OMNI_MODEL = 'mock-default';
  delete process.env.OMNI_CONFIG; delete process.env.OMNI_WEB_WORKSPACE; delete process.env.OMNI_WEB_TOKEN;
  const config = { autoMemory: false, agentsFile: false, repoMap: false, auditLog: false, providers: {
    mock: { baseURL: process.env.OMNI_BASE_URL, apiKey: 'sk-mock-only', models: { 'mock-default': {}, 'mock-session': {} } },
  } };
  for (const dir of [workspaceA, workspaceB]) writeFileSync(path.join(dir, 'omni.json'), JSON.stringify(config));
  const { addTrustedWorkspace } = await import('../src/safety/trust.js');
  assert.equal(addTrustedWorkspace(TEMP), true);
  const mock = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-server.mjs')], { env: { ...process.env, PORT: String(mockPort) }, stdio: 'ignore', windowsHide: true });
  let remote: ChildProcess | undefined;
  let a: ServerConnection | undefined;
  const sessions: ServerSession[] = [];
  async function mockConfig(body: Record<string, unknown>): Promise<void> {
    const r = await fetch(`http://127.0.0.1:${mockPort}/__mock/config`, { method: 'POST', body: JSON.stringify(body) }); assert.equal(r.status, 200);
  }
  try {
    await until(async () => { try { await mockConfig({}); return true; } catch { return false; } }, 'mock ready');
    const command = { executable: process.execPath, args: ['--import', createRequire(import.meta.url).resolve('tsx'), path.join(ROOT, 'src', 'index.ts')] };
    const [first, repeated, b] = await Promise.all([
      ensureSharedServer({ cwd: workspaceA, port: 0, command }), ensureSharedServer({ cwd: workspaceA, port: 0, command }), ensureSharedServer({ cwd: workspaceB, port: 0, command }),
    ]);
    a = first;
    check('并发启动汇聚为一个 broker，同工作区 runtime 复用', a.serverUrl === repeated.serverUrl && a.serverUrl === b.serverUrl && a.url === repeated.url && a.url !== b.url);
    const client = new ServerClient(a), clientB = new ServerClient(b);
    const session = await client.createSession({ model: 'mock-session', permission: 'safe', maxSteps: 8 });
    sessions.push(session);
    const received: { type: string; data: any }[] = [];
    const output = new WebOutput(session.id, (type, data) => received.push({ type, data }), { addApproval: async () => false, addAsk: async () => null });
    await session.start(output);
    const snapshot = await session.snapshot();
    check('会话模型与权限由 server 独立持有', snapshot.status.model === 'mock-session' && snapshot.status.permission === 'safe');
    const before = snapshot.seq;
    const firstReason = await session.run('检查共享运行链路');
    assert.equal(firstReason, 'completed', JSON.stringify(received.filter((e) => e.type === 'error')));
    check('ServerSession 完成真实工具 + 回答链路', true);
    check('终端客户端收到流式回答与工具事件', received.some((e) => e.type === 'answer.chunk') && received.some((e) => e.type === 'tool.start'));
    const auth = { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' };
    const browserHistory = await (await fetch(`${a.url}/api/sessions/${session.id}/messages`, { headers: auth })).json() as { messages: { role: string; content?: unknown }[] };
    check('Web 与 ServerClient 读取同一份 live 会话', browserHistory.messages.length === session.messages.length && browserHistory.messages.some((m) => m.role === 'assistant'));
    const replay = await collectReplay(a, before);
    const ids = replay.flatMap((e) => e.id == null ? [] : [e.id]);
    check('SSE Last-Event-ID 重放带递增 ID，包含已完成轮次', replay.some((e) => e.type === 'run.end') && ids.length > 0 && ids.every((id, i) => i === 0 || id > ids[i - 1]));
    const duplicated = { text: '幂等消息', requestId: 'bot-probe-duplicate-1' };
    const sent = await Promise.all([client.request(`/api/sessions/${session.id}/messages`, duplicated), client.request(`/api/sessions/${session.id}/messages`, duplicated)]);
    check('重复 requestId 并发提交均收到确认', sent.length === 2);
    await until(async () => !(await session.snapshot()).status.runningSessions.includes(session.id), 'duplicate turn ends');
    const onceHistory = await session.history();
    check('重复 requestId 只落一条用户消息', onceHistory.filter((m) => m.role === 'user' && m.content === duplicated.text).length === 1);
    const conflicting = await fetch(`${a.url}/api/sessions/${session.id}/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ ...duplicated, text: '不同内容' }) });
    check('同一 requestId 的不同消息被拒绝', conflicting.status === 400 || conflicting.status === 409);

    // 后端隔离：其它 worker 即使知道会话 id，也不能在错误工作目录恢复/执行它。
    let foreignRejected = false;
    try { await clientB.createSession({}, session.id); } catch { foreignRejected = true; }
    check('另一个工作区拒绝恢复外来会话', foreignRejected);

    await mockConfig({ ask: false, dangerous: false, slow: false });
    const pendingSession = await client.createSession({ permission: 'ask' });
    await client.request(`/api/sessions/${pendingSession.id}/messages`, { text: '需要审批', requestId: 'approval-cancel' });
    const pendingApproval = await until(async () => {
      const s = await client.request<any>(`/api/snapshot?sessionId=${pendingSession.id}`); return s.approvals?.[0] ? s : false;
    }, 'pending approval');
    check('新连接快照恢复待审批请求完整内容', pendingApproval.approvals[0].tool === 'run_command' && !!pendingApproval.approvals[0].summary);
    const stopBusy = await fetch(`${a.serverUrl}/_omni/shutdown`, { method: 'POST', headers: auth, body: '{}' });
    check('server stop 拒绝中断运行中的任务', stopBusy.status === 409);
    await client.request(`/api/sessions/${pendingSession.id}/cancel`, {});
    await until(async () => {
      const s = await client.request<any>(`/api/snapshot?sessionId=${pendingSession.id}`); return !s.status.runningSessions.includes(pendingSession.id) && s.approvals.length === 0;
    }, 'approval cancel');
    check('取消任务同时清除待审批，不遗留悬挂 promise', true);
    const staleApproval = await fetch(`${a.url}/api/sessions/${pendingSession.id}/approval`, { method: 'POST', headers: auth, body: JSON.stringify({ approvalId: pendingApproval.approvals[0].approvalId, allow: true }) });
    check('取消后的旧审批不能再执行', staleApproval.status === 404);

    await mockConfig({ ask: true });
    const askSession = await client.createSession({ permission: 'full' });
    await client.request(`/api/sessions/${askSession.id}/messages`, { text: '需要提问', requestId: 'ask-cancel' });
    const pendingAsk = await until(async () => {
      const s = await client.request<any>(`/api/snapshot?sessionId=${askSession.id}`); return s.asks?.[0] ? s : false;
    }, 'pending ask');
    check('新连接快照恢复问题与选项', !!pendingAsk.asks[0].question && pendingAsk.asks[0].options.length > 0);
    await client.request(`/api/sessions/${askSession.id}/cancel`, {});
    await until(async () => {
      const s = await client.request<any>(`/api/snapshot?sessionId=${askSession.id}`); return !s.status.runningSessions.includes(askSession.id) && s.asks.length === 0;
    }, 'ask cancel');
    check('取消提问任务解除所有等待', true);
    await mockConfig({ ask: false });

    const oldCursor = (await session.snapshot()).seq;
    for (let batch = 0; batch < 21; batch++) {
      await Promise.all(Array.from({ length: 50 }, () => client.request('/api/command', { command: '/pwd' })));
    }
    const overflow = await client.request<{ seq: number; reset?: boolean; events: unknown[] }>(`/api/events/poll?since=${oldCursor}&timeout=0`);
    check('事件缓冲覆盖时明确返回 reset，客户端可转快照恢复', overflow.reset === true && overflow.events.length <= 1000 && overflow.seq > oldCursor);
    const future = await client.request<{ reset?: boolean }>('/api/events/poll?since=999999999&timeout=0');
    check('服务重启导致游标超前时明确要求重置', future.reset === true);

    // 远程认证代理没有第二套 Agent：同一会话可从认证前端读取并继续。
    const remotePort = await reservePort();
    const remoteToken = 'probe-remote-only-token';
    remote = spawn(process.execPath, [...command.args, 'web', '--host', '127.0.0.1', '--port', String(remotePort), '--token', remoteToken, '--no-open'],
      { cwd: workspaceA, env: { ...process.env }, stdio: 'ignore', windowsHide: true });
    const remoteBase = `http://127.0.0.1:${remotePort}`;
    await until(async () => { try { return (await fetch(`${remoteBase}/api/status`, { headers: { authorization: `Bearer ${remoteToken}` } })).status === 200; } catch { return false; } }, 'remote proxy ready');
    check('远程代理保留认证边界', (await fetch(`${remoteBase}/api/sessions`)).status === 401);
    const remoteHistory = await (await fetch(`${remoteBase}/api/sessions/${session.id}/messages`, { headers: { authorization: `Bearer ${remoteToken}` } })).json() as { messages: unknown[] };
    check('远程代理复用同一个工作区会话', remoteHistory.messages.length === (await session.history()).length);
    const brokerManagement = await fetch(`${remoteBase}/_omni/health`, { headers: { authorization: `Bearer ${remoteToken}` } });
    check('远程认证不能访问 broker 管理接口', brokerManagement.status !== 200);
    console.log(`\nOmni Bot / shared server：${checks} 项验收通过。`);
  } catch (error) {
    const tails = readdirSync(runtime).filter((name) => name.endsWith('.log')).map((name) => `${name}:\n${readFileSync(path.join(runtime, name), 'utf8').slice(-1800)}`).join('\n');
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n隔离测试后端日志：\n${tails}`);
  } finally {
    for (const session of sessions) await session.close().catch(() => {});
    remote?.kill('SIGTERM');
    if (a) await fetch(`${a.serverUrl}/_omni/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, body: '{"force":true}' }).catch(() => {});
    mock.kill('SIGTERM');
    await sleep(150);
    rmSync(TEMP, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
