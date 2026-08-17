/**
 * Hooks 框架探针（P0：UserPromptSubmit / PreToolUse / PostToolUse / Stop / Notification）：
 *   1. 单元：matchTool 通配 / runHook JSON 解析与超时降级 / HookRunner 各事件方法；
 *   2. E2E：真实 runAgent + mock API server——PostToolUse 输出回传上下文、PreToolUse
 *      硬拦截不执行、UserPromptSubmit 改写 prompt、Stop 要求继续。
 * 用法：node scripts/mock-server.mjs 由本探针自动起（端口 8792）；npx tsx scripts/probe-tmp/probe-hooks.ts
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import { HookRunner, matchTool, runHook, type HooksConfig } from '../../src/hooks/index.js';
import { tools } from '../../src/tools/index.js';
import { runAgent } from '../../src/agent/loop.js';

let failures = 0;
function check(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}`);
  }
}

/** 最小 Output 桩（runAgent 需要的全部事件 no-op） */
function stubOutput(): any {
  return {
    thinking: { shown: false, start() {}, write() {}, finish() {} },
    banner() {},
    onRound() {},
    onStreamStart() {},
    onAnswer() {},
    onAnswerEnd() {},
    onUsage() {},
    onRequestFailed() {},
    onThinkingSaved() {},
    onToolStep() {},
    onToolResult() {},
    onMaxSteps() {},
    onUserMessage() {},
    onTurnEnd() {},
    onWaitForInput() {},
  };
}

const CWD = process.cwd();
const hook = (mode: string) => `node scripts/mock-hook.mjs ${mode}`;

