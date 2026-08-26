/**
 * 探针：LLM 统计指标准确性（首 token 延迟 / 生成速率 tok/s / 缓存命中率）。
 *
 * A. 单元：buildFooterStats ——
 *    A1 速率用 genMs（纯生成耗时）而非 llmMs 全墙钟
 *    A2 缓存命中率 >100% 时钳制到 100%（某些网关 prompt_tokens 不含 cached）
 *    A3 无 genMs（genMs=0）→ 速率 0（不出现 Infinity/NaN）
 * B. 运行时（mock + web 真实 runAgent）：
 *    B1 lap 事件携带 firstTokenMs（真实）且 >0（mock 流式即时返回）
 *    B2 lap 事件携带 genMs，且 0 ≤ genMs ≤ llmMs
 *    B3 usage 事件携带 cached（真实 API 返回，非估算）
 *    B4 前端累计链路：sessionStats.genMs 事件驱动（模拟 app.js 相同逻辑）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSK = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MOCK_PORT = 49612;
const WEB_PORT = 49613;
const BASE = `http://127.0.0.1:${WEB_PORT}`;

let failCount = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failCount++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}
function startProcess(cmd: string, args: string[], env: Record<string, string>): ChildProcess {
  return spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function waitFor(fn: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`超时：${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** 读取 SSE 流直到 run.end，收集 lap / usage 事件（SSE 事件名在 `event:` 头） */
