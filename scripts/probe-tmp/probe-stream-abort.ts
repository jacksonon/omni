/**
 * 探针：流式/create 挂起阶段的取消立即生效（用户反馈「esc 取消后再次发消息，
 * 显示消息在待发送里，然后过一会才会发送」）——
 *  · 慢首 chunk（2s）：create 挂起中取消 → 立即返回（不等首 chunk）
 *  · 流中长间隔（reasoning 中段 2s 停顿）：取消 → 立即返回（不等下一个 chunk）
 * mock：MOCK_STREAM=1 + MOCK_SLOW_FIRST / MOCK_SLOW_GAP。
 */
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { spawn } from 'node:child_process';
import { runAgent } from '../../src/agent/loop.js';
import type { Output } from '../../src/output/types.js';
import type { RunOptions } from '../../src/agent/types.js';

const PORT = 8799;

function startMock(extra: Record<string, string>): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn('bun', ['run', 'scripts/mock-server.mjs'], {
      env: { ...process.env, PORT: String(PORT), MOCK_STREAM: '1', ...extra },
      stdio: 'ignore',
    });
    setTimeout(resolve, 800);
    (p as unknown as { _keep?: boolean })._keep = true;
  });
}

function makeOut(log: { failed: string[] }): Output {
  return {
    thinking: { get shown() { return false; }, write: () => {}, finish: () => {} },
    onRound: () => {},
    onStreamStart: () => {},
    onAnswer: () => {},
    onAnswerEnd: () => {},
    onUsage: () => {},
    onTurnStart: () => {},
    onLlmLap: () => {},
    onToolsLap: () => {},
    onRequestFailed: (e: unknown) => log.failed.push(String((e as Error)?.message ?? e)),
    onThinkingSaved: () => {},
    onToolStep: () => {},
    onToolResult: () => {},
    onMaxSteps: () => {},
    onUserMessage: () => {},
    banner: () => {},
    flush: async () => {},
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 可重载信号 + 打断槽 */
function makeAbortOpts(slot: { value: string | null }, signalSlot: { ctrl: AbortController }): Partial<RunOptions> {
  return {
    tools: [{ name: 'run_command', description: 'x', parameters: {}, execute: async () => 'ok' }],
    permission: 'full',
    get abortSignal() { return signalSlot.ctrl.signal; },
    interruptPending: () => slot.value !== null,
    takeInterrupt: () => { const t = slot.value; slot.value = null; return t; },
    rearmAbort: () => { signalSlot.ctrl = new AbortController(); },
  };
}

async function main(): Promise<void> {
  const client = new OpenAI({ apiKey: 'sk-mock', baseURL: `http://127.0.0.1:${PORT}/v1` });

  // ===== 测试 F：create 挂起（首 chunk 2s 未到）中取消 → 立即返回 =====
  {
    await startMock({ MOCK_SLOW_FIRST: '1' });
    const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: '开始' }];
    const log = { failed: [] as string[] };
    const out = makeOut(log);
    const slot: { value: string | null } = { value: null };
    const signalSlot: { ctrl: AbortController } = { ctrl: new AbortController() };
    const t0 = Date.now();
    const p1 = runAgent(client, 'mock', messages, makeAbortOpts(slot, signalSlot) as RunOptions, out);
    setTimeout(() => {
      console.log('[F] 150ms 后取消（create 挂起，首 chunk 2s 后才到）');
      signalSlot.ctrl.abort();
    }, 150);
    await p1;
    const elapsed = Date.now() - t0;
    console.log(`[F] runAgent 返回耗时 ${elapsed}ms（< 1000ms = 没等首 chunk）`);
    if (elapsed > 1000) throw new Error('F: create 挂起阶段取消未立即生效（还在等首 chunk）');
    if (log.failed.length > 0) throw new Error(`F: 取消不应报「请求失败」: ${log.failed}`);
    console.log('✓ F 通过：create 挂起中取消 → 立即结束（不等慢首 chunk）');
  }

  // ===== 测试 G：流中长间隔（reasoning 中段 2s 停顿）取消 → 立即返回 =====
  {
    await startMock({ MOCK_SLOW_GAP: '1' });
    const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: '分析' }];
    const log = { failed: [] as string[] };
    const out = makeOut(log);
    const slot: { value: string | null } = { value: null };
    const signalSlot: { ctrl: AbortController } = { ctrl: new AbortController() };
    const t0 = Date.now();
    const p1 = runAgent(client, 'mock', messages, makeAbortOpts(slot, signalSlot) as RunOptions, out);
    // 等 reasoning 前半段流完（~12 字 × 20ms ≈ 250ms）进入 2s 停顿后取消
    setTimeout(() => {
      console.log('[G] 400ms 后取消（reasoning 中段 2s 停顿中）');
      signalSlot.ctrl.abort();
    }, 400);
    await p1;
    const elapsed = Date.now() - t0;
    console.log(`[G] runAgent 返回耗时 ${elapsed}ms（< 1500ms = 没等 2s 停顿的下一个 chunk）`);
    if (elapsed > 1500) throw new Error('G: 流中长间隔取消未立即生效（还在等下一个 chunk）');
    if (log.failed.length > 0) throw new Error(`G: 取消不应报「请求失败」: ${log.failed}`);
    console.log('✓ G 通过：流中长间隔取消 → 立即结束（不等下一个 chunk）');
  }

  console.log('\n== 全部通过：create/流式阶段取消均立即生效 ==');
  process.exit(0);
}

void main();
