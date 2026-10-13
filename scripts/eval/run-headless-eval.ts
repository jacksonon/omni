/**
 * Headless eval（第十一节 P1）：用 `omni exec --output-format json` 跑任务组，
 * 直接消费结构化输出（result/cost_usd/duration_ms/num_turns/session_id/exit_code）
 * ——CI 可跑的轻量评测：mock 离线确定性（默认），真实 API 用 --real（限速/成本自担）。
 *
 * 用法：
 *   npx tsx scripts/eval/run-headless-eval.ts                          # mock 离线
 *   npx tsx scripts/eval/run-headless-eval.ts --real                   # 真实 API
 *   npx tsx scripts/eval/run-headless-eval.ts --repeat 3               # 每任务串行跑 3 次 + p50/p90/p99
 *   npx tsx scripts/eval/run-headless-eval.ts --real --compare A,B     # 多模型对比（repeat 作用于每个模型）
 *
 * 报告落盘 eval-report.json（headless: true 标记区分普通 eval）。
 * --compare 模式落盘 eval-compare.json（与普通 eval 对标）。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const useReal = process.argv.includes('--real');

// --repeat N：每任务串行跑 N 次（串行，避免真实 API 限流；默认 1）
const repeatIdx = process.argv.indexOf('--repeat');
let repeat = 1;
if (repeatIdx >= 0) {
  const n = Number(process.argv[repeatIdx + 1]);
  if (!Number.isInteger(n) || n < 1) {
    console.error('--repeat 后须跟正整数（如 --repeat 3）');
    process.exit(1);
  }
  repeat = n;
}
// --compare m1,m2：多模型对比（同任务组各模型跑一遍；repeat 作用于每个模型）
const compareIdx = process.argv.indexOf('--compare');
const compareModels = compareIdx >= 0
  ? (process.argv[compareIdx + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  : [];

interface HeadlessTask {
  name: string;
  prompt: string;
  /** 结果 JSON 必含字段断言：`result 含子串` / `num_turns ≥ 1` 形式 */
  resultIncludes?: string[];
  minTurns?: number;
  timeoutMs?: number;
}

/** mock 任务（与 mock-server 确定性输出对齐；exec 走完整入口链路） */
const HEADLESS_TASKS_MOCK: HeadlessTask[] = [
  {
    name: '工具调用回合',
    prompt: '执行一个命令验证运行环境',
    resultIncludes: ['任务完成', '端到端验证通过'],
    minTurns: 1,
  },
  {
    name: '最终回答',
    prompt: '告诉我你完成了什么',
    resultIncludes: ['mock 端到端验证'],
    minTurns: 1,
  },
];

/** 真实 API 任务（通用能力冒烟；成本可控——5 个短任务） */
const HEADLESS_TASKS_REAL: HeadlessTask[] = [
  { name: '回答身份', prompt: '你是谁？一句话回答', resultIncludes: ['Omni'], minTurns: 1 },
  { name: '算术', prompt: '计算 17*23 并只输出数字结果', resultIncludes: ['391'], minTurns: 1 },
  { name: '读文件', prompt: '读取 package.json 并说出项目名', resultIncludes: ['omni'], minTurns: 1 },
  { name: '推理', prompt: '一个篮子里有 3 个苹果，拿走 2 个，还剩几个？只输出阿拉伯数字', resultIncludes: ['1'], minTurns: 1 },
  { name: '代码搜索', prompt: '在仓库中搜索 runAgent 函数的定义在哪个文件，只回答文件名', resultIncludes: ['loop'], minTurns: 1 },
];

interface Tokens {
  prompt: number;
  completion: number;
  cached: number;
}

/** 单次重复采样的原始记录（旧 results 行形状 + repeat 序号/时延 additive） */
interface RepeatSample {
  name: string;
  repeat: number;
  ok: boolean;
  reason: string;
  /** 墙钟耗时（旧 ms 字段，保持原口径） */
  ms: number;
  /** 分位统计用：优先 json.duration_ms，缺失回退墙钟 */
  durationMs: number;
  /** 首 token 延迟均值（缺失兼容，见 readTtftMs） */
  ttftMs: number | null;
  turns?: number;
  sessionId?: string;
  tokens?: Tokens;
  costUsd?: number;
  idleTurns?: number;
  errorType?: string;
}

