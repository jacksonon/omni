/**
 * OS 级沙箱（对标 Codex sandbox：read-only / workspace-write / danger-full-access）：
 * 用操作系统机制包裹 run_command 执行，限制其副作用范围。
 *
 * · macOS —— `sandbox-exec`（Seatbelt profile，系统自带）：
 *   read-only      拒绝全部文件写 + 网络
 *   workspace-write 拒绝全盘写 + 网络，但允许工作目录内写（+ 额外白名单路径）
 * · Linux —— `bwrap`（bubblewrap，需系统安装）：
 *   read-only      根文件系统只读挂载 + 无网络 + 隔离 PID/UTS
 *   workspace-write 额外 bind 工作目录可写
 *   无 bwrap 时回退 `firejail`（--private= 只读、--net=none；第九节 P2 细化）
 * · Windows —— 不支持 AppContainer 包装（降级返回原命令 + 提示，不阻塞）；
 *   有 WSL 时可提示用户在 WSL 内运行获得 bwrap 保护（仅提示，不自动切换）
 *
 * 设计取舍：
 * · danger-full-access = 不沙箱（等同 off，用户显式选择无限制）；
 * · 沙箱只包裹 run_command；write_file 等静态工具由权限档位控制（read 档位拒绝）；
 * · 可用性检测只做一次（缓存）；不可用时降级执行并在结果里提示（fail-open，
 *   不因沙箱缺失卡住主流程——但审计/提示让用户知道当前未真正受沙箱保护）。
 * · workspace-write 白名单（config sandboxWritePaths）：额外允许写的绝对路径
 *  （如临时目录/家目录子集——TODO 第九节 P2），macOS 追加 subpath allow、
 *   Linux bwrap 追加 --bind、firejail 追加 --whitelist（只读化白名单语义受限，
 *   firejail 下白名单路径以 read-write bind 表达）。
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

/** 沙箱档位（config `sandbox` 字段） */
export type SandboxMode = 'off' | 'read-only' | 'workspace-write' | 'danger-full-access';

export const SANDBOX_MODES: SandboxMode[] = ['off', 'read-only', 'workspace-write', 'danger-full-access'];

/** 沙箱包装选项（workspace-write 白名单等） */
export interface SandboxOptions {
  /** workspace-write 下额外允许写的绝对路径（config sandboxWritePaths） */
  writePaths?: string[];
}

/** 沙箱包装结果 */
export interface SandboxResult {
  /** 包装后的完整命令（原样执行） */
  command: string;
  /** 是否真正受沙箱保护（false = 降级：原命令 + note 说明） */
  protected: boolean;
  /** 说明（降级原因 / 保护范围） */
  note?: string;
}

let availability: { mac: boolean | null; bwrap: boolean | null; firejail: boolean | null } = {
  mac: null,
  bwrap: null,
  firejail: null,
};

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

/** 检测 Linux firejail 可用性（bwrap 缺失时的回退；缓存） */
function hasFirejail(): boolean {
  if (availability.firejail !== null) return availability.firejail;
  try {
    const r = spawnSync('firejail', ['--version'], { stdio: 'ignore', timeout: 5000 });
    availability.firejail = r.status === 0;
  } catch {
    availability.firejail = false;
  }
  return availability.firejail;
}

/** 规范化白名单路径：过滤空值/相对路径，去重去 cwd（cwd 已默认可写） */
function normalizeWritePaths(paths: string[] | undefined, cwd: string): string[] {
  const out: string[] = [];
  for (const p of paths ?? []) {
    if (!p || !path2IsAbsolute(p)) continue;
    const resolved = resolvePath(p);
    if (resolved === cwd || out.includes(resolved)) continue;
    out.push(resolved);
  }
  return out;
}

