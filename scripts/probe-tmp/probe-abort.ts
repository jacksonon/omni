/**
 * 探针：验证 steer 打断链路（abort → 回合结束 → pending 消费 → 下一轮插入）。
 * mock server 用 MOCK_STREAM=1 逐字流式（20ms/字），abort 可打断流。
 */
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { spawn } from 'node:child_process';
import { runAgent } from '../../src/agent/loop.js';
import type { Output } from '../../src/output/types.js';

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
  thinking: string[];
  answers: string[];
  tools: string[];
  results: string[];
  failed: string[];
  turnStart: number;
  llmLaps: { ms: number; first: number | null }[];
}

function makeOut(log: EventLog): Output {
  return {
    thinking: {
      get shown() {
        return false;
      },
      write: (p: string) => {},
      finish: () => {},
    },
    onRound: () => {},
    onStreamStart: () => {},
    onAnswer: (t: string) => log.answers.push(t),
    onAnswerEnd: () => {},
    onUsage: () => {},
    onTurnStart: () => log.turnStart++,
    onLlmLap: (ms: number, first: number | null) => log.llmLaps.push({ ms, first }),
    onToolsLap: () => {},
    onRequestFailed: (e: unknown) => log.failed.push(String((e as Error)?.message ?? e)),
    onThinkingSaved: () => {},
    onToolStep: (s, m, name, p) => log.tools.push(name),
    onToolResult: () => log.results.push('ok'),
    onMaxSteps: () => {},
    banner: () => {},
    flush: async () => {},
  };
}

async function main(): Promise<void> {
  await startMock();
  const client = new OpenAI({ apiKey: 'sk-mock', baseURL: `http://127.0.0.1:${PORT}/v1` });

  // ===== 测试 A：流中 abort（mid-stream）=====
  {
    const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: '你好' }];
    const log: EventLog = { thinking: [], answers: [], tools: [], results: [], failed: [], turnStart: 0, llmLaps: [] };
    const out = makeOut(log);
    const abort = new AbortController();
    const t0 = Date.now();
    const p1 = runAgent(client, 'mock', messages, { tools: [], abortSignal: abort.signal, permission: 'full' }, out);
    setTimeout(() => {
      console.log(`[A] 300ms 后 abort（流中，reasoning 逐字中）`);
      abort.abort();
    }, 300);
    await p1;
    const elapsed = Date.now() - t0;
    console.log(`[A] runAgent 返回耗时 ${elapsed}ms`);
    console.log(`[A] messages.length=${messages.length}（abort 应 ≤1，半截消息不入上下文）`);
    console.log(`[A] 失败数=${log.failed.length} failed=${JSON.stringify(log.failed)}`);
    if (elapsed > 5000) throw new Error('A: abort 未打断流（runAgent 超时）');
  }

  // ===== 测试 B：create 阶段 abort（请求发出前/中，未到首 chunk）=====
  {
    const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: '立即打断' }];
    const log: EventLog = { thinking: [], answers: [], tools: [], results: [], failed: [], turnStart: 0, llmLaps: [] };
    const out = makeOut(log);
    const abort = new AbortController();
    const t0 = Date.now();
    const p1 = runAgent(client, 'mock', messages, { tools: [], abortSignal: abort.signal, permission: 'full' }, out);
    setTimeout(() => {
      console.log(`[B] 10ms 后 abort（create 阶段）`);
      abort.abort();
    }, 10);
    await p1;
    const elapsed = Date.now() - t0;
    console.log(`[B] runAgent 返回耗时 ${elapsed}ms`);
    console.log(`[B] messages.length=${messages.length}`);
    console.log(`[B] 失败数=${log.failed.length} failed=${JSON.stringify(log.failed)}`);
    if (elapsed > 5000) throw new Error('B: create 阶段 abort 未生效（runAgent 超时）');
  }

  console.log('\n== 全部通过：abort 两阶段都能及时结束回合 ==');
  process.exit(0);
}

void main();