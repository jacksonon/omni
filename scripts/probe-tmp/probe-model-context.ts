/**
 * 数据源自动档探针（scripts/probe-tmp/probe-model-context.ts）：
 * · A 三级匹配：精确 / 裸 id / 后缀 + 未命中 + 大小写归一
 * · B 思考级别推导：effort 子集 ∩ 滑条池、toggle、DeepSeek 特判、未命中回退；
 *   resolveReasoningEffortOptions 显式 > 查表 > 历史默认
 * · C 端点展开接线：cfg 未配置 → 自动补 limit.context 与 reasoningEffortOptions，
 *   显式配置永远不被覆盖；attachRuntime 注入压缩预算 runOpts.context.contextLimit
 * · D /models refresh：mock fetch → 重建 → 写用户快照文件 → 热替换内存表 → 查表命中
 *
 * 隔离：先设 XDG_CONFIG_HOME 为临时目录再动态 import model-context（模块加载时会读
 * 用户快照文件），避免本机真实用户更新污染断言。
 * 用法：npx tsx scripts/probe-tmp/probe-model-context.ts （离线：快照已进 repo，fetch 被 mock）
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const XDG = mkdtempSync(join(tmpdir(), 'omni-modelctx-'));
process.env.XDG_CONFIG_HOME = XDG;

const mc = await import('../../src/config/model-context.js');
const {
  lookupModelContext,
  lookupModelContextWindow,
  deriveReasoningLevels,
  resolveReasoningEffortOptions,
  autoFillLimit,
  describeModelContextWindow,
  snapshotInfo,
  refreshModelContextSnapshot,
  userSnapshotFile,
} = mc;

let failed = 0;
function ok(cond: boolean, desc: string, extra?: unknown): void {
  console.log(`${cond ? '✅' : '❌'} ${desc}${cond || extra === undefined ? '' : ` —— ${JSON.stringify(extra)}`}`);
  if (!cond) failed++;
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/* ---------------- A 三级匹配 ---------------- */
{
  const glm = lookupModelContext('GLM-5.3'); // 大小写归一 + 精确（裸键）
  ok(!!glm && glm.entry.c === 1_000_000, `A① 精确 GLM-5.3 → c=1M: ${JSON.stringify(glm)}`);

  const gw = lookupModelContext('my-gateway/glm-5.3'); // 网关前缀剥掉后裸 id 命中
  ok(!!gw && [1_000_000].includes(gw.entry.c ?? -1), `A② 裸 id my-gateway/glm-5.3 命中: ${JSON.stringify(gw)}`);

  const suf = lookupModelContext('deepseek-chat') ?? lookupModelContext('deepseek/deepseek-v4-flash');
  ok(!!suf, `A③ 裸输入 deepseek-chat 命中（exact/bare/suffix 均可接受）: ${JSON.stringify(suf)}`);

  ok(lookupModelContext('totally-unknown-omni-probe-42') === null, 'A④ 未识别模型返回 null');
  ok(lookupModelContext('') === null && lookupModelContext(undefined) === null, 'A⑤ 空/undefined 输入返回 null');
  ok(lookupModelContextWindow('glm-5.3') === 1_000_000 && lookupModelContextWindow('nope-x') === undefined, 'A⑥ lookupModelContextWindow 未命中 undefined');
}

