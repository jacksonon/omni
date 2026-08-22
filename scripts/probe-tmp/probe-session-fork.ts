/**
 * 会话管理探针：/fork 分叉 + /send 跨会话消息。
 *
 * 运行：npx tsx scripts/probe-tmp/probe-session-fork.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forkSession, sendSessionMessage } from '../../src/agent/session-fork.js';
import { createSession, loadSession, listSessions } from '../../src/agent/session.js';

let failed = 0;
function assert(cond: boolean, label: string, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed++;
    console.error(`  ✗ ${label}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`);
  }
}

async function main(): Promise<void> {
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const fakeXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-session-'));
  process.env.XDG_CONFIG_HOME = fakeXdg;

  console.log('=== A. 会话 fork（/fork）===');
  // 创建一个测试会话文件（3 条消息）
  const file = await createSession({ project: process.cwd(), model: 'mock-model' });
  assert(file !== null, '创建会话文件');
  // 手动追加消息
  const { appendSessionMessages } = await import('../../src/agent/session.js');
  await appendSessionMessages(file!, [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好！有什么可以帮你的？' },
    { role: 'user', content: '帮我看看项目结构' },
    { role: 'assistant', content: '好的，已查看项目结构。' },
  ]);
  // 加载确认 4 条消息
  const loaded = await loadSession(file!);
  assert(loaded !== null && loaded.messages.length === 4, '原始会话 4 条消息');

  // fork：保留前 2 条
  const forkFile = await forkSession(file!, 2, process.cwd(), 'mock-model');
  assert(forkFile !== null, 'fork 成功');
  const forkLoaded = await loadSession(forkFile!);
  assert(forkLoaded !== null, 'fork 文件可读');
  assert(forkLoaded.messages.length === 2, `fork 会话 2 条消息（实际 ${forkLoaded.messages.length}）`);
  assert(forkLoaded.messages[0].role === 'user' && String(forkLoaded.messages[0].content) === '你好', 'fork 消息 1 正确');
  assert(forkLoaded.messages[1].role === 'assistant' && String(forkLoaded.messages[1].content).includes('有什么可以帮'), 'fork 消息 2 正确');
  assert(forkLoaded.meta.id !== loaded!.meta.id, 'fork 新 id');
  assert(forkLoaded.meta.title === loaded!.meta.title, 'fork 继承标题');

  // fork 边界：N=0 或 N>消息数 → 失败
  const fail0 = await forkSession(file!, 0, process.cwd(), 'mock-model');
  assert(fail0 === null, 'fork N=0 失败');
  const fail5 = await forkSession(file!, 5, process.cwd(), 'mock-model');
  assert(fail5 === null, 'fork N>消息数 失败');

  // 原会话文件保留
  const orig = await loadSession(file!);
  assert(orig !== null && orig.messages.length === 4, '原会话保留 4 条消息');

  // fork 会话出现在列表
  const all = await listSessions();
  const forkInfo = all.find((s) => s.id === forkLoaded!.meta.id);
  assert(forkInfo !== undefined, 'fork 会话出现在列表');
  assert(forkInfo!.messages === 2, 'fork 消息数正确');

  console.log('=== B. 跨会话消息（/send）—— 需要 mock server ===');
  // 启动 mock server 做端到端验证
  const { spawn } = await import('node:child_process');
  const MOCK_PORT = 50_000 + Math.floor(Math.random() * 500);
  const mock = spawn('node', ['scripts/mock-server.mjs'], {
    env: { ...process.env, PORT: String(MOCK_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`);
      if (r.status > 0) break;
    } catch {
      await sleep(200);
    }
  }

  // 创建目标会话（2 条消息）
  const targetFile = await createSession({ project: process.cwd(), model: 'mock-model' });
  await appendSessionMessages(targetFile!, [
    { role: 'user', content: '配置在哪里？' },
    { role: 'assistant', content: '在 config 目录下。' },
  ]);

  // 创建目标会话的第二个文件（用于 send 测试）
  const targetFile2 = await createSession({ project: process.cwd(), model: 'mock-model' });
  await appendSessionMessages(targetFile2!, [
    { role: 'user', content: '之前的问题解决了吗？' },
    { role: 'assistant', content: '是的，已解决。' },
  ]);

  // 当前会话消息
  const currentMessages = [
    { role: 'user' as const, content: '当前会话问题' },
  ];
  const targetId = (await loadSession(targetFile2!))!.meta.id;

  // 创建 OpenAI 客户端连接 mock
  const { createClient } = await import('../../src/client.js');
  const client = createClient({ name: 'mock-model', baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-mock' }, 'sk-mock');
  const { tools } = await import('../../src/tools/index.js');
  const runOpts = { tools, stream: true, maxSteps: 50, showThinking: false };
  const { ConsoleOutput } = await import('../../src/output/console.js');
  const output = new ConsoleOutput({ stream: true, showThinking: false });

  // 执行跨会话消息
  console.log(`\n  向会话 ${targetId} 发送消息…`);
  const result = await sendSessionMessage(
    targetId, '检查一下现在的情况', client, 'mock-model', runOpts, output, currentMessages
  );
  assert(result !== null, 'send 返回结果非空');
  assert(result.includes('mock 端到端验证通过'), `send 结果含完成标记（${result.slice(0, 60)}…）`);

  // 当前会话消息已恢复（不包含目标会话的历史）
  assert(currentMessages.length === 1 && currentMessages[0].content === '当前会话问题', '当前会话消息已恢复');

  // 目标会话文件已追加新消息（用户消息 + 完整对话轮）
  const targetLoaded = await loadSession(targetFile2!);
  assert(targetLoaded !== null, '目标会话可读');
  assert(targetLoaded.messages.length > 2, `目标会话已追加消息（原 2 → ${targetLoaded.messages.length}）`);
  const lastMsg = targetLoaded.messages[targetLoaded.messages.length - 1];
  assert(
    typeof lastMsg.content === 'string' && lastMsg.content.includes('mock 端到端验证通过'),
    '目标会话最后一条含回答标记'
  );

  mock.kill('SIGKILL');
  process.env.XDG_CONFIG_HOME = oldXdg;
  fs.rmSync(fakeXdg, { recursive: true, force: true });
  console.log(failed === 0 ? '\n✓✓ 会话 fork + send 探针全部通过' : `\n✗✗ ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});