/**
 * 评估运行器：跑一组任务，统计完成率，输出报告。
 *
 * 用法：
 *   npm run eval          —— 真实 API（用当前 omni.json 配置的模型）
 *   npm run eval:mock     —— 离线（自动起本地 mock server，确定性，可进 CI）
 *
 * 每个任务：spawn `npx tsx src/index.ts "<prompt>"`（真实 CLI 路径，含全部入口逻辑），
 * 捕获 stdout 做子串断言（expect 全命中 / notExpect 零出现），超时 kill。
 * 结果：逐任务 ✓/✗ + 完成率 + 报告落盘 eval-report.json。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVAL_TASKS_MOCK, EVAL_TASKS_REAL, type EvalTask } from './tasks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const useMock = process.argv.includes('--mock');
const tasks = useMock ? EVAL_TASKS_MOCK : EVAL_TASKS_REAL;

interface TaskResult {
  name: string;
  ok: boolean;
  reason: string;
  ms: number;
}

/** 起本地 mock server（独立端口），等待就绪后返回 kill 函数 */
async function startMock(): Promise<() => void> {
  const port = 8791;
  const child = spawn('node', ['scripts/mock-server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 轮询直到端口可连（mock 对 GET /v1/models 返回 404，所以「收到任何 HTTP 响应」即就绪）
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
      if (res.status > 0) break; // 服务器已响应（404 也算就绪）
    } catch {
      /* 未就绪，重试 */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('mock server 启动超时');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return () => child.kill();
}

function runTask(task: EvalTask, env: Record<string, string>): Promise<TaskResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('npx', ['tsx', 'src/index.ts', task.prompt], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => {
      if (process.env.OMNI_DEBUG) process.stderr.write(d);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), task.timeoutMs ?? 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const missing = task.expect.filter((e) => !out.includes(e));
      const leaked = (task.notExpect ?? []).filter((n) => out.includes(n));
      const ms = Date.now() - started;
      if (code === null) resolve({ name: task.name, ok: false, reason: '超时被终止', ms });
      else if (missing.length) resolve({ name: task.name, ok: false, reason: `缺少期望输出：${missing.join('、')}`, ms });
      else if (leaked.length) resolve({ name: task.name, ok: false, reason: `出现禁止输出：${leaked.join('、')}`, ms });
      else resolve({ name: task.name, ok: true, reason: '通过', ms });
    });
  });
}

async function main(): Promise<void> {
  console.log(`\n🧪 Omni 评估（${useMock ? 'mock 离线' : '真实 API'}）· 任务 ${tasks.length} 个\n`);
  const env: Record<string, string> = {};
  let stopMock: (() => void) | null = null;
  if (useMock) {
    console.log('  启动 mock server…');
    stopMock = await startMock();
    env.OMNI_BASE_URL = 'http://127.0.0.1:8791/v1';
    env.OMNI_API_KEY = 'mock';
    env.OMNI_MODEL = 'mock-model';
  }
  try {
    const results: TaskResult[] = [];
    for (const task of tasks) {
      const r = await runTask(task, env);
      results.push(r);
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}（${r.ms}ms）${r.ok ? '' : `— ${r.reason}`}`);
    }
    const okCount = results.filter((r) => r.ok).length;
    const rate = ((okCount / results.length) * 100).toFixed(0);
    console.log(`\n📊 完成率：${okCount}/${results.length}（${rate}%）\n`);
    const report = {
      mode: useMock ? 'mock' : 'real',
      runAt: new Date().toISOString(),
      total: results.length,
      passed: okCount,
      rate: `${rate}%`,
      results,
    };
    writeFileSync(path.join(ROOT, 'eval-report.json'), JSON.stringify(report, null, 2));
    console.log(`报告已写入 eval-report.json`);
    process.exit(okCount === results.length ? 0 : 1);
  } finally {
    stopMock?.();
  }
}

main().catch((err) => {
  console.error('评估失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
