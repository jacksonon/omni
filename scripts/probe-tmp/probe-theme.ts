/**
 * 临时探针：验证设置面板「主题」tab 的后端链路——
 *   A. persistWebThemeToConfig 把 webTheme 写入配置文件
 *   B. /api/settings 接收 webTheme → status.webTheme 更新
 *   C. buildStatus 输出 webTheme（默认 system）
 */
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const ROOT = path.resolve(process.cwd());
const TSK = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const XDG = mkdtempSync(path.join(os.tmpdir(), 'omni-theme-probe-'));
const MOCK_PORT = 48000 + Math.floor(Math.random() * 500);
const WEB_PORT = MOCK_PORT + 7;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
process.env.XDG_CONFIG_HOME = XDG;

// 临时配置文件：两个模型 + 无 webTheme（测试默认 system）
const cfgDir = path.join(XDG, 'omni');
mkdirSync(cfgDir, { recursive: true });
const cfgPath = path.join(cfgDir, 'omni.json');
writeFileSync(cfgPath, JSON.stringify({
  model: 'mock-model',
  baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`,
  apiKey: 'sk-mock',
  models: { 'mock-model': {}, 'mock-high': {} },
}, null, 2));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, timeoutMs = 15000, msg = 'timeout') {
  const t0 = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor: ${msg}`);
    await sleep(200);
  }
}
async function post(p, body) {
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

let mock;
let web;
try {
  mock = spawn('node', [path.join(ROOT, 'scripts', 'mock-server.mjs')], {
    env: { ...process.env, PORT: String(MOCK_PORT) }, stdio: 'ignore',
  });
  await sleep(1200);
  web = spawn(TSK, [path.join(ROOT, 'src', 'index.ts'), 'web', '--no-open', '--port', String(WEB_PORT)], {
    env: { ...process.env, XDG_CONFIG_HOME: XDG, OMNI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1` }, stdio: 'ignore',
  });
  await waitFor(async () => (await fetch(`${BASE}/api/status`).catch(() => null)) !== null, 20000, 'web 服务启动');

  // A. 默认 webTheme
  const s0 = await (await fetch(`${BASE}/api/status`)).json();
  console.log('A. 默认 webTheme =', s0.webTheme);
  if (s0.webTheme !== 'system') throw new Error(`默认应为 system，实际 ${s0.webTheme}`);

  // B. POST webTheme=dark → status 更新
  const r1 = await post('/api/settings', { webTheme: 'dark' });
  console.log('B. POST webTheme=dark →', r1.status, 'webTheme =', r1.json.webTheme);
  if (r1.json.webTheme !== 'dark') throw new Error('切换后 status.webTheme 应为 dark');

  // C. 配置文件写入
  const cfg2 = JSON.parse((await import('node:fs')).readFileSync(cfgPath, 'utf8'));
  console.log('C. 配置文件 webTheme =', cfg2.webTheme);
  if (cfg2.webTheme !== 'dark') throw new Error('配置文件应写入 webTheme=dark');

  // D. 切回 system
  const r2 = await post('/api/settings', { webTheme: 'system' });
  console.log('D. POST webTheme=system →', r2.json.webTheme);
  if (r2.json.webTheme !== 'system') throw new Error('应能切回 system');

  // E. 模型配置保存（modelConfig）→ status.models 更新 + 配置文件写入
  const r3 = await post('/api/settings', {
    modelConfig: {
      modelName: 'mock-high',
      baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      apiKey: 'sk-configured',
      reasoningEffortOptions: ['low', 'high'],
      reasoningEffort: 'high',
      contextLimit: 64000,
    },
  });
  console.log('E. POST modelConfig → status', r3.status, 'models 中 mock-high =', JSON.stringify(
    (r3.json.models || []).find((m) => m.name === 'mock-high')
  ));
  const mh = (r3.json.models || []).find((m) => m.name === 'mock-high');
  if (!mh || mh.reasoningEffortOptions?.join(',') !== 'low,high' || mh.reasoningEffort !== 'high' || mh.limit?.context !== 64000) {
    throw new Error('modelConfig 未同步到 status.models');
  }

  // F. 配置文件写入校验（全局配置 XDG/omni/omni.json）
  const cfg3 = JSON.parse((await import('node:fs')).readFileSync(cfgPath, 'utf8'));
  const stored = cfg3.models?.['mock-high'];
  console.log('F. 配置文件 models.mock-high =', JSON.stringify(stored));
  if (!stored || stored.baseURL !== `http://127.0.0.1:${MOCK_PORT}/v1` || stored.apiKey !== 'sk-configured'
      || stored.reasoningEffortOptions?.join(',') !== 'low,high' || stored.reasoningEffort !== 'high'
      || stored.limit?.context !== 64000) {
    throw new Error('modelConfig 未写入配置文件');
  }

  // G. 语言设置（language）→ status 更新（持久化走与 C 段相同的配置文件写入机制）
  const r4 = await post('/api/settings', { language: 'en' });
  console.log('G. POST language=en → status.language =', r4.json.language);
  if (r4.json.language !== 'en') throw new Error('语言切换后 status.language 应为 en');
  const r5 = await post('/api/settings', { language: 'zh' });
  console.log('  切回 zh →', r5.json.language);

  console.log('\n主题 + 模型配置 + 语言探针 ✓ 全部通过');
} finally {
  web?.kill();
  mock?.kill();
}
