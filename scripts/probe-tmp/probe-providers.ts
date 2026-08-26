/**
 * 探针：providers 分组持久化 + Web API（settings-providers-spec）。
 *
 * A. 配置读写纯函数（config/write.ts）：
 *    A1 persistProviderConfigToGlobal 新建/合并（纯 JSON 全局配置、保留无关字段）
 *    A2 persistProviderModelToGlobal 增改组内模型（apiModel/级别/context + 覆盖字段）
 *    A3 removeProviderModelFromGlobal / removeProviderFromGlobal
 *    A4 persistModelToConfig（/model add，providers-only 语义）
 *    A5 JSONC 拒绝自动改写
 * B. Web API（POST /api/settings）：
 *    B1 providerConfig 保存 → buildStatus.providers 出现分组 + runOpts.models 运行时同步
 *    B2 providerModel 添加模型 → runOpts.models 含 provider 条目
 *    B3 providerDiscover GET {baseURL}/models → 模型列表（mock /models 分支）
 *    B4 setDefaultModel → status.model 切换 + 全局配置顶层 model
 *    B5 providerRemove → runOpts.models 移除
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSK = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MOCK_PORT = 49602;
const WEB_PORT = 49603;
const BASE = `http://127.0.0.1:${WEB_PORT}`;

let failCount = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failCount++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}
function startProcess(cmd: string, args: string[], env: Record<string, string>): ChildProcess {
  return spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function waitFor(fn: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`超时：${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main(): Promise<void> {
  // ---------- A. 纯函数 ----------
  console.log('=== A. config/write.ts providers 持久化 ===');
  const XDG = mkdtempSync(path.join(os.tmpdir(), 'omni-prov-'));
  const globalFile = path.join(XDG, 'omni', 'omni.json');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(path.dirname(globalFile), { recursive: true });
  writeFileSync(globalFile, JSON.stringify({ model: 'deepseek-chat', unrelated: 1 }, null, 2));
  const oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = XDG;
  const { loadConfig } = await import(path.join(ROOT, 'src', 'config', 'index.js'));
  const write = await import(path.join(ROOT, 'src', 'config', 'write.js'));
  const cfg = loadConfig();

  // A1 provider 新建
  let r = write.persistProviderConfigToGlobal({ provider: 'bigmodel', baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-glm' }, cfg);
  check('A1-1 providerConfig 落盘 ok', r.ok === true, JSON.stringify(r));
  let obj = JSON.parse(readFileSync(globalFile, 'utf8'));
  check('A1-2 providers.bigmodel 写入', obj.providers?.bigmodel?.baseURL === 'https://open.bigmodel.cn/api/paas/v4' && obj.providers?.bigmodel?.apiKey === 'sk-glm');
  check('A1-3 无关字段保留', obj.unrelated === 1 && obj.model === 'deepseek-chat');

  // A2 组内模型
  r = write.persistProviderModelToGlobal({ provider: 'bigmodel', modelName: 'glm-4-flash', apiModel: 'glm-4-flash', reasoningEffortOptions: ['low', 'high'], reasoningEffort: 'high', contextLimit: 128000, overrideBaseURL: 'https://override.cn/v1' }, cfg);
  check('A2-1 providerModel 落盘 ok', r.ok === true, JSON.stringify(r));
  obj = JSON.parse(readFileSync(globalFile, 'utf8'));
  const m1 = obj.providers?.bigmodel?.models?.['glm-4-flash'];
  check('A2-2 模型级字段（apiModel/级别/context/覆盖）', m1?.apiModel === 'glm-4-flash' && m1?.reasoningEffort === 'high' && m1?.limit?.context === 128000 && m1?.baseURL === 'https://override.cn/v1');
  // 缺省覆盖字段 → 移除模型级 baseURL（继承）
  r = write.persistProviderModelToGlobal({ provider: 'bigmodel', modelName: 'glm-4-flash', reasoningEffort: 'low' }, cfg);
  obj = JSON.parse(readFileSync(globalFile, 'utf8'));
  check('A2-3 缺省覆盖 → 继承（移除模型级 baseURL）', !('baseURL' in (obj.providers?.bigmodel?.models?.['glm-4-flash'] ?? {})));

  // A3 删除
  r = write.removeProviderModelFromGlobal('bigmodel', 'glm-4-flash', cfg);
  check('A3-1 删除组内模型 ok', r.ok === true, JSON.stringify(r));
  obj = JSON.parse(readFileSync(globalFile, 'utf8'));
  check('A3-2 模型已删（provider 壳保留）', !obj.providers?.bigmodel?.models?.['glm-4-flash']);
  r = write.removeProviderFromGlobal('bigmodel', cfg);
  check('A3-3 删除 provider ok', r.ok === true, JSON.stringify(r));
  obj = JSON.parse(readFileSync(globalFile, 'utf8'));
  check('A3-4 provider 已删（providers 字段清理）', !obj.providers || !obj.providers.bigmodel);

  // A4 /model add 持久化（providers-only：旧版扁平 models 表已移除，/model add 建立单模型 provider 分组）
  const { persistModelToConfig } = write;
  r = write.persistModelToConfig('my-v1', { baseURL: 'https://my.cn/v1', apiKey: 'sk-my' }, cfg);
  check('A4-1 /model add 落盘 ok', r.ok === true, JSON.stringify(r));
  obj = JSON.parse(readFileSync(globalFile, 'utf8'));
  check('A4-2 写入 providers.my-v1（端点归 provider 级）', obj.providers?.['my-v1']?.baseURL === 'https://my.cn/v1' && obj.providers?.['my-v1']?.apiKey === 'sk-my');
  check('A4-3 组内模型 my-v1（模型级不写端点）', obj.providers?.['my-v1']?.models?.['my-v1'] && !('baseURL' in obj.providers?.['my-v1']?.models?.['my-v1']));
  check('A4-4 不再产生扁平 models 字段', !('models' in obj), JSON.stringify(Object.keys(obj)));

  // A5 JSONC 拒绝
  const jsoncFile = path.join(XDG, 'omni', 'omni.jsonc');
  writeFileSync(jsoncFile, '{\n  // 注释\n  "model": "x"\n}\n');
  rmSync(globalFile);
  r = write.persistProviderConfigToGlobal({ provider: 'p', baseURL: 'https://x.cn/v1' }, cfg);
  check('A5 JSONC 拒绝自动改写', r.ok === false && /JSONC|注释/.test(r.message), r.message);
  process.env.XDG_CONFIG_HOME = oldXdg;

  // ---------- B. Web API ----------
  console.log('=== B. Web API providers 动作 ===');
  const XDG2 = mkdtempSync(path.join(os.tmpdir(), 'omni-prov-web-'));
  const mock = startProcess(process.execPath, [path.join(ROOT, 'scripts', 'mock-server.mjs')], { PORT: String(MOCK_PORT) });
  const web = startProcess(process.execPath, [TSK, path.join(ROOT, 'src', 'index.ts'), 'web', '--no-open', '--port', String(WEB_PORT)], {
    XDG_CONFIG_HOME: XDG2,
    OMNI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    OMNI_MODEL: 'mock-model',
    OMNI_API_KEY: 'sk-test',
  });
  try {
    await waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${MOCK_PORT}/__mock/config`, { method: 'POST', body: '{}' })).status === 200; }
      catch { return false; }
    }, 10000, 'mock server 启动');
    await waitFor(async () => {
      try { return (await fetch(`${BASE}/api/status`)).status === 200; }
      catch { return false; }
    }, 15000, 'web 服务启动');
    const post = (body: Record<string, unknown>) => fetch(`${BASE}/api/settings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

    // B1 新建 provider
    let res = await post({ providerConfig: { provider: 'bigmodel', baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-glm' } });
    check('B1-1 providerConfig 200', res.status === 200, JSON.stringify(res.data).slice(0, 100));
    check('B1-2 status.providers 含 bigmodel', Array.isArray(res.data.providers) && res.data.providers.some((g: any) => g.name === 'bigmodel'), JSON.stringify(res.data.providers).slice(0, 120));
    check('B1-3 全局配置落盘 providers', JSON.parse(readFileSync(path.join(XDG2, 'omni', 'omni.json'), 'utf8')).providers?.bigmodel?.baseURL === 'https://open.bigmodel.cn/api/paas/v4');

    // B2 添加模型（继承端点）
    res = await post({ providerModel: { provider: 'bigmodel', modelName: 'glm-4-flash' } });
    check('B2-1 providerModel 200', res.status === 200, JSON.stringify(res.data).slice(0, 100));
    const mB = (res.data.models || []).find((m: any) => m.name === 'glm-4-flash');
    check('B2-2 runOpts.models 同步（provider 标记 + 继承端点）', !!mB && mB.provider === 'bigmodel' && mB.baseURL === 'https://open.bigmodel.cn/api/paas/v4', JSON.stringify(mB));

    // B3 获取模型列表（mock /models）
    res = await post({ providerDiscover: { baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-x' } });
    check('B3-1 providerDiscover 200 且返回列表', res.status === 200 && Array.isArray(res.data.models) && res.data.models.length > 0, JSON.stringify(res.data).slice(0, 120));

    // B4 设为默认
    res = await post({ setDefaultModel: { model: 'glm-4-flash' } });
    check('B4-1 setDefaultModel 200 + 切换', res.status === 200 && res.data.model === 'glm-4-flash', JSON.stringify(res.data).slice(0, 100));
    check('B4-2 全局配置顶层 model', JSON.parse(readFileSync(path.join(XDG2, 'omni', 'omni.json'), 'utf8')).model === 'glm-4-flash');

    // B5 删除模型
    res = await post({ providerRemove: { provider: 'bigmodel', modelName: 'glm-4-flash' } });
    check('B5-1 providerRemove 200', res.status === 200, JSON.stringify(res.data).slice(0, 100));
    check('B5-2 runOpts.models 移除', !(res.data.models || []).some((m: any) => m.name === 'glm-4-flash' || m.name === 'bigmodel/glm-4-flash'));
  } finally {
    mock.kill('SIGTERM');
    web.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    rmSync(XDG, { recursive: true, force: true });
    rmSync(XDG2, { recursive: true, force: true });
  }
  console.log(failCount === 0 ? '\nprobe-providers ✓ 全部通过' : `\nprobe-providers ✗ ${failCount} 项失败`);
  process.exit(failCount === 0 ? 0 : 1);
}

void main();
