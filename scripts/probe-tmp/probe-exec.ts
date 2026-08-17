/**
 * 探针：Headless 执行 + CI 集成（TODO 第二节）——单元 + 端到端全链路验证。
 *
 *   A/B/C  单元：parseExecArgs / validateAgainstSchema / extractFinalAnswer·resultJson
 *   D/E/F  e2e（进程内 runHeadless + mock MOCK_JSON）：text 模式 / schema 通过·不符 /
 *          max-turns 触限 → exit code 语义
 *   G      e2e：exec resume 会话续跑（session_id 不变、num_turns 递增、历史载入）
 *   H      e2e：allowed-tools 工具白名单过滤
 *   I/J    CLI 子进程：stdout 零污染（json / stream-json 单行可消费、进度走 stderr）
 *   K      stdin 注入形态（echo "上下文" | omni exec "任务"）
 *   L      MCP server：initialize → tools/list → tools/call omni_exec（JSON-RPC 握手）
 *
 * 用法：npx tsx scripts/probe-tmp/probe-exec.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { prepareRun, attachRuntime, type RunContext } from '../../src/main.js';
import { runHeadless, parseExecArgs, validateAgainstSchema, extractFinalAnswer, extractJsonObject, resultJson, ExecOutput, type ExecParseResult } from '../../src/exec.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

const PORT = 8811;
const XDG = mkdtempSync(join(tmpdir(), 'omni-exec-probe-'));
process.env.XDG_CONFIG_HOME = XDG; // 会话/全局记忆全部落到临时目录，不污染用户环境
const ENV = {
  ...process.env,
  PORT: String(PORT),
  MOCK_JSON: '1', // 最终回答 = {"verdict":"safe","summary":...}（--output-schema e2e 用）
  OMNI_BASE_URL: `http://127.0.0.1:${PORT}/v1`,
  OMNI_API_KEY: 'sk-mock',
  OMNI_MODEL: 'mock-model',
};
// 进程内 prepareRun/loadConfig 读主进程 process.env（ENV 只在 spawn 子进程时用）——
// 不注入会落到默认 baseURL=api.openai.com，runHeadless 请求外网卡死（实测两次卡住的根因）
Object.assign(process.env, ENV);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function ok(cond: boolean, desc: string): void {
  console.log(`${cond ? '✅' : '❌'} ${desc}`);
  if (!cond) failed++;
}

let mockProc: ReturnType<typeof spawn> | null = null;
async function startMock(): Promise<void> {
  mockProc = spawn('node', ['scripts/mock-server.mjs'], { env: ENV, stdio: 'ignore' });
  // mock 只服务 /chat/completions（其它路径一律 404）——健康检查用裸 TCP 连接探测端口
  for (let i = 0; i < 50; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = connect(PORT, '127.0.0.1', () => { sock.destroy(); resolve(); });
        sock.on('error', reject);
      });
      return;
    } catch { /* mock 未起 */ }
    await wait(100);
  }
  throw new Error('mock server 启动超时');
}

async function makeCtx(): Promise<RunContext> {
  const ctx = prepareRun({});
  await attachRuntime(ctx, new ExecOutput(true)); // MOCK_JSON 下进度静默
  return ctx;
}

function freshResult(messages: ChatCompletionMessageParam[]): HeadlessResult {
  return { result: extractFinalAnswer(messages), costUsd: 0, durationMs: 0, numTurns: 0, sessionId: null, exitCode: 0 };
}
interface HeadlessResult {
  result: string; costUsd: number; durationMs: number; numTurns: number; sessionId: string | null; exitCode: number;
}

