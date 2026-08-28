/**
 * 探针：write_file 工具卡片的 diff 数据链路（第一百八十九次补充）。
 *
 * 背景：后端 loop.ts 在 write_file 完成后已通过 tool.result 的 detail.diff
 * 下发「写入前后对比」，TUI/console 均消费；web 前端此前只渲染文本预览
 * （"已写入 xxx（N 字节）"），工具卡片不显示 diff。修复后 app.js 的
 * toolBlock.result 消费 r.detail?.diff → OmniMarkdown.renderFileDiff()。
 *
 * 验证：
 *   A. mock 第一轮发 write_file（MOCK_WRITE=1）→ SSE tool.result 带 detail.diff
 *      （original/content 齐全，path 正确）；
 *   B. /api/events 的 tool.result payload 结构与 app.js 消费点一致；
 *   C. markdown-renderer.js 暴露 renderFileDiff 且输出 .md-diff 行级着色。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSK = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MOCK_PORT = 49100 + Math.floor(Math.random() * 400);
const WEB_PORT = MOCK_PORT + 100;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const XDG = path.join(os.tmpdir(), `omni-probe-wdiff-${process.pid}-${Date.now() % 100000}`);

let failCount = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failCount++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

function startProcess(cmd: string, args: string[], env: Record<string, string>): ChildProcess {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', () => {});
  child.stderr!.on('data', () => {});
  return child;
}

async function waitFor(fn: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() - t0 > ms) throw new Error(`超时：${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** 简易 SSE 读取器（fetch + 流式 body，与 probe-web.ts 同款） */
class SseReader {
  events: Array<{ type: string; data: any }> = [];
  done = false;
  private ac = new AbortController();
  constructor(sessionId: string) {
    void (async () => {
      const resp = await fetch(`${BASE}/api/events`, { signal: this.ac.signal });
      if (!resp.body) return;
      const dec = new TextDecoder();
      let pending = '';
      for await (const chunk of resp.body as any) {
        pending += dec.decode(chunk, { stream: true });
        let idx = pending.indexOf('\n\n');
        while (idx >= 0) {
          const frame = pending.slice(0, idx);
          pending = pending.slice(idx + 2);
          const type = /^event: (.+)$/m.exec(frame)?.[1] ?? '';
          const dataLine = /^data: (.+)$/m.exec(frame)?.[1] ?? '';
          if (type && dataLine) {
            try {
              const data = JSON.parse(dataLine);
              if (!sessionId || !data.sessionId || data.sessionId === sessionId) {
                this.events.push({ type, data });
              }
            } catch {}
          }
          idx = pending.indexOf('\n\n');
        }
      }
      this.done = true;
    })().catch(() => { this.done = true; });
  }
  abort() { this.ac.abort(); }
  ofType(t: string) { return this.events.filter((e) => e.type === t).map((e) => e.data); }
}

async function main(): Promise<void> {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(XDG, { recursive: true });
  // 工作区信任：否则 web 判定未信任 → 只读降级，write_file 被拒（真实使用中开发者先交互批准信任）
  process.env.XDG_CONFIG_HOME = XDG;
  const { addTrustedWorkspace } = await import(path.join(ROOT, 'src', 'safety', 'trust.js'));
  addTrustedWorkspace(ROOT);
  const mock = startProcess(process.execPath, [path.join(ROOT, 'scripts', 'mock-server.mjs')], {
    PORT: String(MOCK_PORT), MOCK_WRITE: '1',
  });
  let web: ChildProcess | null = null;
  let sse: SseReader | null = null;
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/__mock/config`, { method: 'POST', body: '{}' })).status === 200, 10000, 'mock 启动');
    web = startProcess(process.execPath, [TSK, path.join(ROOT, 'src', 'index.ts'), 'web', '--no-open', '--port', String(WEB_PORT)], {
      XDG_CONFIG_HOME: XDG,
      OMNI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      OMNI_API_KEY: 'sk-mock',
      OMNI_MODEL: 'mock-model',
    });
    await waitFor(async () => (await fetch(`${BASE}/api/status`)).status === 200, 20000, 'web 启动');

    // 静态资源：renderFileDiff 已暴露
    const rdr = await (await fetch(`${BASE}/markdown-renderer.js`)).text();
    check('C renderFileDiff 已暴露', rdr.includes('renderFileDiff') && rdr.includes('md-diff-add'), 'renderer 缺 renderFileDiff');

    // SSE 监听（fetch 流式；等待连接建立避免丢事件）
    sse = new SseReader('');
    await new Promise((r) => setTimeout(r, 500));

    const sess = await (await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    const sid: string = sess.id;
    await fetch(`${BASE}/api/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '写一个文件' }),
    });
    await waitFor(() => Promise.resolve(sse!.ofType('run.end').some((e) => e.sessionId === sid)), 25000, '本轮结束');

    const toolResults = sse.ofType('tool.result').filter((e) => e.sessionId === sid);
    const wd = toolResults.find((e) => e.detail?.diff);
    check('A1 tool.result 事件存在', toolResults.length >= 1, `toolResults=${toolResults.length}`);
    check('A2 write_file 带 detail.diff', !!wd, toolResults.length ? JSON.stringify(toolResults[0]?.detail)?.slice(0, 140) : 'no toolResults');
    if (wd) {
      check('A3 diff.original 为写入前内容（null=新建）', wd.detail.diff.original === null || typeof wd.detail.diff.original === 'string');
      check('A4 diff.content 为写入内容', typeof wd.detail.diff.content === 'string' && wd.detail.diff.content.length > 0);
      check('A5 diff.path 正确', wd.detail.diff.path === 'undo-test.txt', wd.detail.diff.path);
    }
    // 前端消费点
    const appJs = await (await fetch(`${BASE}/app.js`)).text();
    check('B app.js 消费 detail.diff → renderFileDiff', appJs.includes('r.detail?.diff') && appJs.includes('renderFileDiff'), 'app.js 未消费 diff');

    console.log(failCount === 0 ? '\nprobe-web-diff ✓ 全部通过' : `\nprobe-web-diff ✗ ${failCount} 项失败`);
    process.exitCode = failCount === 0 ? 0 : 1;
  } finally {
    mock.kill('SIGTERM');
    web?.kill('SIGTERM');
    const { rmSync } = await import('node:fs');
    rmSync(XDG, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('探针崩溃：', e); process.exit(1); });