/** p50/p90/p99 三件套（全缺失时全 null） */
interface Quantiles {
  p50: number | null;
  p90: number | null;
  p99: number | null;
}

/** 单任务聚合（含每次明细） */
interface TaskStats {
  name: string;
  repeats: number;
  passed: number;
  rate: string;
  /** 端到端时长分位（ms） */
  latency: Quantiles;
  /** 首 token 延迟分位（ms；全缺失则全 null） */
  ttft: Quantiles;
  /** ttft 缺失样本数（分位统计时跳过） */
  ttftMissing: number;
  avgTokens: number;
  avgCostUsd: number;
  samples: RepeatSample[];
}

/** nearest-rank 百分位（sorted 须升序；空数组 → null） */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/** 分位三件套（内部拷贝排序，不动原数组） */
function quantiles(values: number[]): Quantiles {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p90: percentile(sorted, 90), p99: percentile(sorted, 99) };
}

/** 数字字段读取（非有限数字 → undefined） */
function readNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * ttft 读取（缺失兼容：扁平 ttft_ms → 嵌套 latency.ttftMs → null）。
 * exec json 的时延字段由另一路在加；缺失时分位统计跳过并在输出注明。
 */
function readTtftMs(json: any): number | null {
  return readNum(json?.ttft_ms) ?? readNum(json?.latency?.ttftMs) ?? null;
}

/** 分位展示（ms 取整；无数据 → '暂无数据'） */
function fmtQ(q: Quantiles): string {
  if (q.p50 === null || q.p90 === null || q.p99 === null) return '暂无数据';
  return `${Math.round(q.p50)}/${Math.round(q.p90)}/${Math.round(q.p99)}ms`;
}

/**
 * 小样本时延摘要（防「N 小 → p99 = max」被误读成真 99 分位）：
 * n < 20 → `p50=<中位>ms [min–max <最小>–<最大>ms]`（n=1 只报 p50）；
 * n ≥ 20 → 沿用 p50/p90/p99。中位数比极值对冒烟评测更有信息量。
 */
const SMALL_SAMPLE = 20;
function fmtLatency(values: number[]): string {
  if (values.length === 0) return '暂无数据';
  const sorted = [...values].sort((a, b) => a - b);
  const median = percentile(sorted, 50)!;
  if (sorted.length < SMALL_SAMPLE) {
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    return min === max
      ? `p50=${Math.round(median)}ms（n=${sorted.length}）`
      : `p50=${Math.round(median)}ms [min–max ${Math.round(min)}–${Math.round(max)}ms]`;
  }
  return `p50/p90/p99=${fmtQ(quantiles(values))}`;
}

