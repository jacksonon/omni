/**
 * 功能测试：会话管理（fork 分叉 + send 跨会话消息 + 持久化）。
 * 纯函数断言 + mock server 端到端。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestSuite } from './framework.js';
import { forkSession, sendSessionMessage } from '../../src/agent/session-fork.js';
import {
  createSession,
  appendSessionMessages,
  loadSession,
  listSessions,
  finalizeSession,
  persistableMessages,
  isPersistable,
  sessionIdFromPath,
} from '../../src/agent/session.js';

export function sessionSuite(): TestSuite {
  const suite = new TestSuite('会话管理（fork 分叉 / send 跨会话 / 持久化）');

  suite.test('会话持久化：创建 + 追加 + 加载 + 列表', async () => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const fakeXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-sess-'));
    process.env.XDG_CONFIG_HOME = fakeXdg;
    try {
      const file = await createSession({ project: process.cwd(), model: 'mock-model' });
      suite.assert(file !== null, '创建会话');
      await appendSessionMessages(file!, [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
      ]);
      const loaded = await loadSession(file!);
      suite.assert(loaded !== null && loaded.messages.length === 2, '加载 2 条消息');
      suite.assert(loaded!.meta.model === 'mock-model', 'meta 模型');
      await finalizeSession(file!);
      const list = await listSessions();
      suite.assert(list.length === 1, '列表含 1 个会话');
      suite.assert(sessionIdFromPath(file!) === loaded!.meta.id, 'id 与文件名一致');
      // isPersistable：脚手架过滤
      suite.assert(isPersistable({ role: 'system', content: '[项目记忆 AGENTS.md：x] 内容' }) === false, '脚手架 system 不落盘');
      suite.assert(isPersistable({ role: 'user', content: '正常' }) === true, '正常消息落盘');
    } finally {
      process.env.XDG_CONFIG_HOME = oldXdg;
      fs.rmSync(fakeXdg, { recursive: true, force: true });
    }
  });

  suite.test('会话 fork：保留前 N 条 + 原会话保留 + 边界', async () => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const fakeXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-sess2-'));
    process.env.XDG_CONFIG_HOME = fakeXdg;
    try {
      const file = await createSession({ project: process.cwd(), model: 'mock-model' });
      await appendSessionMessages(file!, [
        { role: 'user', content: '第一条' },
        { role: 'assistant', content: '回答一' },
        { role: 'user', content: '第二条' },
        { role: 'assistant', content: '回答二' },
      ]);
      const forkFile = await forkSession(file!, 2, process.cwd(), 'mock-model');
      suite.assert(forkFile !== null, 'fork 成功');
      const fork = await loadSession(forkFile!);
      suite.assert(fork !== null && fork.messages.length === 2, 'fork 保留 2 条');
      suite.assert(String(fork!.messages[0].content) === '第一条', 'fork 消息 1 正确');
      suite.assert(String(fork!.messages[1].content).includes('回答一'), 'fork 消息 2 正确');
      suite.assert(fork!.meta.id !== (await loadSession(file!))!.meta.id, 'fork 新 id');
      // 原会话保留
      const orig = await loadSession(file!);
      suite.assert(orig !== null && orig.messages.length === 4, '原会话保留 4 条');
      // 边界
      suite.assert((await forkSession(file!, 0, process.cwd(), 'mock-model')) === null, 'N=0 失败');
      suite.assert((await forkSession(file!, 5, process.cwd(), 'mock-model')) === null, 'N>上限 失败');
      // 列表可见
      const list = await listSessions();
      suite.assert(list.some((s) => s.id === fork!.meta.id), 'fork 会话在列表');
    } finally {
      process.env.XDG_CONFIG_HOME = oldXdg;
      fs.rmSync(fakeXdg, { recursive: true, force: true });
    }
  });

  suite.test('跨会话消息 /send：mock 端到端', async () => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const fakeXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-sess3-'));
    process.env.XDG_CONFIG_HOME = fakeXdg;
    const MOCK_PORT = 51_000 + Math.floor(Math.random() * 500);
    const { spawn } = await import('node:child_process');
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      env: { ...process.env, PORT: String(MOCK_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      for (let i = 0; i < 30; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`);
          if (r.status > 0) break;
        } catch {
          await sleep(200);
        }
      }
      const targetFile = await createSession({ project: process.cwd(), model: 'mock-model' });
      await appendSessionMessages(targetFile!, [
        { role: 'user', content: '之前的问题解决了吗？' },
        { role: 'assistant', content: '是的，已解决。' },
      ]);
      const targetId = (await loadSession(targetFile!))!.meta.id;

      const { createClient } = await import('../../src/client.js');
      const client = createClient({ name: 'mock-model', baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-mock' }, 'sk-mock');
      const { tools } = await import('../../src/tools/index.js');
      const runOpts = { tools, stream: true, maxSteps: 50, showThinking: false };
      const { ConsoleOutput } = await import('../../src/output/console.js');
      const output = new ConsoleOutput({ stream: true, showThinking: false });
      const currentMessages = [{ role: 'user' as const, content: '当前会话' }];

      const result = await sendSessionMessage(
        targetId, '检查当前情况', client, 'mock-model', runOpts, output, currentMessages
      );
      suite.assert(result !== null, 'send 返回结果');
      suite.assert(result!.includes('mock 端到端验证通过'), '结果含完成标记');
      suite.assert(currentMessages.length === 1 && currentMessages[0].content === '当前会话', '当前上下文恢复');
      const target = await loadSession(targetFile!);
      suite.assert(target !== null && target.messages.length > 2, '目标会话已追加消息');
    } finally {
      mock.kill('SIGKILL');
      process.env.XDG_CONFIG_HOME = oldXdg;
      fs.rmSync(fakeXdg, { recursive: true, force: true });
    }
  });

  return suite;
}