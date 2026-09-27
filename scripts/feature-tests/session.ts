/**
 * 功能测试：会话管理（fork 分叉 + send 跨会话消息 + 持久化）。
 * 纯函数断言 + mock server 端到端。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestSuite } from './framework.js';
import { parseResumeArgs } from '../../src/cli/args.js';
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

  suite.test('parseResumeArgs 顶层 resume 解析（codex resume 对等）', () => {
    const r1 = parseResumeArgs([]);
    suite.assert(r1.id === null && !r1.last && !r1.all && r1.promptWords.length === 0, '空参全缺省');
    const r2 = parseResumeArgs(['abc123', '继续干']);
    suite.assert(r2.id === 'abc123' && r2.promptWords.join(' ') === '继续干', 'id + prompt');
    const r3 = parseResumeArgs(['--last', '--all', '继续']);
    suite.assert(r3.last && r3.all && r3.id === null && r3.promptWords.join(' ') === '继续', '--last --all + prompt');
    const rl = parseResumeArgs(['abc', '--last']);
    suite.assert(rl.id === null && rl.last === true && rl.promptWords.join(' ') === 'abc', '--last 优先，首词转 prompt（无互斥态）');
    let threw = '';
    threw = '';
    try {
      parseResumeArgs(['--nope']);
    } catch (e) {
      threw = (e as Error).message;
    }
    suite.assert(threw.includes('未知参数'), '未知 flag 报错');
  });

  suite.test('顶层 resume 会话恢复（mock 端到端：--last/坏 id/裸非 TTY）', async () => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const fakeXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-sess-resume-'));
    process.env.XDG_CONFIG_HOME = fakeXdg;
    fs.mkdirSync(path.join(fakeXdg, 'omni'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeXdg, 'omni', 'trusted-workspaces.json'),
      JSON.stringify({ workspaces: [process.cwd()] })
    );
    const MOCK_PORT = 52_000 + Math.floor(Math.random() * 500);
    const { spawn } = await import('node:child_process');
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      env: { ...process.env, PORT: String(MOCK_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const runCli = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn('npx', ['tsx', 'src/index.ts', ...args], {
          env: {
            ...process.env,
            XDG_CONFIG_HOME: fakeXdg,
            OMNI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
            OMNI_API_KEY: 'sk-mock',
            OMNI_MODEL: 'mock-model',
            OMNI_PERMISSION: 'full',
            OMNI_SHOW_THINKING: '0',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        child.stdout.on('data', (d) => (acc += d));
        child.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
    try {
      for (let i = 0; i < 30; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`);
          if (r.status > 0) break;
        } catch {
          await sleep(200);
        }
      }
      // 种子会话（API 直建 + 落盘，不跑交互循环）
      const seed = await createSession({ project: process.cwd(), model: 'mock-model' });
      await appendSessionMessages(seed!, [
        { role: 'user', content: '种子问题' },
        { role: 'assistant', content: '种子回答' },
      ]);
      await finalizeSession(seed!);
      const r1 = await runCli(['resume', '--last', '继续任务']);
      suite.assert(r1.code === 0, `resume --last 退出码 0（实际 ${r1.code}）`);
      suite.assert(r1.out.includes('已恢复会话'), '打印统一恢复提示');
      suite.assert(r1.out.includes('mock 端到端验证通过'), '续跑拿到最终回答');
      const r2 = await runCli(['resume', 'no-such-id-xyz']);
      suite.assert(r2.code !== 0 && r2.out.includes('不存在'), '坏 id 非零退出并指路');
      const r3 = await runCli(['resume']);
      suite.assert(r3.code !== 0 && r3.out.includes('--last'), '裸 resume 非 TTY 指路 --last');
    } finally {
      mock.kill('SIGKILL');
      process.env.XDG_CONFIG_HOME = oldXdg;
      fs.rmSync(fakeXdg, { recursive: true, force: true });
    }
  });

  suite.test('顶层 fork 分叉进交互（codex fork：无 prompt 进交互，有 prompt 直跑）', async () => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const fakeXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-sess-fork-'));
    process.env.XDG_CONFIG_HOME = fakeXdg;
    fs.mkdirSync(path.join(fakeXdg, 'omni'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeXdg, 'omni', 'trusted-workspaces.json'),
      JSON.stringify({ workspaces: [process.cwd()] })
    );
    const MOCK_PORT = 53_000 + Math.floor(Math.random() * 500);
    const { spawn } = await import('node:child_process');
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      env: { ...process.env, PORT: String(MOCK_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const runCli = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn('npx', ['tsx', 'src/index.ts', ...args], {
          env: {
            ...process.env,
            XDG_CONFIG_HOME: fakeXdg,
            OMNI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
            OMNI_API_KEY: 'sk-mock',
            OMNI_MODEL: 'mock-model',
            OMNI_PERMISSION: 'full',
            OMNI_SHOW_THINKING: '0',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        child.stdout.on('data', (d) => (acc += d));
        child.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
    try {
      for (let i = 0; i < 30; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`);
          if (r.status > 0) break;
        } catch {
          await sleep(200);
        }
      }
      const seed = await createSession({ project: process.cwd(), model: 'mock-model' });
      await appendSessionMessages(seed!, [
        { role: 'user', content: '种子任务' },
        { role: 'assistant', content: '种子答案' },
      ]);
      await finalizeSession(seed!);
      const sid = (await loadSession(seed!))!.meta.id;
      // 无 prompt：分叉后进交互，管道 EOF 干净退出；新文件含分叉消息
      const before = (await listSessions()).length;
      const r1 = await runCli(['fork', sid.slice(0, 8)]);
      suite.assert(r1.code === 0, `fork 进交互退出码 0（实际 ${r1.code}）`);
      suite.assert(r1.out.includes('已分叉新会话'), '打印分叉公告');
      const after = await listSessions();
      suite.assert(after.length === before + 1, '新会话文件落盘');
      const forked = after.find((s) => s.id !== sid);
      const loaded = await loadSession(forked!.path);
      suite.assert(loaded !== null && loaded.messages.length === 2, '分叉消息全量继承');
      // 有 prompt：分叉后直跑一轮
      const r2 = await runCli(['fork', sid, '分叉后继续']);
      suite.assert(r2.code === 0, `fork+prompt 退出码 0（实际 ${r2.code}）`);
      suite.assert(r2.out.includes('mock 端到端验证通过'), 'fork 后续跑拿到回答');
      // 坏源与裸非 TTY
      const r3 = await runCli(['fork', 'no-such-xyz']);
      suite.assert(r3.code !== 0, '坏源非零退出');
      const r4 = await runCli(['fork']);
      suite.assert(r4.code !== 0 && r4.out.includes('--last'), '裸 fork 非 TTY 指路');
    } finally {
      mock.kill('SIGKILL');
      process.env.XDG_CONFIG_HOME = oldXdg;
      fs.rmSync(fakeXdg, { recursive: true, force: true });
    }
  });

  suite.test('顶层 archive/unarchive/delete 会话管理（codex 同名命令）', async () => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const fakeXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-sess-aud-'));
    process.env.XDG_CONFIG_HOME = fakeXdg;
    const { spawn } = await import('node:child_process');
    const runCli = (args: string[], stdin?: string) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn('npx', ['tsx', 'src/index.ts', ...args], {
          env: { ...process.env, XDG_CONFIG_HOME: fakeXdg },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let acc = '';
        child.stdout.on('data', (d) => (acc += d));
        child.stderr.on('data', (d) => (acc += d));
        if (stdin !== undefined) {
          child.stdin.write(stdin);
          child.stdin.end();
        } else {
          child.stdin.end();
        }
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
    try {
      const seed = await createSession({ project: process.cwd(), model: 'mock-model' });
      await appendSessionMessages(seed!, [{ role: 'user', content: 'x' }]);
      await finalizeSession(seed!);
      const sid = (await loadSession(seed!))!.meta.id;
      const short = sid.slice(0, 8);
      const r1 = await runCli(['archive', short]);
      suite.assert(r1.code === 0 && r1.out.includes('已归档'), `archive 前缀匹配归档（实际 ${r1.code}）`);
      suite.assert((await loadSession(seed!))!.meta.archived === true, '归档落盘');
      const r1b = await runCli(['archive', sid]);
      suite.assert(r1b.code === 0 && r1b.out.includes('无变化'), '重复归档幂等提示');
      const r2 = await runCli(['unarchive', sid]);
      // updateSessionMeta(false) 为删键语义（缺键即 false，全库按 falsy 读），此处同口径断言
      suite.assert(r2.code === 0 && !(await loadSession(seed!))!.meta.archived, '取消归档');
      const r3 = await runCli(['delete', sid]);
      suite.assert(r3.code !== 0 && r3.out.includes('--yes'), '非交互无 --yes 拒绝删除');
      suite.assert(fs.existsSync(seed!), '拒绝后文件保留');
      const r3b = await runCli(['delete', sid], 'n\n');
      suite.assert(r3b.code !== 0, '管道非 TTY 同样拒绝（confirm 短路，需 --yes）');
      suite.assert(fs.existsSync(seed!), '取消后文件保留');
      const r4 = await runCli(['delete', sid, '--yes']);
      suite.assert(r4.code === 0 && r4.out.includes('已永久删除'), '--yes 删除成功');
      suite.assert(!fs.existsSync(seed!), '文件已删');
      const r5 = await runCli(['archive', sid]);
      suite.assert(r5.code !== 0, '删后归档报错');
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