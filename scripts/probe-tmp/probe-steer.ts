/**
 * 探针：验证 steer 打断消息「插入当前轮」链路——
 *  · 流中 abort + 中断槽有消息 → loop 取走消息 push 进 messages（新 user 消息）
 *    → **同一轮内继续**（模型直接回答打断消息，不结束本轮，turnStart 只计 1 次）
 *  · 流中 abort + 槽为空（/stop / Esc 取消）→ 优雅结束本轮，无「请求失败」提示
 *  · create 阶段 abort + 槽有消息（如工具执行期间被打断）→ 同样同一轮内继续
 * mock server 用 MOCK_STREAM=1 逐字流式（20ms/字），abort 可打断流。
 * 注意：tools 必须带 run_command（否则 mock 走计划模式分支、不流式）；信号用
 * getter 持有——rearmAbort 换新控制器后，loop 每次读 opts.abortSignal 得到新信号。
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
  answers: string[];
  userMessages: string[];
  failed: string[];
  turnStarts: number;
  toolRounds: number;
}

function makeOut(log: EventLog): Output {
  return {
    thinking: {
      get shown() {
        return false;
      },
      write: () => {},
      finish: () => {},
    },
    onRound: () => {},
    onStreamStart: () => {},
    onAnswer: (t: string) => log.answers.push(t),
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

/** 假的 run_command 工具（立即返回，不真执行）：让 mock 走流式分支而非计划模式 */
const stubTool = {
  name: 'run_command',
  description: 'x',
  parameters: {},
  execute: async () => 'mock-ok',
};

/** 可重载的取消信号 + 打断槽（模拟 interactive 的 abortCtrl/interruptText 组合） */
function makeAbortOpts(
  slot: { value: string | null },
  signalSlot: { ctrl: AbortController }
): Partial<RunOptions> {
  return {
    tools: [stubTool],
    permission: 'full',
    get abortSignal() {
      return signalSlot.ctrl.signal;
    },
    interruptPending: () => slot.value !== null,
    takeInterrupt: () => {
      const t = slot.value;
      slot.value = null;
      return t;
    },
    rearmAbort: () => {
      signalSlot.ctrl = new AbortController(); // 与 interactive 的 rearmAbort 同语义
    },
  };
}

