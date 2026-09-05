/**
 * 探针：子代理与编排（TODO 第六节）——单元 + 端到端全链路验证。
 *
 *   A    单元：parseSubagentFrontmatter（name/description/model/permission/tools/skills/maxSteps）
 *   B    单元：discoverSubagents（临时目录 .agents/subagents/*.md；非法跳过/项目优先全局）
 *   C    单元：parsePipelineArgs（任务 / --agents / --accept / --parallel / --max）
 *   D    e2e：MOCK_SUBAGENT 主代理 delegate 委托——子代理跑 run_command → 结果回传，
 *        轨迹事件含 subagent/start·step·end，foldTrace 渲染嵌套树行
 *   E    e2e：/orchestrate——fan-out 3 worker 并行 → 汇总器 → 对抗审查（mock 固定输出）
 *   F    e2e：/goal——缺省自动推导验收标准；第一次验收「不满足」→ 第二次「满足」→ 提前结束（2 次迭代）
 *
 * 用法：npx tsx scripts/probe-tmp/probe-subagent.ts
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { prepareRun, attachRuntime, type RunContext } from '../../src/main.js';
import { runAgent } from '../../src/agent/loop.js';
import { EventRecorder } from '../../src/agent/events.js';
import { foldTrace } from '../../src/agent/trace.js';
import { parseSubagentFrontmatter, discoverSubagents } from '../../src/agent/subagent-defs.js';
import { parsePipelineArgs, runGoal, runOrchestrate } from '../../src/agent/orchestrate.js';
import { ExecOutput } from '../../src/exec.js';

const PORT = 8813;
const XDG = mkdtempSync(join(tmpdir(), 'omni-subagent-probe-'));
process.env.XDG_CONFIG_HOME = XDG;
const ENV = {
  ...process.env,
  PORT: String(PORT),
  OMNI_BASE_URL: `http://127.0.0.1:${PORT}/v1`,
  OMNI_API_KEY: 'sk-mock',
  OMNI_MODEL: 'mock-model',
};
Object.assign(process.env, ENV);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function ok(cond: boolean, desc: string): void {
  console.log(`${cond ? '✅' : '❌'} ${desc}`);
  if (!cond) failed++;
}

let mockProc: ReturnType<typeof spawn> | null = null;
async function startMock(extra: Record<string, string> = {}): Promise<void> {
  if (mockProc) {
    mockProc.kill('SIGKILL'); // mock server 不捕获 SIGTERM？——实测 kill(SIGTERM) 后旧进程仍占端口
    await wait(400); // 等旧进程退出/端口释放——否则新进程 EADDRINUSE 崩溃、connect 连到旧进程（段间污染根因）
  }
  const env = { ...ENV, ...extra };
  mockProc = spawn('node', ['scripts/mock-server.mjs'], { env, stdio: 'ignore' });
  await wait(250); // 让新进程完成 bind
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

async function makeCtx(mockEnv: Record<string, string> = {}): Promise<RunContext> {
  await startMock(mockEnv);
  const ctx = prepareRun({});
  await attachRuntime(ctx, new ExecOutput(false));
  return ctx;
}

async function main(): Promise<void> {
  console.log(`XDG_CONFIG_HOME=${XDG}  PORT=${PORT}`);

  // ── A. frontmatter 解析 ──────────────────────────────────────────────
  {
    const fm = parseSubagentFrontmatter(
      '---\nname: code-reviewer\ndescription: 审查代码\nmodel: gpt-5\npermission: read\ntools: read_file, search_code\nskills: git-release,test-writing\nmaxSteps: 15\n---\n正文指令'
    );
    ok(fm.name === 'code-reviewer', 'A1 frontmatter name');
    ok(fm.description === '审查代码', 'A2 frontmatter description');
    ok(fm.model === 'gpt-5', 'A3 frontmatter model');
    ok(fm.permission === 'read', 'A4 frontmatter permission');
    ok(fm.tools?.length === 2 && fm.tools[1] === 'search_code', 'A5 frontmatter tools 列表（去空格）');
    ok(fm.skills?.length === 2 && fm.skills[0] === 'git-release', 'A6 frontmatter skills');
    ok(fm.maxSteps === 15, 'A7 frontmatter maxSteps');
    const bad = parseSubagentFrontmatter('没有 frontmatter');
    ok(bad.name === undefined, 'A8 无 frontmatter 返回空');
    const badPerm = parseSubagentFrontmatter('---\nname: x\npermission: evil\n---');
    ok(badPerm.permission === undefined, 'A9 非法 permission 丢弃');
  }

  // ── B. 定义发现（临时目录）───────────────────────────────────────────
  {
    const proj = mkdtempSync(join(tmpdir(), 'omni-defs-proj-'));
    mkdirSync(join(proj, '.agents', 'subagents'), { recursive: true });
    writeFileSync(join(proj, '.agents', 'subagents', 'code-reviewer.md'),
      '---\nname: code-reviewer\ndescription: 只读审查\npermission: read\n---\n只读准则');
    writeFileSync(join(proj, '.agents', 'subagents', 'bad-name.md'),
      '---\nname: other\ndescription: 名字不一致\n---\n应被跳过');
    writeFileSync(join(proj, '.agents', 'subagents', 'no-desc.md'),
      '---\nname: no-desc\n---\n缺 description 应被跳过');
    // 全局同名（项目优先）
    mkdirSync(join(XDG, 'omni', 'subagents'), { recursive: true });
    writeFileSync(join(XDG, 'omni', 'subagents', 'code-reviewer.md'),
      '---\nname: code-reviewer\ndescription: 全局版\n---\n全局');
    const defs = await discoverSubagents(proj);
    const cr = defs.find((d) => d.name === 'code-reviewer');
    ok(defs.length === 1, `B1 只发现合法定义（实际 ${defs.length}）`);
    ok(cr?.description === '只读审查' && cr.permission === 'read', 'B2 项目优先于全局 + permission 解析');
    ok(cr?.instructions.includes('只读准则'), 'B3 正文指令解析');
  }

  // ── C. 编排参数解析 ──────────────────────────────────────────────────
  {
    const p = parsePipelineArgs('完成登录功能 --agents a,b --accept 测试通过 --parallel 2');
    ok(p.task === '完成登录功能', `C1 task=${p.task}`);
    ok(p.agents?.length === 2 && p.agents[1] === 'b', 'C2 agents 列表');
    ok(p.accept === '测试通过', `C3 accept=${p.accept}`);
    ok(p.parallel === 2, 'C4 parallel');
    const p2 = parsePipelineArgs('普通任务');
    ok(p2.task === '普通任务' && p2.agents === undefined && p2.accept === undefined, 'C5 无 flag');
    const p3 = parsePipelineArgs('完成部署 --max 3 --accept 发布成功');
    ok(p3.max === 3 && p3.accept === '发布成功', 'C6 --max 上限解析');
  }

  // ── D. 主代理 delegate 委托 e2e（MOCK_SUBAGENT）──────────────────────
  {
    const ctx = await makeCtx({ MOCK_SUBAGENT: '1' });
    ctx.runOpts.events = await EventRecorder.open(null);
    ctx.messages.push({ role: 'user', content: '请用子代理检查项目根目录' });
    await runAgent(ctx.client, ctx.model, ctx.messages, ctx.runOpts, new ExecOutput(false));
    const last = ctx.messages[ctx.messages.length - 1];
    ok(last?.role === 'assistant' && typeof last.content === 'string' && last.content.includes('任务完成'),
      'D1 主代理最终回答（mock）');
    const evs = ctx.runOpts.events.events;
    const sa = evs.filter((e) => e.k === 'subagent/start');
    const se = evs.filter((e) => e.k === 'subagent/end');
    ok(sa.length === 1 && se.length === 1, `D2 轨迹含 subagent/start·end（${sa.length}/${se.length}）`);
    const rows = foldTrace(evs);
    const subRows = rows.filter((r) => r.kind === 'subagent');
    ok(subRows.length === 1 && subRows[0].text.includes('delegate'), `D3 foldTrace 渲染子代理行（${subRows[0]?.text ?? '无'}）`);
    const done = subRows[0];
    ok(done?.text.includes('✓') && (done?.sub?.length ?? 0) > 0, 'D4 子代理行含完成标记与结果摘要副行');
    ok(evs.filter((e) => e.k === 'subagent/step').length >= 1, 'D5 轨迹含 subagent/step');
  }

  // ── E. /orchestrate e2e（mock 固定角色输出）─────────────────────────
  {
    const ctx = await makeCtx({});
    ctx.runOpts.events = await EventRecorder.open(null);
    const logs: string[] = [];
    const { combined, review } = await runOrchestrate('评估 mock 项目', ctx.runOpts.subagents, {
      client: ctx.client,
      model: ctx.model,
      runOpts: ctx.runOpts,
      log: (t) => logs.push(t),
      onSubagentEvent: () => {},
    });
    ok(logs.some((l) => l.includes('fan-out：3 个 worker')), 'E1 默认 3 个 worker fan-out');
    ok(combined.includes('综合结论'), 'E2 汇总器输出');
    ok(review.includes('总体结论'), 'E3 对抗审查输出');
    const evs = ctx.runOpts.events.events;
    ok(evs.filter((e) => e.k === 'subagent/start').length === 3, 'E4 轨迹 3 个 worker start');
    const subRows = foldTrace(evs).filter((r) => r.kind === 'subagent');
    ok(subRows.length === 3 && subRows.every((r) => r.text.includes('worker')), `E5 子代理行（${subRows.length} 行，depth 0 无树形缩进）`);
  }

  // ── F. /goal e2e（第一次不满足 → 第二次满足提前结束 + 自动推导验收标准）──
  {
    const ctx = await makeCtx({ MOCK_GOAL_CHECKS: '0' });
    ctx.runOpts.events = await EventRecorder.open(null);
    const logs: string[] = [];
    const streams: string[] = []; // 流式段（推导/验收判定逐字）
    const result = await runGoal('完成部署', {
      client: ctx.client,
      model: ctx.model,
      runOpts: ctx.runOpts,
      log: (t) => logs.push(t),
      onStream: () => ({
        start(prefix: string) {
          streams.push(prefix);
        },
        chunk(text: string) {
          streams[streams.length - 1] += text;
        },
        end() {},
      }),
      onSubagentEvent: () => {},
    });
    const met = logs.filter((l) => l.includes('目标达成'));
    ok(met.length === 1 && met[0].includes('第 2 轮'), `F1 第二次迭代验收达成（logs: ${met[0] ?? '无'}）`);
    ok(result.includes('[目标达成：第 2 轮]'), 'F2 返回结果含目标达成标记');
    ok(logs.some((l) => l.includes('推导验收标准')), 'F3 缺省自动推导验收标准');
    ok(streams.some((s) => s.includes('验收标准：1) 功能完整可运行')), 'F4 推导固定条款走流式段');
    ok(
      streams.some((s) => s.includes('验收判定（第 1 轮）：') && s.includes('不满足：结果尚未完整')),
      `F5 判定反馈进下一轮（streams: ${streams.find((s) => s.includes('不满足')) ?? '无'}）`
    );
  }

  // ── G. 三层预览：step.tool 当前动作 + 卡片结果摘要 + /agents <name> 展开 ──
  {
    // G1：真实委托轨迹的 step 事件带 tool（子代理工具执行时补发）
    const ctx = await makeCtx({ MOCK_SUBAGENT: '1' });
    ctx.runOpts.events = await EventRecorder.open(null);
    ctx.messages.push({ role: 'user', content: '请用子代理检查项目根目录' });
    await runAgent(ctx.client, ctx.model, ctx.messages, ctx.runOpts, new ExecOutput(false));
    // delegate 的 onEvent 回调：SubagentEvent 直接经 tools/delegate.ts 汇聚——从
    // 轨迹事件无法还原 tool 字段（events.subagentStep 不带），故单独断言 delegate
    // 工具执行结果里子代理跑了工具（step 事件数量 > 思考步数）
    const evs = ctx.runOpts.events.events;
    const steps = evs.filter((e) => e.k === 'subagent/step').length;
    ok(steps >= 1, `G1 轨迹含 subagent/step（${steps} 个）`);

    // G2：TuiOutput 面板模型——运行中 delegate 走输入区上方 delegateRuns 面板行
    //（不入对话流）；end 后 onToolResult 收尾：面板行移除 + 对话流留结果卡
    const { TuiOutput } = await import('../../src/tui/output.js');
    const { createTuiState, pushLine } = await import('../../src/tui/state.js');
    const s = createTuiState();
    s.model = 'mock';
    pushLine(s, { kind: 'user', text: 'hi' });
    const out = new TuiOutput(s, { showThinking: true }, { paint: () => {}, clearScrollback: () => {} } as never);
    out.onToolStep(1, 50, 'delegate', 'delegate task=检查项目根目录', { task: '检查项目根目录' }, 1);
    // 运行中 delegate 不进对话流、进面板行
    ok(s.lines.length === 1, 'G2a-0 运行中 delegate 不 push 对话流行（仍只有 user 行）');
    ok(s.delegateRuns.length === 1 && s.delegateRuns[0].seq === 1 && s.delegateRuns[0].title.includes('检查项目根目录'),
      'G2a delegate 面板行已创建（seq/title）');
    out.onSubagentEvent({ type: 'start', id: 'sub1', parentId: null, depth: 0, name: 'delegate', task: '检查项目根目录', seq: 1 });
    out.onSubagentEvent({ type: 'step', id: 'sub1', parentId: null, depth: 0, name: 'delegate', step: 0, maxSteps: 10, tool: 'run_command', seq: 1 });
    ok(s.delegateRuns[0].status.includes('run_command'), `G2b step 带 tool 显示当前动作（${s.delegateRuns[0].status}）`);
    out.onSubagentEvent({ type: 'think', id: 'sub1', parentId: null, depth: 0, name: 'delegate', text: '先看目录', seq: 1 });
    out.onSubagentEvent({ type: 'toolStart', id: 'sub1', parentId: null, depth: 0, name: 'delegate', text: 'run_command', argsPreview: '$ ls', seq: 1 });
    out.onSubagentEvent({ type: 'toolEnd', id: 'sub1', parentId: null, depth: 0, name: 'delegate', toolOk: true, outputPreview: ['（目录）ok'], seq: 1 });
    ok(s.delegateRuns[0].items.length === 3, `G2c 面板行明细含 think+toolStart+toolEnd（${s.delegateRuns[0].items.length} 条）`);
    out.onSubagentEvent({
      type: 'end', id: 'sub1', parentId: null, depth: 0, name: 'delegate',
      status: 'ok', summary: '项目结构正常，无问题。\n细节见 trace', steps: 2, durationMs: 1200, seq: 1,
    });
    ok(s.delegateRuns[0].status.startsWith('完成'), `G2d end 后面板行状态收尾（${s.delegateRuns[0].status}）`);
    // onToolResult：面板行移除 + 对话流留结果卡
    out.onToolResult(true, 44, ['项目结构正常，无问题。'], undefined, 1);
    ok(s.delegateRuns.length === 0, 'G2e-1 onToolResult 移除面板行');
    const cardLine = s.lines[s.lines.length - 1];
    ok(cardLine.kind === 'tool' && cardLine.card?.name === 'delegate' && cardLine.card.status === 'ok',
      'G2e-2 对话流留 delegate 结果卡');
    ok(cardLine.card?.subagent?.ok === true, 'G2e-3 结果卡含 subagent 摘要');
    // 结果卡收起态渲染：命令 + `✓ 子代理 delegate · N 步 · 结果首行`
    const { toolCardLines } = await import('../../src/output/format.js');
    const lines = toolCardLines(
      { ...cardLine.card, name: 'delegate', status: 'ok', expanded: false, spinner: undefined } as never,
      60
    );
    const resultRow = lines.find((l) => l.role === 'exec');
    ok(!!resultRow && resultRow.text.includes('✓') && resultRow.text.includes('项目结构正常'),
      `G2e-4 结果卡收起态显示结果摘要行（${resultRow?.text.trim() ?? '无'}）`);

    // G2f：并行多 delegate 按 seq 精确配对——两条面板行，事件带各自 seq 归集互不覆盖
    const s2 = createTuiState();
    s2.model = 'mock';
    const out2 = new TuiOutput(s2, { showThinking: true }, { paint: () => {}, clearScrollback: () => {} } as never);
    out2.onToolStep(1, 50, 'delegate', '→ 子代理A', { task: 'A' }, 1);
    out2.onToolStep(1, 50, 'delegate', '→ 子代理B', { task: 'B' }, 2);
    const runA = s2.delegateRuns.find((r) => r.seq === 1)!;
    const runB = s2.delegateRuns.find((r) => r.seq === 2)!;
    ok(!!runA && !!runB, 'G2f-1 两条面板行按 seq 分别入列');
    out2.onSubagentEvent({ type: 'step', id: 'subB', parentId: null, depth: 0, name: 'delegate', step: 0, maxSteps: 10, tool: 'search_code', seq: 2 });
    out2.onSubagentEvent({ type: 'think', id: 'subB', parentId: null, depth: 0, name: 'delegate', text: 'B 的思考', seq: 2 });
    out2.onSubagentEvent({ type: 'toolStart', id: 'subB', parentId: null, depth: 0, name: 'delegate', text: 'search_code', argsPreview: '* Grep "x"', seq: 2 });
    ok(runB.status.includes('search_code') && !runA.status.includes('search_code'), 'G2f-2 seq=2 事件归集到 B 行');
    ok(runB.items.length === 2 && runA.items.length === 0, 'G2f-3 B 行明细含 think+toolStart，A 行不被污染');

    // G2g：停止链路——stop 标记 + stopped 事件 → 面板行停止态；onToolResult 收尾成结果卡
    // （stopped 经 render 点击入口：标记 stopRequested → state.stopSubagent；这里直接驱动事件）
    runB.stopRequested = true;
    runB.status = '停止中…';
    out2.onSubagentEvent({ type: 'stopped', id: 'subB', parentId: null, depth: 0, name: 'delegate', steps: 1, durationMs: 500, seq: 2 });
    ok(runB.stopped === true && runB.status === '已停止', 'G2g-1 stopped 标记面板行停止态');
    out2.onToolResult(false, 10, ['已停止'], undefined, 2);
    ok(s2.delegateRuns.length === 1 && s2.delegateRuns[0].seq === 1, 'G2g-2 stopped 后 onToolResult 移除对应面板行（A 仍在）');
    // 收尾 A：正常完成路径
    out2.onToolResult(true, 20, ['A 完成'], undefined, 1);
    ok(s2.delegateRuns.length === 0, 'G2g-2b A 完成后面板清空');
    const stoppedCard = [...s2.lines].reverse().find(
      (l) => l.kind === 'tool' && l.card?.name === 'delegate' && l.card.subagent?.ok === false
    );
    ok(!!stoppedCard && stoppedCard.card?.status === 'err', 'G2g-3 停止结果卡为 err 态');
    const linesB = toolCardLines(
      { ...stoppedCard!.card, name: 'delegate', expanded: true, spinner: undefined } as never,
      60
    );
    const textB = linesB.map((l) => l.text).join('\n');
    ok(textB.includes('B 的思考') && textB.includes('* Grep "x"'), 'G2g-4 结果卡展开明细含 think+tool');
    ok(textB.includes('⏹ 已停止'), 'G2g-5 停止结果卡渲染 ⏹ 已停止');
    ok(!linesB.some((l) => l.role === 'stop'), 'G2g-6 结果卡无 ⏹ 停止按钮（停止只作用于运行中面板）');

    // G3：/agents <name> 展开查看角色全文（TUI 命令面板）
    const { runCommand: rc } = await import('../../src/tui/commands.js');
    const projG = mkdtempSync(join(tmpdir(), 'omni-agents-g-'));
    mkdirSync(join(projG, '.agents', 'subagents'), { recursive: true });
    writeFileSync(join(projG, '.agents', 'subagents', 'code-reviewer.md'),
      '---\nname: code-reviewer\ndescription: 只读审查\npermission: read\ntools: read_file, search_code\n---\n只读准则：\n1. 只看不改\n2. 给行号建议');
    const sG = createTuiState();
    const defsG = await discoverSubagents(projG);
    ok(defsG.length === 1 && defsG[0].name === 'code-reviewer', 'G3a 发现定义');
    await rc({ state: sG, subagents: defsG, tools: [], model: 'mock' } as never, '/agents code-reviewer');
    const panel = (sG.cmdPanel?.lines ?? []).map(String).join('\n');
    ok(panel.includes('code-reviewer — 只读审查'), 'G3b 标题含 name+description');
    ok(panel.includes('权限：read'), 'G3c 权限行');
    ok(panel.includes('工具白名单：read_file、search_code'), 'G3d 工具白名单');
    ok(panel.includes('只读准则') && panel.includes('1. 只看不改'), 'G3e 角色正文全文');
    // 未知名：warn 提示可用列表
    await rc({ state: sG, subagents: defsG, tools: [], model: 'mock' } as never, '/agents unknown-agent');
    const panel2 = (sG.cmdPanel?.lines ?? []).map(String).join('\n');
    ok(panel2.includes('未找到子代理定义「unknown-agent」'), 'G3f 未知名 warn');
  }

  mockProc?.kill();
  console.log(failed === 0 ? '\n🎉 全部通过' : `\n💥 ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