async function unitTests(): Promise<void> {
  console.log('\n[1] 单元：matchTool');
  check(matchTool(undefined, 'write_file') === true, '无 matcher = 全部');
  check(matchTool('*', 'run_command') === true, '`*` = 全部');
  check(matchTool('write_file', 'write_file') === true, '精确命中');
  check(matchTool('write_file', 'read_file') === false, '精确不命中');
  check(matchTool('read_*', 'read_file') === true && matchTool('read_*', 'run_command') === false, '前缀通配');
  check(matchTool('*_file', 'write_file') === true && matchTool('*_file', 'run_command') === false, '后缀通配');

  console.log('\n[1] 单元：runHook（JSON 协议 + 降级）');
  const r1 = await runHook(`echo '{"decision":"approve"}'`, { cwd: CWD, hook_event_name: 'PreToolUse', source: 'omni' }, 5000, CWD);
  check(r1.json?.decision === 'approve', 'stdout JSON 解析');
  const r2 = await runHook(`echo 'log line'; echo '{"decision":"block","reason":"x"}'`, { cwd: CWD, hook_event_name: 'PreToolUse', source: 'omni' }, 5000, CWD);
  check(r2.json?.decision === 'block' && r2.json.reason === 'x', '前置日志后取末尾 JSON');
  const r3 = await runHook('echo hello', { cwd: CWD, hook_event_name: 'PreToolUse', source: 'omni' }, 5000, CWD);
  check(r3.json === null && r3.failed === false, '非 JSON → null（不视为失败）');
  const r4 = await runHook('sleep 3', { cwd: CWD, hook_event_name: 'PreToolUse', source: 'omni' }, 300, CWD);
  check(r4.failed === true && r4.json === null && (r4.failReason ?? '').includes('超时'), '超时降级');
  const r5 = await runHook('this-command-does-not-exist-xyz', { cwd: CWD, hook_event_name: 'PreToolUse', source: 'omni' }, 3000, CWD);
  check(r5.failed === true, '命令不存在降级');
  // P1：stderr 捕获——非零退出码 + 无 stdout 时，stderr 尾部并入失败原因
  const r6 = await runHook(`echo 'boom detail' 1>&2; exit 1`, { cwd: CWD, hook_event_name: 'PreToolUse', source: 'omni' }, 3000, CWD);
  check(r6.failed === true && (r6.failReason ?? '').includes('boom detail'), 'stderr 捕获并入失败原因');

  console.log('\n[1] 单元：P1 新事件（SessionStart/PreCompact）');
  const collect: [string, string[]][] = [];
  const runnerP1 = new HookRunner(
    { hooks: { SessionStart: [{ command: hook('output') }], PreCompact: [{ command: hook('notify') }] }, cwd: CWD, onOutput: (e, lines) => collect.push([e, lines]) }
  );
  const s1 = await runnerP1.sessionStart();
  const s2 = await runnerP1.sessionStart();
  check(s1.length === 1 && s2.length === 0, 'SessionStart 每会话只触发一次');
  runnerP1.preCompact(12);
  await new Promise((r) => setTimeout(r, 800));
  check(collect.some(([e, l]) => e === 'PreCompact' && l.some((x) => x.includes('mock-notification'))), 'PreCompact fire-and-forget 触发');

  console.log('\n[1] 单元：config hooks 分层叠加（全局/项目/自定义合并）');
  const { loadConfig } = await import('../../src/config/index.js');
  const tmpLayer = mkdtempSync(path.join(os.tmpdir(), 'omni-hooks-layer-'));
  writeFileSync(
    path.join(tmpLayer, 'omni.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'write_file', command: hook('block') }] } })
  );
  const customLayer = path.join(tmpLayer, 'custom.json');
  writeFileSync(
    customLayer,
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'run_command', command: hook('pass') }], Stop: [{ command: hook('block') }] } })
  );
  const prevCwd = process.cwd();
  process.chdir(tmpLayer); // 项目配置发现从 cwd 向上 → 命中 tmpLayer/omni.json
  const prevEnv = process.env.OMNI_CONFIG;
  process.env.OMNI_CONFIG = customLayer;
  const cfgLayer = loadConfig();
  process.env.OMNI_CONFIG = prevEnv;
  process.chdir(prevCwd);
  const mergedPre = cfgLayer.hooks?.PreToolUse ?? [];
  check(mergedPre.length === 2, '分层叠加：项目 + 自定义 PreToolUse 合并（2 条）');
  check(mergedPre[0]?.command.includes('block') && mergedPre[1]?.command.includes('pass'), '低层（项目）在前、高层追加');
  check((cfgLayer.hooks?.Stop ?? []).length === 1, '自定义层独立事件 Stop 保留');

  console.log('\n[1] 单元：HookRunner 各事件');
  const hooks: HooksConfig = {
    PreToolUse: [
      { matcher: 'write_file', command: hook('block') },
      { matcher: 'write_file', command: hook('updated') },
      { matcher: 'read_*', command: hook('pass') },
    ],
    PostToolUse: [{ matcher: 'write_file', command: hook('output') }],
    Stop: [{ command: hook('block') }],
    UserPromptSubmit: [{ command: hook('rewrite') }],
    Notification: [{ command: hook('notify') }],
  };
  const runner = new HookRunner({ hooks, cwd: CWD });
  // PreToolUse：write_file 命中两个 hook（第二个 block → 硬拦截；reason 来自 block）
  const pre = await runner.preToolUse('write_file', { path: 'a.txt' });
  check(pre.allow === false && (pre.reason ?? '').includes('mock 拦截'), 'PreToolUse block 硬拦截');
  // read_file 只命中 pass → 放行
  const pre2 = await runner.preToolUse('read_file', { path: 'a.txt' });
  check(pre2.allow === true, 'PreToolUse 放行（matcher 过滤）');
  // run_command 无命中 hook → 放行
  const pre3 = await runner.preToolUse('run_command', { command: 'ls' });
  check(pre3.allow === true && pre3.updatedInput === undefined, 'PreToolUse 无匹配 hook 原样');
  // PostToolUse：extra 收集 hookSpecificOutput；matcher 不命中 → 空
  const post = await runner.postToolUse('write_file', { path: 'a.txt' }, '退出码: 0');
  check(post.extra.length === 1 && post.extra[0].includes('mock-lint'), 'PostToolUse hookSpecificOutput');
  const post2 = await runner.postToolUse('run_command', { command: 'ls' }, 'out');
  check(post2.extra.length === 0, 'PostToolUse matcher 不命中 → 无 extra');
  // Stop：block（未续过）→ 要求继续；stop_hook_active=true → 忽略 block
  const stop1 = await runner.stop(false);
  check(stop1.allow === false && (stop1.reason ?? '').includes('mock 要求继续'), 'Stop block 要求继续');
  const stop2 = await runner.stop(true);
  check(stop2.allow === true, 'Stop stop_hook_active=true 忽略 block');
  // UserPromptSubmit：改写 prompt
  const ups = await runner.userPromptSubmit('帮我改一下');
  check(ups.prompt === '帮我改一下（mock hook 改写）', 'UserPromptSubmit updatedPrompt 改写');
  // Notification：fire-and-forget（返回后稍等，通知输出不阻塞）
  const notified = await new Promise<boolean>((resolve) => {
    const r = new HookRunner({ hooks, cwd: CWD, onOutput: (_e, lines) => resolve(lines.some((l) => l.includes('mock-notification'))) });
    r.notification({ message_type: 'test' });
    setTimeout(() => resolve(false), 1500);
  });
  check(notified, 'Notification fire-and-forget 输出');
  // 失败降级：PreToolUse 命令不存在 → 放行
  const badRunner = new HookRunner({ hooks: { PreToolUse: [{ matcher: '*', command: 'no-such-cmd-xyz' }] }, cwd: CWD });
  const preFail = await badRunner.preToolUse('write_file', {});
  check(preFail.allow === true, 'PreToolUse 失败降级放行');
  // 超时降级：PreToolUse 慢脚本 → 放行
  const slowRunner = new HookRunner({ hooks: { PreToolUse: [{ command: hook('slow'), timeoutMs: 300 }] }, cwd: CWD });
  const t0 = Date.now();
  const preSlow = await slowRunner.preToolUse('write_file', {});
  check(preSlow.allow === true && Date.now() - t0 < 1500, `PreToolUse 超时降级放行（${Date.now() - t0}ms）`);
}

