/**
 * 功能测试：`omni exec` headless CLI（codex exec 对等：-o 落盘等 flags 解析 + 端到端）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestSuite } from './framework.js';
import { parseExecArgs } from '../../src/exec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOCK_PORT = 47_000 + Math.floor(Math.random() * 800);

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

export function execSuite(): TestSuite {
  const suite = new TestSuite('Headless CLI / omni exec（flags 解析 + -o 落盘端到端）');

  suite.test('exec flags 解析：-o 落盘（codex --output-last-message）', () => {
    const r1 = parseExecArgs(['任务']);
    suite.assert(r1.promptRaw === '任务' && r1.outputLastMessage == null, '缺省无落盘');
    const r2 = parseExecArgs(['任务', '-o', '/tmp/x.md']);
    suite.assert(r2.promptRaw === '任务' && r2.outputLastMessage === '/tmp/x.md', '-o 短 flag');
    const r3 = parseExecArgs(['--output-last-message=/tmp/y.md', '任务']);
    suite.assert(r3.promptRaw === '任务' && r3.outputLastMessage === '/tmp/y.md', '--flag=value 形态');
    const r4 = parseExecArgs(['任务', '--approve-for-me']);
    suite.assert(r4.approveForMe === true && r4.outputLastMessage == null, '互不干扰');
  });

  suite.test('端到端：exec -o <文件> 落盘最终回答（mock 服务）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-exec-o-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 6;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      const outfile = path.join(xdg, 'exec-last.md');
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn('npx', ['tsx', 'src/index.ts', 'exec', '验证 exec 落盘', '-o', outfile], {
          cwd: ROOT,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: xdg,
            OMNI_BASE_URL: `http://127.0.0.1:${port}/v1`,
            OMNI_API_KEY: 'sk-mock',
            OMNI_MODEL: 'mock-model',
            OMNI_PERMISSION: 'full',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        child.stdout.on('data', (d) => (acc += d));
        child.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      suite.assert(code === 0, `进程退出码 0（实际 ${code}）`);
      const body = fs.existsSync(outfile) ? fs.readFileSync(outfile, 'utf8') : '';
      suite.assert(body.includes('mock 端到端验证通过'), '-o 文件含最终回答');
    } finally {
      mock.kill();
    }
  });

  suite.test('omni doctor 顶层诊断命令（codex doctor 对等）', async () => {
    const { code, out } = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn('npx', ['tsx', 'src/index.ts', 'doctor'], {
        cwd: ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let acc = '';
      child.stdout.on('data', (d) => (acc += d));
      child.stderr.on('data', (d) => (acc += d));
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.on('close', (c) => {
        clearTimeout(timer);
        resolve({ code: c, out: acc });
      });
    });
    suite.assert(code === 0, `退出码 0（实际 ${code}）`);
    suite.assert(out.includes('环境诊断'), '打印诊断报告头');
    suite.assert(out.includes('Node：'), '含运行时信息');
  });

  return suite;
}