async function main(): Promise<void> {
  console.log(`XDG_CONFIG_HOME=${XDG}  PORT=${PORT}`);
  await startMock();

  /* ── A. parseExecArgs 单元 ── */
  console.log('\n[A] parseExecArgs');
  const a1: ExecParseResult = parseExecArgs(['修一下', '--output-format', 'stream-json', '--max-turns', '7', '--allowed-tools', 'read_file,run_command']);
  ok(a1.promptRaw === '修一下' && a1.outputFormat === 'stream-json' && a1.maxTurns === 7 && JSON.stringify(a1.allowedTools) === JSON.stringify(['read_file', 'run_command']), '全量 flag 解析');
  const a2 = parseExecArgs(['--output-format=json', '--max-turns=3', '任务']);
  ok(a2.outputFormat === 'json' && a2.maxTurns === 3, '--flag=value 写法');
  const a3 = parseExecArgs(['resume', 'sess-1', '继续干', '--output-format', 'text']);
  ok(a3.resumeId === 'sess-1' && a3.promptRaw === '继续干', 'exec resume <id> 形态');
  const a4 = parseExecArgs(['resume', 'sess-2']);
  ok(a4.resumeId === 'sess-2' && a4.promptRaw === '[继续上次任务]', 'resume 无 prompt 回退占位');
  const a5 = parseExecArgs(['-']);
  ok(a5.promptRaw === '-', 'stdin 形态 `-` 透传');
  for (const [bad, label] of [
    [['--max-turns', '0'], 'max-turns 非正整数'],
    [['--output-format', 'xml'], 'output-format 非法值'],
    [['--wat'], '未知参数'],
  ] as [string[], string][]) {
    let threw = false;
    try { parseExecArgs(bad); } catch { threw = true; }
    ok(threw, `${label} → 抛错`);
  }
  const a6 = parseExecArgs(['任务', '--output-schema', '{"type":"object","required":["verdict"]}']);
  ok(JSON.stringify(a6.outputSchema) === '{"type":"object","required":["verdict"]}', 'output-schema 内联 JSON');
  const schemaFile = join(XDG, 'schema.json');
  writeFileSync(schemaFile, '{"type":"string","enum":["ok"]}');
  const a7 = parseExecArgs(['任务', '--output-schema', schemaFile]);
  ok(JSON.stringify(a7.outputSchema) === '{"type":"string","enum":["ok"]}', 'output-schema 文件路径');
  const a8 = parseExecArgs(['任务', '--', '--not-a-flag']);
  ok(a8.promptRaw === '任务 --not-a-flag', '`--` 后原样视为任务文本');

  /* ── B. validateAgainstSchema 单元 ── */
  console.log('\n[B] validateAgainstSchema');
  const bSchema = {
    type: 'object',
    required: ['verdict', 'count'],
    additionalProperties: false,
    properties: {
      verdict: { type: 'string', enum: ['safe', 'unsafe'], minLength: 2 },
      count: { type: 'number', minimum: 0, maximum: 100 },
      list: { type: 'array', items: { type: 'string' }, minItems: 1 },
      note: { type: 'string', pattern: '^[a-z]+$' },
    },
  };
  const b1 = validateAgainstSchema({ verdict: 'safe', count: 3, list: ['x'], note: 'ok' }, bSchema);
  ok(b1.length === 0, '合法对象通过');
  const b2 = validateAgainstSchema({ verdict: 'unsafe', count: 101, list: [], note: 'OK' }, bSchema);
  ok(b2.some((e) => e.includes('最大') || e.includes('maximum') || e.includes('> 100')) && b2.some((e) => e.includes('minItems') || e.includes('元素数')), `越界值逐项报错：${b2.join('; ')}`);
  const b3 = validateAgainstSchema({ verdict: 'weird' }, bSchema);
  ok(b3.some((e) => e.includes('枚举') || e.includes('enum')), `enum 不匹配：${b3.join('; ')}`);
  const b4 = validateAgainstSchema('not-json', bSchema);
  ok(b4.some((e) => e.includes('期望类型') || e.includes('期望 type')), `类型不符（answer 非 JSON 场景）：${b4.join('; ')}`);
  const b5 = validateAgainstSchema({ verdict: 'safe', extra: 1 }, bSchema);
  ok(b5.some((e) => e.includes('不允许') || e.includes('not allowed')), 'additionalProperties:false 拦截多余字段');
  const b6 = validateAgainstSchema({ verdict: 'safe' }, bSchema);
  ok(b6.some((e) => e.includes('count')), 'required 缺字段报错');

  /* ── C. extractFinalAnswer / resultJson 单元 ── */
  console.log('\n[C] extractFinalAnswer / resultJson');
  ok(extractFinalAnswer([
    { role: 'user', content: 'u' },
    { role: 'assistant', content: '中间' },
    { role: 'tool', tool_call_id: 'c', content: 't' },
    { role: 'assistant', content: '最终回答' },
  ]) === '最终回答', '取最后一个带正文的 assistant 消息');
  ok(extractFinalAnswer([{ role: 'user', content: 'u' }]) === '', '无回答返回空串');
  const rj = resultJson({ result: 'r', costUsd: 0.0012, durationMs: 42, numTurns: 2, sessionId: 's1', exitCode: 0 });
  ok(rj.result === 'r' && rj.cost_usd === 0.0012 && rj.duration_ms === 42 && rj.num_turns === 2 && rj.session_id === 's1' && rj.exit_code === 0, 'resultJson 字段齐全');
  const jx1 = extractJsonObject('{"verdict":"safe","summary":"ok"}');
  ok(JSON.stringify(jx1) === '{"verdict":"safe","summary":"ok"}', 'extractJsonObject 纯 JSON 原样');
  const jx2 = extractJsonObject('```json\n{"a":1}\n```\n说明文字');
  ok(JSON.stringify(jx2) === '{"a":1}', 'extractJsonObject ```json 围栏提取');
  const jx3 = extractJsonObject('好的，结论如下：{"verdict":"safe"} 以上');
  ok(JSON.stringify(jx3) === '{"verdict":"safe"}', 'extractJsonObject 首 { 到末 } 收窄（尾随散文）');
  ok(extractJsonObject('这不是 JSON') === null, 'extractJsonObject 非 JSON → null');

  /* ── D. e2e：runHeadless text 模式 ── */
  console.log('\n[D] runHeadless（text / json）');
  const ctxD = await makeCtx();
  const d = await runHeadless(ctxD, new ExecOutput(true), { prompt: '任务 D', outputFormat: 'text' });
  ok(d.exitCode === 0, `text 模式 exit 0（reason completed）`);
  ok(d.result.includes('mock 端到端'), `result 含 mock 回答：${d.result.slice(0, 40)}`);
  ok(!!d.sessionId && d.numTurns >= 1 && d.durationMs >= 0, `json 字段齐全：session=${d.sessionId} turns=${d.numTurns} ms=${d.durationMs}`);
  const sessDir = join(XDG, 'omni', 'sessions');
  const files = readdirSync(sessDir);
  ok(files.length === 1 && files[0].includes(d.sessionId!), `会话已落盘：${files[0]}`);
  ok(readFileSync(join(sessDir, files[0]), 'utf8').includes('任务 D'), '会话文件含任务消息');

  /* ── E. e2e：schema 通过 / 不符 ── */
  console.log('\n[E] --output-schema');
  const ctxE = await makeCtx();
  const eOk = await runHeadless(ctxE, new ExecOutput(true), {
    prompt: '任务 E',
    outputFormat: 'json',
    outputSchema: { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string', enum: ['safe', 'unsafe'] } } },
  });
  ok(eOk.exitCode === 0 && JSON.parse(eOk.result).verdict === 'safe', `MOCK_JSON 回答符合 schema → exit 0（${eOk.result.slice(0, 60)}）`);
  const ctxE2 = await makeCtx();
  const eBad = await runHeadless(ctxE2, new ExecOutput(true), {
    prompt: '任务 E2',
    outputFormat: 'json',
    outputSchema: { type: 'object', required: ['missing_field'] },
  });
  ok(eBad.exitCode === 1, `schema 不符 → exit 1（answer 无 required 字段）`);

  /* ── F. e2e：max-turns 触限 ── */
  console.log('\n[F] --max-turns');
  const ctxF = await makeCtx();
  ctxF.runOpts.maxSteps = 1; // applyExecOpts 同语义：Math.min(maxSteps, maxTurns)
  const f = await runHeadless(ctxF, new ExecOutput(true), { prompt: '任务 F', outputFormat: 'json' });
  ok(f.exitCode === 1 && f.result === '', `max-turns 触限 → exit 1 + 空 result`);

  /* ── G. e2e：exec resume 续跑 ── */
  console.log('\n[G] exec resume');
  const ctxG0 = await makeCtx();
  const g1 = await runHeadless(ctxG0, new ExecOutput(true), { prompt: '第一轮任务', outputFormat: 'json' });
  const sid = g1.sessionId!;
  const ctxG = await makeCtx();
  const g2 = await runHeadless(ctxG, new ExecOutput(true), { prompt: '继续讨论', resumeId: sid, outputFormat: 'json' });
  ok(g2.sessionId === sid, `resume 后 session_id 不变（${sid}）`);
  ok(g2.numTurns > g1.numTurns, `num_turns 递增：${g1.numTurns} → ${g2.numTurns}`);
  const resumedFile = readdirSync(sessDir).find((x) => x.includes(sid));
  const resumedContent = resumedFile ? readFileSync(join(sessDir, resumedFile), 'utf8') : '';
  ok(resumedContent.includes('第一轮任务') && resumedContent.includes('继续讨论'), '恢复会话文件含两段消息（无重复落盘）');
  const ctxBad = await makeCtx();
  let threw = false;
  try { await runHeadless(ctxBad, new ExecOutput(true), { prompt: 'x', resumeId: 'no-such-session', outputFormat: 'json' }); } catch { threw = true; }
  ok(threw, 'resume 不存在的会话 → 抛错');

  /* ── H. e2e：allowed-tools 白名单 ── */
  console.log('\n[H] --allowed-tools');
  const ctxH = await makeCtx();
  ctxH.runOpts.tools = ctxH.runOpts.tools.filter((t) => ['read_file', 'run_command'].includes(t.name)); // applyExecOpts 同语义
  const h = await runHeadless(ctxH, new ExecOutput(true), { prompt: '任务 H', outputFormat: 'json' });
  ok(h.exitCode === 0, `白名单 [read_file,run_command] 下 mock 链路仍通（工具受限但任务完成）`);
  const ctxH2 = await makeCtx();
  ctxH2.runOpts.tools = []; // 白名单命中 0 个工具 → 空工具链
  const h2 = await runHeadless(ctxH2, new ExecOutput(true), { prompt: '任务 H2', outputFormat: 'json' });
  ok(h2.exitCode === 0 && h2.result.length > 0, `空工具链不崩（纯回答）/ 结果非空`);

  /* ── I/J/K. CLI 子进程：stdout 零污染 + stdin 注入 ── */
  console.log('\n[I-J-K] CLI 子进程');
  const runCli = (args: string[], stdin?: string): { stdout: string; stderr: string; code: number } => {
    const r = spawnSync('npx', ['tsx', 'src/index.ts', 'exec', ...args], {
      env: { ...ENV, NO_COLOR: '1' },
      input: stdin,
      encoding: 'utf8',
      timeout: 60000,
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 };
  };
  const i1 = runCli(['任务 I', '--output-format', 'json']);
  const i1parsed = JSON.parse(i1.stdout.trim());
  ok(i1.code === 0 && i1parsed.result && i1parsed.session_id, `I. json：exit ${i1.code} + 单行 JSON 可解析`);
  ok(i1.stderr.length > 0 && !i1.stdout.includes('思考中') && !i1.stderr.includes('"result"'), 'I. stdout 零污染（进度在 stderr、结果在 stdout）');
  const j1 = runCli(['任务 J', '--output-format', 'stream-json']);
  const jLines = j1.stdout.trim().split('\n');
  const jLast = JSON.parse(jLines[jLines.length - 1]);
  ok(jLines.every((l) => l.startsWith('{')), `J. stream-json 每行一个 JSON（${jLines.length} 行）`);
  ok(jLast.t === 'result' && jLast.result && jLast.session_id, 'J. 末行 t=result（tail -1 即结构化结果）');
  const jEv = JSON.parse(jLines[0]);
  ok(jEv.t === 'ev' && jEv.e.k, 'J. 事件行 t=ev + 轨迹事件对象');
  const k1 = runCli(['任务 K（注入上下文）', '--output-format', 'json'], '这行 stdio 内容将被注入为上下文');
  ok(k1.code === 0, `K. stdin 注入形态 exit 0`);
  const k2 = runCli(['-', '--output-format', 'json'], 'stdin 整段即 prompt');
  ok(k2.code === 0 && k2.stdout.includes('mock 端到端'), 'K. `-` = 整段 stdin 即 prompt');

  /* ── L. MCP server：JSON-RPC 握手 ── */
  console.log('\n[L] omni mcp-server');
  const child = spawn('npx', ['tsx', 'src/index.ts', 'mcp-server'], { env: { ...ENV, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const responses: Record<string, unknown>[] = [];
  child.stdout!.on('data', (c) => {
    buf += String(c);
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });
  const send = (obj: unknown): void => { child.stdin!.write(JSON.stringify(obj) + '\n'); };
  const waitResponse = async (id: number, timeoutMs = 30000): Promise<Record<string, unknown>> => {
    const t0 = Date.now();
    while (!responses.some((r) => r.id === id)) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`MCP 响应超时 id=${id}，已收：${JSON.stringify(responses)}`);
      await wait(50);
    }
    return responses.find((r) => r.id === id)!;
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
  const init = await waitResponse(1);
  ok(init.result && (init.result as { serverInfo?: { name?: string } }).serverInfo?.name === 'omni-mcp', 'L. initialize 握手（serverInfo=omni-mcp）');
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = (await waitResponse(2)).result as { tools: { name: string }[] };
  ok(JSON.stringify(list.tools.map((t) => t.name).sort()) === JSON.stringify(['omni_exec', 'omni_reply']), 'L. tools/list 暴露 omni_exec + omni_reply');
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'omni_exec', arguments: { prompt: 'MCP 任务 L' } } });
  const call = (await waitResponse(3)).result as { content: { text: string }[]; isError: boolean };
  ok(!call.isError && call.content[0].text.includes('session_id'), `L. tools/call omni_exec 执行成功：${call.content[0].text.slice(0, 80)}`);
  const mcpResult = JSON.parse(call.content[0].text);
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'omni_reply', arguments: { session_id: mcpResult.session_id, prompt: '继续 MCP 会话' } } });
  const reply = (await waitResponse(4)).result as { content: { text: string }[]; isError: boolean };
  ok(!reply.isError && JSON.parse(reply.content[0].text).session_id === mcpResult.session_id, 'L. tools/call omni_reply 续跑同一会话');
  child.stdin!.end();
  await new Promise((r) => child.on('close', r));
  ok(child.exitCode === 0, `L. mcp-server 干净退出（exit ${child.exitCode}）`);

  console.log(`\n${failed === 0 ? '🎉 全部通过' : `❌ ${failed} 项失败`}`);
  mockProc?.kill(); // 回收 mock server 子进程
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('探针异常：', e);
  mockProc?.kill();
  process.exit(1);
});