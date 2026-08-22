/**
 * 安全与信任探针（第九节）：工作区信任 + 危险命令扩展正则 + OS 级沙箱。
 *
 * 运行：npx tsx scripts/probe-tmp/probe-security-trust.ts
 */
import { dangerousCommand, gateTool, applyApprovalMode } from '../../src/safety/policy.js';
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
import { resolveWorkspaceTrust } from '../../src/main.js';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failed = 0;
function assert(cond: boolean, label: string, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed++;
    console.error(`  ✗ ${label}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`);
  }
}

const mkTool = (name: string, extra?: Record<string, unknown>) =>
  ({ name, description: '', parameters: {}, execute: async () => '', ...extra }) as never;

async function main(): Promise<void> {
  console.log('=== A. 危险命令扩展正则（config dangerousPatterns）===');
  // 内置清单照常命中
  assert(dangerousCommand('rm -rf /tmp/x')?.includes('rm -rf') === true, '内置：rm -rf 命中');
  assert(dangerousCommand('echo hi') === null, '内置：普通命令不命中');
  // 扩展正则命中
  assert(dangerousCommand('docker rm -f web', ['(\\s|^)docker\\s+rm\\s+-f\\b'])?.includes('扩展危险规则') === true, '扩展：docker rm -f 命中');
  // 非法正则兜底忽略（不抛错）
  assert(dangerousCommand('anything', ['[unclosed']) === null, '扩展：非法正则忽略');
  // gateTool 带扩展正则 → safe 档位转审批
  const gExt = gateTool('safe', mkTool('run_command'), { command: 'az logout --all' }, ['(\\s|^)az\\s+logout\\b']);
  assert(gExt.needApproval === true, `gateTool 扩展正则命中转审批（${JSON.stringify(gExt)}）`);

  console.log('=== B. 工作区信任（trusted-workspaces.json）===');
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const fakeXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-trust-'));
  process.env.XDG_CONFIG_HOME = fakeXdg;
  const work = path.join(fakeXdg, 'proj', 'src');
  fs.mkdirSync(work, { recursive: true });
  assert(!isTrustedWorkspace(work), '新目录未信任');
  assert(loadTrustedWorkspaces().length === 0, '信任清单为空');
  assert(addTrustedWorkspace(path.join(fakeXdg, 'proj')) === true, '添加信任（项目根）');
  // 子目录继承信任（父目录在清单）
  assert(isTrustedWorkspace(work) === true, '子目录继承父目录信任');
  // 文件确实落盘
  assert(existsSync(trustedWorkspacesFile()), '信任清单文件已落盘');
  assert(removeTrustedWorkspace(path.join(fakeXdg, 'proj')) === true, '移除信任');
  assert(!isTrustedWorkspace(work), '移除后子目录不再信任');
  // resolveWorkspaceTrust：无审批 UI（Output 无 requestApproval）→ fail-safe 拒绝
  const trust = await resolveWorkspaceTrust(work, {} as never);
  assert(trust === false, 'resolveWorkspaceTrust 无审批 UI → 拒绝（fail-safe 只读）');
  process.env.XDG_CONFIG_HOME = oldXdg;
  fs.rmSync(fakeXdg, { recursive: true, force: true });

  console.log('=== C. OS 级沙箱（sandbox-exec / bwrap 包装）===');
  _resetSandboxAvailability();
  const mode = parseSandboxMode('read-only');
  assert(mode === 'read-only', 'parseSandboxMode 解析 read-only');
  assert(parseSandboxMode('bogus') === 'off', 'parseSandboxMode 非法回退 off');
  assert(typeof sandboxLabel(mode) === 'string' && sandboxLabel(mode).includes('只读'), 'sandboxLabel 中文标签');
  const cwd = process.cwd();
  // off / danger-full-access：不包装
  const offRes = wrapSandboxCommand('off', cwd, 'echo hi');
  assert(offRes.command === 'echo hi' && offRes.protected === false, 'off 不包装');
  const fullRes = wrapSandboxCommand('danger-full-access', cwd, 'echo hi');
  assert(fullRes.command === 'echo hi' && fullRes.note?.includes('全访问'), 'danger-full-access 不沙箱 + 提示');
  // read-only：mac → sandbox-exec 包装（含 deny network / deny file-write）
  const roRes = wrapSandboxCommand('read-only', cwd, 'ls');
  if (process.platform === 'darwin') {
    assert(roRes.protected === true && roRes.command.startsWith('sandbox-exec -p') && roRes.command.includes('deny network'), `macOS sandbox-exec 包装（${roRes.command.slice(0, 60)}…）`);
  } else if (process.platform === 'linux') {
    assert(roRes.protected === true && roRes.command.startsWith('bwrap') && roRes.command.includes('--ro-bind'), `Linux bwrap 包装（${roRes.command.slice(0, 60)}…）`);
  } else {
    assert(roRes.protected === false && roRes.note?.includes('降级'), '不支持的平台降级 + 提示');
  }
  // workspace-write：mac → 允许 cwd 子路径写
  const wsRes = wrapSandboxCommand('workspace-write', cwd, 'touch x');
  if (process.platform === 'darwin') {
    assert(wsRes.command.includes('subpath') && wsRes.command.includes(cwd), 'workspace-write 允许 cwd 内写');
  }
  // 沙箱提示函数
  assert(typeof (await import('../../src/safety/sandbox.js')).sandboxHint('read-only', cwd) === 'string', 'sandboxHint 提示存在');

  console.log('=== D. gateTool 未信任目录场景（read 档位硬约束）===');
  // read 档位：写工具直接拒绝（per-tool approve 也不能绕过）
  const gRead = gateTool('read', mkTool('write_file'), { path: '/tmp/x' });
  assert(gRead.allow === false, 'read 档位拒绝 write_file');
  const gReadApprove = gateTool('read', mkTool('mcp_write', { approvalMode: 'approve' }), {});
  assert(gReadApprove.allow === false, 'read 档位 + approve 模式仍拒绝（硬约束）');
  const gReadRo = gateTool('read', mkTool('read_file'), { path: 'a.ts' });
  assert(gReadRo.allow === true, 'read 档位放行 read_file');
  // applyApprovalMode 边界
  const ap = applyApprovalMode('approve', { allow: false, reason: 'x' }, mkTool('t'));
  assert(ap.allow === false, 'approve 不绕过 deny');

  console.log(failed === 0 ? '\n✓✓ 安全与信任探针全部通过' : `\n✗✗ ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