async function startMock(): Promise<() => void> {
  const port = 8792;
  const child = spawn('node', ['scripts/mock-server.mjs'], { cwd: CWD, env: { ...process.env, PORT: String(port), MOCK_WRITE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
      if (res.status > 0) break;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('mock server 启动超时');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return () => child.kill();
}

async function e2e(): Promise<void> {
  const stop = await startMock();
  try {
    const client = new OpenAI({ baseURL: 'http://127.0.0.1:8792/v1', apiKey: 'mock' });
    const hookOpts = { cwd: CWD, onOutput: () => {} };

    console.log('\n[2] E2E：PostToolUse 输出回传上下文（write_file → mock-lint 进工具结果）');
    {
      const msgs: any[] = [];
      const runner = new HookRunner({
        hooks: { PostToolUse: [{ matcher: 'write_file', command: hook('output') }] },
        ...hookOpts,
      });
      await runAgent(client, 'mock-model', msgs, { tools, maxSteps: 5, stream: true, showThinking: true, hooks: runner, permission: 'full', auditLog: false }, stubOutput());
      const toolMsg = msgs.find((m) => m.role === 'tool');
      check(String(toolMsg?.content).includes('[hook 输出]') && String(toolMsg?.content).includes('mock-lint'), '工具结果含 [hook 输出] + mock-lint');
      check(String(toolMsg?.content).includes('undo-test.txt'), '工具结果仍含原始输出（写入路径）');
    }

    console.log('\n[2] E2E：PreToolUse 硬拦截（write_file 被 block → 不执行、无副作用）');
    {
      const undoFile = `${CWD}/undo-test.txt`;
      if (existsSync(undoFile)) unlinkSync(undoFile);
      const msgs: any[] = [];
      const runner = new HookRunner({
        hooks: { PreToolUse: [{ matcher: 'write_file', command: hook('block') }] },
        ...hookOpts,
      });
      await runAgent(client, 'mock-model', msgs, { tools, maxSteps: 5, stream: true, showThinking: true, hooks: runner, permission: 'full', auditLog: false }, stubOutput());
      const toolMsg = msgs.find((m) => m.role === 'tool');
      check(String(toolMsg?.content).includes('已拦截（hook）') && String(toolMsg?.content).includes('mock 拦截'), '工具结果含已拦截（hook）');
      check(!existsSync(undoFile), 'write_file 未实际执行（无副作用）');
    }

    console.log('\n[2] E2E：UserPromptSubmit 改写 prompt（模型实际看到改写后的内容）');
    {
      const msgs: any[] = [];
      const runner = new HookRunner({
        hooks: { UserPromptSubmit: [{ command: hook('rewrite') }] },
        ...hookOpts,
      });
      const rewritten = (await runner.userPromptSubmit('帮我验证环境')).prompt;
      msgs.push({ role: 'user', content: rewritten });
      await runAgent(client, 'mock-model', msgs, { tools, maxSteps: 5, stream: true, showThinking: true, hooks: runner, permission: 'full', auditLog: false }, stubOutput());
      check(msgs[0].content === '帮我验证环境（mock hook 改写）', 'messages[0] 为改写后的 prompt');
    }

    console.log('\n[2] E2E：Stop hook 要求继续（block → system 消息 → 模型继续 → 再完成）');
    {
      const msgs: any[] = [{ role: 'user', content: 'hi' }];
      const runner = new HookRunner({ hooks: { Stop: [{ command: hook('block') }] }, ...hookOpts });
      await runAgent(client, 'mock-model', msgs, { tools, maxSteps: 6, stream: true, showThinking: true, hooks: runner, permission: 'full', auditLog: false }, stubOutput());
      const stopMsg = msgs.find((m) => m.role === 'system' && String(m.content).includes('Stop hook 要求继续'));
      check(!!stopMsg, 'messages 含 [Stop hook 要求继续]');
      // 只续一次：Stop 再次触发时 stop_hook_active=true → 忽略 block，正常结束
      const stopBlocks = msgs.filter((m) => m.role === 'system' && String(m.content).includes('Stop hook 要求继续')).length;
      check(stopBlocks === 1, `只续一次（${stopBlocks} 条要求继续消息）`);
    }

    console.log('\n[2] E2E：SessionStart 每会话一次（hookSpecificOutput 注入首轮系统提示）');
    {
      const ev: string[] = [];
      const runner = new HookRunner({ hooks: { SessionStart: [{ command: hook('output') }] }, ...hookOpts, onOutput: (_e, l) => ev.push(...l) });
      const msgs: any[] = [{ role: 'user', content: 'hi' }];
      await runAgent(client, 'mock-model', msgs, { tools, maxSteps: 5, stream: true, showThinking: true, hooks: runner, permission: 'full', auditLog: false }, stubOutput());
      check(ev.filter((l) => l.includes('mock-lint')).length === 1, 'SessionStart 首回合触发一次');
      await runAgent(client, 'mock-model', msgs, { tools, maxSteps: 5, stream: true, showThinking: true, hooks: runner, permission: 'full', auditLog: false }, stubOutput());
      check(ev.filter((l) => l.includes('mock-lint')).length === 1, 'SessionStart 第二回合不重复触发');
    }

    console.log('\n[2] E2E：PreCompact 压缩前触发（summarizeContext 接线）');
    {
      const ev: string[] = [];
      const runner = new HookRunner({ hooks: { PreCompact: [{ command: hook('notify') }] }, ...hookOpts, onOutput: (_e, l) => ev.push(...l) });
      const { summarizeContext } = await import('../../src/agent/context.js');
      const msgs: any[] = [];
      for (let i = 0; i < 20; i++) msgs.push({ role: 'user', content: `q${i}` }, { role: 'assistant', content: `a${i}` });
      await summarizeContext(client, 'mock-model', msgs, { summarizeAt: 10, summarizeWindow: 8, hooks: runner });
      await new Promise((r) => setTimeout(r, 600)); // fire-and-forget 回显异步，等其落定
      check(ev.some((l) => l.includes('mock-notification')), 'PreCompact 在压缩发生前触发');
    }

    console.log('\n[2] E2E：SubagentStart/Stop + 子代理工具过 Pre/PostUse');
    {
      const ev: string[] = [];
      const runner = new HookRunner(
        {
          hooks: {
            SubagentStart: [{ command: hook('notify') }],
            SubagentStop: [{ command: hook('notify') }],
            PostToolUse: [{ matcher: '*', command: hook('output') }],
          },
          ...hookOpts,
          onOutput: (_e, l) => ev.push(...l),
        }
      );
      const { runSubagent } = await import('../../src/agent/subagent.js');
      const { Safety } = await import('../../src/safety/index.js');
      const gate = new Safety({ tier: 'full', audit: false });
      const result = await runSubagent(client, 'mock-model', '验证一下环境', { tools, gate, maxSteps: 5, hooks: runner });
      await new Promise((r) => setTimeout(r, 600)); // SubagentStop 是 fire-and-forget，等其回显落定
      check(ev.filter((l) => l.includes('mock-notification')).length >= 2, `SubagentStart/Stop 均触发（${ev.filter((l) => l.includes('mock-notification')).length} 条）`);
      check(ev.some((l) => l.includes('mock-lint')), '子代理工具调用过 PostToolUse（enforcement 覆盖）');
      check(result.length > 0, '子代理返回结论');
    }
  } finally {
    stop();
  }
}

async function main(): Promise<void> {
  await unitTests();
  await e2e();
  console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
