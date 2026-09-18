/**
 * 功能测试：/btw 旁问（参数解析 / 上下文快照 / 只读工具循环 / 错误降级）。
 * 用假 OpenAI 客户端（流式 chunk 序列）驱动，无需网络。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import { TestSuite } from './framework.js';
import {
  askBtw,
  formatBtwNote,
  parseBtwArgs,
  snapshotForBtw,
  BTW_SYSTEM_PROMPT,
  BTW_TOOLS,
} from '../../src/agent/btw.js';

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

export function btwSuite(): TestSuite {
  const suite = new TestSuite('旁问 /btw（参数解析 / 快照 / 只读工具循环 / 降级）');

  suite.test('parseBtwArgs：--keep 解析与问题提取', () => {
    const a = parseBtwArgs('这个报错是什么意思');
    suite.assert(a.keep === false && a.question === '这个报错是什么意思', '普通问题');
    const b = parseBtwArgs('  --keep   刚才那个函数在哪定义  ');
    suite.assert(b.keep === true && b.question === '刚才那个函数在哪定义', '--keep + 问题');
    const c = parseBtwArgs('--keep');
    suite.assert(c.keep === true && c.question === '', '仅 --keep 无问题');
    const d = parseBtwArgs('');
    suite.assert(d.keep === false && d.question === '', '空参数');
  });

  suite.test('snapshotForBtw：过滤脚手架/工具消息 + 条数/字符上限', () => {
    const msgs: any[] = [
      { role: 'system', content: '[项目记忆] 不该进快照' },
      { role: 'user', content: '第一条问题' },
      { role: 'assistant', content: '第一条回答' },
      { role: 'tool', tool_call_id: 't1', content: '工具结果' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'user', content: '最近的问题' },
    ];
    const snap = snapshotForBtw(msgs);
    suite.assert(snap.length === 3, `只保留 3 条纯文本 user/assistant（实际 ${snap.length}）`);
    suite.assert(snap.every((m) => m.role === 'user' || m.role === 'assistant'), '无 system/tool');
    suite.assert(JSON.stringify(snap[snap.length - 1]) === JSON.stringify({ role: 'user', content: '最近的问题' }), '保持时间序（最后一条 = 最近）');
    const capped = snapshotForBtw(msgs, 2);
    suite.assert(capped.length === 2, 'maxMessages 生效');
    const charCapped = snapshotForBtw([{ role: 'user', content: 'x'.repeat(500) }, { role: 'assistant', content: 'y'.repeat(500) }], 20, 600);
    suite.assert(charCapped.length === 1, '字符超限从最旧丢弃');
  });

  suite.test('formatBtwNote：Q/A 进 system 消息（可落盘格式）', () => {
    const note = formatBtwNote('在哪定义', '在 src/a.ts:10');
    suite.assert(note.startsWith('[旁问] 问：在哪定义'), '前缀 + 问题');
    suite.assert(note.includes('答：在 src/a.ts:10'), '答案');
    suite.assert(!note.startsWith('[项目记忆') && !note.startsWith('[全局记忆'), '不命中脚手架过滤前缀（可落盘）');
  });

  suite.test('askBtw：无工具调用直接回答 + 快照注入 + 不污染 messages', async () => {
    const { client, seen } = fakeClient([[textChunk('侧问答案')]]);
    const messages: any[] = [{ role: 'user', content: '主线任务里的问题' }];
    const before = JSON.stringify(messages);
    const r = await askBtw(client, 'mock', messages, '旁问一下');
    suite.assert(r.ok && r.answer === '侧问答案' && r.toolCalls === 0, '回答与计数');
    suite.assert(JSON.stringify(messages) === before, '原 messages 不被修改');
    suite.assert(seen.length === 1, '只有一次 LLM 调用');
    const sent = seen[0].messages;
    suite.assert(String(sent[0].content).startsWith('你是 omni 的旁问助手'), '系统提示为首条');
    suite.assert(sent.some((m: any) => m.content === '主线任务里的问题'), '当前对话快照注入');
    suite.assert(sent[sent.length - 1].content === '旁问一下', '问题在末尾');
    suite.assert(seen[0].tools?.length === 3 && seen[0].tools.every((t: any) => t.type === 'function'), '只读工具定义随请求下发');
  });

  suite.test('askBtw：工具轮 → 只读执行 → 最终回答（工具结果回传转录）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-btw-'));
    const file = path.join(tmp, 'note.txt');
    fs.writeFileSync(file, 'BTW-TOOL-CONTENT');
    const { client, seen } = fakeClient([
      [toolChunk('call_1', 'read_file', JSON.stringify({ path: file }))],
      [textChunk('文件里写着 BTW-TOOL-CONTENT')],
    ]);
    const r = await askBtw(client, 'mock', [{ role: 'user', content: '看看 note.txt' }], 'note.txt 里有什么', { cwd: tmp });
    suite.assert(r.ok && r.toolCalls === 1, `一次工具调用（实际 ${r.toolCalls}）`);
    suite.assert(r.answer.includes('BTW-TOOL-CONTENT'), '最终回答');
    const second = seen[1].messages;
    const toolMsg = second.find((m: any) => m.role === 'tool');
    suite.assert(Boolean(toolMsg) && String(toolMsg.content).includes('BTW-TOOL-CONTENT'), '工具结果回传（read_file 生效）');
    suite.assert(seen[1].tools !== undefined, '中间步仍允许工具');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  suite.test('askBtw：最后一步强制收口（不带工具）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-btw2-'));
    const file = path.join(tmp, 'a.txt');
    fs.writeFileSync(file, 'hello');
    const { client, seen } = fakeClient([
      [toolChunk('call_1', 'read_file', JSON.stringify({ path: file }))],
      [textChunk('收口回答')],
    ]);
    const r = await askBtw(client, 'mock', [], '看看', { cwd: tmp, maxSteps: 2 });
    suite.assert(r.ok && r.answer === '收口回答', '两步内收口');
    suite.assert(seen[1].tools === undefined, '最后一步不下发工具');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  suite.test('askBtw：LLM 异常降级（ok=false + error）', async () => {
    const client = {
      chat: { completions: { create: async () => { throw new Error('网络断了'); } } },
    } as unknown as OpenAI;
    const r = await askBtw(client, 'mock', [], '问题');
    suite.assert(r.ok === false && r.error === '网络断了', '错误透传');
    suite.assert(r.answer === '' && r.toolCalls === 0, '空结果');
  });

  suite.test('BTW_TOOLS 只读三件套 + 系统提示约束', () => {
    const names = BTW_TOOLS.map((t) => t.name).sort();
    suite.assert(JSON.stringify(names) === JSON.stringify(['list_directory', 'read_file', 'search_code']), '仅只读工具');
    suite.assert(!BTW_TOOLS.some((t) => t.name === 'run_command' || t.name === 'write_file'), '无命令/写工具');
    suite.assert(BTW_SYSTEM_PROMPT.includes('只读工具') && BTW_SYSTEM_PROMPT.includes('不要修改文件'), '提示约束');
  });

  return suite;
}
