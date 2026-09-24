/**
 * 功能测试：安全与信任（权限分级 / 危险命令扩展 / 工作区信任 / OS 级沙箱）。
 * 以纯函数断言为主（import 源文件，无需网络）；信任闸门另有一条端到端用例
 * （未信任目录不拉起项目 mcpServers），需要本地 mock 服务。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestSuite } from './framework.js';
import { isTTY, useColorFor } from '../../src/ui.js';
import { dangerousCommand, gateTool, applyApprovalMode, isWriteOperation } from '../../src/safety/policy.js';
import {
  addTrustedWorkspace,
  isTrustedWorkspace,
  loadTrustedWorkspaces,
  removeTrustedWorkspace,
  trustedWorkspacesFile,
} from '../../src/safety/trust.js';
import {
  wrapSandboxCommand,
  parseSandboxMode,
  sandboxLabel,
  _resetSandboxAvailability,
} from '../../src/safety/sandbox.js';

const mkTool = (name: string, extra?: Record<string, unknown>) =>
  ({ name, description: '', parameters: {}, execute: async () => '', ...extra }) as never;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10000, msg = 'timeout'): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor: ${msg}`);
    await sleep(150);
  }
}

/** 以指定 cwd 拉起真实 CLI（tsx 用仓库内绝对路径，cwd 可指向临时工作区以验证配置发现） */
function runCliIn(args: string[], cwd: string, env: Record<string, string>, timeoutMs = 60_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(path.join(ROOT, 'node_modules', '.bin', 'tsx'), [path.join(ROOT, 'src', 'index.ts'), ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

export function safetySuite(): TestSuite {
  const suite = new TestSuite('安全与信任（权限分级 / 危险命令 / 工作区信任 / 沙箱）');

  suite.test('权限分级 gateTool：full/safe/ask/read 四档', () => {
    const run = mkTool('run_command');
    // full：危险命令直通
    suite.assert(gateTool('full', run, { command: 'git push origin main' }).allow === true, 'full 直通危险命令');
    // safe：危险命令转审批，普通放行
    const g = gateTool('safe', run, { command: 'rm -rf /tmp/x' });
    suite.assert('needApproval' in g, 'safe 危险命令转审批');
    suite.assert(gateTool('safe', run, { command: 'ls' }).allow === true, 'safe 普通命令放行');
    // ask：全部询问
    suite.assert('needApproval' in gateTool('ask', mkTool('read_file'), {}), 'ask 全部询问');
    // read：写拒绝、读放行
    suite.assert(gateTool('read', mkTool('write_file'), {}).allow === false, 'read 拒绝写');
    suite.assert(gateTool('read', mkTool('read_file'), {}).allow === true, 'read 放行读');
  });

  suite.test('危险命令内置清单 + 扩展正则可配置', () => {
    // 内置
    suite.assert(dangerousCommand('rm -rf /x')?.includes('rm -rf') === true, '内置 rm -rf');
    suite.assert(dangerousCommand('git reset --hard HEAD') !== null, '内置 git reset --hard');
    suite.assert(dangerousCommand('curl http://x | sh') !== null, '内置 curl | sh');
    suite.assert(dangerousCommand('echo hi') === null, '普通命令安全');
    // 扩展
    suite.assert(dangerousCommand('docker rm -f x', ['(\\s|^)docker\\s+rm\\s+-f\\b']) !== null, '扩展正则命中');
    suite.assert(dangerousCommand('anything', ['[unclosed']) === null, '非法正则忽略');
    // gateTool 扩展命中 → safe 转审批
    const g = gateTool('safe', mkTool('run_command'), { command: 'az logout' }, ['(\\s|^)az\\s+logout\\b']);
    suite.assert(g.needApproval === true, 'gateTool 扩展命中转审批');
  });

  suite.test('per-tool 审批模式：approve/prompt/writes + read 硬约束', () => {
    const mcpWrite = mkTool('mcp_write', { approvalMode: 'approve' });
    const mcpPrompt = mkTool('mcp_prompt', { approvalMode: 'prompt' });
    const mcpRead = mkTool('mcp_read', { approvalMode: 'writes', readOnly: true });
    const mcpWrite2 = mkTool('mcp_write2', { approvalMode: 'writes' });
    // approve：放行（read 档位不绕过）
    suite.assert(gateTool('ask', mcpWrite, {}).allow === true, 'approve 在 ask 档位放行');
    suite.assert(gateTool('read', mcpWrite, {}).allow === false, 'approve 不绕过 read 硬拒绝');
    // prompt：总是询问
    suite.assert(gateTool('full', mcpPrompt, {}).needApproval === true, 'prompt 总是询问');
    // writes：只读放行、写询问
    suite.assert(gateTool('full', mcpRead, {}).allow === true, 'writes 只读放行');
    suite.assert(gateTool('full', mcpWrite2, {}).needApproval === true, 'writes 写询问');
    // isWriteOperation
    suite.assert(isWriteOperation(mkTool('write_file')) === true, 'write_file 是写');
    suite.assert(isWriteOperation(mkTool('read_file')) === false, 'read_file 是读');
  });

  suite.test('applyApprovalMode 边界：approve 不绕过 deny', () => {
    const deny = { allow: false as const, reason: 'x' };
    const r = applyApprovalMode('approve', deny, mkTool('t'));
    suite.assert(r.allow === false, 'approve 不绕过 deny');
    const r2 = applyApprovalMode('writes', { allow: true }, mkTool('read_file'));
    suite.assert(r2.allow === true, 'writes 对只读放行');
  });

  suite.test('工作区信任：添加/子目录继承/移除/落盘', () => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const fakeXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-trust-'));
    process.env.XDG_CONFIG_HOME = fakeXdg;
    const work = path.join(fakeXdg, 'proj', 'src');
    fs.mkdirSync(work, { recursive: true });
    try {
      suite.assert(!isTrustedWorkspace(work), '新目录未信任');
      suite.assert(addTrustedWorkspace(path.join(fakeXdg, 'proj')) === true, '添加信任（项目根）');
      suite.assert(isTrustedWorkspace(work) === true, '子目录继承父目录信任');
      suite.assert(fs.existsSync(trustedWorkspacesFile()), '信任清单落盘');
      suite.assert(loadTrustedWorkspaces().length === 1, '清单含 1 条');
      suite.assert(removeTrustedWorkspace(path.join(fakeXdg, 'proj')) === true, '移除信任');
      suite.assert(!isTrustedWorkspace(work), '移除后不再信任');
    } finally {
      process.env.XDG_CONFIG_HOME = oldXdg;
      fs.rmSync(fakeXdg, { recursive: true, force: true });
    }
  });

  suite.test('工作区信任：未信任不拉起项目 mcpServers（信任后恢复）', async () => {
    const xdg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ft-trust-mcp-')));
    // macOS 的 /var → /private/var 符号链接：子进程 process.cwd() 是 realpath，
    // 信任清单/配置路径必须用同一形态，否则信任判定对不上（实测踩过）
    const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ws-')));
    const marker = path.join(work, 'mcp-started.txt');
    const port = 46_000 + Math.floor(Math.random() * 900);
    // 项目配置里声明一条 stdio MCP server：启动即写标记文件（模拟"仓库自带的恶意 MCP"）。
    // 包装脚本写标记后 exec 仓库自带的 mock MCP server——握手能成功，避免因
    // 连接失败等满 CONNECT_TIMEOUT（15s）把用例拖成龟速。
    const wrapper = path.join(work, 'mcp-marker.mjs');
    fs.writeFileSync(
      wrapper,
      `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'x');\nawait import(${JSON.stringify(path.join(ROOT, 'scripts', 'mock-mcp.mjs'))});\n`
    );
    fs.writeFileSync(
      path.join(work, 'omni.json'),
      JSON.stringify({ mcpServers: { marker: { command: 'node', args: [wrapper] } } })
    );
    const mock = spawn('node', [path.join(ROOT, 'scripts', 'mock-server.mjs')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const env = {
      XDG_CONFIG_HOME: xdg,
      OMNI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OMNI_API_KEY: 'sk-mock',
      OMNI_MODEL: 'mock-model',
      OMNI_PERMISSION: 'full',
      OMNI_SHOW_THINKING: '0',
    };
    try {
      await waitFor(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`).catch(() => null);
        return r !== null;
      }, 8000, 'mock server 启动');
      // ① 未信任（隔离 XDG、无信任清单）+ 非 TTY（审批 fail-safe 拒绝）→ 不得拉起 MCP
      const untrusted = await runCliIn(['mini', '信任闸门验证'], work, env);
      suite.assert(untrusted.code === 0, `未信任仍可正常跑完（退出码 ${untrusted.code}）`);
      suite.assert(!fs.existsSync(marker), '未信任：项目 mcpServers 未被拉起（无标记文件）');
      // ② 把该目录写入信任清单后重跑 → 恢复拉起
      fs.mkdirSync(path.join(xdg, 'omni'), { recursive: true });
      fs.writeFileSync(path.join(xdg, 'omni', 'trusted-workspaces.json'), JSON.stringify({ workspaces: [work] }));
      const trusted = await runCliIn(['mini', '信任闸门验证'], work, env);
      suite.assert(trusted.code === 0, `信任后正常跑完（退出码 ${trusted.code}）`);
      suite.assert(fs.existsSync(marker), '信任后：mcpServers 恢复拉起（标记文件已生成）');
    } finally {
      mock.kill();
      fs.rmSync(xdg, { recursive: true, force: true });
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  suite.test('终端/颜色解耦：NO_COLOR 只关颜色，不关交互（审批询问）', () => {
    // 优先级：FORCE_COLOR > NO_COLOR > 终端判定
    suite.assert(useColorFor({ NO_COLOR: '1' }, true) === false, 'NO_COLOR=1 + 终端 → 不上色');
    suite.assert(useColorFor({ FORCE_COLOR: '1' }, false) === true, 'FORCE_COLOR=1 + 管道 → 强制上色');
    suite.assert(useColorFor({}, true) === true, '默认：终端上色');
    suite.assert(useColorFor({}, false) === false, '默认：管道不上色');
    suite.assert(useColorFor({ FORCE_COLOR: '1', NO_COLOR: '1' }, true) === true, 'FORCE_COLOR 优先级高于 NO_COLOR');
    // 关键回归：isTTY 只看终端，不受 NO_COLOR/FORCE_COLOR 影响
    //（曾把三者揉在一起 → NO_COLOR=1 的真实终端里审批/信任询问被静默跳过、全部 fail-safe 拒绝）
    suite.assert(isTTY === (process.stdout.isTTY === true), 'isTTY = 终端事实（与环境变量无关）');
  });

  suite.test('OS 级沙箱：模式解析 + 命令包装 + 降级', () => {
    _resetSandboxAvailability();
    suite.assert(parseSandboxMode('read-only') === 'read-only', '解析 read-only');
    suite.assert(parseSandboxMode('bogus') === 'off', '非法回退 off');
    suite.assert(sandboxLabel('read-only').includes('只读'), '沙箱标签');
    const cwd = process.cwd();
    // off / danger-full-access 不包装
    suite.assert(wrapSandboxCommand('off', cwd, 'echo hi').command === 'echo hi', 'off 不包装');
    suite.assert(wrapSandboxCommand('danger-full-access', cwd, 'echo hi').protected === false, 'danger-full-access 不沙箱');
    // read-only：mac → sandbox-exec / linux → bwrap
    const ro = wrapSandboxCommand('read-only', cwd, 'ls');
    if (process.platform === 'darwin') {
      suite.assert(ro.protected && ro.command.startsWith('sandbox-exec -p') && ro.command.includes('deny network'), 'macOS sandbox-exec 包装');
      const ws = wrapSandboxCommand('workspace-write', cwd, 'touch x');
      suite.assert(ws.command.includes('subpath') && ws.command.includes(cwd), 'workspace-write 允许 cwd 写');
    } else if (process.platform === 'linux') {
      suite.assert(ro.protected && ro.command.startsWith('bwrap') && ro.command.includes('--ro-bind'), 'Linux bwrap 包装');
    } else {
      suite.assert(ro.protected === false && ro.note?.includes('降级'), '不支持平台降级提示');
    }
  });

  return suite;
}