/* ---------------- B 思考级别推导 ---------------- */
{
  ok(
    eq(deriveReasoningLevels('glm-5.3'), ['none', 'auto', 'low', 'high', 'max']),
    `B① GLM effort 映射 none/auto/low/high/max: ${JSON.stringify(deriveReasoningLevels('glm-5.3'))}`
  );
  const gpt = deriveReasoningLevels('gpt-5');
  ok(
    eq(gpt, ['none', 'auto', 'low', 'medium', 'high']),
    `B② GPT-5 无 xhigh/max（minimal 被 Omni 滑条池丢弃）: ${JSON.stringify(gpt)}`
  );
  ok(eq(deriveReasoningLevels('glm-4.6'), ['none', 'auto']), `B③ toggle 型只有开关两档: ${JSON.stringify(deriveReasoningLevels('glm-4.6'))}`);
  // DeepSeek：以快照数据为准（优先级 ②）——表内带 effort 的 V4 系列按表推导；
  // 表内无 effort（如 deepseek-chat 仅 toggle）仍只有开关两档；未命中表 → undefined
  const dsKeys = ['deepseek-v4-flash-0731', 'deepseek/my-model', 'deepseek-chat'];
  const ds = dsKeys.map((k) => deriveReasoningLevels(k));
  ok(
    ds[0] !== undefined && eq(ds[0], ['none', 'auto', 'high', 'max']) && ds[1] === undefined && ds[2] !== undefined && eq(ds[2], ['none', 'auto']),
    `B④ DeepSeek 表内 effort 按表推导 / 无 effort 仅开关 / 未命中 undefined: ${JSON.stringify({ keys: dsKeys, res: ds })}`
  );
  ok(
    eq(deriveReasoningLevels('deepseek-v4-flash'), ['none', 'auto', 'low', 'high', 'max']),
    `B⑭ deepseek-v4-flash 裸 id 查表 → none/auto/low/high/max: ${JSON.stringify(deriveReasoningLevels('deepseek-v4-flash'))}`
  );
  ok(deriveReasoningLevels('totally-unknown-omni-probe-42') === undefined, 'B⑤ 未命中返回 undefined');

  ok(eq(resolveReasoningEffortOptions(['low'], 'glm-5.3'), ['low']), 'B⑥ 显式配置原样优先');
  ok(eq(resolveReasoningEffortOptions([], 'glm-5.3'), []), 'B⑦ 显式空数组 = 明确关闭级别切换（不查表不猜档）');
  ok(
    eq(resolveReasoningEffortOptions(undefined, 'totally-unknown-omni-probe-42'), ['none', 'auto', 'low', 'medium', 'high', 'xhigh', 'max']),
    'B⑧ 全部未命中 → 默认档位（low/medium/high/xhigh/max + none/auto）'
  );
  ok(
    eq(resolveReasoningEffortOptions(undefined, 'glm-5.3'), ['none', 'auto', 'low', 'high', 'max']),
    'B⑬ 未配置（undefined）→ 查表推导'
  );
  const l1 = autoFillLimit({ context: 12345 }, 'glm-5.3');
  const l2 = autoFillLimit({ output: 8192 }, 'glm-5.3');
  ok(
    l1 !== undefined && l1.context === 12345 && !('output' in l1) &&
      l2 !== undefined && l2.context === 1_000_000 && l2.output === 8192 &&
      autoFillLimit(undefined, 'nope-x') === undefined,
    `B⑨ autoFillLimit 手动优先/只补缺失 context/output 不猜: ${JSON.stringify([l1, l2])}`
  );
  ok(describeModelContextWindow(12345, 'glm-5.3').source === 'manual', 'B⑩ describe 手动配置来源');
  ok(describeModelContextWindow(undefined, 'totally-unknown-omni-probe-42').source === 'fallback', 'B⑪ describe 兜底来源');
  ok(snapshotInfo().source === 'builtin' && snapshotInfo().count >= 1000, 'B⑫ 初始状态：内置快照（隔离环境无用户文件）');
}

