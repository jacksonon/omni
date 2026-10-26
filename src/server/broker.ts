/** 一个用户一个入口，工作区运行时分别在子进程里运行，避免 process.chdir/MCP/撤销栈交错。 */
import http from 'node:http';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { openSync, closeSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ConfigOverrides } from '../config/index.js';
import { VERSION } from '../version.js';
import { PresenceStore } from '../pet/presence.js';
import { petSettings, petCatalog } from '../web/pet.js';
import { canonicalWorkspace, readServerRecord, registryPath, runtimeDir, workspaceId, writeServerRecord } from './discovery.js';
import { resolveServerCommand } from './manager.js';
import { BROKER_COOKIE, SERVER_PRODUCT, SERVER_PROTOCOL, type ServerConnection } from './protocol.js';

interface Worker { id: string; cwd: string; port: number; token: string; process: ChildProcess }

export function secureEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function bodyJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 1_000_000) throw new Error('请求过大');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export interface BrokerHandle { server: http.Server; port: number; token: string; close(force?: boolean): Promise<boolean> }

export async function startBroker(options: { port?: number; token?: string; record?: boolean } = {}): Promise<BrokerHandle> {
  const token = options.token ?? randomBytes(32).toString('hex');
  const workers = new Map<string, Promise<Worker>>();
  const tickets = new Map<string, { workspaceId: string; expires: number }>();
  const presence = new PresenceStore();
  const petListeners = new Set<http.ServerResponse>();
  const petWatches = new Map<string, AbortController>();
  const petChanged = () => { for (const res of petListeners) res.write('event: pet.changed\ndata: {}\n\n'); };
  const cmd = resolveServerCommand();
  let closing = false;
  let publicPort = options.port ?? 3080;
  const base = (): string => `http://127.0.0.1:${publicPort}`;

  async function ensureWorker(cwdArg: string, overrides: ConfigOverrides = {}): Promise<Worker> {
    if (closing) throw new Error('服务正在停止');
    const cwd = canonicalWorkspace(cwdArg);
    const id = workspaceId(cwd);
    const existing = workers.get(id);
    if (existing) return existing;
    const started = (async (): Promise<Worker> => {
      const port = await freePort();
      const workerToken = randomBytes(32).toString('hex');
      const log = openSync(path.join(runtimeDir(), `workspace-${id}.log`), 'a', 0o600);
      const env = { ...process.env, OMNI_WEB_WORKSPACE: cwd, OMNI_INTERNAL_WORKER: '1', OMNI_WEB_TOKEN: workerToken,
        OMNI_WORKER_OVERRIDES: JSON.stringify(overrides), OMNI_DEBUG: '' };
      let child: ChildProcess;
      try {
        child = spawn(cmd.executable, [...cmd.args, 'server', '_worker', '--port', String(port)], {
          cwd, windowsHide: true, stdio: ['ignore', log, log], env,
        });
      } finally { closeSync(log); }
      let spawnError: Error | undefined;
      let exited = false;
      child.once('error', (error) => { spawnError = error; });
      child.once('exit', (code, signal) => {
        exited = true; workers.delete(id);
        if (!closing) console.error(`[omni-server] workspace ${id} exited code=${code} signal=${signal ?? 'none'}`);
      });
      const until = Date.now() + 35_000;
      while (Date.now() < until) {
        if (spawnError) throw spawnError;
        if (exited) throw new Error(`工作区后端提前退出；日志：workspace-${id}.log`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
            headers: { authorization: `Bearer ${workerToken}` }, signal: AbortSignal.timeout(600),
          });
          if (response.ok) {
            const status = await response.json() as { version?: string; cwd?: string };
            if (status.version === VERSION && status.cwd === cwd) {
              const worker = { id, cwd, port, token: workerToken, process: child };
              watchPet(worker); petChanged(); return worker;
            }
          }
        } catch { /* 后端还在准备 MCP 与工具 */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      child.kill('SIGTERM');
      throw new Error(`工作区后端启动超时；日志：workspace-${id}.log`);
    })();
    workers.set(id, started);
    started.catch(() => workers.delete(id));
    return started;
  }

  function watchPet(worker: Worker): void {
    const controller = new AbortController(); petWatches.set(worker.id, controller);
    worker.process.once('exit', () => { controller.abort(); petWatches.delete(worker.id); petChanged(); });
    void (async () => {
      let cursor = '';
      while (!controller.signal.aborted && !closing) {
        try {
          const response = await fetch(`http://127.0.0.1:${worker.port}/api/events`, {
            headers: { authorization: `Bearer ${worker.token}`, ...(cursor ? { 'Last-Event-ID': cursor } : {}) }, signal: controller.signal });
          if (!response.ok || !response.body) throw new Error('pet stream unavailable');
          const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            buffer += decoder.decode(value, { stream: true }); let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              cursor = /^id: (.+)$/m.exec(frame)?.[1] ?? cursor;
              if (/^event: (?:pet.changed|ready)$/m.test(frame)) petChanged();
            }
            if (buffer.length > 2_000_000) throw new Error('oversized frame');
          }
        } catch { /* 周期快照和重连修正遗漏，不将正文传给宠物客户端。 */ }
        if (!controller.signal.aborted && !closing) await new Promise<void>(resolve => {
          const timer = setTimeout(done, 1000);
          function done() { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); }
          controller.signal.addEventListener('abort', done, { once: true });
        });
      }
    })();
  }

  function connection(worker: Worker): Omit<ServerConnection, 'token'> {
    // ticket 限时、一次性，长期 token 不进地址栏/浏览历史/Referer。
    const now = Date.now();
    for (const [key, value] of tickets) if (value.expires < now) tickets.delete(key);
    const ticket = randomBytes(24).toString('hex');
    tickets.set(ticket, { workspaceId: worker.id, expires: now + 60_000 });
    return { url: `${base()}/w/${worker.id}`, serverUrl: base(), workspaceId: worker.id,
      browserUrl: `${base()}/_omni/connect?ticket=${ticket}` };
  }

  function authorized(req: http.IncomingMessage): boolean {
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const cookie = /(?:^|;\s*)omni_broker=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    return secureEqual(bearer, token) || secureEqual(cookie, token);
  }

  async function close(force = false): Promise<boolean> {
    if (closing) return true;
    if (!force) {
      for (const workerPromise of workers.values()) {
        const worker = await workerPromise.catch(() => null);
        if (!worker) continue;
        try {
          const r = await fetch(`http://127.0.0.1:${worker.port}/api/status`, { headers: { authorization: `Bearer ${worker.token}` }, signal: AbortSignal.timeout(1000) });
          if ((await r.json() as { running?: boolean }).running) return false;
        } catch { /* 已退出的 worker 没有活跃任务 */ }
      }
    }
    closing = true;
    for (const controller of petWatches.values()) controller.abort();
    for (const res of petListeners) res.end();
    for (const workerPromise of workers.values()) {
      const worker = await workerPromise.catch(() => null);
      worker?.process.kill('SIGTERM');
    }
    if (options.record !== false && readServerRecord()?.pid === process.pid) rmSync(registryPath(), { force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return true;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (![`127.0.0.1:${publicPort}`, `localhost:${publicPort}`].includes(host)) { send(res, 403, { error: '无效 Host' }); return; }
      const url = new URL(req.url ?? '/', base());
      if (url.pathname === '/_omni/connect' && req.method === 'GET') {
        const key = url.searchParams.get('ticket') ?? '';
        const ticket = tickets.get(key);
        tickets.delete(key);
        if (!ticket || ticket.expires < Date.now()) { send(res, 401, { error: '登录链接已过期，请重新运行 omni web' }); return; }
        res.writeHead(303, { location: `/w/${ticket.workspaceId}/`,
          'set-cookie': `${BROKER_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        res.end(); return;
      }
      if (!authorized(req)) { send(res, 401, { error: '共享服务需要本机客户端认证', code: 'unauthorized' }); return; }
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== host) { send(res, 403, { error: '跨站请求已拒绝' }); return; }
      if (url.pathname === '/_omni/health' && req.method === 'GET') {
        send(res, 200, { product: SERVER_PRODUCT, protocol: SERVER_PROTOCOL, version: VERSION, pid: process.pid, port: publicPort }); return;
      }
      if (url.pathname === '/_omni/workspaces' && req.method === 'POST') {
        const body = await bodyJson(req);
        const worker = await ensureWorker(String(body.cwd ?? process.cwd()), (body.overrides ?? {}) as ConfigOverrides);
        send(res, 200, connection(worker)); return;
      }
      if (url.pathname === '/_omni/workspaces' && req.method === 'GET') {
        const list = await Promise.all([...workers.values()].map(async (p) => {
          const w = await p.catch(() => null); return w ? { id: w.id, cwd: w.cwd, url: `${base()}/w/${w.id}` } : null;
        }));
        send(res, 200, { workspaces: list.filter(Boolean) }); return;
      }
      if (url.pathname === '/_omni/status' && req.method === 'GET') {
        const list = await Promise.all([...workers.values()].map(async (p) => {
          const w = await p.catch(() => null); if (!w) return null;
          try {
            const headers = { authorization: `Bearer ${w.token}` };
            const response = await fetch(`http://127.0.0.1:${w.port}/api/snapshot`, { headers, signal: AbortSignal.timeout(1500) });
            const snapshot = await response.json() as { status: { running?: boolean; runningSessions?: string[]; model?: string }; approvals?: unknown[]; asks?: unknown[] };
            return { id: w.id, cwd: w.cwd, url: `${base()}/w/${w.id}`, status: {
              running: snapshot.status.running, runningSessions: snapshot.status.runningSessions, model: snapshot.status.model,
            }, pending: { approvals: snapshot.approvals ?? [], asks: snapshot.asks ?? [] } };
          } catch { return { id: w.id, cwd: w.cwd, url: `${base()}/w/${w.id}`, status: { error: true }, pending: { approvals: [], asks: [] } }; }
        }));
        send(res, 200, { workspaces: list.filter(Boolean) }); return;
      }
      if (url.pathname === '/_omni/pet/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('event: pet.changed\ndata: {}\n\n'); petListeners.add(res);
        const timer = setInterval(() => res.write(': ping\n\n'), 15000);
        res.on('close', () => { clearInterval(timer); petListeners.delete(res); }); return;
      }
      if (url.pathname === '/_omni/pet/presence' && req.method === 'POST') {
        const body = await bodyJson(req); body.cwd = canonicalWorkspace(String(body.cwd ?? ''));
        presence.update(body); petChanged(); send(res, 200, { ok: true }); return;
      }
      if (url.pathname === '/_omni/pet/read' && req.method === 'POST') {
        const body = await bodyJson(req); presence.read(String(body.sessionId), Number(body.revision));
        petChanged(); send(res, 200, { ok: true }); return;
      }
      if (url.pathname === '/_omni/pet' && req.method === 'GET') {
        const list = await Promise.all([...workers.values()].map(async value => {
          const w = await value.catch(() => null); if (!w) return [];
          try {
            const r = await fetch(`http://127.0.0.1:${w.port}/api/pet`, { headers: { authorization: `Bearer ${w.token}` }, signal: AbortSignal.timeout(1500) });
            if (!r.ok) return [];
            const snapshot = await r.json() as { tasks: Record<string, unknown>[] };
            return snapshot.tasks.map(t => ({ ...t, cwd: w.cwd, url: `${base()}/w/${w.id}` }));
          } catch { return []; }
        }));
        send(res, 200, { version: 1, settings: await petSettings(), pets: await petCatalog(), tasks: [...list.flat(), ...presence.snapshot()] }); return;
      }
      if (url.pathname === '/_omni/shutdown' && req.method === 'POST') {
        const body = await bodyJson(req);
        // 先探测再响应，close 会关所有连接，因此把真正关闭延迟到响应发完。
        if (body.force !== true) {
          for (const p of workers.values()) {
            const w = await p.catch(() => null); if (!w) continue;
            const r = await fetch(`http://127.0.0.1:${w.port}/api/status`, { headers: { authorization: `Bearer ${w.token}` }, signal: AbortSignal.timeout(1000) });
            if ((await r.json() as { running?: boolean }).running) { send(res, 409, { error: '有任务正在执行；如需取消并停止，使用 omni server stop --force' }); return; }
          }
        }
        send(res, 200, { ok: true }); setImmediate(() => void close(true)); return;
      }
      const route = /^\/w\/([a-f0-9]{24})(\/.*)?$/.exec(url.pathname);
      if (!route) { send(res, 404, { error: '请从 omni web 或 omni bot 进入工作区' }); return; }
      const worker = await workers.get(route[1])?.catch(() => null);
      if (!worker) { send(res, 404, { error: '工作区后端已停止，请重新连接', code: 'workspace_unavailable' }); return; }
      const scopedPath = route[2] ?? '/';
      if (scopedPath === '/api/workspace' && req.method === 'POST') {
        const body = await bodyJson(req);
        const dest = await ensureWorker(String(body.dir ?? ''));
        send(res, 200, { cwd: dest.cwd, url: `${base()}/w/${dest.id}`, redirectUrl: `/w/${dest.id}/` }); return;
      }
      const headers = { ...req.headers, authorization: `Bearer ${worker.token}`, 'accept-encoding': 'identity' };
      delete headers.cookie;
      // 子进程只信任内部 token；浏览器身份停留在 broker。
      const upstream = http.request({ hostname: '127.0.0.1', port: worker.port, method: req.method,
        path: scopedPath + url.search, headers }, (response) => {
        const responseHeaders = { ...response.headers };
        delete responseHeaders['set-cookie'];
        responseHeaders['cache-control'] = 'no-store';
        if (responseHeaders.location?.startsWith('/')) responseHeaders.location = `/w/${worker.id}${responseHeaders.location}`;
        if (String(response.headers['content-type']).includes('text/html')) {
          // 静态引用仍然按原页面书写；挂载到工作区前缀时只改站内绝对地址。
          delete responseHeaders['content-length'];
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => {
            const prefix = `/w/${worker.id}`;
            const html = Buffer.concat(chunks).toString().replace(/((?:src|href|action)=["'])\/(?!\/)/g, `$1${prefix}/`);
            res.writeHead(response.statusCode ?? 200, responseHeaders); res.end(html);
          });
        } else {
          res.writeHead(response.statusCode ?? 200, responseHeaders); response.pipe(res);
        }
      });
      upstream.once('error', () => { if (!res.headersSent) send(res, 502, { error: '工作区后端连接已中断' }); else res.end(); });
      res.once('close', () => { if (!res.writableEnded) upstream.destroy(); });
      req.pipe(upstream);
    } catch (e) { if (!res.headersSent) send(res, 400, { error: e instanceof Error ? e.message : String(e) }); else res.end(); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(publicPort, '127.0.0.1', () => resolve());
  });
  publicPort = (server.address() as net.AddressInfo).port;
  if (options.record !== false) writeServerRecord({ product: SERVER_PRODUCT, protocol: SERVER_PROTOCOL, version: VERSION, pid: process.pid, port: publicPort, token, startedAt: Date.now() });
  return { server, port: publicPort, token, close };
}
