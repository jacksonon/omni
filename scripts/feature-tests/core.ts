/**
 * 功能测试：核心 Agent 循环（端到端 mock）。
 * 启动本地 mock server + 真实 CLI 入口（tsx src/index.ts），量化断言输出。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestSuite } from './framework.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOCK_PORT = 48_000 + Math.floor(Math.random() * 800);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10000, msg = 'timeout'): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor: ${msg}`);
    await sleep(150);
  }
}

async function startMock(env: Record<string, string>): Promise<() => void> {
  const child = spawn('node', ['scripts/mock-server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(MOCK_PORT), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`).catch(() => null);
    return r !== null;
  }, 8000, 'mock server 启动');
  return () => child.kill();
}

function runCli(prompt: string, env: Record<string, string>, timeoutMs = 60_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'src/index.ts', prompt], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

export function coreSuite(): TestSuite {
  const suite = new TestSuite('核心 Agent 循环（端到端 mock）');
  const baseEnv: Record<string, string> = {
    OMNI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    OMNI_API_KEY: 'sk-mock',
    OMNI_MODEL: 'mock-model',
    OMNI_PERMISSION: 'full', // 单任务自动执行（不触发审批卡）
  };

  suite.test('端到端：工具调用 + 流式回答 + 任务完成', async () => {
    const stop = await startMock({});
    try {
      const { code, out } = await runCli('验证一下环境', baseEnv);
      suite.assert(code === 0, `进程退出码 0（实际 ${code}）`);
      suite.assert(out.includes('echo mock-ok'), '执行工具调用（run_command）');
      suite.assert(out.includes('mock 端到端验证通过'), '流式回答完成');
      suite.assert(out.includes('任务完成'), '最终回答含完成标记');
    } finally {
      stop();
    }
  });

  suite.test('工具：write_file 端到端（MOCK_WRITE）', async () => {
    const stop = await startMock({ MOCK_WRITE: '1' });
    try {
      const { code, out } = await runCli('创建文件', baseEnv);
      suite.assert(code === 0, `进程退出码 0（实际 ${code}）`);
      suite.assert(out.includes('undo-test.txt'), '调用 write_file');
      suite.assert(out.includes('mock 端到端验证通过'), '任务完成');
    } finally {
      stop();
    }
  });

  suite.test('工具：read_file 并行多读（MOCK_MULTIREAD）', async () => {
    const stop = await startMock({ MOCK_MULTIREAD: '1' });
    try {
      const { code, out } = await runCli('读取项目文件', baseEnv);
      suite.assert(code === 0, `进程退出码 0（实际 ${code}）`);
      suite.assert(out.includes('→ Explored'), `console 显示 read 调用（${out.includes('→ Explored')}）`);
      suite.assert(out.includes('mock 端到端验证通过'), '任务完成');
    } finally {
      stop();
    }
    // formatToolCall 纯函数：read_file → * Read 路径
    const { formatToolCall } = await import('../../src/output/format.js');
    const preview = formatToolCall('read_file', { path: 'src/foo.ts' });
    suite.assert(preview.includes('* Read src/foo.ts'), `formatToolCall 一行式（${preview}）`);
  });

  suite.test('计划模式：/plan 只读（不调用 run_command）', async () => {
    // buildToolSchemas 是纯函数，无需 mock
    const { buildToolSchemas } = await import('../../src/agent/loop.js');
    const { tools } = await import('../../src/tools/index.js');
    const schemas = buildToolSchemas(tools, true);
    const names = schemas.map((s) => s.function.name);
    suite.assert(!names.includes('run_command'), '计划模式无 run_command');
    suite.assert(names.includes('read_file') && names.includes('list_directory'), '计划模式有只读工具');
    suite.assert(names.length === 3, `只读工具 3 个（实际 ${names.length}）`);
    // 非计划模式返回全部工具
    const all = buildToolSchemas(tools, false);
    suite.assert(all.length === tools.length, `非计划模式返回全部（${all.length}/${tools.length}）`);
  });

  return suite;
}