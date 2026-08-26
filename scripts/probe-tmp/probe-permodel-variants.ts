/**
 * 探针：per-model variants —— providers 组内模型 reasoningEffortOptions / reasoningEffort
 *（每个模型可配自己的思考级别选项与默认值；缺省回退顶层全局；/model 切换自动带出；
 *  /variants 切换持久化到 providers.<组>.models.<模型>.reasoningEffort，切换回其他模型不受影响）。
 *
 *   A  config 解析：loadConfig 读 per-model 思考级别字段（非法字段丢弃，缺省回退顶层）
 *   B  attachRuntime modelEndpoints 展开：端点携带解析后的思考级别
 *      （默认模型 / 组内模型 / 纯端点模型，缺省均回退全局）
 *   C  CLI 交互 e2e（真实子进程）：/variants → /model mock-high（联动 high + 选项 low|high）
 *      → /variants low（持久化 providers.mock.models.mock-high.reasoningEffort）→ /model mock-model
 *      （回退全局 medium）→ 配置文件终态验证（顶层 reasoningEffort 未被污染）
 *
 * 用法：npx tsx scripts/probe-tmp/probe-permodel-variants.ts
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRun, attachRuntime } from '../../src/main.js';

const REPO = process.cwd();
const PORT = 8815;
const XDG = mkdtempSync(join(tmpdir(), 'omni-permodel-'));
process.env.XDG_CONFIG_HOME = XDG;

// 临时项目配置：顶层全局思考级别 + 一个带 per-model 级别（+ 一个非法字段）的模型 + 一个纯端点模型
// 端点/密钥只认 providers 分组（旧版扁平 models 表已移除）
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'omni-permodel-cfg-'));
const CONFIG_FILE = join(CONFIG_DIR, 'omni.json');
const FIXTURE = {
  model: 'mock-model',
  reasoningEffort: 'medium',
  reasoningEffortOptions: ['low', 'medium', 'high'],
  providers: {
    mock: {
      baseURL: `http://127.0.0.1:${PORT}/v1`,
      apiKey: 'sk-mock',
      models: {
        'mock-model': {},
        'mock-high': {
          reasoningEffortOptions: ['low', 'high'],
          reasoningEffort: 'high',
          bad: 123, // 非法字段：apply 应丢弃
        },
        'mock-plain': {},
      },
    },
  },
};
writeFileSync(CONFIG_FILE, JSON.stringify(FIXTURE, null, 2));

let failed = 0;
function ok(cond: boolean, desc: string): void {
  console.log(`${cond ? '✅' : '❌'} ${desc}`);
  if (!cond) failed++;
}

// ---------- A + B：config 解析 + attachRuntime 展开 ----------
{
  const oldOmniConfig = process.env.OMNI_CONFIG;
  process.env.OMNI_CONFIG = CONFIG_FILE;
  const { loadConfig } = await import('../../src/config/index.js');
  const cfg = loadConfig();
  if (!cfg.models || !cfg.models['mock-high'] || !cfg.models['mock-plain']) {
    ok(false, `A config models（providers 展开）解析失败: ${JSON.stringify(cfg.models)}`);
    process.exit(1);
  }
  ok(cfg.models['mock-high'].reasoningEffort === 'high', 'A providers 展开 mock-high.reasoningEffort=high');
  ok(
    JSON.stringify(cfg.models['mock-high'].reasoningEffortOptions) === JSON.stringify(['low', 'high']),
    `A mock-high.reasoningEffortOptions=['low','high']: ${JSON.stringify(cfg.models['mock-high'].reasoningEffortOptions)}`
  );
  ok(!('bad' in cfg.models['mock-high']), 'A 非法字段 bad 被丢弃');
  ok(cfg.models['mock-plain'].reasoningEffort === undefined, 'A 纯端点模型无思考级别字段（缺省回退）');
  ok(cfg.models['mock-high'].baseURL === `http://127.0.0.1:${PORT}/v1`, 'A 模型级端点继承 provider（baseURL）');
  ok(cfg.models['mock-high'].provider === 'mock', 'A 展开条目带 provider 标记');
  ok(cfg.reasoningEffort === 'medium', 'A 顶层全局思考级别 medium');

  const ctx = prepareRun({});
  await attachRuntime(ctx, {} as never);
  process.env.OMNI_CONFIG = oldOmniConfig;
  const models = ctx.runOpts.models ?? [];
  ok(models.length === 3, `B modelEndpoints 展开 3 条: ${models.map((m) => m.name).join(',')}`);
  const def = models.find((m) => m.name === 'mock-model')!;
  const high = models.find((m) => m.name === 'mock-high')!;
  const plain = models.find((m) => m.name === 'mock-plain')!;
  ok(
    def.reasoningEffort === 'medium' && JSON.stringify(def.reasoningEffortOptions) === JSON.stringify(['low', 'medium', 'high']),
    `B 默认模型端点回退全局: ${def.reasoningEffort} ${JSON.stringify(def.reasoningEffortOptions)}`
  );
  ok(
    high.reasoningEffort === 'high' && JSON.stringify(high.reasoningEffortOptions) === JSON.stringify(['low', 'high']),
    `B per-model 端点携带模型专属级别: ${high.reasoningEffort} ${JSON.stringify(high.reasoningEffortOptions)}`
  );
  ok(
    plain.reasoningEffort === 'medium' && JSON.stringify(plain.reasoningEffortOptions) === JSON.stringify(['low', 'medium', 'high']),
    `B 纯端点模型回退全局: ${plain.reasoningEffort} ${JSON.stringify(plain.reasoningEffortOptions)}`
  );
}

// ---------- C：CLI 交互 e2e（真实子进程 + 管道 stdin） ----------
{
  const childEnv = { ...process.env, NO_COLOR: '1', OMNI_CONFIG: CONFIG_FILE };
  delete childEnv.OMNI_MODEL;
  delete childEnv.OMNI_API_KEY;
  delete childEnv.OMNI_BASE_URL;
  const child = spawn(join(REPO, 'node_modules/.bin/tsx'), [join(REPO, 'src/index.ts')], {
    cwd: CONFIG_DIR,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  child.stderr.on('data', (d) => (err += d.toString()));
  const commands = [
    '/variants', // → medium（全局选项 low|medium|high）
    '/model mock-high', // → 联动 high + 选项 low|high
    '/variants', // → high（low|high）
    '/variants low', // → 持久化 models.mock-high.reasoningEffort=low
    '/variants', // → low（low|high）
    '/model mock-model', // → 回退全局 medium
    '/variants', // → medium（low|medium|high）
    '/exit',
  ];
  const exited = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CLI e2e 超时（60s）'));
    }, 60000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
  child.stdin.write(commands.join('\n') + '\n');
  child.stdin.end();
  const code = await exited;
  ok(code === 0, `C CLI 子进程退出码 0（实际 ${code}）`);
  const all = out + err;
  const ordered = [
    '当前：medium（级别：low|medium|high）',
    '已切换模型 → mock-high',
    '思考级别 high',
    '当前：high（级别：low|high）',
    '已切换思考级别 → low',
    '仅对模型 mock-high 生效',
    '当前：low（级别：low|high）',
    '已切换模型 → mock-model',
    '思考级别 medium',
    '当前：medium（级别：low|medium|high）',
  ];
  let last = -1;
  for (const expect of ordered) {
    const idx = all.indexOf(expect, Math.max(0, last + 1)); // 重复字符串按序取后续出现
    ok(idx > last, `C 输出按序含「${expect}」`);
    last = idx;
  }
  // 配置文件终态：/variants low 落在 providers.mock.models.mock-high，顶层全局未被污染
  const finalCfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  ok(finalCfg.model === 'mock-model', `C 顶层 model 持久化为 mock-model: ${finalCfg.model}`);
  ok(finalCfg.reasoningEffort === 'medium', `C 顶层 reasoningEffort 未被污染（仍 medium）: ${finalCfg.reasoningEffort}`);
  ok(
    finalCfg.providers?.mock?.models?.['mock-high']?.reasoningEffort === 'low',
    `C providers.mock.models.mock-high.reasoningEffort=low（per-model 持久化）: ${JSON.stringify(finalCfg.providers?.mock?.models?.['mock-high'])}`
  );
  ok(
    JSON.stringify(finalCfg.providers?.mock?.models?.['mock-high']?.reasoningEffortOptions) === JSON.stringify(['low', 'high']),
    `C mock-high.reasoningEffortOptions 保留 ['low','high']: ${JSON.stringify(finalCfg.providers?.mock?.models?.['mock-high']?.reasoningEffortOptions)}`
  );
  ok(finalCfg.providers?.mock?.models?.['mock-plain'] !== undefined, 'C providers.mock.models.mock-plain 条目未被破坏');
  ok(
    !('models' in finalCfg),
    `C 配置终态无扁平 models 字段（providers-only）: ${JSON.stringify(Object.keys(finalCfg))}`
  );
}

rmSync(CONFIG_DIR, { recursive: true, force: true });
rmSync(XDG, { recursive: true, force: true });

console.log(failed === 0 ? '\n✅ probe-permodel-variants 全绿' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
