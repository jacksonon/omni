/**
 * 探针：坏 stdio MCP server 不拖垮 web 启动（Windows「后端服务启动超时」根因之一）。
 *
 * Windows 上 `npx` 是 .cmd，spawn 异步 ENOENT 被 StdioTransport 吞掉 → initialize
 * 干等满超时；此前发现还是串行的，两个坏 server = 60s ≫ Electron 壳 30s 判超时。
 * 修复：spawn 失败立即拒绝在途请求 + 握手 CONNECT_TIMEOUT=15s + 并行发现。
 *
 * 本机（macOS）用「不存在的命令」复现同款异步 ENOENT 路径：
 *   A. 配置 2 个坏 server → /api/status 就绪时间必须 < 20s（Electron 预算内）；
 *   B. 启动日志含两个「已跳过该服务器」（并行、各自失败、服务照常起）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSK = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WEB_PORT = 49591;
const BASE = `http://127.0.0.1:${WEB_PORT}`;

let failCount = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failCount++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

async function main(): Promise<void> {
  const XDG = mkdtempSync(path.join(os.tmpdir(), 'omni-badmcp-'));
  // 全局配置：2 个坏 stdio server（命令不存在 = 异步 ENOENT，与 Windows 上 npx 同路径）
  const cfgDir = path.join(XDG, 'omni');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(path.join(cfgDir, 'omni.json'), JSON.stringify({
    model: 'mock-model',
    baseURL: 'http://127.0.0.1:49999/v1',
    apiKey: 'sk-x',
    mcpServers: {
      badA: { command: '/nonexistent/omni-mcp-a', args: [] },
      badB: { command: '/nonexistent/omni-mcp-b', args: [] },
    },
  }), 'utf8');

  const stripped: NodeJS.ProcessEnv = { ...process.env };
  delete stripped.OMNI_API_KEY;
  delete stripped.OPENAI_API_KEY;
  const web = spawn(process.execPath, [TSK, path.join(ROOT, 'src', 'index.ts'), 'web', '--no-open', '--port', String(WEB_PORT)], {
    env: { ...stripped, XDG_CONFIG_HOME: XDG },
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  web.stdout!.on('data', (d) => (out += d));
  web.stderr!.on('data', (d) => (out += d));
  try {
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 30000) {
      try {
        const r = await fetch(`${BASE}/api/status`);
        if (r.status === 200) { ready = true; break; }
      } catch { /* 未就绪 */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    const elapsed = Date.now() - t0;
    check(`A1 有 2 个坏 MCP 时服务就绪 < 20s（实际 ${(elapsed / 1000).toFixed(1)}s）`, ready && elapsed < 20000);
    check('A2 坏 server A 被跳过', out.includes('badA') && out.includes('已跳过'));
    check('A3 坏 server B 被跳过', out.includes('badB') && out.includes('已跳过'));
    check('A4 进程存活', web.exitCode === null);
  } finally {
    web.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    rmSync(XDG, { recursive: true, force: true });
  }
  console.log(failCount === 0 ? '\nprobe-badmcp ✓ 全部通过' : `\nprobe-badmcp ✗ ${failCount} 项失败`);
  process.exit(failCount === 0 ? 0 : 1);
}

void main();
