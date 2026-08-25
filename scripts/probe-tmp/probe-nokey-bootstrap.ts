/**
 * 探针：无 API Key 引导启动（Windows 桌面应用「后端服务启动超时」修复验证）。
 *
 * 场景 = 全新 Windows 机器首次安装：没有任何 omni 配置文件、没有 OMNI_API_KEY /
 * OPENAI_API_KEY 环境变量。修复前：prepareRun 抛「未找到 API Key」→ 后端进程秒退
 * → Electron 壳傻等 20s 报笼统的「后端服务启动超时」，用户永远到不了设置面板。
 * 修复后：
 *   A. web 服务照常启动（占位 Key），/api/status 200；
 *   B. 发送消息得到优雅失败（run.end，进程不崩）；
 *   C. 设置面板填入真实 Key（POST /api/settings）→ 同一会话重发消息成功。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSK = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MOCK_PORT = 49581;
const WEB_PORT = 49582;
const BASE = `http://127.0.0.1:${WEB_PORT}`;

let failCount = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failCount++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

function startProcess(cmd: string, args: string[], env: Record<string, string>): ChildProcess {
  const stripped: NodeJS.ProcessEnv = { ...process.env };
  // 模拟全新机器：剥掉一切密钥来源（spawn env 里 undefined 不会遮蔽继承值，必须显式置空）
  delete stripped.OMNI_API_KEY;
  delete stripped.OPENAI_API_KEY;
  const child = spawn(cmd, args, {
    env: { ...stripped, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  (child as any).__log = () => out;
  return child;
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
  const XDG = mkdtempSync(path.join(os.tmpdir(), 'omni-nokey-'));
  const mock = startProcess(process.execPath, [path.join(ROOT, 'scripts', 'mock-server.mjs')], { PORT: String(MOCK_PORT) });
  let web: ChildProcess | null = null;
  try {
    await waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${MOCK_PORT}/__mock/config`, { method: 'POST', body: '{}' })).status === 200; }
      catch { return false; }
    }, 10000, 'mock server 启动');

    // 无任何配置、无任何 Key——修复前这里起不来
    const t0dbg = Date.now();
    web = startProcess(
      process.execPath,
      [TSK, path.join(ROOT, 'src', 'index.ts'), 'web', '--no-open', '--port', String(WEB_PORT)],
      {
        XDG_CONFIG_HOME: XDG,
        OMNI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
        OMNI_MODEL: 'mock-model',
        OMNI_API_KEY: '',
        OPENAI_API_KEY: '',
      }
    );

    let started = false;
    try {
      await waitFor(async () => {
        try {
          return (await fetch(`${BASE}/api/status`)).status === 200;
        } catch (e) {
          if (Date.now() - t0dbg > 6000 && Date.now() - t0dbg < 6300) {
            console.error(`  [debug] still waiting: ${e instanceof Error ? (e as Error & { cause?: unknown }).cause ?? e.message : e} · childOut=${web.__log().length}B`);
          }
          return false;
        }
      }, 15000, 'web 服务启动（无 Key）');
      started = true;
    } catch (e) {
      console.error(`  [debug] waitFor 异常：${e instanceof Error ? e.message : e}`);
    }
    console.error(`  [debug] child final log:\n${web.__log().slice(-800)}`);
    check('A1 无 Key 时服务照常启动（不再秒退）', started,
      `pid=${web.pid} exitCode=${web.exitCode} log=[${web.__log().slice(-600)}]`);

    if (!started) throw new Error('服务未启动，后续用例无法执行');

    const st = await (await fetch(`${BASE}/api/status`)).json();
    check('A2 status 正常返回模型信息', st.model === 'mock-model', JSON.stringify(st).slice(0, 120));
    check('A3 启动日志含无 Key 提示', web.__log().includes('未配置 API Key'));

    // B. 发送消息：mock 网关不校验 Key（真实网关此处会 401）——重点验证
    // 「无 Key 服务不崩、链路照常走完」，这正是修复要保证的引导体验
    const s = await fetch(`${BASE}/api/sessions`, { method: 'POST', body: '{}' });
    const sid = ((await s.json()) as { id: string }).id;
    const send = await fetch(`${BASE}/api/sessions/${sid}/messages`, { method: 'POST', body: JSON.stringify({ text: '你好' }) });
    check('B1 发送消息被受理', send.status === 202, 'status=' + send.status);
    let gotAnswer = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const hist = (await (await fetch(`${BASE}/api/sessions/${sid}/messages`)).json()) as { messages?: { role: string; content?: string }[] };
      const last = hist.messages?.[hist.messages.length - 1];
      if (last && last.role === 'assistant' && typeof last.content === 'string' && last.content.includes('任务完成')) {
        gotAnswer = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    check('B2 无 Key 发消息链路完整（进程不崩）', gotAnswer);
    check('B3 进程仍存活', web.exitCode === null && !web.killed);
    const baseCount = ((await (await fetch(`${BASE}/api/sessions/${sid}/messages`)).json()) as { messages?: unknown[] }).messages?.length ?? 0;

    // C. 设置面板填入真实 Key → 同一会话消息成功
    const set = await fetch(`${BASE}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-mock-late' }),
    });
    check('C1 设置 API Key 成功', set.status === 200 || set.status === 204, 'status=' + set.status);
    await fetch(`${BASE}/api/sessions/${sid}/messages`, { method: 'POST', body: JSON.stringify({ text: '你好，请完成回复任务' }) });
    let okAnswer = false;
    const t1 = Date.now();
    while (Date.now() - t1 < 20000) {
      const hist = (await (await fetch(`${BASE}/api/sessions/${sid}/messages`)).json()) as { messages?: { role: string; content?: string }[] };
      const msgs = hist.messages ?? [];
      // C 轮必须产生「新的」assistant 回答（比 B 轮末尾更多消息）且以完成文案收尾
      const last = [...msgs].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string');
      if (msgs.length > baseCount && last && (last.content as string).includes('任务完成')) {
        okAnswer = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    check('C2 填 Key 后同一会话对话成功', okAnswer);
  } finally {
    mock.kill('SIGTERM');
    web?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    rmSync(XDG, { recursive: true, force: true });
  }

  console.log(failCount === 0 ? '\nprobe-nokey-bootstrap ✓ 全部通过' : `\nprobe-nokey-bootstrap ✗ ${failCount} 项失败`);
  process.exit(failCount === 0 ? 0 : 1);
}

void main();
