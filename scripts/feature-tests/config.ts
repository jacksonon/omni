/**
 * 功能测试：配置分层 / JSONC 解析 / 字段解析。
 * 纯函数断言（import 源文件），无需网络。
 */
import { spawn } from 'node:child_process';
import { TestSuite } from './framework.js';
import { parseJsonc } from '../../src/config/jsonc.js';
import { loadConfig } from '../../src/config/index.js';
import { parseArgs } from '../../src/cli/args.js';
import { findProjectConfig } from '../../src/config/discover.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function configSuite(): TestSuite {
  const suite = new TestSuite('配置系统（分层 / JSONC / 字段解析）');

  suite.test('JSONC 解析：注释 + 尾逗号', () => {
    const obj = parseJsonc(`{
      // 注释
      "model": "gpt-4o",
      "maxSteps": 50,  // 尾逗号
    }`);
    suite.assert(obj?.model === 'gpt-4o', '解析字符串字段');
    suite.assert(obj?.maxSteps === 50, '解析数字字段');
    // 非法输入抛异常（parseJsonc 无兜底，调用方 try/catch）
    let threw = false;
    try {
      parseJsonc('{');
    } catch {
      threw = true;
    }
    suite.assert(threw === true, '非法 JSON 抛异常');
  });

  suite.test('配置默认值（隔离：空 cwd + 空 XDG + 无环境变量）', () => {
    const saved: [string, string | undefined][] = [];
    const tmpXdg = mkdtempSync(path.join(os.tmpdir(), 'ft-xdg-'));
    for (const k of ['OMNI_MODEL', 'OMNI_BASE_URL', 'OMNI_API_KEY', 'OMNI_PERMISSION', 'OMNI_MAX_STEPS', 'OMNI_SHOW_THINKING']) {
      saved.push([k, process.env[k]]);
      delete process.env[k];
    }
    saved.push(['XDG_CONFIG_HOME', process.env.XDG_CONFIG_HOME]);
    process.env.XDG_CONFIG_HOME = tmpXdg; // 隔离全局配置（避免读到真实 ~/.config/omni）
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ft-cfgdefault-'));
    const oldCwd = process.cwd();
    process.chdir(tmp); // 空目录：无项目配置 → 纯默认值
    try {
      const cfg = loadConfig();
      suite.assert(cfg.model === 'gpt-4o-mini', '默认模型 gpt-4o-mini');
      suite.assert(cfg.maxSteps === 50, '默认 maxSteps 50');
      suite.assert(cfg.permission === 'safe', '默认权限 safe');
      suite.assert(cfg.auditLog === true, '默认审计日志开启');
      suite.assert(cfg.sandbox === 'off', '默认沙箱 off');
      suite.assert(cfg.language === 'zh', '默认语言 zh');
    } finally {
      process.chdir(oldCwd);
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(tmp, { recursive: true, force: true });
      rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  suite.test('--sandbox 沙箱覆盖（codex -s 对等）', () => {
    const r1 = parseArgs(['mini', '--sandbox', 'read-only', 'task']);
    suite.assert(r1.flags.cd === null && r1.taskArgs.join(' ') === 'mini task', '--sandbox 不污染任务参数');
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = mkdtempSync(path.join(os.tmpdir(), 'ft-cfgsb-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ft-cfgsb-w-'));
    const oldCwd = process.cwd();
    process.chdir(tmp);
    try {
      suite.assert(loadConfig().sandbox === 'off', '缺省 off');
      suite.assert(loadConfig({ sandbox: 'read-only' }).sandbox === 'read-only', 'overrides 生效');
      suite.assert(loadConfig({ sandbox: 'nonsense' }).sandbox === 'off', '非法值回退');
    } finally {
      process.chdir(oldCwd);
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      rmSync(tmp, { recursive: true, force: true });
      rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  suite.test('-a/--ask-for-approval 审批策略覆盖（codex -a 对等）', () => {
    const r1 = parseArgs(['mini', '-a', 'never', 'task']);
    suite.assert(r1.overrides.askForApproval === 'never' && r1.taskArgs.join(' ') === 'mini task', '-a 短式剥离不污染任务');
    const r2 = parseArgs(['exec', '--ask-for-approval=read', 'task']);
    suite.assert(r2.overrides.askForApproval === 'read', '--ask-for-approval= 形态');
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = mkdtempSync(path.join(os.tmpdir(), 'ft-cfgask-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ft-cfgask-w-'));
    const oldCwd = process.cwd();
    process.chdir(tmp);
    const savedPerm = process.env.OMNI_PERMISSION;
    try {
      suite.assert(loadConfig().permission === 'safe', '缺省 safe');
      suite.assert(loadConfig({ askForApproval: 'never' }).permission === 'full', 'never→full');
      suite.assert(loadConfig({ askForApproval: 'on-request' }).permission === 'safe', 'on-request→safe');
      suite.assert(loadConfig({ askForApproval: 'read' }).permission === 'read', '原生档位直通');
      process.env.OMNI_PERMISSION = 'read';
      suite.assert(loadConfig({ askForApproval: 'never' }).permission === 'full', 'CLI 高于环境变量');
      delete process.env.OMNI_PERMISSION;
      for (const bad of ['sometimes', '']) {
        let threw = '';
        try { loadConfig({ askForApproval: bad }); } catch (e) { threw = (e as Error).message; }
        suite.assert(threw.includes('ask-for-approval'), `非法值 ${JSON.stringify(bad)} 抛错（不静默回退）`);
      }
    } finally {
      process.chdir(oldCwd);
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      if (savedPerm === undefined) delete process.env.OMNI_PERMISSION;
      else process.env.OMNI_PERMISSION = savedPerm;
      rmSync(tmp, { recursive: true, force: true });
      rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  suite.test('--add-dir 沙箱额外可写目录（codex --add-dir，可重复追加）', () => {
    const r1 = parseArgs(['mini', '--add-dir', '/tmp/a', 'task']);
    suite.assert((r1.overrides.addDirs ?? []).join(',') === '/tmp/a' && r1.taskArgs.join(' ') === 'mini task', '--add-dir 剥离不污染任务');
    const r2 = parseArgs(['exec', '--add-dir=/tmp/a', '--add-dir', '/tmp/b']);
    suite.assert((r2.overrides.addDirs ?? []).join(',') === '/tmp/a,/tmp/b', '--add-dir= 形态 + 可重复');
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = mkdtempSync(path.join(os.tmpdir(), 'ft-cfgad-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ft-cfgad-w-'));
    const oldCwd = process.cwd();
    process.chdir(tmp);
    try {
      const c0 = loadConfig();
      suite.assert(!c0.sandboxWritePaths?.length, '缺省无额外可写目录');
      const c1 = loadConfig({ addDirs: ['/tmp/a', '/tmp/a', 'rel/sub'] });
      suite.assert(
        // macOS /tmp→/private/tmp 符号链接：相对展开以后置 resolve 为准，不拼 tmp 前缀
        (c1.sandboxWritePaths ?? []).join(',') === `/tmp/a,${path.resolve('rel/sub')}`,
        '合并+去重+相对展开，配置文件项保留'
      );
      writeFileSync(path.join(tmp, 'omni.json'), JSON.stringify({ sandboxWritePaths: ['/cfg/one'] }));
      const c2 = loadConfig({ addDirs: ['/cli/two'] });
      suite.assert(
        (c2.sandboxWritePaths ?? []).join(',') === '/cfg/one,/cli/two',
        '配置文件项 + CLI 追加共存'
      );
    } finally {
      process.chdir(oldCwd);
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      rmSync(tmp, { recursive: true, force: true });
      rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  suite.test('中英 --help 关键行（多轮 slash/flag 增补回归锁）', async () => {
    const runHelp = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn('npx', ['tsx', 'src/index.ts', ...args], {
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
    const en = await runHelp(['--help']);
    suite.assert(en.code === 0, '英文帮助退出码 0');
    for (const s of ['/stop stop the running turn', '/import import config from Claude Code', '/recap summarize', 'exec fork', 'exec review', '--ephemeral', '--add-dir', '--color', '/clear clear context', '/trace full trace ledger', '/spec spec workflow', '--strict-config', '--ignore-user-config']) {
      suite.assert(en.out.includes(s), `英文帮助含 ${s}`);
    }
    const zh = await runHelp(['--help', '--lang', 'zh']);
    suite.assert(zh.code === 0, '中文帮助退出码 0');
    for (const s of ['/stop 停止当前任务', '/import 从 Claude Code 迁移配置', '/recap 总结当前对话', '分叉出新会话', '非交互代码审查', '不落盘会话文件', '沙箱额外可写目录', '--color', '/clear 清空上下文', '/trace 完整轨迹账本', '/spec 规格工作流', '严格配置校验', '跳过用户级配置文件']) {
      suite.assert(zh.out.includes(s), `中文帮助含 ${s}`);
    }
  });

  suite.test('全局 -i/--image + --approve-for-me（codex 顶层同款）', () => {
    const r1 = parseArgs(['mini', '-i', 'a.png', '--image=b.png', 'task']);
    suite.assert((r1.overrides.images ?? []).join(',') === 'a.png,b.png', '-i 可重复 + = 形态');
    suite.assert(r1.taskArgs.join(' ') === 'mini task', '图片参数不污染任务文本');
    const r2 = parseArgs(['--approve-for-me', 'exec', 'task']);
    suite.assert(r2.overrides.approveForMe === true && r2.taskArgs.join(' ') === 'exec task', '--approve-for-me 全局剥离');
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = mkdtempSync(path.join(os.tmpdir(), 'ft-cfgafm-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    try {
      suite.assert(loadConfig().autoReview !== true, '缺省非自动审批');
      suite.assert(loadConfig({ approveForMe: true }).autoReview === true, 'overrides 置 cfg.autoReview');
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  suite.test('--strict-config 未知顶层字段报错（codex 同款，防拼写/静默失效）', () => {
    const r = parseArgs(['--strict-config', 'task']);
    suite.assert(r.overrides.strictConfig === true && r.taskArgs.join(' ') === 'task', '--strict-config 剥离');
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = mkdtempSync(path.join(os.tmpdir(), 'ft-cfgstrict-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ft-cfgstrict-w-'));
    const oldCwd = process.cwd();
    process.chdir(tmp);
    try {
      writeFileSync(path.join(tmp, 'omni.json'), JSON.stringify({ model: 'x', modle: 'typo', apiKey: 'sk-should-not-be-here', $schema: './config.schema.json' }));
      let threw = '';
      try {
        loadConfig({ strictConfig: true });
      } catch (e) {
        threw = (e as Error).message;
      }
      suite.assert(threw.includes('modle') && threw.includes('apiKey'), '拼写错误 + 文件层静默失效字段都被点名');
      suite.assert(threw.includes('omni.json'), '报错带文件路径');
      const ok = loadConfig({ strictConfig: false });
      suite.assert(ok.model === 'x', '非 strict 下静默兼容（行为不变）');
      writeFileSync(path.join(tmp, 'omni.json'), JSON.stringify({ model: 'x' }));
      suite.assert(loadConfig({ strictConfig: true }).model === 'x', '干净配置 strict 通过');
    } finally {
      process.chdir(oldCwd);
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      rmSync(tmp, { recursive: true, force: true });
      rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  suite.test('-V 版本别名（codex 双层 -V 对等；此前会污染成任务文本）', async () => {
    suite.assert(parseArgs(['-V']).version === true, '-V 置 version');
    suite.assert(parseArgs(['-V']).taskArgs.length === 0, '-V 不进任务参数');
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn('npx', ['tsx', 'src/index.ts', '-V'], {
        cwd: ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let acc = '';
      child.stdout.on('data', (d) => (acc += d));
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.on('close', (c) => {
        clearTimeout(timer);
        resolve({ code: c, text: acc });
      });
    });
    suite.assert(out.code === 0 && out.text.includes('omni v'), '-V 打印版本退出码 0');
  });

  suite.test('-p profile 别名（codex -p 对等；此前会污染成任务文本）', () => {
    const r = parseArgs(['-p', 'work', 'task']);
    suite.assert(r.overrides.profile === 'work' && r.taskArgs.join(' ') === 'task', '-p 置 profile 且不污染任务');
  });

  suite.test('CLI 参数覆盖模型（overrides 优先级最高）', () => {
    const saved = process.env.OMNI_MODEL;
    delete process.env.OMNI_MODEL;
    try {
      const cfg = loadConfig({ model: 'test-model' });
      suite.assert(cfg.model === 'test-model', 'CLI 参数覆盖默认模型');
    } finally {
      if (saved !== undefined) process.env.OMNI_MODEL = saved;
    }
  });

  suite.test('--ignore-user-config 跳过用户层（codex 同款）', () => {
    const r = parseArgs(['exec', '--ignore-user-config', 'task']);
    suite.assert(r.overrides.ignoreUserConfig === true && r.taskArgs.join(' ') === 'exec task', 'flag 剥离不污染任务（子命令保留同 -a 用例）');
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = mkdtempSync(path.join(os.tmpdir(), 'ft-cfgignore-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ft-cfgignore-w-'));
    const oldCwd = process.cwd();
    process.chdir(tmp); // 空目录：无项目配置
    const savedModel = process.env.OMNI_MODEL;
    try {
      mkdirSync(path.join(tmpXdg, 'omni'), { recursive: true });
      writeFileSync(path.join(tmpXdg, 'omni', 'omni.json'), JSON.stringify({ model: 'global-model' }));
      suite.assert(loadConfig().model === 'global-model', '缺省读用户层');
      suite.assert(loadConfig({ ignoreUserConfig: true }).model === 'gpt-4o-mini', 'ignore 后回默认值');
      process.env.OMNI_MODEL = 'env-model';
      suite.assert(loadConfig({ ignoreUserConfig: true }).model === 'env-model', '环境变量照常生效');
    } finally {
      process.chdir(oldCwd);
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      if (savedModel === undefined) delete process.env.OMNI_MODEL;
      else process.env.OMNI_MODEL = savedModel;
      rmSync(tmp, { recursive: true, force: true });
      rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  suite.test('--ignore-user-config 端到端：doctor 配置来源行（真 CLI 子进程）', async () => {
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const tmpXdg = mkdtempSync(path.join(os.tmpdir(), 'ft-cfgignore-e2e-'));
    process.env.XDG_CONFIG_HOME = tmpXdg;
    try {
      mkdirSync(path.join(tmpXdg, 'omni'), { recursive: true });
      writeFileSync(path.join(tmpXdg, 'omni', 'omni.json'), JSON.stringify({ model: 'global-marker-model' }));
      const runDoctor = (args: string[]) =>
        new Promise<string>((resolve) => {
          const child = spawn('npx', ['tsx', 'src/index.ts', ...args], {
            cwd: ROOT,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let acc = '';
          child.stdout.on('data', (d) => (acc += d));
          child.stderr.on('data', (d) => (acc += d));
          const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
          child.on('close', () => {
            clearTimeout(timer);
            resolve(acc);
          });
        });
      const marker = path.join(tmpXdg, 'omni', 'omni.json');
      const plain = await runDoctor(['doctor']);
      suite.assert(plain.includes(marker), '缺省来源行含用户层文件');
      const ignored = await runDoctor(['--ignore-user-config', 'doctor']);
      suite.assert(!ignored.includes(marker), 'flag 后来源行无用户层文件');
      suite.assert(ignored.includes('omni.json'), '项目层配置仍在来源行');
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  suite.test('配置发现：向上查找 + git 根边界', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ft-cfg-'));
    mkdirSync(path.join(root, 'sub'), { recursive: true });
    mkdirSync(path.join(root, '.git'));
    writeFileSync(path.join(root, 'omni.json'), '{"model":"test"}');
    const found = findProjectConfig(path.join(root, 'sub'));
    suite.assert(found !== null && found.endsWith('omni.json'), '向上找到项目配置');
    rmSync(root, { recursive: true, force: true });
  });

  return suite;
}