/* ---------------- C 端点展开接线（loadConfig + attachRuntime） ---------------- */
{
  const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'omni-modelctx-cfg-'));
  writeFileSync(
    join(CONFIG_DIR, 'omni.json'),
    JSON.stringify({
      model: 'glm-5.3',
      providers: {
        big: {
          baseURL: 'https://api.example.com/v1',
          apiKey: 'sk-test',
          models: {
            'glm-5.3': {},
            'gpt-tuned': { reasoningEffortOptions: ['low'], limit: { context: 12345 } },
            'unknown-x': {},
          },
        },
      },
    })
  );
  const oldCwd = process.cwd();
  const { loadConfig } = await import('../../src/config/index.js');
  const { prepareRun, attachRuntime } = await import('../../src/main.js');
  process.chdir(CONFIG_DIR);
  try {
    const cfg = loadConfig();
    ok(cfg.reasoningEffortOptions.length === 0, `C① 未配置语义 = 空数组（由数据源推导）: ${JSON.stringify(cfg.reasoningEffortOptions)}`);
    const ctx = prepareRun({});
    await attachRuntime(ctx, {} as never);
    const models = ctx.runOpts.models ?? [];
    const glm = models.find((m) => m.name === 'glm-5.3');
    const tuned = models.find((m) => m.name === 'gpt-tuned');
    const unk = models.find((m) => m.name === 'unknown-x');
    ok(glm?.limit?.context === 1_000_000, `C② 自动档 limit.context 从数据源补缺: ${JSON.stringify(glm?.limit)}`);
    ok(eq(glm?.reasoningEffortOptions, ['none', 'auto', 'low', 'high', 'max']), `C③ 自动档思考级别选项: ${JSON.stringify(glm?.reasoningEffortOptions)}`);
    ok(tuned?.limit?.context === 12345 && eq(tuned?.reasoningEffortOptions, ['low']), `C④ 显式配置不被覆盖: ${JSON.stringify({ limit: tuned?.limit, opts: tuned?.reasoningEffortOptions })}`);
    ok(!unk?.limit && eq(unk?.reasoningEffortOptions, ['none', 'auto', 'low', 'medium', 'high', 'xhigh', 'max']), `C⑤ 未知模型回退默认档位、无 limit`);
    ok(ctx.runOpts.context?.contextLimit === 1_000_000, `C⑥ attachRuntime 注入压缩预算（当前模型窗口）: ${ctx.runOpts.context?.contextLimit}`);
    ok(
      eq(ctx.runOpts.reasoningEffortOptions, ['none', 'auto', 'low', 'high', 'max']),
      `C⑧ 默认模型端点档位透传 runOpts（/variants 首屏）: ${JSON.stringify(ctx.runOpts.reasoningEffortOptions)}`
    );
    const info = describeModelContextWindow(models.find((m) => m.name === 'glm-5.3')?.limit?.context, 'glm-5.3');
    ok(info.source === 'manual' && info.value === 1_000_000, 'C⑦ /status 窗口描述（手动标记来自补缺后的生效值）');
  } finally {
    process.chdir(oldCwd);
  }
}

/* ---------------- D /models refresh 全流程（mock fetch，不联网） ---------------- */
{
  const fakeApi = {
    zai: {
      models: {
        'glm-probe-9': {
          modalities: { input: ['text'] },
          limit: { context: 500000 },
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['low', 'max'] }],
        },
        tiny: { modalities: { input: ['text'] }, limit: { context: 2048 } }, // < 4096 → 剔除
        ocr: { modalities: { input: ['image'] }, limit: { context: 99999 } }, // 非文本输入 → 剔除
      },
    },
    openrouter: {
      models: {
        'zai/glm-probe-9': { modalities: { input: ['text'] }, limit: { context: 111 } }, // 聚合低优，被官方覆盖
      },
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, json: async () => fakeApi })) as typeof fetch;
  try {
    const res = await refreshModelContextSnapshot();
    ok(res.ok && res.info.source === 'user' && res.info.count >= 1, `D① refresh 成功且来源=用户更新: ${JSON.stringify(res.ok ? res.info : res.error)}`);
    ok(existsSync(userSnapshotFile()), `D② 用户快照文件已写入: ${userSnapshotFile()}`);
    const hit = lookupModelContext('glm-probe-9');
    ok(hit?.entry.c === 500000 && hit.matchType === 'exact', `D③ 热替换后查表命中新条目（无前缀输入命中表键）: ${JSON.stringify(hit)}`);
    ok(lookupModelContext('tiny') === null && lookupModelContext('ocr') === null, 'D④ 过滤规则生效（context<4096 / 非文本输入剔除）');
    const agg = lookupModelContext('zai/glm-probe-9');
    ok(agg?.entry.c === 500000, `D⑤ 官方 qualified 覆盖聚合条目: ${JSON.stringify(agg)}`);
    ok(eq(deriveReasoningLevels('glm-probe-9'), ['none', 'auto', 'low', 'max']), `D⑥ refresh 后的档位推导同步生效: ${JSON.stringify(deriveReasoningLevels('glm-probe-9'))}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 隔离环境清理
try {
  rmSync(XDG, { recursive: true, force: true });
} catch {
  /* 忽略 */
}

console.log(failed === 0 ? '\n✅ 数据源自动档探针全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