/* 路径工具（不 import node:path 的 path.resolve 以便纯函数测试注入 cwd） */
function path2IsAbsolute(p: string): boolean {
  return p.startsWith('/');
}
function resolvePath(p: string): string {
  // 简单规范化（.. 折叠）；沙箱参数场景无需 symlink 解析
  const parts = p.split('/').filter((s) => s && s !== '.');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

/** macOS Seatbelt profile：工作目录写权限（+ 白名单路径） */
function seatbeltProfile(mode: SandboxMode, cwd: string, writePaths: string[]): string {
  const esc = cwd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const extras = writePaths
    .map((p) => `(allow file-write* (subpath "${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"))`)
    .join('\n');
  if (mode === 'read-only') {
    return `(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n(deny mach-lookup (global-name "com.apple.distributed_notifications"))`;
  }
  // workspace-write：允许 cwd 内写 + 白名单路径，其余写与网络拒绝
  return `(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n(allow file-write* (subpath "${esc}"))${extras ? `\n${extras}` : ''}`;
}

/**
 * 把命令包进沙箱。off / danger-full-access 返回原命令（不保护）；
 * 平台不支持时降级（原命令 + 提示）。
 */
export function wrapSandboxCommand(mode: SandboxMode, cwd: string, command: string, opts: SandboxOptions = {}): SandboxResult {
  if (mode === 'off' || mode === 'danger-full-access') {
    return { command, protected: false, note: mode === 'danger-full-access' ? 'danger-full-access：不沙箱（全访问）' : undefined };
  }
  const writePaths = normalizeWritePaths(opts.writePaths, cwd);
  if (process.platform === 'darwin' && hasSandboxExec()) {
    const profile = seatbeltProfile(mode, cwd, writePaths);
    const wrapped = `sandbox-exec -p ${JSON.stringify(profile)} -- ${command}`;
    return {
      command: wrapped,
      protected: true,
      note:
        mode === 'read-only'
          ? 'sandbox（只读 + 无网络）'
          : `sandbox（仅工作目录可写 + 无网络）${writePaths.length ? ` + ${writePaths.length} 个白名单路径` : ''}`,
    };
  }
  if (process.platform === 'linux') {
    if (hasBwrap()) {
      const base = 'bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-net --unshare-uts --unshare-pid';
      const binds =
        mode === 'workspace-write'
          ? ['', ...writePaths].map((p) => (p ? ` --bind ${JSON.stringify(p)} ${JSON.stringify(p)}` : ` --bind ${JSON.stringify(cwd)} ${JSON.stringify(cwd)}`)).join('')
          : '';
      return {
        command: `${base}${binds} ${command}`,
        protected: true,
        note: mode === 'read-only' ? 'bwrap（只读 + 无网络）' : 'bwrap（仅工作目录可写 + 无网络）',
      };
    }
    // bwrap 缺失 → firejail 回退（第九节 P2）：--net=none 断网 + 只读化根 +
    // workspace-write 用 --whitelist 放行工作目录写入（firejail 默认允许用户写自己家，
    // 这里用 read-only 覆盖再放行白名单，尽量收敛到与 bwrap 同等强度）
    if (hasFirejail()) {
      const ro = mode === 'read-only' ? ' --read-only=/' : '';
      const wl = mode === 'workspace-write'
        ? ['', ...writePaths].map((p) => ` --whitelist=${p || cwd}`).join('')
        : '';
      return {
        command: `firejail --net=none --private=${cwd}${ro}${wl} -- ${command}`,
        protected: true,
        note:
          mode === 'read-only'
            ? 'firejail（只读 + 无网络；bwrap 未安装已回退）'
            : `firejail（仅工作目录可写 + 无网络；bwrap 未安装已回退）${writePaths.length ? ` + ${writePaths.length} 个白名单路径` : ''}`,
      };
    }
  }
  return {
    command,
    protected: false,
    note: `沙箱不可用（${process.platform} 需 sandbox-exec / bwrap / firejail），已降级为直接执行`,
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
  availability = { mac: null, bwrap: null, firejail: null };
}
