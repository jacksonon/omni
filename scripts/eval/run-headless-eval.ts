/**
 * Headless eval（第十一节 P1）：用 `omni exec --output-format json` 跑任务组，
 * 直接消费结构化输出（result/cost_usd/duration_ms/num_turns/session_id/exit_code）
 * ——CI 可跑的轻量评测：mock 离线确定性（默认），真实 API 用 --real（限速/成本自担）。
 *
 * 用法：
 *   npx tsx scripts/eval/run-headless-eval.ts            # mock 离线
 *   npx tsx scripts/eval/run-headless-eval.ts --real     # 真实 API
 *
 * 报告落盘 eval-report.json（headless: true 标记区分普通 eval）。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const useReal = process.argv.includes('--real');

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

/** 真实 API 任务（通用能力冒烟；成本可控——3 个短任务） */
const HEADLESS_TASKS_REAL: HeadlessTask[] = [
  { name: '回答身份', prompt: '你是谁？一句话回答', resultIncludes: ['Omni'], minTurns: 1 },
  { name: '算术', prompt: '计算 17*23 并只输出数字结果', resultIncludes: ['391'], minTurns: 1 },
  { name: '读文件', prompt: '读取 package.json 并说出项目名', resultIncludes: ['omni'], minTurns: 2 },
];

function runExec(
  prompt: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string; json: any | null }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'src/index.ts', 'exec', prompt, '--output-format', 'json'], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
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

async function main(): Promise<void> {
  const tasks = useReal ? HEADLESS_TASKS_REAL : HEADLESS_TASKS_MOCK;
  console.log(`\n🧪 Omni Headless 评估（${useReal ? '真实 API' : 'mock 离线'} · omni exec --output-format json）· ${tasks.length} 任务\n`);
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
    const results: { name: string; ok: boolean; reason: string; ms: number; turns?: number; sessionId?: string }[] = [];
    for (const task of tasks) {
      const t0 = Date.now();
      const r = await runExec(task.prompt, env, task.timeoutMs ?? 120_000);
      const ms = Date.now() - t0;
      const problems: string[] = [];
      if (r.code !== 0) problems.push(`退出码 ${r.code}`);
      for (const inc of task.resultIncludes ?? []) {
        if (!(r.json?.result ?? '').includes(inc)) problems.push(`result 缺「${inc}」`);
      }
      if (task.minTurns && (r.json?.num_turns ?? 0) < task.minTurns) problems.push(`turns ${r.json?.num_turns} < ${task.minTurns}`);
      results.push({
        name: task.name,
        ok: problems.length === 0,
        reason: problems.join('、') || '通过',
        ms,
        turns: r.json?.num_turns,
        sessionId: r.json?.session_id,
      });
      console.log(`  ${results.at(-1)!.ok ? '✓' : '✗'} ${task.name}（${ms}ms${r.json ? ` · ${r.json.num_turns} 轮` : ''}）${results.at(-1)!.ok ? '' : `— ${problems.join('、')}`}`);
    }
    const passed = results.filter((r) => r.ok).length;
    const rate = ((passed / results.length) * 100).toFixed(0);
    console.log(`\n📊 完成率：${passed}/${results.length}（${rate}%）\n`);
    writeFileSync(
      path.join(ROOT, 'eval-report.json'),
      JSON.stringify({ mode: useReal ? 'headless-real' : 'headless-mock', runAt: new Date().toISOString(), total: results.length, passed, rate: `${rate}%`, results }, null, 2)
    );
    console.log('报告已写入 eval-report.json');
    process.exit(passed === results.length ? 0 : 1);
  } finally {
    stopMock?.();
  }
}

main().catch((err) => {
  console.error('Headless 评估失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
