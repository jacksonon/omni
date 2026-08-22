/**
 * OS 级沙箱（对标 Codex sandbox：read-only / workspace-write / danger-full-access）：
 * 用操作系统机制包裹 run_command 执行，限制其副作用范围。
 *
 * · macOS —— `sandbox-exec`（Seatbelt profile，系统自带）：
 *   read-only      拒绝全部文件写 + 网络
 *   workspace-write 拒绝全盘写 + 网络，但允许工作目录内写
 * · Linux —— `bwrap`（bubblewrap，需系统安装）：
 *   read-only      根文件系统只读挂载 + 无网络 + 隔离 PID/UTS
 *   workspace-write 额外 bind 工作目录可写
 * · Windows / 不可用 —— 不支持（降级返回原命令 + 提示，不阻塞）
 *
 * 设计取舍：
 * · danger-full-access = 不沙箱（等同 off，用户显式选择无限制）；
 * · 沙箱只包裹 run_command；write_file 等静态工具由权限档位控制（read 档位拒绝）；
 * · 可用性检测只做一次（缓存）；不可用时降级执行并在结果里提示（fail-open，
 *   不因沙箱缺失卡住主流程——但审计/提示让用户知道当前未真正受沙箱保护）。
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

/** 沙箱档位（config `sandbox` 字段） */
export type SandboxMode = 'off' | 'read-only' | 'workspace-write' | 'danger-full-access';

export const SANDBOX_MODES: SandboxMode[] = ['off', 'read-only', 'workspace-write', 'danger-full-access'];

/** 沙箱包装结果 */
export interface SandboxResult {
  /** 包装后的完整命令（原样执行） */
  command: string;
  /** 是否真正受沙箱保护（false = 降级：原命令 + note 说明） */
  protected: boolean;
  /** 说明（降级原因 / 保护范围） */
  note?: string;
}

let availability: { mac: boolean | null; bwrap: boolean | null } = { mac: null, bwrap: null };

/** 检测 macos sandbox-exec 可用性（缓存） */
function hasSandboxExec(): boolean {
  if (availability.mac !== null) return availability.mac;
  availability.mac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
  return availability.mac;
}

/** 检测 Linux bwrap 可用性（缓存） */
function hasBwrap(): boolean {
  if (availability.bwrap !== null) return availability.bwrap;
  try {
    const r = spawnSync('bwrap', ['--version'], { stdio: 'ignore', timeout: 5000 });
    availability.bwrap = r.status === 0;
  } catch {
    availability.bwrap = false;
  }
  return availability.bwrap;
}

/** macOS Seatbelt profile：工作目录写权限 */
function seatbeltProfile(mode: SandboxMode, cwd: string): string {
  const esc = cwd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  if (mode === 'read-only') {
    return `(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n(deny mach-lookup (global-name "com.apple.distributed_notifications"))`;
  }
  // workspace-write：允许 cwd 内写，其余写与网络拒绝
  return `(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n(allow file-write* (subpath "${esc}"))`;
}

/**
 * 把命令包进沙箱。off / danger-full-access 返回原命令（不保护）；
 * 平台不支持时降级（原命令 + 提示）。
 */
export function wrapSandboxCommand(mode: SandboxMode, cwd: string, command: string): SandboxResult {
  if (mode === 'off' || mode === 'danger-full-access') {
    return { command, protected: false, note: mode === 'danger-full-access' ? 'danger-full-access：不沙箱（全访问）' : undefined };
  }
  if (process.platform === 'darwin' && hasSandboxExec()) {
    const profile = seatbeltProfile(mode, cwd);
    const wrapped = `sandbox-exec -p ${JSON.stringify(profile)} -- ${command}`;
    return {
      command: wrapped,
      protected: true,
      note: mode === 'read-only' ? 'sandbox（只读 + 无网络）' : 'sandbox（仅工作目录可写 + 无网络）',
    };
  }
  if (process.platform === 'linux' && hasBwrap()) {
    const base = 'bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-net --unshare-uts --unshare-pid';
    const binds = mode === 'workspace-write' ? ` --bind ${JSON.stringify(cwd)} ${JSON.stringify(cwd)}` : '';
    return {
      command: `${base}${binds} ${command}`,
      protected: true,
      note: mode === 'read-only' ? 'bwrap（只读 + 无网络）' : 'bwrap（仅工作目录可写 + 无网络）',
    };
  }
  return {
    command,
    protected: false,
    note: `沙箱不可用（${process.platform} 需 sandbox-exec / bwrap），已降级为直接执行`,
  };
}

/** 沙箱档位的人性化名称（/status 展示） */
export function sandboxLabel(mode: SandboxMode): string {
  switch (mode) {
    case 'off': return '关闭';
    case 'read-only': return '只读（拒绝写 + 网络）';
    case 'workspace-write': return '工作区可写（仅 cwd，拒绝网络）';
    case 'danger-full-access': return '全访问（不沙箱）';
  }
}

/** 解析用户配置字符串 → SandboxMode（非法回退 off） */
export function parseSandboxMode(v: unknown): SandboxMode {
  return SANDBOX_MODES.includes(v as SandboxMode) ? (v as SandboxMode) : 'off';
}

/** 沙箱保护是否影响网络（read-only / workspace-write 都禁网） */
export function sandboxBlocksNetwork(mode: SandboxMode): boolean {
  return mode === 'read-only' || mode === 'workspace-write';
}

/** 工作目录归属的沙箱场景提示（run_command 结果里附带，让模型/用户知道限制） */
export function sandboxHint(mode: SandboxMode, cwd: string): string | null {
  if (mode === 'read-only') return `[沙箱：只读，拒绝文件写入与网络]`;
  if (mode === 'workspace-write') return `[沙箱：仅 ${cwd} 可写，拒绝网络]`;
  return null;
}

/** 测试辅助：重置可用性缓存 */
export function _resetSandboxAvailability(): void {
  availability = { mac: null, bwrap: null };
}
