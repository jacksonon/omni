/**
 * 探针：Web 附件 API（web-attach-spec.md D11 服务端部分）。
 *
 * 场景 = 前端 `+` 文件/图片选择器提交附件后，POST /api/sessions/:id/messages
 * 携带 { text, attachments }：
 *   A. 纯文本（无附件）→ 用户消息 content 仍是字符串（完全向后兼容）；
 *   B. 文本 + 图片附件 → content 数组含 image_url part（data:image/…）与 text part，
 *      且 JSONL 落盘保留数组（loadSession 可读回、loop messagesHaveImage 可判定）；
 *   C. 文本附件（kind=text）→ 【附件：name】part；
 *   D. 路径占位（kind=path）→ [附件：name（…read_file…）] part；
 *   E. 非法 dataUrl（非 data:image/）→ 静默丢弃，content 回退为纯字符串。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSK = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MOCK_PORT = 49592;
const WEB_PORT = 49593;
const BASE = `http://127.0.0.1:${WEB_PORT}`;

let failCount = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failCount++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

function startProcess(cmd: string, args: string[], env: Record<string, string>): ChildProcess {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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

type Msg = { role: string; content?: unknown };

/** 发送消息并等待该轮 Agent 完成（mock 返回「任务完成」），返回最新消息列表。
 *  前一轮的 run.end 在内存回答可见后才落盘/清理（runs 表）——409 时重试等待。 */
