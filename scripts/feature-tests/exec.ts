/**
 * 功能测试：`omni exec` headless CLI（codex exec 对等：-o 落盘等 flags 解析 + 端到端）。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestSuite } from './framework.js';
import { execHelpText, handleExecHelp, parseExecArgs } from '../../src/exec.js';
import { isConsoleCommand } from '../../src/main.js';
import { collectImageAttachments, loadImageAttachment, userMessageWithImages } from '../../src/agent/context.js';
import { reviewCode } from '../../src/agent/review.js';
import { dim, isTTY, setColorOverride } from '../../src/ui.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOCK_PORT = 47_000 + Math.floor(Math.random() * 800);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10000, msg = 'timeout'): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor: ${msg}`);
    await sleep(150);
  }
}

export function execSuite(): TestSuite {
  const suite = new TestSuite('Headless CLI / omni exec（flags 解析 + -o 落盘端到端）');

  suite.test('exec flags 解析：-o 落盘（codex --output-last-message）', () => {
    const r1 = parseExecArgs(['任务']);
    suite.assert(r1.promptRaw === '任务' && r1.outputLastMessage == null, '缺省无落盘');
    const r2 = parseExecArgs(['任务', '-o', '/tmp/x.md']);
    suite.assert(r2.promptRaw === '任务' && r2.outputLastMessage === '/tmp/x.md', '-o 短 flag');
    const r3 = parseExecArgs(['--output-last-message=/tmp/y.md', '任务']);
    suite.assert(r3.promptRaw === '任务' && r3.outputLastMessage === '/tmp/y.md', '--flag=value 形态');
    const r4 = parseExecArgs(['任务', '--approve-for-me']);
    suite.assert(r4.approveForMe === true && r4.outputLastMessage == null, '互不干扰');
  });

  suite.test('exec flags 解析：-i/--image 图片附件 + -m 模型（codex exec 对等）', () => {
    const r1 = parseExecArgs(['任务']);
    suite.assert(Array.isArray(r1.images) && r1.images.length === 0, '缺省无图片');
    const r2 = parseExecArgs(['-i', 'a.png', '任务', '--image=b.png']);
    suite.assert(r2.images.join(',') === 'a.png,b.png' && r2.promptRaw === '任务', '-i 可重复 + --image= 形态');
    const r3 = parseExecArgs(['任务', '-m', 'gpt-5']);
    suite.assert(r3.model === 'gpt-5', '-m 短 flag 模型覆盖');
    const r4 = parseExecArgs(['--model', 'deepseek-chat', '任务']);
    suite.assert(r4.model === 'deepseek-chat', '--model 长 flag');
  });

  suite.test('exec flags 解析：resume --last 最近会话（codex exec resume --last）', () => {
    const r1 = parseExecArgs(['resume', '--last', '继续']);
    suite.assert(r1.resumeLast === true && r1.resumeId === null && r1.promptRaw === '继续', 'resume --last 形态');
    const r2 = parseExecArgs(['--last']);
    suite.assert(r2.resumeLast === true && r2.promptRaw === '[继续上次任务]', '--last 无 prompt 续跑占位');
    const r3 = parseExecArgs(['resume', 'abc123']);
    suite.assert(r3.resumeId === 'abc123' && r3.resumeLast === false, 'resume <id> 不受影响');
    const r4 = parseExecArgs(['任务']);
    suite.assert(r4.resumeLast === false, '缺省关闭');
    const r5 = parseExecArgs(['--last', '--all']);
    suite.assert(r5.resumeLast === true && r5.resumeAll === true, '--last --all 跨目录');
    suite.assert(parseExecArgs(['任务']).resumeAll === false, '--all 缺省关闭');
  });

  suite.test('exec flags 解析：--color 颜色开关（codex exec --color）', () => {
    const r1 = parseExecArgs(['任务']);
    suite.assert(r1.color === undefined, '缺省 auto（不动默认）');
    const r2 = parseExecArgs(['--color', 'never', '任务']);
    suite.assert(r2.color === 'never' && r2.promptRaw === '任务', '--color never');
    const r3 = parseExecArgs(['任务', '--color=always']);
    suite.assert(r3.color === 'always', '--color= 形态');
    let threw = '';
    try {
      parseExecArgs(['--color', 'rainbow', '任务']);
    } catch (e) {
      threw = (e as Error).message;
    }
    suite.assert(threw.includes('--color 仅支持'), '非法取值报错');
    // 开关直达输出层（wrap 闭包运行时读绑定；用完复位，不污染后续测试）
    setColorOverride('never');
    suite.assert(dim('x') === 'x', 'never 下 dim 透传');
    setColorOverride('always');
    suite.assert(dim('x').includes('\x1b['), 'always 下 dim 带 ANSI');
    setColorOverride(null);
    if (!isTTY) suite.assert(dim('x') === 'x', '复位回默认（管道无 TTY 即无色；同进程复用不泄漏）');
  });

  suite.test('exec flags 解析：fork 分叉（codex exec fork）', () => {
    const r1 = parseExecArgs(['fork', 'abc123', '继续']);
    suite.assert(r1.forkId === 'abc123' && r1.promptRaw === '继续' && !r1.resumeId, 'fork <id> + prompt');
    const r2 = parseExecArgs(['fork', '--last']);
    suite.assert(r2.forkLast === true && r2.promptRaw === '', 'fork --last 无 prompt 仅分叉');
    let threw = '';
    try {
      parseExecArgs(['fork']);
    } catch (e) {
      threw = (e as Error).message;
    }
    suite.assert(threw.includes('缺少会话 id'), 'fork 缺 id 报错');
    const r3 = parseExecArgs(['任务']);
    suite.assert(r3.forkId === null && r3.forkLast === false, '缺省无 fork');
  });

  suite.test('exec resume/fork 缺 id 显式报错（不吞成新任务/误认 flag 为 id）', () => {
    for (const args of [['resume'], ['fork'], ['resume', '--all'], ['fork', '--all'], ['resume', '-']]) {
      let threw = '';
      try {
        parseExecArgs(args);
      } catch (e) {
        threw = (e as Error).message;
      }
      suite.assert(threw.includes('缺少会话 id'), `${args.join(' ') || 'bare'} 缺 id 显式报错`);
    }
  });

  suite.test('exec 子命令互斥：fork/resume/review 混写报错（不猜意图）', () => {
    for (const args of [
      ['fork', 'abc', '--resume', 'def'],
      ['resume', 'abc', '--last'],
      ['review', '--resume', 'abc'],
      ['review', '看看', '--last'],
      ['fork', '--last', '--resume', 'abc'],
    ]) {
      let threw = '';
      try {
        parseExecArgs(args);
      } catch (e) {
        threw = (e as Error).message;
      }
      suite.assert(threw.includes('互斥') || threw.includes('不支持'), `${args.join(' ')} 混写报错`);
    }
  });

  suite.test('exec flags 解析：review 非交互审查（codex exec review）', () => {
    const r1 = parseExecArgs(['review']);
    suite.assert(r1.reviewMode === true && r1.promptRaw === '', 'review 无额外要求');
    const r2 = parseExecArgs(['review', '关注边界']);
    suite.assert(r2.reviewMode === true && r2.promptRaw === '关注边界', 'review 额外要求拼任务');
    const r3 = parseExecArgs(['任务']);
    suite.assert(r3.reviewMode === false, '缺省非 review');
    const rb1 = parseExecArgs(['review', '--base', 'main', '看看']);
    suite.assert(rb1.reviewMode === true && rb1.reviewBase === 'main' && rb1.promptRaw === '看看', '--base 审查范围');
    const rc1 = parseExecArgs(['review', '--commit', 'abc123']);
    suite.assert(rc1.reviewCommit === 'abc123', '--commit 审查提交');
    const ru = parseExecArgs(['review', '--uncommitted']);
    suite.assert(ru.reviewMode === true, '--uncommitted 显式缺省照常进 review');
    const rt = parseExecArgs(['review', '--title', 'Fix login', '看看']);
    suite.assert(rt.reviewMode === true && rt.reviewTitle === 'Fix login' && rt.promptRaw === '看看', '--title 审查对象标题');
    let threwTitle = '';
    try {
      parseExecArgs(['--title', 'x', 'task']);
    } catch (e) {
      threwTitle = (e as Error).message;
    }
    suite.assert(threwTitle.includes('仅 exec review 可用'), '--title 非 review 域限定报错');
    for (const args of [['review', '--base', 'main', '--commit', 'abc123'], ['review', '--base', 'main', '--uncommitted'], ['--base', 'main', 'task'], ['--uncommitted', 'task']]) {
      let threw = '';
      try {
        parseExecArgs(args);
      } catch (e) {
        threw = (e as Error).message;
      }
      suite.assert(threw.includes('互斥') || threw.includes('仅 exec review 可用'), `${args.join(' ')} 范围互斥/域限定报错`);
    }
    for (const args of [['review', '--max-turns', '5'], ['review', '--allowed-tools', 'read_file'], ['review', '--output-schema', '{}']]) {
      let threw = '';
      try {
        parseExecArgs(args);
      } catch (e) {
        threw = (e as Error).message;
      }
      suite.assert(threw.includes('exec review 不支持'), `${args.join(' ')} loop 系 flags 互斥报错`);
    }
  });

  suite.test('review --title 进模型输入（codex --title 审查摘要标题）', async () => {
    let seen = '';
    async function* chunks(): AsyncGenerator<unknown> {
      yield { choices: [{ delta: { content: 'ok' } }] };
    }
    const stubClient = {
      chat: { completions: { create: async (req: { messages: { content: unknown }[] }) => {
        seen = JSON.stringify(req.messages.map((m) => m.content));
        return chunks();
      } } },
    };
    const r = await reviewCode(stubClient as never, 'm', 'diff-body', { command: null, output: 'x' }, 'extra-req', [], 'Fix login race');
    suite.assert(r === 'ok', '桩 client 跑通');
    suite.assert(seen.includes('Fix login race') && seen.includes('审查对象标题'), '标题进输入上下文');
    suite.assert(seen.includes('extra-req') && seen.includes('diff-body'), '原有输入不受影响');
    let seen2 = '';
    const stub2 = { chat: { completions: { create: async (req: { messages: { content: unknown }[] }) => {
      seen2 = JSON.stringify(req.messages.map((m) => m.content));
      return chunks();
    } } } };
    await reviewCode(stub2 as never, 'm', 'd', { command: null, output: 'x' });
    suite.assert(!seen2.includes('审查对象标题'), '无标题不加段');
  });

  suite.test('exec flags 解析：--json 事件 JSONL（codex --json，即 stream-json）', () => {
    const r1 = parseExecArgs(['--json', '任务']);
    suite.assert(r1.outputFormat === 'stream-json' && r1.promptRaw === '任务', '--json 置 stream-json');
    suite.assert(parseExecArgs(['任务']).outputFormat === 'text', '缺省 text');
  });

  suite.test('端到端：exec --json 事件流（mock 服务）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-exec-json-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 16;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      const out = await new Promise<string>((resolve) => {
        const child = spawn('npx', ['tsx', 'src/index.ts', 'exec', '--json', '流任务'], {
          cwd: ROOT,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: xdg,
            OMNI_BASE_URL: `http://127.0.0.1:${port}/v1`,
            OMNI_API_KEY: 'sk-mock',
            OMNI_MODEL: 'mock-model',
            OMNI_PERMISSION: 'full',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        child.stdout.on('data', (d) => (acc += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', () => {
          clearTimeout(timer);
          resolve(acc);
        });
      });
      const lines = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      suite.assert(lines.length >= 2, '多行事件 + 末行结果');
      suite.assert(lines.every((o) => o.t === 'ev' || o.t === 'result'), '全行信封 t=ev/result');
      const last = lines[lines.length - 1] as { t: string; result: string };
      suite.assert(last.t === 'result' && last.result.includes('mock 端到端验证通过'), '末行结果含最终回答');
    } finally {
      mock.kill();
    }
  });

  suite.test('exec flags 解析：--ephemeral 不落盘（codex exec --ephemeral）', () => {
    const r1 = parseExecArgs(['--ephemeral', '任务']);
    suite.assert(r1.ephemeral === true && r1.promptRaw === '任务', '--ephemeral 置位');
    suite.assert(parseExecArgs(['任务']).ephemeral === false, '缺省落盘');
  suite.test('exec flags 解析：--add-dir 沙箱额外可写目录（codex --add-dir）', () => {
    const r1 = parseExecArgs(['--add-dir', '/tmp/a', '任务', '--add-dir=/tmp/b']);
    suite.assert(r1.addDirs.join(',') === '/tmp/a,/tmp/b' && r1.promptRaw === '任务', '可重复 + = 形态');
    suite.assert(parseExecArgs(['任务']).addDirs.length === 0, '缺省空');
  });
    for (const args of [['resume', 'abc', '--ephemeral'], ['--ephemeral', '--last'], ['fork', 'abc', '--ephemeral']]) {
      let threw = '';
      try {
        parseExecArgs(args);
      } catch (e) {
        threw = (e as Error).message;
      }
      suite.assert(threw.includes('互斥'), `${args.join(' ')} 与 resume/fork 互斥报错`);
    }
  });

  suite.test('图片附件管线：load/collect/userMessage（@提及 → vision parts）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-exec-img-'));
    // 1x1 PNG（base64），真实二进制走 data URL 组装
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    const abs = path.join(dir, 'shot.png');
    fs.writeFileSync(abs, png);
    fs.writeFileSync(path.join(dir, 'note.txt'), 'hello');
    const one = await loadImageAttachment(abs, 'shot.png');
    suite.assert(!!one && one.dataUrl.startsWith('data:image/png;base64,'), '单文件加载成 data URL');
    const miss = await loadImageAttachment(path.join(dir, 'nope.png'), 'nope.png');
    suite.assert(miss === null, '不存在静默 null');
    const notImg = await loadImageAttachment(path.join(dir, 'note.txt'), 'note.txt');
    suite.assert(notImg === null, '非图片后缀静默 null');
    const found = await collectImageAttachments(`看看 @${abs} 有什么问题`, dir);
    suite.assert(found.length === 1 && found[0]!.path === abs, '@绝对路径提及收集');
    const mail = await collectImageAttachments('联系 a@b.com 即可', dir);
    suite.assert(mail.length === 0, '邮箱不误判为提及');
    const msg = userMessageWithImages('看图', found);
    suite.assert(
      typeof msg.content !== 'string' && (msg.content as unknown[]).length === 2,
      '有图时组装 text+image_url 两段'
    );
    const plain = userMessageWithImages('纯文本', []);
    suite.assert(plain.content === '纯文本', '无图保持纯文本形状');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  suite.test('端到端：exec -o <文件> 落盘最终回答（mock 服务）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-exec-o-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 6;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      const outfile = path.join(xdg, 'exec-last.md');
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn('npx', ['tsx', 'src/index.ts', 'exec', '验证 exec 落盘', '-o', outfile], {
          cwd: ROOT,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: xdg,
            OMNI_BASE_URL: `http://127.0.0.1:${port}/v1`,
            OMNI_API_KEY: 'sk-mock',
            OMNI_MODEL: 'mock-model',
            OMNI_PERMISSION: 'full',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        child.stdout.on('data', (d) => (acc += d));
        child.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      suite.assert(code === 0, `进程退出码 0（实际 ${code}）`);
      const body = fs.existsSync(outfile) ? fs.readFileSync(outfile, 'utf8') : '';
      suite.assert(body.includes('mock 端到端验证通过'), '-o 文件含最终回答');
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：exec @图片提及 + -i 显式附件走 headless（mock 服务）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-exec-img-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-exec-shot-'));
    const abs = path.join(imgDir, 'shot.png');
    fs.writeFileSync(
      abs,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      )
    );
    const port = MOCK_PORT + 7;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runExec = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn('npx', ['tsx', 'src/index.ts', ...args], {
          cwd: ROOT,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: xdg,
            OMNI_BASE_URL: `http://127.0.0.1:${port}/v1`,
            OMNI_API_KEY: 'sk-mock',
            OMNI_MODEL: 'mock-model',
            OMNI_PERMISSION: 'full',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        child.stdout.on('data', (d) => (acc += d));
        child.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      const r1 = await runExec(['exec', `看看 @${abs} 有什么问题`]);
      suite.assert(r1.code === 0, `@提及 headless 退出码 0（实际 ${r1.code}）`);
      suite.assert(r1.out.includes('mock 端到端验证通过'), '@提及 headless 拿到最终回答');
      suite.assert(r1.out.includes('已附加 1 张图片'), '@提及 headless 打印附加提示');
      const r2 = await runExec(['exec', '-i', abs, '描述这张图']);
      suite.assert(r2.code === 0, `-i 显式附件退出码 0（实际 ${r2.code}）`);
      suite.assert(r2.out.includes('mock 端到端验证通过'), '-i 显式附件拿到最终回答');
      // 不存在的图片静默跳过，不炸流程
      const r3 = await runExec(['exec', '-i', path.join(imgDir, 'nope.png'), '继续任务']);
      suite.assert(r3.code === 0, '缺失图片静默跳过不炸流程');
    } finally {
      mock.kill();
      fs.rmSync(imgDir, { recursive: true, force: true });
    }
  });

  suite.test('端到端：exec resume --last 恢复最近会话（mock 服务）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-exec-last-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 8;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runExec = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn('npx', ['tsx', 'src/index.ts', ...args], {
          cwd: ROOT,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: xdg,
            OMNI_BASE_URL: `http://127.0.0.1:${port}/v1`,
            OMNI_API_KEY: 'sk-mock',
            OMNI_MODEL: 'mock-model',
            OMNI_PERMISSION: 'full',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        child.stdout.on('data', (d) => (acc += d));
        child.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      // 无会话时 --last 明确报错（不静默新建）
      const r0 = await runExec(['exec', '--last']);
      suite.assert(r0.code !== 0 && r0.out.includes('暂无可恢复的会话'), '无会话 --last 报错');
      const r1 = await runExec(['exec', '首次任务建会话']);
      suite.assert(r1.code === 0, '首次 exec 建会话');
      const r2 = await runExec(['exec', 'resume', '--last', '继续任务']);
      suite.assert(r2.code === 0, `resume --last 退出码 0（实际 ${r2.code}）`);
      suite.assert(r2.out.includes('mock 端到端验证通过'), 'resume --last 拿到最终回答');
      suite.assert(r2.out.includes('已恢复会话') && r2.out.includes('条历史消息'), 'resume --last 打印统一恢复提示（含历史条数）');
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：exec fork 分叉 + 续跑（mock 服务）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-exec-fork-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 9;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runExec = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn('npx', ['tsx', 'src/index.ts', ...args], {
          cwd: ROOT,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: xdg,
            OMNI_BASE_URL: `http://127.0.0.1:${port}/v1`,
            OMNI_API_KEY: 'sk-mock',
            OMNI_MODEL: 'mock-model',
            OMNI_PERMISSION: 'full',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        child.stdout.on('data', (d) => (acc += d));
        child.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      const r1 = await runExec(['exec', '--output-format', 'json', '建会话']);
      suite.assert(r1.code === 0, '首次 exec 建会话');
      const sid = (JSON.parse(r1.out.split('\n').filter(Boolean).pop()!) as { session_id: string }).session_id;
      suite.assert(typeof sid === 'string' && sid.length > 0, '拿到源会话 id');
      // 仅分叉：stdout 新 id（text 形态）
      const r2 = await runExec(['exec', 'fork', sid]);
      suite.assert(r2.code === 0, `fork-only 退出码 0（实际 ${r2.code}）`);
      const forked = r2.out.split('\n').filter(Boolean).pop() ?? '';
      suite.assert(forked.length > 0 && forked !== sid, 'fork-only 输出新会话 id');
      suite.assert(r2.out.includes('fork 新会话'), 'fork-only 打印分叉提示');
      // 分叉 + 续跑
      const r3 = await runExec(['exec', 'fork', sid, '分叉后继续']);
      suite.assert(r3.code === 0, `fork+续跑退出码 0（实际 ${r3.code}）`);
      suite.assert(r3.out.includes('mock 端到端验证通过'), 'fork+续跑拿到最终回答');
      suite.assert(!r3.out.includes('已恢复会话'), 'fork 续跑抑制重复播报（fork 行已说明来源）');
      // 不存在的源报错
      const r4 = await runExec(['exec', 'fork', 'no-such-session']);
      suite.assert(r4.code !== 0 && r4.out.includes('不存在'), 'fork 缺失源报错');
    } finally {
      mock.kill();
    }
  });

  suite.test('端到端：exec --color never/always（mock 服务）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-exec-color-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const port = MOCK_PORT + 10;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runExec = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn('npx', ['tsx', 'src/index.ts', ...args], {
          cwd: ROOT,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: xdg,
            OMNI_BASE_URL: `http://127.0.0.1:${port}/v1`,
            OMNI_API_KEY: 'sk-mock',
            OMNI_MODEL: 'mock-model',
            OMNI_PERMISSION: 'full',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        child.stdout.on('data', (d) => (acc += d));
        child.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      // 先建一个会话，后续 --last 续跑必打「已恢复会话」dim 提示行（确定性 ANSI 源）
      const r0 = await runExec(['exec', '建会话']);
      suite.assert(r0.code === 0, '先建会话');
      const r1 = await runExec(['exec', '--color', 'never', '--last']);
      suite.assert(r1.code === 0, `--color never 退出码 0（实际 ${r1.code}）`);
      suite.assert(r1.out.includes('已恢复会话'), '--color never 照常恢复');
      suite.assert(!r1.out.includes('\x1b['), '--color never 全程无 ANSI');
      const r2 = await runExec(['exec', '--color', 'always', '--last']);
      suite.assert(r2.code === 0, `--color always 退出码 0（实际 ${r2.code}）`);
      suite.assert(r2.out.includes('\x1b['), '--color always 提示行带 ANSI（管道非 TTY 仍上色）');
    } finally {
      // 子进程置过全局颜色开关：复位，避免污染同进程后续测试
      setColorOverride(null);
      mock.kill();
    }
  });

  suite.test('端到端：exec review 非交互审查（mock 服务 + 临时 git 仓库）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-exec-review-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    // 临时 git 仓库：一次提交 + 一处未提交改动（review 数据源与脏工作树解耦）
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-exec-repo-'));
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { typecheck: 'echo check-ok' } }));
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    const git = (a: string[]) =>
      new Promise<void>((resolve, reject) => {
        const c = spawn('git', a, { cwd: repo, stdio: 'ignore' });
        c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${a.join(' ')}`))));
      });
    await git(['init']);
    await git(['config', 'user.email', 't@t.t']);
    await git(['config', 'user.name', 't']);
    await git(['add', '.']);
    await git(['commit', '-m', 'init']);
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
    const shot = path.join(repo, 'shot.png');
    fs.writeFileSync(
      shot,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      )
    );
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [repo] }));
    const port = MOCK_PORT + 12;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runExec = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        // cwd=临时仓库（review 读盘上 git 改动），入口必须绝对路径（相对路径相对 cwd 解析）
        const child = spawn('npx', ['tsx', path.join(ROOT, 'src/index.ts'), ...args], {
          cwd: repo,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: xdg,
            OMNI_BASE_URL: `http://127.0.0.1:${port}/v1`,
            OMNI_API_KEY: 'sk-mock',
            OMNI_MODEL: 'mock-model',
            OMNI_PERMISSION: 'full',
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
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      const r1 = await runExec(['exec', 'review']);
      suite.assert(r1.code === 0, `review 退出码 0（实际 ${r1.code}）`);
      suite.assert(r1.out.includes('## 审查结果（mock）'), 'review stdout 为审查正文');
      const r2 = await runExec(['exec', 'review', '关注边界']);
      suite.assert(r2.code === 0 && r2.out.includes('## 审查结果（mock）'), 'review 额外要求同样跑通');
      const r3b = await runExec(['review', '顶层直达']);
      suite.assert(r3b.code === 0 && r3b.out.includes('## 审查结果（mock）'), '顶层 review 直达 exec review');
      const r3c = await runExec(['exec', 'review', '-i', shot, '结合截图评审']);
      suite.assert(r3c.code === 0, `review -i 退出码 0（实际 ${r3c.code}）`);
      suite.assert(r3c.out.includes('## 审查结果（mock）'), 'review -i 图片随审查发出');
      suite.assert(r3c.out.includes('已附加 1 张图片'), 'review -i 打印附加提示');
      const r3 = await runExec(['exec', 'review', '--output-format', 'json']);
      const obj = JSON.parse(r3.out.split('\n').filter(Boolean).pop()!) as { result: string; session_id: unknown; exit_code: number };
      suite.assert(obj.exit_code === 0 && obj.session_id === null && obj.result.includes('## 审查结果（mock）'), 'review json 形态（无会话）');
      const r3s = await runExec(['exec', 'review', '--output-format', 'stream-json']);
      const last = JSON.parse(r3s.out.split('\n').filter(Boolean).pop()!) as { t: string; result: string; exit_code: number };
      suite.assert(r3s.code === 0 && last.t === 'result' && last.exit_code === 0 && last.result.includes('## 审查结果（mock）'), 'review stream-json 末行结果');
      const r3u = await runExec(['exec', 'review', '--uncommitted']);
      suite.assert(r3u.code === 0 && r3u.out.includes('## 审查结果（mock）'), '--uncommitted 与缺省同效');
      const r3t = await runExec(['exec', 'review', '--title', 'Fix login race', '关注并发']);
      suite.assert(r3t.code === 0 && r3t.out.includes('## 审查结果（mock）'), '--title 标题随审查发出（codex --title）');
      // 审查范围：第二提交 → --commit 审它，--base 审相对它的改动（codex --base/--commit）
      spawnSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
      spawnSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', 'second'], { cwd: repo, stdio: 'ignore' });
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
      const r4 = await runExec(['exec', 'review', '--commit', head]);
      suite.assert(r4.code === 0, `--commit 退出码 0（实际 ${r4.code}）`);
      suite.assert(r4.out.includes('## 审查结果（mock）'), '--commit 审指定提交');
      const r5 = await runExec(['exec', 'review', '--base', 'HEAD~1']);
      suite.assert(r5.code === 0 && r5.out.includes('## 审查结果（mock）'), '--base 审相对分支改动');
      const r6 = await runExec(['exec', 'review', '--commit', 'zzzz']);
      suite.assert(r6.code !== 0, '非法 SHA 拒绝');
      const r6b = await runExec(['exec', 'review', '--commit', 'deadbeef']);
      suite.assert(r6b.code !== 0, '不存在的提交拒绝（cat-file 校验）');
      const r7 = await runExec(['exec', 'review', '--base', 'main;evil']);
      suite.assert(r7.code !== 0, '注入形 base 拒绝');
      const r8 = await runExec(['exec', 'review', '--base', 'no-such-branch-xyz']);
      suite.assert(r8.code !== 0, '不存在的基准分支报错');
    } finally {
      mock.kill();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  suite.test('端到端：exec --last --all 跨目录恢复（codex resume --all）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-exec-all-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-exec-projA-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-exec-projB-'));
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [dirA, dirB] }));
    const port = MOCK_PORT + 13;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runExec = (args: string[], cwd: string) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn('npx', ['tsx', path.join(ROOT, 'src/index.ts'), ...args], {
          cwd,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: xdg,
            OMNI_BASE_URL: `http://127.0.0.1:${port}/v1`,
            OMNI_API_KEY: 'sk-mock',
            OMNI_MODEL: 'mock-model',
            OMNI_PERMISSION: 'full',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        child.stdout.on('data', (d) => (acc += d));
        child.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      const r1 = await runExec(['exec', '目录A任务'], dirA);
      suite.assert(r1.code === 0, '目录A建会话');
      // 目录B无会话：--last 按目录过滤报错（含 --all 提示）
      const r2 = await runExec(['exec', '--last'], dirB);
      suite.assert(r2.code !== 0 && r2.out.includes('--all'), '跨目录 --last 报目录过滤错');
      // --all 跨目录恢复A的会话
      const r3 = await runExec(['exec', '--last', '--all', '继续'], dirB);
      suite.assert(r3.code === 0, `--all 退出码 0（实际 ${r3.code}）`);
      suite.assert(r3.out.includes('已恢复会话'), '--all 跨目录同样统一播报');
      suite.assert(r3.out.includes('mock 端到端验证通过'), '--all 拿到最终回答');
      // fork --last --all 同样跨目录
      const r4 = await runExec(['exec', 'fork', '--last', '--all'], dirB);
      suite.assert(r4.code === 0, `fork --all 退出码 0（实际 ${r4.code}）`);
    } finally {
      mock.kill();
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  suite.test('端到端：exec --ephemeral 不写会话文件（mock 服务）', async () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-exec-eph-'));
    fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [ROOT] }));
    const shot = path.join(xdg, 'shot.png');
    fs.writeFileSync(
      shot,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      )
    );
    const sessionsDir = path.join(xdg, 'omni', 'sessions');
    const countSessions = (): number => {
      try {
        return fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl')).length;
      } catch {
        return 0;
      }
    };
    const port = MOCK_PORT + 14;
    const mock = spawn('node', ['scripts/mock-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runExec = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn('npx', ['tsx', 'src/index.ts', ...args], {
          cwd: ROOT,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: xdg,
            OMNI_BASE_URL: `http://127.0.0.1:${port}/v1`,
            OMNI_API_KEY: 'sk-mock',
            OMNI_MODEL: 'mock-model',
            OMNI_PERMISSION: 'full',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        child.stdout.on('data', (d) => (acc += d));
        child.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      const r1 = await runExec(['exec', '--ephemeral', '阅后即焚任务']);
      suite.assert(r1.code === 0, `--ephemeral 退出码 0（实际 ${r1.code}）`);
      suite.assert(r1.out.includes('临时会话') && r1.out.includes('mock-model'), '--ephemeral 临时会话运行头');
      suite.assert(r1.out.includes('mock 端到端验证通过'), '--ephemeral 照常拿最终回答');
      suite.assert(countSessions() === 0, '--ephemeral 不写会话文件');
      const r2 = await runExec(['exec', '--ephemeral', '--output-format', 'json', '再来一次']);
      const obj = JSON.parse(r2.out.split('\n').filter(Boolean).pop()!) as { session_id: unknown; exit_code: number };
      suite.assert(obj.exit_code === 0 && obj.session_id === null, '--ephemeral json session_id 为 null');
      suite.assert(countSessions() === 0, 'json 形态同样不写文件');
      const r3 = await runExec(['exec', '普通任务']);
      suite.assert(r3.code === 0 && countSessions() === 1, '缺省仍落盘（对照）');
      suite.assert(r3.out.includes('exec 新会话') && r3.out.includes('mock-model'), '新建会话 stderr 运行头（codex exec header 对等）');
      // 交叉：--ephemeral × -i（无会话文件 + vision parts 组装两条路径并存）
      const r4 = await runExec(['exec', '--ephemeral', '-i', shot, '阅后即焚看图']);
      suite.assert(r4.code === 0, `--ephemeral+-i 退出码 0（实际 ${r4.code}）`);
      suite.assert(r4.out.includes('已附加 1 张图片'), '--ephemeral 下图片照常附加');
      suite.assert(r4.out.includes('mock 端到端验证通过'), '--ephemeral+-i 拿到最终回答');
      suite.assert(countSessions() === 1, '--ephemeral+-i 不新增会话文件');
    } finally {
      mock.kill();
    }
  });

  suite.test('execHelpText 中英双语（--lang en 对等主帮助）', () => {
    const zh = execHelpText();
    const en = execHelpText('en');
    suite.assert(zh.includes('用法：omni exec') && en.includes('Usage: omni exec'), '中英 Usage 行');
    suite.assert(en.includes('exec fork') && en.includes('--ephemeral'), '英文含 fork/ephemeral 行');
    suite.assert(zh.includes('[--title') && en.includes('[--title'), '中英 review 帮助含 --title');
    const zhLines = zh.split('\n').length;
    const enLines = en.split('\n').length;
    suite.assert(zhLines === enLines, `中英行数一一对应（${zhLines} vs ${enLines}）`);
  });

  suite.test('isConsoleCommand 双入口路由表（子命令恒 console，不被 TUI 吞）', () => {
    for (const c of ['exec', 'review', 'resume', 'fork', 'archive', 'unarchive', 'delete', 'mcp-server', 'acp', 'web', 'mcp', 'plugin', 'completion', 'preset', 'import', 'watch', 'mini', 'doctor']) {
      suite.assert(isConsoleCommand([c]) === true, `${c} 走 console`);
    }
    suite.assert(isConsoleCommand(['e']) === true, 'exec 别名 e 同样 console（不被 TUI 吞）');
    suite.assert(isConsoleCommand(['doctor', 'x']) === false, 'doctor 带参是任务文本');
    suite.assert(isConsoleCommand([]) === false, '空参进交互');
    suite.assert(isConsoleCommand(['你好']) === false, '普通任务进交互');
    suite.assert(isConsoleCommand(['--help']) === false, '--help 走通用帮助分支');
  });

  suite.test('handleExecHelp 预检：子命令/分隔符判定（纯函数）', () => {
    suite.assert(handleExecHelp(['exec', '--help']) === true, 'exec --help 命中');
    suite.assert(handleExecHelp(['exec', '-h']) === true, '-h 命中');
    suite.assert(handleExecHelp(['exec', 'resume', '--help']) === true, '子命令后 --help 命中');
    suite.assert(handleExecHelp(['--help']) === false, '裸 --help 不归 exec');
    suite.assert(handleExecHelp(['mini', '--help']) === false, '其它子命令不命中');
    suite.assert(
      handleExecHelp(['exec', '--', '--help']) === false,
      '-- 之后不当 flag（任务文本语义）'
    );
    suite.assert(handleExecHelp(['exec', 'task']) === false, '普通任务不命中');
    suite.assert(handleExecHelp(['review', '--help']) === true, '顶层 review --help 命中（codex review --help）');
  });

  suite.test('exec --help 打专属帮助（codex exec --help，不被全局帮助吞掉）', async () => {
    const run = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn('npx', ['tsx', path.join(ROOT, 'src/index.ts'), ...args], {
          cwd: ROOT,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let acc = '';
        child.stdout.on('data', (d) => (acc += d));
        child.stderr.on('data', (d) => (acc += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, out: acc });
        });
      });
    const r1 = await run(['exec', '--help']);
    suite.assert(r1.code === 0, `exec --help 退出码 0（实际 ${r1.code}）`);
    suite.assert(r1.out.includes('用法：omni exec') && r1.out.includes('exec resume'), 'exec 专属用法');
    suite.assert(!r1.out.includes('Interactive mode'), '不打通用巨型帮助');
    const r2 = await run(['--help']);
    suite.assert(r2.code === 0 && r2.out.includes('Interactive mode'), '裸 --help 仍打通用帮助');
    const r2d = await run(['e', '--help']);
    suite.assert(r2d.code === 0 && r2d.out.includes('用法：omni exec') && !r2d.out.includes('Interactive mode'), '别名 e --help 打 exec 专属帮助');
    const r2b = await run(['exec', '--', '--help']);
    suite.assert(r2b.code === 0 && r2b.out.includes('Interactive mode'), 'exec -- --help 走通用帮助（分隔符后不当 flag）');
    const r2c = await run(['exec', '--help', '--lang', 'en']);
    suite.assert(r2c.code === 0 && r2c.out.includes('Usage: omni exec'), 'exec --help --lang en 打英文专属帮助');
    // tui-entry（原生二进制同源）：自带 --help 短路，需同样先拦截 exec 专属帮助
    const r3 = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn('bun', ['src/tui-entry.ts', 'exec', '--help'], {
        cwd: ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let acc = '';
      child.stdout.on('data', (d) => (acc += d));
      child.stderr.on('data', (d) => (acc += d));
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.on('close', (c) => {
        clearTimeout(timer);
        resolve({ code: c, out: acc });
      });
    });
    suite.assert(r3.code === 0 && r3.out.includes('用法：omni exec') && !r3.out.includes('Interactive mode'), 'tui-entry exec --help 同样专属');
  });

  suite.test('omni doctor 顶层诊断命令（codex doctor 对等）', async () => {
    const { code, out } = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn('npx', ['tsx', 'src/index.ts', 'doctor'], {
        cwd: ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let acc = '';
      child.stdout.on('data', (d) => (acc += d));
      child.stderr.on('data', (d) => (acc += d));
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.on('close', (c) => {
        clearTimeout(timer);
        resolve({ code: c, out: acc });
      });
    });
    suite.assert(code === 0, `退出码 0（实际 ${code}）`);
    suite.assert(out.includes('环境诊断'), '打印诊断报告头');
    suite.assert(out.includes('Node：'), '含运行时信息');
    suite.assert(out.includes('Git：'), '含 Git 仓库节（codex doctor git）');
    suite.assert(out.includes('终端：'), '含终端状态节（TTY/尺寸/颜色，mini 排障）');
    suite.assert(out.includes('搜索：'), '含搜索后端节（rg/bundled，codex doctor search）');
    suite.assert(out.includes('外部编辑器：'), '含编辑器环境节（VISUAL/EDITOR，codex doctor environment）');
  });

  return suite;
}
