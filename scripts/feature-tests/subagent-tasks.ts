/**
 * 功能测试：子代理任务中心（Agent View，1.0 完整版）——
 * runSubagent 保留 transcript/明细、resumeSubagent 续跑、注册表 resume/stop、
 * 会话持久化（t:"sub"）往返 + hydrate 回灌、SubagentDef reasoningEffort 解析。
 * 用假 OpenAI 客户端（流式 chunk 序列）驱动，无需网络。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import { TestSuite } from './framework.js';
import { runSubagent, resumeSubagent } from '../../src/agent/subagent.js';
import { SubagentRegistry } from '../../src/agent/subagent-registry.js';
import { appendSubagentRecord, loadSubagentRecords } from '../../src/agent/session.js';
import { parseSubagentFrontmatter } from '../../src/agent/subagent-defs.js';
import { Safety } from '../../src/safety/index.js';
import type { Tool } from '../../src/tools/types.js';

/** 假客户端：按调用次序返回预设的流式 chunk 序列，记录每次 create 的入参 */
function fakeClient(calls: unknown[][]): { client: OpenAI; seen: any[] } {
  const seen: any[] = [];
  let i = 0;
  const client = {
    chat: {
      completions: {
        create: async (params: any) => {
          seen.push(params);
          const chunks = calls[i++] ?? [];
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  } as unknown as OpenAI;
  return { client, seen };
}

const textChunk = (text: string) => ({ choices: [{ delta: { content: text } }] });
const toolChunk = (id: string, name: string, args: string) => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }],
});

const gate = new Safety({ tier: 'full', audit: false, requestApproval: async () => true });

function makeRecord(id: string): any {
  return {
    id,
    parentId: null,
    depth: 0,
    name: 'delegate',
    task: 't',
    status: 'running',
    steps: 0,
    maxSteps: 5,
    startedAt: Date.now(),
    seq: null,
    transcript: [],
    items: [],
    dropped: 0,
  };
}