async function sendAndWait(sid: string, body: Record<string, unknown>): Promise<Msg[]> {
  const tSend = Date.now();
  for (;;) {
    const r = await fetch(`${BASE}/api/sessions/${sid}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 202) break;
    if (r.status !== 409) throw new Error(`发送失败 HTTP ${r.status}`);
    if (Date.now() - tSend > 20000) throw new Error('发送 409 重试超时（上一轮未结束）');
    await new Promise((r) => setTimeout(r, 300));
  }
  const t0 = Date.now();
  for (;;) {
    const hist = (await (await fetch(`${BASE}/api/sessions/${sid}/messages`)).json()) as { messages?: Msg[] };
    const msgs = hist.messages ?? [];
    const last = [...msgs].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string');
    if (last && (last.content as string).includes('任务完成')) return msgs;
    if (Date.now() - t0 > 20000) throw new Error('等待 Agent 完成超时');
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** 轮询会话 JSONL 直到包含指定片段（落盘在 run.end 之后，需等待） */
async function sessionJsonlHas(xdg: string, sid: string, needle: string, timeoutMs = 15000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    try {
      const dir = path.join(xdg, 'omni', 'sessions');
      const file = readdirSync(dir).find((f) => f.startsWith(sid));
      if (file && readFileSync(path.join(dir, file), 'utf8').includes(needle)) return true;
    } catch { /* 目录/文件尚未就绪 */ }
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

function lastUser(msgs: Msg[]): Msg {
  return msgs.filter((m) => m.role === 'user')[msgs.filter((m) => m.role === 'user').length - 1];
}

const PNG_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function main(): Promise<void> {
  const XDG = mkdtempSync(path.join(os.tmpdir(), 'omni-attach-'));
  const mock = startProcess(process.execPath, [path.join(ROOT, 'scripts', 'mock-server.mjs')], { PORT: String(MOCK_PORT) });
  const web = startProcess(
    process.execPath,
    [TSK, path.join(ROOT, 'src', 'index.ts'), 'web', '--no-open', '--port', String(WEB_PORT)],
    { XDG_CONFIG_HOME: XDG, OMNI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, OMNI_MODEL: 'mock-model', OMNI_API_KEY: 'sk-test' }
  );
  try {
    await waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${MOCK_PORT}/__mock/config`, { method: 'POST', body: '{}' })).status === 200; }
      catch { return false; }
    }, 10000, 'mock server 启动');
    await waitFor(async () => {
      try { return (await fetch(`${BASE}/api/status`)).status === 200; }
      catch { return false; }
    }, 15000, 'web 服务启动');
    const s = await fetch(`${BASE}/api/sessions`, { method: 'POST', body: '{}' });
    const sid = ((await s.json()) as { id: string }).id;

    // A. 纯文本（向后兼容：content 保持字符串）
    let msgs = await sendAndWait(sid, { text: '纯文本消息' });
    let u = lastUser(msgs);
    check('A1 纯文本 content 为字符串', typeof u.content === 'string' && u.content === '纯文本消息',
      JSON.stringify(u.content).slice(0, 80));

    // B. 文本 + 图片附件（image_url data URL）
    msgs = await sendAndWait(sid, {
      text: '看看这张图',
      attachments: [{ kind: 'image', name: 'demo.png', dataUrl: PNG_DATA }],
    });
    u = lastUser(msgs);
    check('B1 有附件时 content 为数组', Array.isArray(u.content), typeof u.content);
    const partsB = (u.content as Array<Record<string, unknown>>) ?? [];
    check('B2 含 image_url part（data:image/）',
      partsB.some((p) => p.type === 'image_url' && (p.image_url as Record<string, string>)?.url?.startsWith('data:image/')),
      JSON.stringify(partsB).slice(0, 120));
    check('B3 文本 part 保留用户输入', partsB.some((p) => p.type === 'text' && p.text === '看看这张图'));

    // C. 文本附件（kind=text）→ 【附件：name】part
    msgs = await sendAndWait(sid, {
      text: '读一下配置',
      attachments: [{ kind: 'text', name: 'omni.jsonc', content: '{\n  "model": "mock"\n}' }],
    });
    u = lastUser(msgs);
    const partsC = (u.content as Array<Record<string, unknown>>) ?? [];
    check('C1 文本附件 part 带文件名', partsC.some((p) => p.type === 'text' && (p.text as string)?.startsWith('【附件：omni.jsonc】\n')),
      JSON.stringify(partsC).slice(0, 120));

    // D. 路径占位（kind=path）→ [附件：name（…read_file…）] part
    msgs = await sendAndWait(sid, {
      text: '处理这个二进制',
      attachments: [{ kind: 'path', name: 'blob.bin' }],
    });
    u = lastUser(msgs);
    const partsD = (u.content as Array<Record<string, unknown>>) ?? [];
    check('D1 路径占位 part 提示 read_file', partsD.some((p) => p.type === 'text' && (p.text as string)?.includes('blob.bin') && (p.text as string)?.includes('read_file')),
      JSON.stringify(partsD).slice(0, 120));

    // E. 非法 dataUrl → 静默丢弃，content 回退纯字符串
    msgs = await sendAndWait(sid, {
      text: '坏图',
      attachments: [{ kind: 'image', name: 'evil.png', dataUrl: 'http://evil.com/x.png' }],
    });
    u = lastUser(msgs);
    check('E1 非法 dataUrl 被丢弃且 content 为字符串', typeof u.content === 'string' && u.content === '坏图',
      typeof u.content + ' ' + JSON.stringify(u.content).slice(0, 80));

    // 持久化回读：JSONL 中确实存了 content 数组而非字符串拼接（落盘在 run.end 后，轮询等待）
    check('B4 落盘保留数组（JSONL 含 image_url）', await sessionJsonlHas(XDG, sid, '"type":"image_url"'),
      '读取 ' + path.join(XDG, 'omni', 'sessions'));
    check('P1 落盘含 【附件： 文本 part', await sessionJsonlHas(XDG, sid, '【附件：omni.jsonc】'));
    check('P2 落盘含 read_file 占位提示', await sessionJsonlHas(XDG, sid, 'read_file'));
  } finally {
    mock.kill('SIGTERM');
    web.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    rmSync(XDG, { recursive: true, force: true });
  }

  console.log(failCount === 0 ? '\nprobe-attach-api ✓ 全部通过' : `\nprobe-attach-api ✗ ${failCount} 项失败`);
  process.exit(failCount === 0 ? 0 : 1);
}

void main();
