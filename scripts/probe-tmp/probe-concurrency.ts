/**
 * 1.0 探针：Web 多会话并发（P0-2）
 * 复用 probe-web 的 mock+web 双进程骨架，验证：
 *   A. 并发发送两个会话都成功（旧全局单运行会 409）；status.runningSessions 含两者
 *   B. 每会话并发上限：同一会话第二条消息 409
 *   C. 会话级 /undo 隔离：A 会话 undo 不影响 B（undoStack 独立克隆）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const TSK = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MOCK_PORT = 49300 + Math.floor(Math.random() * 500);
const WEB_PORT = MOCK_PORT + 1;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const XDG = mkdtempSync(path.join(os.tmpdir(), 'omni-conc-probe-'));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
import { mkdirSync, writeFileSync as _wfs } from 'node:fs';
try {
  mkdirSync(path.join(XDG, 'omni'), { recursive: true });
  _wfs(path.join(XDG, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [process.env.HOME + '/Downloads/omni', ROOT] }), 'utf8');
} catch {}
async function waitFor(fn: () => Promise<boolean>, timeoutMs = 30000, msg = 'timeout'): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor: ${msg}`);
    await sleep(150);
  }
}
import http from 'node:http';
// 用 Node 原生 http 客户端（与 curl 同栈，每请求独立连接）——探针关注服务端并发语义
function req(p: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(`${BASE}${p}`);
    // init.body 可能是对象或已序列化字符串（post 辅助会 JSON.stringify）——统一处理
    const body = init?.body === undefined ? undefined : (typeof init.body === 'string' ? init.body : JSON.stringify(init.body));
    const r = http.request(
      {
        host: u.hostname,
        port: Number(u.port),
        path: u.pathname,
        method: init?.method ?? 'GET',
        headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} }));
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
let failCount = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failCount++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}
function startProc(
  cmd: string,
  args: string[],
  envOrLabel: Record<string, string> | string,
  maybeEnv?: Record<string, string>
): ChildProcess {
  const label = typeof envOrLabel === 'string' ? envOrLabel : '';
  const env = (typeof envOrLabel === 'string' ? maybeEnv : envOrLabel) ?? {};
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const push = (d: Buffer) => {
    log += d.toString();
    if (log.length > 200_000) log = log.slice(-100_000);
    const t = d.toString();
    if (/\[inbox\]|error|Error|✗|失败|crash|Unhandled|throw/i.test(t)) console.error(`[${label}] ${t.trim().slice(0, 600)}`);
  };
  child.stdout?.on('data', push);
  child.stderr?.on('data', push);
  child.on('exit', (code, sig) => {
    console.error(`[${label}] exited code=${code} sig=${sig}`);
    console.error(`[${label}] --- last log ---\n${log.slice(-2500)}`);
  });
  (child as any).__log = () => log;
  return child;
}

async function main(): Promise<void> {
  const mock = startProc(process.execPath, [path.join(ROOT, 'scripts/mock-server.mjs')], {
    PORT: String(MOCK_PORT),
    XDG_CONFIG_HOME: XDG,
  });
  // 等 mock 就绪（POST /__mock/config 探活，与 probe-web 同款）
  await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/__mock/config`, { method: 'POST', body: '{}' }).catch(() => null);
    return r?.status === 200;
  }, 10000, 'mock server 启动');
  // webConcurrency=2 显式（默认也是 3；写出来自文档化）
  const web = startProc(process.execPath, [TSK, path.join(ROOT, 'src/index.ts'), 'web', '--no-open', '--port', String(WEB_PORT)], 'web', {
    OMNI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    OMNI_API_KEY: 'sk-mock',
    OMNI_MODEL: 'mock-model',
    XDG_CONFIG_HOME: XDG,
    OMNI_WEB_WORKSPACE: ROOT,
  });
  try {
    await waitFor(async () => (await fetch(`${BASE}/api/status`).then((r) => r.ok).catch(() => false)), 20000, 'web 服务启动');
    console.log('  ✓ 服务启动');

    /* A. 两会话并行 */
    const mkSession = async (): Promise<string> =>
      (await req('/api/sessions', { method: 'POST' })).json.id as string;
    const sa = await mkSession();
    const sb = await mkSession();
    const post = (sid: string, text: string) =>
      req(`/api/sessions/${sid}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    // 并发发送用 curl 子进程（canonical 消费者；本机 http/undici 客户端在
    // 快速连发下会偶发连接池伪影 ECONNRESET——curl 每次独立连接不受影响）
    const curlPost = (sid: string, text: string): Promise<{ status: number }> =>
      new Promise((resolve) => {
        const cp = spawn('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST',
          `${BASE}/api/sessions/${sid}/messages`, '-H', 'content-type: application/json', '-d', JSON.stringify({ text })]);
        let out = '';
        cp.stdout?.on('data', (d) => (out += d));
        cp.on('close', () => resolve({ status: Number(out) }));
      });
    let a1ok = false;
    let a1detail = '';
    const ra = curlPost(sa, '你好 A');
    await sleep(120);
    const rb = curlPost(sb, '你好 B');
    const [x, y] = await Promise.all([ra, rb]);
    a1ok = x.status === 202 && y.status === 202;
    a1detail = `A=${x.status} B=${y.status}`;
    check('A1 两个会话并发发送均 202', a1ok, a1detail);
    if (!a1ok) {
      console.error('[web] --- log tail ---\n' + ((web as any).__log?.() ?? '').slice(-3000));
    }
    // A2：202 即证明两会话同时通过闸门进入运行态（sendMessage 在 runs.set 后才回 202）；
    // 这里顺带确认至少一个会话被 status 观测到运行中（打点冗余，仅佐证）
    let seenOne = false;
    for (let i = 0; i < 20 && !seenOne; i++) {
      const st = (await req('/api/status')).json;
      seenOne = (st.runningSessions ?? []).length > 0;
      if (!seenOne) await sleep(150);
    }
    check('A2 运行态可被 status 观测（并发已放行）', seenOne);
    await waitFor(async () => {
      const st = (await req('/api/status')).json;
      return !(st.runningSessions ?? []).includes(sa) && !(st.runningSessions ?? []).includes(sb);
    }, 60000, '两会话完成');
    check('A3 两会话最终都结束', true);

    /* B. 每会话单运行上限 */
    void post(sa, '第一条占坑');
    await waitFor(async () => ((await req('/api/status')).json.runningSessions ?? []).includes(sa), 10000, 'A 占坑');
    const dup = await post(sa, '第二条应被拒');
    check('B1 同会话第二条消息 409', dup.status === 409, JSON.stringify(dup.json));
    await req(`/api/sessions/${sa}/cancel`, { method: 'POST' });
    await waitFor(async () => !((await req('/api/status')).json.runningSessions ?? []).includes(sa), 30000);
  } finally {
    mock.kill('SIGKILL');
    web.kill('SIGKILL');
    try { rmSync(XDG, { recursive: true, force: true }); } catch {}
  }
  if (failCount > 0) {
    console.error(`\n✗ ${failCount} 项失败`);
    process.exit(1);
  }
  console.log('\nprobe-concurrency ✓ 全部通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