async function captureEvents(sid: string, ms = 20000): Promise<{ laps: any[]; usages: any[] }> {
  const res = await fetch(`${BASE}/api/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const laps: any[] = [];
  const usages: any[] = [];
  let pending = '';
  const t0 = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let idx = pending.indexOf('\n\n');
    while (idx >= 0) {
      const frame = pending.slice(0, idx);
      pending = pending.slice(idx + 2);
      const evName = /^event: (.+)$/m.exec(frame)?.[1] ?? '';
      const dataLine = /^data: (.+)$/m.exec(frame)?.[1] ?? '';
      if (evName && dataLine) {
        let data: any;
        try { data = JSON.parse(dataLine); } catch { idx = pending.indexOf('\n\n'); continue; }
        if (data.sessionId === sid) {
          if (evName === 'lap') laps.push(data);
          if (evName === 'usage') usages.push(data);
          if (evName === 'run.end') return { laps, usages };
        }
      }
      idx = pending.indexOf('\n\n');
    }
    if (Date.now() - t0 > ms) return { laps, usages };
  }
  return { laps, usages };
}

async function main(): Promise<void> {
  // ---------- A. 单元：buildFooterStats ----------
  console.log('=== A. buildFooterStats 准确性 ===');
  const { STATUSLINE_DEFAULT } = await import(path.join(ROOT, 'src', 'tui', 'layout.js'));
  const layout = await import(path.join(ROOT, 'src', 'tui', 'layout.js'));
  const mkState = (stats: any, tokens: any) => ({
    statusline: STATUSLINE_DEFAULT,
    language: 'zh' as const,
    stats,
    tokens,
  });
  // A1 速率 = completion / genMs（排除首 token 等待）
  const s1 = mkState({ turns: 1, steps: 1, llmMs: 10000, toolsMs: 0, firstTokenSum: 5000, firstTokenCount: 1, genMs: 2000, cached: 0 }, { prompt: 1000, completion: 500 });
  const line1 = layout.buildFooterStats(s1 as never);
  check('A1 tok/s 用 genMs（500 tok / 2s = 250）', line1.includes('250 tok/s'), line1);
  // 若误用 llmMs（500/10 = 50）会被误判（用边界断言避免命中 250 里的子串）
  check('A1-2 未误用 llmMs（不应「· 50 tok/s」）', !/· 50 tok\/s/.test(line1), line1);
  // A2 缓存命中 >100% → 钳制 100（网关 prompt_tokens 不含 cached 时）
  const s2 = mkState({ turns: 0, steps: 0, llmMs: 0, toolsMs: 0, firstTokenSum: 0, firstTokenCount: 0, genMs: 0, cached: 900 }, { prompt: 100, completion: 0 });
  check('A2 缓存命中钳制 100%', layout.buildFooterStats(s2 as never).includes('缓存命中 100%'), layout.buildFooterStats(s2 as never));
  // A3 genMs=0（无生成/失败请求）→ 速率 0 不崩溃
  const s3 = mkState({ turns: 0, steps: 0, llmMs: 5000, toolsMs: 0, firstTokenSum: 0, firstTokenCount: 0, genMs: 0, cached: 0 }, { prompt: 0, completion: 300 });
  const line3 = layout.buildFooterStats(s3 as never);
  check('A3 genMs=0 → 速率 0', line3.includes('0 tok/s'), line3);
  // A4 单 chunk 退化：genMs=0 但 llmMs > firstTokenSum → 回退 llmMs-firstTokenSum（不应 0 tok/s）
  const s4 = mkState({ turns: 1, steps: 0, llmMs: 500, toolsMs: 0, firstTokenSum: 200, firstTokenCount: 1, genMs: 0, cached: 0 }, { prompt: 100, completion: 50 });
  const line4 = layout.buildFooterStats(s4 as never);
  check('A4 genMs=0 回退 llmMs-firstTokenSum（50 tok/0.3s ≈ 167 tok/s）', line4.includes('167 tok/s'), line4);

  // ---------- B. 运行时（真实 runAgent + mock） ----------
  console.log('=== B. 运行时数值真实性 ===');
  const XDG = mkdtempSync(path.join(os.tmpdir(), 'omni-stats-'));
  const mock = startProcess(process.execPath, [path.join(ROOT, 'scripts', 'mock-server.mjs')], { PORT: String(MOCK_PORT) });
  const web = startProcess(process.execPath, [TSK, path.join(ROOT, 'src', 'index.ts'), 'web', '--no-open', '--port', String(WEB_PORT)], {
    XDG_CONFIG_HOME: XDG,
    OMNI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    OMNI_MODEL: 'mock-model',
    OMNI_API_KEY: 'sk-test',
  });
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

    // 订阅 SSE 再发送（避免漏掉事件）
    const eventsP = captureEvents(sid);
    const r = await fetch(`${BASE}/api/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '统计探针' }),
    });
    check('B0 发送 202', r.status === 202, String(r.status));
    const { laps, usages } = await eventsP;
    check('B1 lap 事件 ≥1 且 firstTokenMs 真实（非 null ≥0）', laps.length > 0 && laps.every((l) => l.firstTokenMs != null && l.firstTokenMs >= 0), JSON.stringify(laps).slice(0, 160));
    check('B2 genMs 存在且 0 ≤ genMs ≤ llmMs', laps.length > 0 && laps.every((l) => l.genMs != null && l.genMs >= 0 && l.genMs <= l.llmMs), JSON.stringify(laps).slice(0, 160));
    check('B3 usage 事件 ≥1 且含真实 prompt/completion/cached', usages.length > 0 && usages.every((u) => u.prompt > 0 && u.completion > 0 && typeof u.cached === 'number'), JSON.stringify(usages).slice(0, 160));
    // B4 前端累计链路（与 app.js lap/usage handler 同逻辑）
    const stats = { turns: 0, steps: 0, llmMs: 0, toolsMs: 0, firstTokenSum: 0, firstTokenCount: 0, genMs: 0, cached: 0 };
    const usage = { prompt: 0, completion: 0, total: 0, cached: 0 };
    laps.forEach((l) => {
      stats.llmMs += l.llmMs;
      if (l.firstTokenMs != null) { stats.firstTokenSum += l.firstTokenMs; stats.firstTokenCount++; }
      if (l.genMs != null) stats.genMs += l.genMs;
    });
    usages.forEach((u) => { usage.prompt += u.prompt; usage.completion += u.completion; usage.cached += u.cached; });
    const firstAvg = stats.firstTokenCount > 0 ? stats.firstTokenSum / stats.firstTokenCount / 1000 : 0;
    const gen = stats.genMs > 0 ? stats.genMs : Math.max(1, stats.llmMs - stats.firstTokenSum);
    const rate = gen > 0 ? Math.round(usage.completion / (gen / 1000)) : 0;
    const cache = usage.prompt > 0 ? Math.min(100, Math.round((stats.cached / usage.prompt) * 100)) : 0;
    // mock 即时响应：首 token/genMs 可能是 0ms（localhost 真实值）——只验证累计链路工作
    check('B4 累计链路（firstTokenCount>0 且 genMs 累计且 usage 真实）',
      stats.firstTokenCount > 0 && stats.genMs >= 0 && usage.prompt > 0 && usage.completion > 0,
      `laps=${laps.length} usages=${usages.length}`);
    console.log(`  · 实测：首 token 平均 ${firstAvg.toFixed(1)}s · ${rate} tok/s · 缓存命中 ${cache}%`);
  } finally {
    mock.kill('SIGTERM');
    web.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    rmSync(XDG, { recursive: true, force: true });
  }
  console.log(failCount === 0 ? '\nprobe-stats ✓ 全部通过' : `\nprobe-stats ✗ ${failCount} 项失败`);
  process.exit(failCount === 0 ? 0 : 1);
}

void main();
