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
  /**
   * 网络白名单（1.0 P0-4）：hostname 列表。非空时沙箱内命令经内置过滤代理出网
   * （需配合 proxyPort）；空/缺省 = 全禁网。
   */
  networkAllow?: string[];
  /** 内置白名单代理端口（networkAllow 非空时由 attachRuntime 启动并传入） */
  proxyPort?: number;
  /**
   * 凭证 masking（1.0 P0-4）：环境变量名列表——这些变量在沙箱命令里被替换为
   * sentinel `__OMNI_MASKED__<名>`，防凭据被 echo 进工具结果。
   */
  maskEnvVars?: string[];
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

/** macOS Seatbelt profile：工作目录写权限（+ 白名单路径）；网络按白名单收紧或全禁 */
function seatbeltProfile(mode: SandboxMode, cwd: string, writePaths: string[], opts: SandboxOptions): string {
  const esc = cwd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const extras = writePaths
    .map((p) => `(allow file-write* (subpath "${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"))`)
    .join('\n');
  // 网络：无白名单 → 全禁；有白名单 + 代理端口 → 仅允许连本地代理（内核层强制，
  // 出站目标由代理按 hostname 白名单二次过滤）
  const hasProxy = !!(opts.networkAllow?.length && opts.proxyPort);
  const network = hasProxy
    ? `(deny network*)\n(allow network-outgoing (remote tcp "127.0.0.1:${opts.proxyPort}"))`
    : '(deny network*)';
  if (mode === 'read-only') {
    return `(version 1)\n(allow default)\n${network}\n(deny file-write*)\n(deny mach-lookup (global-name "com.apple.distributed_notifications"))`;
  }
  // workspace-write：允许 cwd 内写 + 白名单路径，其余写与网络拒绝
  return `(version 1)\n(allow default)\n${network}\n(deny file-write*)\n(allow file-write* (subpath "${esc}"))${extras ? `\n${extras}` : ''}`;
}

/**
 * 沙箱内命令的「自我保护」检查：拒绝修改 omni 自身策略面（配置文件 / hooks /
 * 审计日志 / 信任清单）——否则沙箱内的 agent 可以改配置给自己提权。
 * 只在沙箱启用时对 run_command 生效；误报代价低（提示用户临时关沙箱执行）。
 */
const SANDBOX_POLICY_PATTERNS: RegExp[] = [
  /\bomni\.jsonc?\b/,
  /~?\/?\.config\/omni\//,
  /\btrusted-workspaces\.json\b/,
  /\baudit\.log\b/,
];

export function touchesSandboxPolicy(command: string): string | null {
  for (const re of SANDBOX_POLICY_PATTERNS) {
    if (re.test(command)) return re.source;
  }
  return null;
}

/** 沙箱出网所需的代理环境变量赋值串（POSIX `env` 前缀形态） */
function proxyEnvPrefix(port: number): string {
  return (
    ` http_proxy=http://127.0.0.1:${port}` +
    ` https_proxy=http://127.0.0.1:${port}` +
    ` HTTP_PROXY=http://127.0.0.1:${port}` +
    ` HTTPS_PROXY=http://127.0.0.1:${port}` +
    ` NO_PROXY=localhost,127.0.0.1`
  );
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
  const hasProxy = !!(opts.networkAllow?.length && opts.proxyPort);
  // 环境前缀：代理变量（白名单出网）+ 凭证 masking（值替换为 sentinel）
  let envPrefix = '';
  if (hasProxy && opts.proxyPort) envPrefix += proxyEnvPrefix(opts.proxyPort);
  if (opts.maskEnvVars?.length) {
    for (const name of opts.maskEnvVars) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) envPrefix += ` ${name}=__OMNI_MASKED__${name}`;
    }
  }
  if (process.platform === 'darwin' && hasSandboxExec()) {
    const profile = seatbeltProfile(mode, cwd, writePaths, opts);
    const wrapped = `sandbox-exec -p ${JSON.stringify(profile)} -- env${envPrefix || ' '} ${command}`;
    return {
      command: wrapped,
      protected: true,
      note:
        (mode === 'read-only'
          ? 'sandbox（只读 + 网络'
          : `sandbox（仅工作目录可写 + 网络${writePaths.length ? ` + ${writePaths.length} 个白名单路径` : ''}`) +
        (hasProxy ? `：仅经本地白名单代理（${opts.networkAllow!.join('、')}）` : '全禁') +
        '）',
    };
  }
  if (process.platform === 'linux') {
    if (hasBwrap()) {
      // 白名单出网时不能 --unshare-net（否则连本机代理都不可达）——降为代理环境
      // 变量尽力而为；无白名单保持断网硬隔离。
      const netFlags = hasProxy ? '' : ' --unshare-net';
      const base = `bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp${netFlags} --unshare-uts --unshare-pid`;
      const binds =
        mode === 'workspace-write'
          ? ['', ...writePaths].map((p) => (p ? ` --bind ${JSON.stringify(p)} ${JSON.stringify(p)}` : ` --bind ${JSON.stringify(cwd)} ${JSON.stringify(cwd)}`)).join('')
          : '';
      return {
        command: `${base}${binds} -- env${envPrefix || ' '} ${command}`,
        protected: true,
        note:
          (mode === 'read-only' ? 'bwrap（只读 + 网络' : 'bwrap（仅工作目录可写 + 网络') +
          (hasProxy ? `：白名单经代理，非白名单目标依赖工具遵循 proxy 变量（尽力而为）` : '全禁') +
          '）',
      };
    }
    // bwrap 缺失 → firejail 回退（第九节 P2）：--net=none 断网 + 只读化根 +
    // workspace-write 用 --whitelist 放行工作目录写入。白名单出网时放开网络、
    // 由代理环境变量约束（firejail 无按 hostname 过滤能力——尽力而为）。
    if (hasFirejail()) {
      const ro = mode === 'read-only' ? ' --read-only=/' : '';
      const wl = mode === 'workspace-write'
        ? ['', ...writePaths].map((p) => ` --whitelist=${p || cwd}`).join('')
        : '';
      const netFlag = hasProxy ? '' : ' --net=none';
      return {
        command: `firejail${netFlag} --private=${cwd}${ro}${wl} -- env${envPrefix || ' '} ${command}`,
        protected: true,
        note:
          (mode === 'read-only' ? 'firejail（只读 + 网络' : `firejail（仅工作目录可写 + 网络`) +
          (hasProxy ? `：白名单经代理（尽力而为）；bwrap 未安装已回退）` : '全禁；bwrap 未安装已回退）') +
        '',
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