export function subagentTasksSuite(): TestSuite {
  const suite = new TestSuite('子代理任务中心（transcript / 续跑 / 注册表 / 持久化）');

  suite.test('runSubagent：保留完整 transcript + 明细，结束置 ok', async () => {
    const echo: Tool = {
      name: 'read_file',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      async execute(): Promise<string> {
        return 'TOOL-OUT';
      },
    } as unknown as Tool;
    const { client } = fakeClient([[toolChunk('c1', 'read_file', '{}')], [textChunk('最终结论')]]);
    const registry = new SubagentRegistry();
    const record = makeRecord('sub1');
    const events: any[] = [];
    const answer = await runSubagent(client, 'mock-model', '做个事', {
      tools: [echo],
      gate,
      maxSteps: 5,
      name: 'delegate',
      id: 'sub1',
      onEvent: (ev) => events.push(ev),
      record,
      registry,
    });
    suite.assert(answer === '最终结论', '返回最终结论', answer);
    suite.assert(record.status === 'ok', 'status = ok', record.status);
    suite.assert(record.transcript.length >= 3, `transcript 保留完整（${record.transcript.length} 条）`);
    suite.assert(record.transcript.some((m: any) => m.role === 'tool'), '工具结果在 transcript 里');
    suite.assert(record.steps >= 1, 'step 计数递增');
    suite.assert(record.items.some((i: any) => i.kind === 'tool'), '工具明细被记录');
    suite.assert(record.result === '最终结论', 'result 写入记录');
    suite.assert(registry.size === 1 && registry.records()[0].id === 'sub1', '注册表登记');
    suite.assert(events.some((e) => e.type === 'start') && events.some((e) => e.type === 'end'), 'start/end 事件');
    suite.assert(events.every((e) => e.id === 'sub1'), '事件带 id');
    suite.assert(events.some((e) => e.model === 'mock-model'), '事件带 model（Agent View 展示）');
  });

  suite.test('resumeSubagent：带原 transcript 追问续跑', async () => {
    const { client, seen } = fakeClient([[textChunk('追问答案')]]);
    const record = makeRecord('sub2');
    record.transcript = [
      { role: 'user', content: '初始任务' },
      { role: 'assistant', content: '初始答案' },
    ];
    const answer = await resumeSubagent(client, 'mock-model', record, '再问一句', {
      tools: [],
      gate,
      maxSteps: 3,
      name: 'delegate',
      id: 'sub2',
    });
    suite.assert(answer === '追问答案', '返回续跑答案', answer);
    suite.assert(record.resumed === true, 'resumed 标记置位');
    suite.assert(record.transcript.some((m: any) => m.content === '再问一句'), '追问进 transcript');
    const sent = seen[0].messages;
    suite.assert(
      sent.length >= 3 && sent[0].content === '初始任务' && sent[2].content === '再问一句',
      '续跑携带原历史（不是重头开始）'
    );
  });

  suite.test('registry：resume 走注入闭包；stop 触发 abort（兜底 controller）', async () => {
    const registry = new SubagentRegistry();
    const ctrl = new AbortController();
    const rec = makeRecord('sub3');
    rec.status = 'running';
    rec.controller = ctrl;
    registry.register({ record: rec, resume: async (m) => `resumed:${m}` });
    const r = await registry.resume('sub3', 'hi');
    suite.assert(r === 'resumed:hi', 'resume 闭包生效', r);
    const ok = registry.stop('sub3');
    suite.assert(ok === true && ctrl.signal.aborted, 'stop 回退到 record.controller.abort');
    suite.assert((await registry.resume('missing', 'x')) === null, '未知 id resume 返回 null');
  });

  suite.test('持久化：appendSubagentRecord / loadSubagentRecords 往返 + hydrate 只读', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-sub-'));
    const file = path.join(tmp, 's.jsonl');
    fs.writeFileSync(file, JSON.stringify({ t: 'meta', id: 'x', project: '/p', model: 'm', created: 0, updated: 0 }) + '\n');
    const rec = makeRecord('sub4');
    rec.status = 'ok';
    rec.endedAt = Date.now();
    rec.model = 'mock-model';
    rec.effort = 'high';
    rec.result = '最终结果 sk-abcdefghijklmnopqrstuvwxyz';
    rec.items = [{ kind: 'tool', text: 'read_file', name: 'read_file', ok: true }];
    rec.steps = 2;
    const ok = await appendSubagentRecord(file, rec);
    suite.assert(ok, 'appendSubagentRecord 写入成功');
    const loaded = await loadSubagentRecords(file);
    suite.assert(loaded.length === 1 && loaded[0].id === 'sub4', 'loadSubagentRecords 读回');
    suite.assert(loaded[0].model === 'mock-model' && loaded[0].effort === 'high', 'model/effort 保留');
    suite.assert(loaded[0].items.length === 1 && loaded[0].items[0].name === 'read_file', '明细保留');
    suite.assert(!loaded[0].result!.includes('sk-abcdefghijklmnopqrstuvwxyz'), '结果密钥脱敏', loaded[0].result);
    const reg = new SubagentRegistry();
    reg.hydrate(loaded as any);
    suite.assert(reg.size === 1 && reg.records()[0].status === 'ok', 'hydrate 回灌注册表');
    suite.assert((await reg.resume('sub4', 'x')) === null, '恢复记录不可续跑（无运行上下文）');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  suite.test('SubagentDef：reasoningEffort 解析（per-agent 思考级别）', () => {
    const fm = parseSubagentFrontmatter('---\nname: r\ndescription: d\nreasoningEffort: high\n---\nbody');
    suite.assert(fm.reasoningEffort === 'high', 'reasoningEffort 解析', fm);
    const fm2 = parseSubagentFrontmatter('---\nname: r\ndescription: d\n---\nbody');
    suite.assert(fm2.reasoningEffort === undefined, '缺省 undefined');
  });

  return suite;
}