function runExec(
  prompt: string,
  env: Record<string, string>,
  timeoutMs: number,
  model?: string
): Promise<{ code: number | null; stdout: string; stderr: string; json: any | null }> {
  return new Promise((resolve) => {
    const args = ['tsx', 'src/index.ts', 'exec', prompt, '--output-format', 'json'];
    if (model) args.push('-m', model);
    const child = spawn('npx', args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // 独立进程组：超时 kill 必须带走 npx 壳 + 内层 tsx 真进程，否则壳死而真进程
      //  holding 住管道，close 事件等它跑完才触发（超时形同虚设，还在后台烧 token）
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      let json: any = null;
      try {
        json = JSON.parse(stdout.trim().split('\n').pop() ?? '');
      } catch {
        // stdout 非 JSON → 解析失败（失败用例如实报告）
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}

async function startMock(): Promise<() => void> {
  const port = 8793;
  const child = spawn('node', ['scripts/mock-server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/models`);
      if (r.status > 0) break;
    } catch {
      /* 未就绪 */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('mock server 启动超时');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return () => child.kill();
}

/** 单任务串行跑 repeat 次 → 样本 + 聚合 */
async function runTaskRepeats(task: HeadlessTask, env: Record<string, string>, model?: string): Promise<TaskStats> {
  const samples: RepeatSample[] = [];
  for (let i = 1; i <= repeat; i++) {
    const t0 = Date.now();
    const r = await runExec(task.prompt, env, task.timeoutMs ?? 120_000, model);
    const ms = Date.now() - t0;
    const problems: string[] = [];
    if (r.code !== 0) problems.push(`退出码 ${r.code}`);
    for (const inc of task.resultIncludes ?? []) {
      if (!(r.json?.result ?? '').includes(inc)) problems.push(`result 缺「${inc}」`);
    }
    if (task.minTurns && (r.json?.num_turns ?? 0) < task.minTurns) problems.push(`turns ${r.json?.num_turns} < ${task.minTurns}`);
    const t = r.json?.tokens as Tokens | undefined;
    samples.push({
      name: task.name,
      repeat: i,
      ok: problems.length === 0,
      reason: problems.join('、') || '通过',
      ms,
      durationMs: readNum(r.json?.duration_ms) ?? ms,
      ttftMs: readTtftMs(r.json),
      turns: readNum(r.json?.num_turns),
      sessionId: typeof r.json?.session_id === 'string' ? r.json.session_id : undefined,
      tokens: t,
      costUsd: readNum(r.json?.cost_usd),
      idleTurns: readNum(r.json?.idle_turns),
      errorType: (r.json?.error_type as string) ?? 'unknown',
    });
  }
  const passed = samples.filter((s) => s.ok).length;
  const ttftVals = samples.map((s) => s.ttftMs).filter((v): v is number => v !== null);
  return {
    name: task.name,
    repeats: samples.length,
    passed,
    rate: `${((passed / samples.length) * 100).toFixed(0)}%`,
    latency: quantiles(samples.map((s) => s.durationMs)),
    ttft: quantiles(ttftVals),
    ttftMissing: samples.length - ttftVals.length,
    avgTokens: samples.reduce((a, s) => a + (s.tokens?.prompt ?? 0) + (s.tokens?.completion ?? 0), 0) / samples.length,
    avgCostUsd: samples.reduce((a, s) => a + (s.costUsd ?? 0), 0) / samples.length,
    samples,
  };
}

/** 每任务一行：通过率 x/N · 时延摘要（小样本用中位+极值）· ttft 摘要 · tokens 均值 · $均值 */
function printTaskLine(st: TaskStats): void {
  const durs = st.samples.map((s) => s.durationMs);
  const ttftVals = st.samples.map((s) => s.ttftMs).filter((v): v is number => v !== null);
  const ttftPart = ttftVals.length === 0
    ? 'ttft 暂无数据（exec 未上报 ttft_ms，已跳过）'
    : `ttft ${fmtLatency(ttftVals)}${st.ttftMissing > 0 ? `（${st.ttftMissing} 次缺失已跳过）` : ''}`;
  console.log(`  ${st.passed === st.repeats ? '✓' : '✗'} ${st.name}（通过 ${st.passed}/${st.repeats} · 时长 ${fmtLatency(durs)} · ${ttftPart} · ${Math.round(st.avgTokens).toLocaleString()} tok均值 · $${st.avgCostUsd.toFixed(4)}均值）`);
  for (const s of st.samples) {
    if (!s.ok) console.log(`    ✗ 第 ${s.repeat} 次 — ${s.reason}`);
  }
}

interface SuiteResult {
  taskStats: TaskStats[];
  /** 旧口径 results：逐样本一行（repeat=1 时与旧版同形） */
  results: {
    name: string; repeat: number; ok: boolean; reason: string; ms: number; turns?: number; sessionId?: string;
    tokens?: Tokens; costUsd?: number; idleTurns?: number; errorType?: string;
  }[];
  totalTokens: number;
  totalCost: number;
  totalIdle: number;
  errorBins: Map<string, number>;
}

/** 一组任务 × repeat 次（全串行）→ 逐任务行 + 汇总数据 */
async function runSuite(tasks: HeadlessTask[], env: Record<string, string>, model?: string): Promise<SuiteResult> {
  const taskStats: TaskStats[] = [];
  for (const task of tasks) {
    const st = await runTaskRepeats(task, env, model);
    taskStats.push(st);
    printTaskLine(st);
  }
  const samples = taskStats.flatMap((t) => t.samples);
  // 1.0 P1-10：成本效率报告——token/成本/空转回合/失败类别（harness-model pair 口径）
  const results = samples.map((s) => ({
    name: s.name,
    repeat: s.repeat,
    ok: s.ok,
    reason: s.reason,
    ms: s.ms,
    turns: s.turns,
    sessionId: s.sessionId,
    tokens: s.tokens,
    costUsd: s.costUsd,
    idleTurns: s.idleTurns,
    errorType: s.errorType,
  }));
  let totalTokens = 0;
  let totalCost = 0;
  let totalIdle = 0;
  const errorBins = new Map<string, number>();
  for (const s of samples) {
    totalTokens += (s.tokens?.prompt ?? 0) + (s.tokens?.completion ?? 0);
    totalCost += s.costUsd ?? 0;
    totalIdle += s.idleTurns ?? 0;
    const key = s.errorType ?? 'unknown';
    errorBins.set(key, (errorBins.get(key) ?? 0) + 1);
  }
  return { taskStats, results, totalTokens, totalCost, totalIdle, errorBins };
}

/** 汇总输出：完成率/成本/全局分位 + 末尾总表 */
function printSummary(suite: SuiteResult): void {
  const { taskStats, results, totalTokens, totalCost, totalIdle, errorBins } = suite;
  const passed = results.filter((r) => r.ok).length;
  const rate = ((passed / results.length) * 100).toFixed(0);
  const costPerRun = totalCost / results.length;
  console.log(`\n📊 完成率：${passed}/${results.length}（${rate}%）${repeat > 1 ? ` · repeat=${repeat}` : ''}`);
  console.log(`💰 成本：$${totalCost.toFixed(4)} 合计 · $${costPerRun.toFixed(4)}/${repeat > 1 ? '次' : '任务'} · ${totalTokens.toLocaleString()} tokens · 空转回合 ${totalIdle}`);
  const allDur = taskStats.flatMap((t) => t.samples.map((s) => s.durationMs));
  const allTtft = taskStats.flatMap((t) => t.samples.map((s) => s.ttftMs).filter((v): v is number => v !== null));
  const ttftMissing = allDur.length - allTtft.length;
  console.log(`⏱️ 时长 ${fmtLatency(allDur)}（${allDur.length} 次采样）`);
  if (allTtft.length > 0) {
    console.log(`⚡ ttft ${fmtLatency(allTtft)}${ttftMissing > 0 ? `（${ttftMissing} 次缺失已跳过）` : ''}`);
  } else {
    console.log('⚡ ttft 暂无数据（exec 未上报 ttft_ms，分位统计已跳过）');
  }
  if (errorBins.size > 0) {
    console.log(`🧭 失败类别：${[...errorBins.entries()].map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  }
  // 末尾总表
  console.log('\n📋 分任务汇总：');
  console.log(`  ${'任务'.padEnd(8)}${'通过'.padEnd(7)}${'时延'.padEnd(40)}${'ttft'.padEnd(40)}${'tok均值'.padEnd(9)}$均值`);
  for (const st of taskStats) {
    const durs = st.samples.map((s) => s.durationMs);
    const ttftVals = st.samples.map((s) => s.ttftMs).filter((v): v is number => v !== null);
    console.log(`  ${st.name.padEnd(8)}${`${st.passed}/${st.repeats}`.padEnd(7)}${fmtLatency(durs).padEnd(40)}${fmtLatency(ttftVals).padEnd(40)}${Math.round(st.avgTokens).toLocaleString().padEnd(9)}$${st.avgCostUsd.toFixed(4)}`);
  }
  console.log('');
}

/** 全局分位（报告落盘用；旧字段不动，新增 repeats/latency/ttft/perTask） */
function buildReport(suite: SuiteResult, extra: Record<string, unknown>): Record<string, unknown> {
  const { taskStats, results, totalTokens, totalCost, totalIdle, errorBins } = suite;
  const passed = results.filter((r) => r.ok).length;
  const rate = ((passed / results.length) * 100).toFixed(0);
  const allDur = taskStats.flatMap((t) => t.samples.map((s) => s.durationMs));
  const allTtft = taskStats.flatMap((t) => t.samples.map((s) => s.ttftMs).filter((v): v is number => v !== null));
  return {
    ...extra,
    runAt: new Date().toISOString(),
    total: results.length,
    passed,
    rate: `${rate}%`,
    costUsd: Number(totalCost.toFixed(6)),
    tokens: totalTokens,
    idleTurns: totalIdle,
    errorBins: Object.fromEntries(errorBins),
    results,
    repeats: repeat,
    latency: quantiles(allDur),
    ttft: quantiles(allTtft),
    ttftMissing: allDur.length - allTtft.length,
    perTask: taskStats,
  };
}

/** --compare：多模型对比（各模型串行跑同一任务组；mock 下共用一个 server） */
async function runCompare(tasks: HeadlessTask[]): Promise<void> {
  if (compareModels.length < 2) {
    console.error('--compare 至少需要两个模型：--compare modelA,modelB');
    process.exit(1);
  }
  console.log(`\n🧪 Omni Headless 多模型对比（${useReal ? '真实 API' : 'mock 离线'} · repeat=${repeat}）· 模型 ${compareModels.join(' vs ')} · 任务 ${tasks.length} 个\n`);
  const env: Record<string, string> = {};
  let stopMock: (() => void) | null = null;
  if (!useReal) {
    stopMock = await startMock();
    env.OMNI_BASE_URL = 'http://127.0.0.1:8793/v1';
    env.OMNI_API_KEY = 'sk-mock';
    env.OMNI_MODEL = 'mock-model';
    env.OMNI_PERMISSION = 'full';
  }
  try {
    const perModel: { model: string; suite: SuiteResult }[] = [];
    for (const model of compareModels) {
      console.log(`── ${model} ──`);
      const suite = await runSuite(tasks, env, model);
      perModel.push({ model, suite });
      console.log('');
    }
    console.log('📊 对比结果：');
    console.log(`  ${'模型'.padEnd(20)}${'完成率'.padEnd(12)}${'时延'.padEnd(40)}${'ttft'.padEnd(40)}$均值/次`);
    for (const { model, suite } of perModel) {
      const passed = suite.results.filter((r) => r.ok).length;
      const rate = ((passed / suite.results.length) * 100).toFixed(0);
      const allDur = suite.taskStats.flatMap((t) => t.samples.map((s) => s.durationMs));
      const allTtft = suite.taskStats.flatMap((t) => t.samples.map((s) => s.ttftMs).filter((v): v is number => v !== null));
      const avgCost = suite.totalCost / suite.results.length;
      console.log(`  ${model.padEnd(20)}${`${passed}/${suite.results.length}（${rate}%）`.padEnd(12)}${fmtLatency(allDur).padEnd(40)}${fmtLatency(allTtft).padEnd(40)}$${avgCost.toFixed(4)}`);
    }
    console.log('');
    writeFileSync(
      path.join(ROOT, 'eval-compare.json'),
      JSON.stringify({
        mode: useReal ? 'headless-real' : 'headless-mock',
        runAt: new Date().toISOString(),
        models: compareModels,
        repeats: repeat,
        perModel: perModel.map(({ model, suite }) => ({ model, ...buildReport(suite, {}) })),
      }, null, 2)
    );
    console.log('报告已写入 eval-compare.json');
    process.exit(perModel.every(({ suite }) => suite.results.every((r) => r.ok)) ? 0 : 1);
  } finally {
    stopMock?.();
  }
}

async function main(): Promise<void> {
  const tasks = useReal ? HEADLESS_TASKS_REAL : HEADLESS_TASKS_MOCK;
  // --compare：多模型对比分支（独立流程，写 eval-compare.json）
  if (compareModels.length >= 1) return runCompare(tasks);
  console.log(`\n🧪 Omni Headless 评估（${useReal ? '真实 API' : 'mock 离线'} · omni exec --output-format json · repeat=${repeat}）· ${tasks.length} 任务\n`);
  const env: Record<string, string> = {};
  let stopMock: (() => void) | null = null;
  if (!useReal) {
    stopMock = await startMock();
    env.OMNI_BASE_URL = 'http://127.0.0.1:8793/v1';
    env.OMNI_API_KEY = 'sk-mock';
    env.OMNI_MODEL = 'mock-model';
    env.OMNI_PERMISSION = 'full';
  }
  try {
    const suite = await runSuite(tasks, env);
    printSummary(suite);
    writeFileSync(
      path.join(ROOT, 'eval-report.json'),
      JSON.stringify(buildReport(suite, { mode: useReal ? 'headless-real' : 'headless-mock' }), null, 2)
    );
    console.log('报告已写入 eval-report.json');
    process.exit(suite.results.every((r) => r.ok) ? 0 : 1);
  } finally {
    stopMock?.();
  }
}

main().catch((err) => {
  console.error('Headless 评估失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