async function main(): Promise<void> {
  await startMock();
  const client = new OpenAI({ apiKey: 'sk-mock', baseURL: `http://127.0.0.1:${PORT}/v1` });

  // ===== 测试 A：流中 abort + 中断槽有消息（steer 打断）→ 同一轮内继续 =====
  {
    const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: '你好' }];
    const log: EventLog = { answers: [], userMessages: [], failed: [], turnStarts: 0, toolRounds: 0 };
    const out = makeOut(log);
    const slot: { value: string | null } = { value: null };
    const signalSlot: { ctrl: AbortController } = { ctrl: new AbortController() };
    const t0 = Date.now();
    const p1 = runAgent(client, 'mock', messages, makeAbortOpts(slot, signalSlot) as RunOptions, out);
    setTimeout(() => {
      console.log('[A] 400ms 后 steer 打断（流中 + 槽写入「改用 mock 方案」）');
      slot.value = '改用 mock 方案';
      signalSlot.ctrl.abort();
    }, 400);
    await p1;
    const elapsed = Date.now() - t0;
    console.log(`[A] runAgent 返回耗时 ${elapsed}ms（打断后应继续回答，明显 > 400ms）`);
    console.log(`[A] messages=${JSON.stringify(messages.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content.slice(0, 20) : '[工具调用]'}`))}`);
    console.log(`[A] turnStarts=${log.turnStarts} userMessages=${JSON.stringify(log.userMessages)} failed=${JSON.stringify(log.failed)}`);
    if (elapsed < 800) throw new Error('A: 打断后未继续（runAgent 过早返回）');
    const userIdx = messages.findIndex((m) => m.role === 'user' && m.content === '改用 mock 方案');
    if (userIdx < 0) throw new Error('A: 打断消息未插入 messages');
    const roles = messages.map((m) => m.role);
    if (roles[roles.length - 1] !== 'assistant') throw new Error('A: 打断后模型未给出回答（最后一条不是 assistant）');
    if (userIdx < roles.length - 1 && roles[userIdx + 1] !== 'assistant') throw new Error('A: 打断消息后应有 assistant 回答（同一轮内继续）');
    if (log.turnStarts !== 1) throw new Error(`A: turnStart 应只计 1 次（同一轮内继续），实际 ${log.turnStarts}`);
    if (log.userMessages[0] !== '改用 mock 方案') throw new Error('A: onUserMessage 未收到打断消息');
    if (log.failed.length > 0) throw new Error(`A: 打断不应报「请求失败」: ${log.failed}`);
    console.log('✓ A 通过：流中打断 → 打断消息插入当前轮 → 同一轮内继续回答（turnStart=1，无请求失败）');
  }

  // ===== 测试 B：流中 abort + 槽为空（/stop / Esc 取消）→ 优雅结束本轮 =====
  {
    const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: '取消吧' }];
    const log: EventLog = { answers: [], userMessages: [], failed: [], turnStarts: 0, toolRounds: 0 };
    const out = makeOut(log);
    const slot: { value: string | null } = { value: null };
    const signalSlot: { ctrl: AbortController } = { ctrl: new AbortController() };
    const t0 = Date.now();
    const p1 = runAgent(client, 'mock', messages, makeAbortOpts(slot, signalSlot) as RunOptions, out);
    setTimeout(() => {
      console.log('[B] 400ms 后取消（槽为空，/stop / Esc 语义）');
      signalSlot.ctrl.abort();
    }, 400);
    await p1;
    console.log(`[B] messages=${JSON.stringify(messages.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content.slice(0, 20) : '[工具调用]'}`))}`);
    if (Date.now() - t0 > 5000) throw new Error('B: 取消未生效（runAgent 超时）');
    if (messages.some((m) => m.role === 'user' && m.content === '取消吧' && messages.indexOf(m) > 0)) throw new Error('B: 取消不应插入新 user 消息');
    if (log.failed.length > 0) throw new Error(`B: 取消不应报「请求失败」: ${log.failed}`);
    console.log('✓ B 通过：取消（无打断消息）→ 优雅结束本轮，无请求失败提示');
  }

  // ===== 测试 C：create 阶段 abort + 槽有消息（如工具执行期间被打断）→ 同一轮内继续 =====
  {
    const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: '准备开始' }];
    const log: EventLog = { answers: [], userMessages: [], failed: [], turnStarts: 0, toolRounds: 0 };
    const out = makeOut(log);
    const slot: { value: string | null } = { value: null };
    const signalSlot: { ctrl: AbortController } = { ctrl: new AbortController() };
    const p1 = runAgent(client, 'mock', messages, makeAbortOpts(slot, signalSlot) as RunOptions, out);
    setTimeout(() => {
      console.log('[C] 5ms 后 abort（create 阶段）+ 槽写入「先别跑」');
      slot.value = '先别跑';
      signalSlot.ctrl.abort();
    }, 5);
    await p1;
    const roles = messages.map((m) => m.role);
    const userIdx = messages.findIndex((m) => m.role === 'user' && m.content === '先别跑');
    if (userIdx < 0) throw new Error('C: create 阶段打断消息未插入 messages');
    if (roles[roles.length - 1] !== 'assistant') throw new Error('C: create 阶段打断后模型未回答');
    if (log.failed.length > 0) throw new Error(`C: 打断不应报「请求失败」: ${log.failed}`);
    console.log('✓ C 通过：create 阶段打断 → 打断消息插入当前轮 → 同一轮内继续回答');
  }

  console.log('\n== 全部通过：打断消息插入当前轮（同一轮内继续）+ 取消优雅结束 ==');
  process.exit(0);
}

void main();
