/**
 * 探针：/model 与 /variants 的模型能力数据源联动（用户报告的两个 bug 的 CLI e2e）——
 *   bug2 ①启动模型的思考级别从 models.dev 快照查表推导（而非「无可切换」/写死五档）；
 *   bug2 ②/model add 新模型立即查表带出档位（cfg.reasoningEffortOptions 默认 [] 不再被
 *        误当成「显式关闭」短路查表）；
 *   ③未识别模型回退默认档位（low/medium/high/xhigh/max + none/auto，优先级 ③）；
 *   回切模型档位跟随端点。
 *
 *   A 启动查表：默认模型 glm-5.3（无任何显式级别配置）→ /variants 显示 none|auto|low|high|max
 *   B /model add gpt-5（表内）→ /variants 显示 none|auto|low|medium|high
 *   C /model add mock-x（表外）→ /variants 显示「当前模型没有可切换的思考级别。」
 *   D /model glm-5.3 回切 → /variants 恢复 none|auto|low|high|max
 *
 * 用法：npx tsx scripts/probe-tmp/probe-model-variants-e2e.ts
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const XDG = mkdtempSync(join(tmpdir(), 'omni-mv-xdg-'));
process.env.XDG_CONFIG_HOME = XDG; // 隔离用户级快照/记忆，保证查表走内置快照

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'omni-mv-cfg-'));
const CONFIG_FILE = join(CONFIG_DIR, 'omni.json');
// 无顶层 reasoningEffortOptions/reasoningEffort——全部走数据源查表；
// baseURL 指向不存在的本地端口即可（/variants 与 /model 纯本地操作不联网）
writeFileSync(
  CONFIG_FILE,
  JSON.stringify({
    model: 'glm-5.3',
    providers: {
      mock: { baseURL: 'http://127.0.0.1:8819/v1', apiKey: 'sk-probe', models: { 'glm-5.3': {} } },
    },
  })
);

let failed = 0;
function ok(cond: boolean, desc: string): void {
  console.log(`${cond ? '✅' : '❌'} ${desc}`);
  if (!cond) failed++;
}

const childEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', OMNI_CONFIG: CONFIG_FILE };
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
  '/variants', // A 启动模型查表推导
  '/model add gpt-5 --base-url http://127.0.0.1:8819/v1', // B 表内模型立即查表
  '/variants',
  '/model add mock-x --base-url http://127.0.0.1:8819/v1', // C 表外模型无可切换
  '/variants',
  '/model glm-5.3', // D 回切恢复
  '/variants',
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
ok(code === 0, `CLI 子进程退出码 0（实际 ${code}）`);
const all = out + err;
const ordered: [string, string][] = [
  ['A', '（级别：none|auto|low|high|max）'], // 启动模型 glm-5.3 查表推导（bug：此前「无可切换」/写死五档）
  ['B', '已添加并切换模型 → gpt-5'],
  ['B', '（级别：none|auto|low|medium|high）'], // /model add 立即查表（bug：此前被顶层 [] 短路成「无可切换」）
  ['C', '已添加并切换模型 → mock-x'],
  ['C', '（级别：none|auto|low|medium|high|xhigh|max）'], // 未识别模型：回退默认档位（优先级 ③）
  ['D', '已切换模型 → glm-5.3'],
  ['D', '（级别：none|auto|low|high|max）'], // 回切档位跟随端点
];
let last = -1;
for (const [tag, expect] of ordered) {
  const idx = all.indexOf(expect, Math.max(0, last + 1)); // 重复字符串按序取后续出现
  ok(idx > last, `${tag} 输出按序含「${expect}」`);
  last = idx;
}

rmSync(CONFIG_DIR, { recursive: true, force: true });
rmSync(XDG, { recursive: true, force: true });

console.log(failed === 0 ? '\n✅ probe-model-variants-e2e 全绿' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
