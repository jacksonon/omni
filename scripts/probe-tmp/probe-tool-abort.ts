/**
 * 探针：工具执行阶段的取消/打断立即生效（用户反馈「esc 取消后再次发消息会先排队」）——
 *  · 慢工具（3s）执行中取消（槽空，Esc//stop）→ runAgent **立即**返回（不等工具完成，
 *    不再「排队等工具跑完」）
 *  · 慢工具执行中打断（steer）→ 打断消息插入当前轮同一轮内继续（工具结果丢弃不回传）
 * mock server：MOCK_STREAM=1，第一轮（无 tool 结果）返回 run_command 工具调用。
 */
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { spawn } from 'node:child_process';
import { runAgent } from '../../src/agent/loop.js';
import type { Output } from '../../src/output/types.js';
import type { RunOptions } from '../../src/agent/types.js';

const PORT = 8799;

function startMock(): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn('bun', ['run', 'scripts/mock-server.mjs'], {
      env: { ...process.env, PORT: String(PORT), MOCK_STREAM: '1' },
      stdio: 'ignore',
    });
    setTimeout(resolve, 800);
    (p as unknown as { _keep?: boolean })._keep = true;
  });
}

interface EventLog {
  userMessages: string[];
  failed: string[];
  turnStarts: number;
  toolRounds: number;
}

function makeOut(log: EventLog): Output {
  return {
    thinking: { get shown() { return false; }, write: () => {}, finish: () => {} },
    onRound: () => {},
    onStreamStart: () => {},
    onAnswer: () => {},
    onAnswerEnd: () => {},
    onUsage: () => {},
    onTurnStart: () => log.turnStarts++,
    onLlmLap: () => {},
    onToolsLap: () => {},
    onRequestFailed: (e: unknown) => log.failed.push(String((e as Error)?.message ?? e)),
    onThinkingSaved: () => {},
    onToolStep: () => log.toolRounds++,
    onToolResult: () => {},
    onMaxSteps: () => {},
    onUserMessage: (t: string) => log.userMessages.push(t),
    banner: () => {},
    flush: async () => {},
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 3 秒慢工具（不可中断）：模拟 run_command 长任务 */
const slowTool = {
  name: 'run_command',
  description: 'x',
  parameters: {},
  execute: async () => {
    await wait(3000);
    return 'slow-ok';
  },
};

/** 可重载信号 + 打断槽（与 probe-steer 同款） */
function makeAbortOpts(slot: { value: string | null }, signalSlot: { ctrl: AbortController }): Partial<RunOptions> {
  return {
    tools: [slowTool],
    permission: 'full',
    get abortSignal() { return signalSlot.ctrl.signal; },
    interruptPending: () => slot.value !== null,
    takeInterrupt: () => { const t = slot.value; slot.value = null; return t; },
    rearmAbort: () => { signalSlot.ctrl = new AbortController(); },
  };
}

async function main(): Promise<void> {
  await startMock();
  const client = new OpenAI({ apiKey: 'sk-mock', baseURL: `http://127.0.0.1:${PORT}/v1` });

  // ===== 测试 D：工具执行中取消（槽空）→ 立即返回，不等 3s 工具 =====
  {
    const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: '跑一下' }];
    const log: EventLog = { userMessages: [], failed: [], turnStarts: 0, toolRounds: 0 };
    const out = makeOut(log);
    const slot: { value: string | null } = { value: null };
    const signalSlot: { ctrl: AbortController } = { ctrl: new AbortController() };
    const t0 = Date.now();
    const p1 = runAgent(client, 'mock', messages, makeAbortOpts(slot, signalSlot) as RunOptions, out);
    // 等流式 reasoning（~500ms）+ 工具调用 chunk 到达、工具开始执行后取消
    setTimeout(() => {
      console.log('[D] 800ms 后取消（工具执行中，槽空 / Esc 语义）');
      signalSlot.ctrl.abort();
    }, 800);
    await p1;
    const elapsed = Date.now() - t0;
    console.log(`[D] runAgent 返回耗时 ${elapsed}ms（< 2000ms = 没等 3s 工具）`);
    console.log(`[D] messages=${JSON.stringify(messages.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content.slice(0, 15) : '[工具调用]'}`))}`);
    console.log(`[D] failed=${JSON.stringify(log.failed)}`);
    if (elapsed > 2000) throw new Error('D: 取消未立即生效（还在等慢工具完成）');
    if (messages.some((m) => m.role === 'tool')) throw new Error('D: 取消后工具结果不应回传');
    if (log.failed.length > 0) throw new Error(`D: 取消不应报「请求失败」: ${log.failed}`);
    console.log('✓ D 通过：工具执行中取消 → 立即结束本轮（不等慢工具，新消息不再排队等工具）');
  }

  // ===== 测试 E：工具执行中打断（steer）→ 打断消息插入当前轮，同一轮内继续 =====
  {
    const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: '先看看' }];
    const log: EventLog = { userMessages: [], failed: [], turnStarts: 0, toolRounds: 0 };
    const out = makeOut(log);
    const slot: { value: string | null } = { value: null };
    const signalSlot: { ctrl: AbortController } = { ctrl: new AbortController() };
    const p1 = runAgent(client, 'mock', messages, makeAbortOpts(slot, signalSlot) as RunOptions, out);
    setTimeout(() => {
      console.log('[E] 800ms 后打断（工具执行中 + 槽写入「先别跑」）');
      slot.value = '先别跑';
      signalSlot.ctrl.abort();
    }, 800);
    await p1;
    const roles = messages.map((m) => m.role);
    const userIdx = messages.findIndex((m) => m.role === 'user' && m.content === '先别跑');
    console.log(`[E] messages=${JSON.stringify(messages.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content.slice(0, 15) : '[工具调用]'}`))}`);
    if (userIdx < 0) throw new Error('E: 打断消息未插入 messages');
    if (roles[roles.length - 1] !== 'assistant') throw new Error('E: 打断后模型未回答');
    if (log.turnStarts !== 1) throw new Error(`E: turnStart 应只计 1 次，实际 ${log.turnStarts}`);
    if (log.failed.length > 0) throw new Error(`E: 打断不应报「请求失败」: ${log.failed}`);
    console.log('✓ E 通过：工具执行中打断 → 打断消息插入当前轮同一轮内继续（结果丢弃不回传）');
  }

  console.log('\n== 全部通过：工具执行阶段取消/打断立即生效 ==');
  process.exit(0);
}

void main();
