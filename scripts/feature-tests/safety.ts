/**
 * 功能测试：安全与信任（权限分级 / 危险命令扩展 / 工作区信任 / OS 级沙箱）。
 * 纯函数断言（import 源文件），无需网络。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestSuite } from './framework.js';
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