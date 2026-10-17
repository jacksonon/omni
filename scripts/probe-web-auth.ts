/**
 * Web 账号密码认证 e2e 探针：`npm run probe:web:auth`
 *
 * 覆盖（不依赖真实模型）：
 *   A. `omni web auth set` 写入全局配置（scrypt 哈希，不落明文）
 *   B. 未登录：首页返回登录页、/api/* 返回 401
 *   C. 错误口令 401；正确口令下发 HttpOnly Cookie + Bearer token
 *   D. Cookie / Bearer 两种凭据均可访问 API（小程序用 Bearer）
 *   E. 登录后首页返回 SPA（含 PWA manifest）、SSE 可建立
 *   F. 登出后会话失效；静态资源无需登录
 *   G. 连续失败触发 429 限流
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSK = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = 50000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const XDG = mkdtempSync(path.join(os.tmpdir(), 'omni-web-auth-probe-'));
const USER = 'probe';
const PASS = 'probe-pass-123';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 15000, msg = 'timeout'): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor: ${msg}`);
    await sleep(200);
  }
}

let fails = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    fails++;
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function startProcess(args: string[], env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [TSK, path.join(ROOT, 'src', 'index.ts'), ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  (child as any).__log = () => out;
  return child;
}

function cookieOf(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  const first = raw.find((c) => c.startsWith('omni_session=')) ?? res.headers.get('set-cookie') ?? '';
  return first.split(';')[0] ?? '';
}

async function post(p: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function main(): Promise<void> {
  process.env.XDG_CONFIG_HOME = XDG;
  let web: ChildProcess | null = null;
  try {
    // A. 设置账号密码（非交互：OMNI_WEB_PASSWORD）
    const set = startProcess(['web', 'auth', 'set', '--user', USER, '--days', '7'], {
      XDG_CONFIG_HOME: XDG,
      OMNI_WEB_PASSWORD: PASS,
    });
    await new Promise<void>((resolve) => set.on('exit', () => resolve()));
    const cfgText = (await import('node:fs')).readFileSync(path.join(XDG, 'omni', 'omni.json'), 'utf8');
    check('auth set 写入配置', cfgText.includes('"webAuth"') && cfgText.includes('scrypt$'), cfgText.slice(0, 120));
    check('配置不含明文口令', !cfgText.includes(PASS));

    // 启动 web（--auth：回环也强制登录）
    web = startProcess(['web', '--port', String(PORT), '--auth', '--no-open'], {
      XDG_CONFIG_HOME: XDG,
      OMNI_API_KEY: 'sk-mock',
      OMNI_BASE_URL: 'http://127.0.0.1:1/v1',
      OMNI_MODEL: 'mock-model',
    });
    await waitFor(async () => (await fetch(BASE + '/')).status === 200, 20000, 'web 启动');

    // B. 未登录
    const home = await fetch(BASE + '/');
    const homeText = await home.text();
    check('未登录首页返回登录页', home.status === 200 && homeText.includes('登录') && homeText.includes('/api/auth/login'));
    const anon = await fetch(BASE + '/api/status');
    check('未登录 API 401', anon.status === 401 && (await anon.json()).code === 'unauthorized');
    check('静态资源公开', (await fetch(BASE + '/style.css')).status === 200);
    check('manifest 公开', (await fetch(BASE + '/manifest.webmanifest')).status === 200);

    // C. 登录
    const bad = await post('/api/auth/login', { username: USER, password: 'nope-nope' });
    check('错误口令 401', bad.status === 401);
    const ok = await post('/api/auth/login', { username: USER, password: PASS });
    const loginJson: any = await ok.json();
    const cookie = cookieOf(ok);
    check('正确口令 200', ok.status === 200 && loginJson.ok === true);
    check('下发 HttpOnly 会话 Cookie', /HttpOnly/i.test(ok.headers.get('set-cookie') ?? '') && cookie.startsWith('omni_session='));
    check('返回 Bearer token（小程序）', typeof loginJson.token === 'string' && loginJson.token.startsWith('omni1.'));

    // D. 两种凭据
    const byCookie = await fetch(BASE + '/api/status', { headers: { cookie } });
    check('Cookie 访问 API', byCookie.status === 200);
    const byBearer = await fetch(BASE + '/api/status', { headers: { authorization: `Bearer ${loginJson.token}` } });
    check('Bearer 访问 API', byBearer.status === 200);
    const me = await fetch(BASE + '/api/auth/me', { headers: { cookie } });
    check('me 返回用户名', me.status === 200 && (await me.json()).user === USER);

    // E. 登录后 SPA + SSE
    const spa = await fetch(BASE + '/', { headers: { cookie } });
    const spaText = await spa.text();
    check('登录后返回 SPA', spa.status === 200 && spaText.includes('manifest.webmanifest'));
    const ac = new AbortController();
    const sse = await fetch(BASE + '/api/events', { headers: { cookie }, signal: ac.signal });
    const first = await sse.body?.getReader().read();
    ac.abort();
    check('SSE 可建立', sse.status === 200 && !!first && new TextDecoder().decode(first.value).includes('event: ready'));

    // E2. 长轮询回退（Cloudflare Quick Tunnel 会缓冲 SSE）
    const cursor = await (await fetch(BASE + '/api/events/poll', { headers: { cookie } })).json();
    check('长轮询返回游标', typeof cursor.seq === 'number');
    const mk = await fetch(BASE + '/api/sessions', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    check('轮询测试会话创建', mk.status === 201);
    const polled = await (await fetch(BASE + `/api/events/poll?since=${cursor.seq}&timeout=3`, { headers: { cookie } })).json();
    check(
      '长轮询收到事件',
      Array.isArray(polled.events) && polled.events.some((e: any) => e.type === 'session.created'),
      JSON.stringify(polled).slice(0, 120)
    );
    const t0 = Date.now();
    const empty = await (await fetch(BASE + `/api/events/poll?since=${polled.seq}&timeout=3`, { headers: { cookie } })).json();
    check('长轮询超时返回空', Array.isArray(empty.events) && empty.events.length === 0 && Date.now() - t0 < 5000);

    // F. 登出 + 静态
    const out = await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: { cookie } });
    check('登出 200', out.status === 200);
    check('登出后会话失效', (await fetch(BASE + '/api/status', { headers: { cookie } })).status === 401);

    // G. 限流（连续失败）
    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      lastStatus = (await post('/api/auth/login', { username: USER, password: 'bad-password' })).status;
    }
    check('连续失败触发 429', lastStatus === 429, String(lastStatus));
    // H. 配对模式（omni pair：链接 + 二维码 + 一次性免密兑换）
    web?.kill('SIGTERM');
    await sleep(400);
    const PAIR_PORT = PORT + 1;
    const PAIR_BASE = `http://127.0.0.1:${PAIR_PORT}`;
    web = startProcess(['pair', '--host', '127.0.0.1', '--port', String(PAIR_PORT), '--code', 'PAIRCODE'], {
      XDG_CONFIG_HOME: XDG,
      OMNI_API_KEY: 'sk-mock',
      OMNI_BASE_URL: 'http://127.0.0.1:1/v1',
      OMNI_MODEL: 'mock-model',
    });
    await waitFor(async () => (await fetch(PAIR_BASE + '/')).status === 200, 20000, 'pair 启动');
    const pairLog = String((web as any).__log?.() ?? '');
    check('pair 打印链接', pairLog.includes('?pair=PAIR-CODE'));
    check('pair 打印二维码', /[\u2584\u2588]/.test(pairLog));

    const redeemCall = (code: string): Promise<Response> =>
      fetch(PAIR_BASE + '/api/auth/pair/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
    check('错误配对码 401', (await redeemCall('WRONGCOD')).status === 401);
    const redeemed = await redeemCall('PAIR-CODE');
    const pairJson: any = await redeemed.json();
    const pairCookie = cookieOf(redeemed);
    check('配对码兑换 200', redeemed.status === 200 && pairJson.ok === true);
    check(
      '配对会话可访问 API',
      (await fetch(PAIR_BASE + '/api/status', { headers: { cookie: pairCookie } })).status === 200
    );
    check('配对码单次使用', (await redeemCall('PAIR-CODE')).status === 401);

  } finally {
    web?.kill('SIGTERM');
    await sleep(300);
    rmSync(XDG, { recursive: true, force: true });
  }

  if (fails > 0) {
    console.error(`\n✗ web 认证探针失败 ${fails} 项`);
    process.exitCode = 1;
  } else {
    console.log('\n✓ web 认证探针全部通过');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
