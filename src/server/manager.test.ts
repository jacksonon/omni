/** 真子进程覆盖发现锁与跨工作区隔离，不用假的内存 manager 自证。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { ServerConnection, ServerRecord } from './protocol.js';

test('并发客户端复用一个 server，工作区 child 隔离，浏览器 ticket 只能消费一次', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omni-server-integration-'));
  for (const name of ['config', 'runtime', 'project-a', 'project-b']) mkdirSync(path.join(root, name));
  const cli = fileURLToPath(new URL('../index.ts', import.meta.url));
  const loader = createRequire(import.meta.url).resolve('tsx');
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), OMNI_SERVER_RUNTIME_DIR: path.join(root, 'runtime'),
    OMNI_API_KEY: 'test-only-placeholder', OMNI_MODEL: 'mock-model', OMNI_CONFIG: '', OMNI_WEB_WORKSPACE: '', OMNI_WEB_TOKEN: '' };
  async function run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', loader, cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += String(d); });
      child.stderr.on('data', (d) => { stderr += String(d); });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    });
  }
  try {
    const commands = ['project-a', 'project-a', 'project-b'].map((name) => run(['server', 'ensure', '--json', '--port', '0', '--cwd', path.join(root, name)]));
    const [a, a2, b] = (await Promise.all(commands)).map((out) => JSON.parse(out.trim()) as ServerConnection);
    assert.equal(a.serverUrl, a2.serverUrl); assert.equal(a.serverUrl, b.serverUrl);
    assert.equal(a.workspaceId, a2.workspaceId); assert.notEqual(a.workspaceId, b.workspaceId);
    const headers = { authorization: `Bearer ${a.token}` };
    const statusA = await (await fetch(`${a.url}/api/status`, { headers })).json() as { cwd: string };
    const statusB = await (await fetch(`${b.url}/api/status`, { headers })).json() as { cwd: string };
    assert.equal(path.basename(statusA.cwd), 'project-a'); assert.equal(path.basename(statusB.cwd), 'project-b');
    const list = await (await fetch(`${a.serverUrl}/_omni/workspaces`, { headers })).json() as { workspaces: unknown[] };
    assert.equal(list.workspaces.length, 2);
    const login = await fetch(a.browserUrl, { redirect: 'manual' });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie') ?? '';
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    assert.equal((await fetch(a.browserUrl, { redirect: 'manual' })).status, 401);
    const page = await fetch(`${a.url}/`, { headers: { cookie: cookie.split(';')[0] } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('src="app.js"') || html.includes(`/w/${a.workspaceId}/app.js`));
    assert.equal((await fetch(`${a.url}/app.js`, { headers })).status, 200);
    const switched = await fetch(`${a.url}/api/workspace`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ dir: path.join(root, 'project-b') }) });
    assert.equal((await switched.json() as { redirectUrl: string }).redirectUrl, `/w/${b.workspaceId}/`);
    assert.equal(path.basename((await (await fetch(`${a.url}/api/status`, { headers })).json() as { cwd: string }).cwd), 'project-a');
  } finally {
    try { await run(['server', 'stop', '--force']); } catch { /* 后端启动失败时还要清理临时目录 */ }
    // 等待 OS 子进程退出后再删隔离目录；不碰真实用户配置或服务。
    let record: ServerRecord | undefined;
    try { record = JSON.parse(readFileSync(path.join(root, 'runtime', 'server.json'), 'utf8')); } catch { /* 已正常移除 */ }
    if (record) { try { process.kill(record.pid, 'SIGTERM'); } catch { /* 已退出 */ } }
    rmSync(root, { recursive: true, force: true });
  }
});
