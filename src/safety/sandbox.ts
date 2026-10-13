/**
 * OS 级沙箱（对标 Codex sandbox：read-only / workspace-write / danger-full-access）：
 * 用操作系统机制包裹 run_command 执行，限制其副作用范围。
 *
 * · macOS —— `sandbox-exec`（Seatbelt profile，系统自带）：
 *   read-only      拒绝全部文件写 + 网络，并拒绝读取敏感凭证目录（~/.ssh、~/.aws 等）
 *   workspace-write 拒绝全盘写 + 网络，但允许工作目录内写（+ 额外白名单路径）
 *   网络白名单经内置代理：Seatbelt 内核层只放行到本地代理端口（真·强制）
 * · Linux —— `bwrap`（bubblewrap，需系统安装）：
 *   read-only      根文件系统只读挂载 + 无网络 + 隔离 PID/UTS
 *   workspace-write 额外 bind 工作目录可写
 *   无 bwrap 时回退 `firejail`（--private= 只读、--net=none）
 *   网络白名单：只能经代理环境变量**尽力而为**（bwrap 为让本机代理可达必须放开内核
 *   网络限制，非白名单目标若绕过 proxy 变量即可直连）——**非内核层强制**
 * · Windows —— 不支持 AppContainer 包装（降级返回原命令 + 提示，不阻塞）；
 *   建议在 WSL 内运行 omni 以获得 bwrap 保护（仅提示，不自动切换）
 *
 * fail-closed（沙箱启用时的**默认**）：平台没有可用沙箱原语 → 拒绝执行命令，
 *   而不是静默裸奔（见 config sandboxFailClosed，缺省在沙箱启用时为 true）。
 *   用户显式 `sandboxFailClosed: false` 可退回 fail-open 降级放行；
 *   网络白名单在非 macOS 平台无法内核强制，fail-closed 下同样拒绝（除非显式关闭）。
 *   `sandbox: off` / `danger-full-access` 不受影响。
 *
 * 设计取舍：
 * · danger-full-access = 不沙箱（等同 off，用户显式选择无限制）；
 * · 沙箱只包裹 run_command；write_file 等静态工具由权限档位控制（read 档位拒绝）；
 * · 可用性检测只做一次（缓存）；策略面守卫只拦常见直白写法（可被命令替换绕过），
 *   真正的边界是 OS 沙箱本身。
 * · workspace-write 白名单（config sandboxWritePaths）：额外允许写的绝对路径
 *  （如临时目录/家目录子集），macOS 追加 subpath allow、Linux bwrap 追加 --bind、
 *   firejail 追加 --whitelist（只读化白名单语义受限，firejail 下以 read-write bind 表达）。
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
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
   * 平台差异：macOS 由 Seatbelt 内核强制「仅连本地代理端口」；Linux（bwrap/firejail）
   * 只能靠 http_proxy/https_proxy 环境变量尽力而为（见 SandboxResult.networkEnforced）。
   */
  networkAllow?: string[];
  /** 内置白名单代理端口（networkAllow 非空时由 attachRuntime 启动并传入） */
  proxyPort?: number;
  /**
   * 凭证 masking（1.0 P0-4）：环境变量名列表——这些变量在沙箱命令里被替换为
   * sentinel `__OMNI_MASKED__<名>`，防凭据被 echo 进工具结果。
   */
  maskEnvVars?: string[];
  /** 家目录（`~` 展开 / 敏感读取拒绝路径的基准；默认 os.homedir()；测试可注入） */
  home?: string;
}

/** 沙箱包装结果 */
export interface SandboxResult {
  /** 包装后的完整命令（原样执行） */
  command: string;
  /** 是否真正受沙箱保护（false = 降级：原命令 + note 说明） */
  protected: boolean;
  /** 说明（降级原因 / 保护范围） */
  note?: string;
  /**
   * 网络白名单是否由**内核层强制**：
   * · macOS → true（Seatbelt `deny network*` + 仅放行本地代理端口）；
   * · Linux/bwrap/firejail → false（仅 proxy 环境变量，尽力而为，可被绕过）。
   * 未启用网络白名单时可不关心；main.ts 在 fail-closed 下据此拒绝弱保证的执行。
   */
  networkEnforced?: boolean;
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

/** Seatbelt 字符串转义（路径/值里的反斜杠与引号） */
function sbQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 敏感凭证目录/文件的读取拒绝清单（macOS Seatbelt `deny file-read*` 用）：
 * 沙箱内的命令即便工作目录可写，也不应读到私钥/云凭证/包管理器令牌。
 *
 * trade-off：可能误伤确实需要该凭证的合法命令（如 `git` over SSH 需要 `~/.ssh`、
 * `gh` 需要 `~/.config/gh`）。取舍是安全优先——需要这类凭证时请在**沙箱外**执行，
 * 或显式关闭沙箱（`sandbox: off`）。`.git/config` 里可能含 token，但它是仓库内文件、
 * 且 workspace-write 下通常需要读，暂不列入（按需再加）。
 */
export function sensitiveReadDenyPaths(home: string): string[] {
  if (!home) return [];
  const j = (p: string) => `${home}/${p}`;
  return [
    j('.ssh'),
    j('.aws'),
    j('.gnupg'),
    j('.config/omni'), // omni 自身的配置/会话/审计
    j('.config/gh'),
    j('.netrc'),
    j('.docker/config.json'),
  ];
}

/**
 * macOS Seatbelt profile：工作目录写权限（+ 白名单路径）；网络按白名单收紧或全禁；
 * 并显式拒绝读取敏感凭证目录。**纯函数**（cwd/home 均可注入，便于单测）。
 */
export function seatbeltProfile(mode: SandboxMode, cwd: string, writePaths: string[], opts: SandboxOptions = {}): string {
  const esc = cwd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const extras = writePaths
    .map((p) => `(allow file-write* (subpath ${sbQuote(p)}))`)
    .join('\n');
  // 网络：无白名单 → 全禁；有白名单 + 代理端口 → 仅允许连本地代理（Seatbelt 内核层强制，
  // 出站目标再由内置代理按 hostname 白名单二次过滤）
  const hasProxy = !!(opts.networkAllow?.length && opts.proxyPort);
  const network = hasProxy
    ? `(deny network*)\n(allow network-outgoing (remote tcp "127.0.0.1:${opts.proxyPort}"))`
    : '(deny network*)';
  // 敏感读取拒绝（排在 `(allow default)` 之后 → 后者胜出，即拒绝读取）。
  // 若 cwd 恰好位于某拒绝路径内（如在 ~/.config/omni 里跑），跳过该条避免自锁。
  const home = opts.home ?? process.env.HOME ?? homedir();
  const readDenies = sensitiveReadDenyPaths(home)
    .filter((p) => !(cwd === p || cwd.startsWith(`${p}/`)))
    .map((p) => `(deny file-read* (subpath ${sbQuote(p)}))`)
    .join('\n');
  const denies = readDenies ? `\n${readDenies}` : '';
  if (mode === 'read-only') {
    return `(version 1)\n(allow default)\n${network}${denies}\n(deny file-write*)\n(deny mach-lookup (global-name "com.apple.distributed_notifications"))`;
  }
  // workspace-write：允许 cwd 内写 + 白名单路径，其余写与网络拒绝
  return `(version 1)\n(allow default)\n${network}${denies}\n(deny file-write*)\n(allow file-write* (subpath "${esc}"))${extras ? `\n${extras}` : ''}`;
}

/**
 * 沙箱内命令的「自我保护」检查：拒绝访问 omni 自身策略面（配置文件 / 全局配置目录 /
 * 信任清单 / 审计日志 / 项目 `.omni` 目录）——否则沙箱内的 agent 可以改配置给自己提权，
 * 或读取审计/信任状态外泄。
 *
 * 这是**尽力而为的字符串守卫**（不是完整 shell 解析）：先展开 `~`/`$HOME`、去掉引号、
 * 按 shell 元字符（`; | & && || > < ( ) 反引号 空白`）切词、相对路径按 cwd 解析（含 `..`
 * 折叠），再与受保护目标比对。可被变量拼接/命令替换绕过（如 `P=omni; rm $P.json`）——
 * 真正的边界是 OS 沙箱本身，守卫只拦常见直白写法。
 *
 * 示例（命中 → 返回标签）：
 *   findSandboxPolicyHit('rm omni.json')                        → 'omni.json'（相对 cwd）
 *   findSandboxPolicyHit('echo x >> ~/.config/omni/omni.json')  → '~/.config/omni/'（展开 ~）
 *   findSandboxPolicyHit('cat "$HOME/.config/omni/audit.log"')  → 'audit.log'
 *   findSandboxPolicyHit('rm -rf .omni/checkpoints')            → '.omni/'
 *   findSandboxPolicyHit('cat src/index.ts')                    → null（无关命令）
 */
export interface SandboxPolicyGuardOptions {
  /** 解析相对路径的基准目录（默认 process.cwd()） */
  cwd?: string;
  /** `~` / `$HOME` 展开目标（默认 process.env.HOME） */
  home?: string;
}

/** 折叠路径中的 `.` / `..` / 重复斜杠（纯字符串，不做 symlink 解析） */
function collapsePath(p: string): string {
  const isAbs = p.startsWith('/');
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!isAbs) parts.push('..');
    } else {
      parts.push(seg);
    }
  }
  return (isAbs ? '/' : '') + parts.join('/');
}

/** 受保护目标（集中维护，便于扩展/审阅） */
const SANDBOX_POLICY_TARGETS = {
  configFiles: ['omni.json', 'omni.jsonc'],
  trustFile: 'trusted-workspaces.json',
  auditFile: 'audit.log',
  projectDir: '.omni',
};

/** 可测试的核心实现：命中返回标签（如 'omni.json'），否则 null */
export function findSandboxPolicyHit(command: string, opts: SandboxPolicyGuardOptions = {}): string | null {
  const cwd = collapsePath(opts.cwd ?? process.cwd());
  const home = collapsePath(opts.home ?? process.env.HOME ?? '');
  // 1) 先展开 $HOME / ${HOME}（变量写法不漏检）
  const expanded = command.replace(/\$\{HOME\}|\$HOME\b/g, home);
  // 2) 去引号 + 按 shell 元字符/空白切词（引号/反斜杠直接切掉）
  const tokens = expanded.split(/[\s;|&<>()`'"\\]+/);
  const configDir = home ? `${home}/.config/omni` : '';
  const expandHome = (t: string): string =>
    t === '~' ? home : t.startsWith('~/') ? `${home}${t.slice(1)}` : t;
  for (let tok of tokens) {
    if (!tok) continue;
    tok = expandHome(tok);
    // `VAR=path` 赋值形态：取等号后的路径再做一次 ~ 展开
    const eq = tok.indexOf('=');
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok.slice(0, eq))) tok = expandHome(tok.slice(eq + 1));
    if (!tok) continue;
    // 3) 相对路径按 cwd 解析为绝对路径（含 .. 折叠）
    const abs = collapsePath(tok.startsWith('/') ? tok : `${cwd}/${tok}`);
    const base = abs.slice(abs.lastIndexOf('/') + 1);
    if (SANDBOX_POLICY_TARGETS.configFiles.includes(base)) return base;
    if (base === SANDBOX_POLICY_TARGETS.trustFile) return base;
    if (base === SANDBOX_POLICY_TARGETS.auditFile) return base;
    if (configDir && (abs === configDir || abs.startsWith(`${configDir}/`))) return '~/.config/omni/';
    if (abs.split('/').includes(SANDBOX_POLICY_TARGETS.projectDir)) return '.omni/';
  }
  // 4) 兜底：整串（已展开）里直接含配置目录/目标名（引号内空格等切词失效的写法）
  if (configDir && expanded.includes(`${home}/.config/omni/`)) return '~/.config/omni/';
  for (const f of [...SANDBOX_POLICY_TARGETS.configFiles, SANDBOX_POLICY_TARGETS.trustFile, SANDBOX_POLICY_TARGETS.auditFile]) {
    if (expanded.includes(f)) return f;
  }
  return null;
}

/** 兼容入口（保留既有函数名/契约 `string | null`）：命中返回标签，否则 null */
export function touchesSandboxPolicy(command: string): string | null {
  return findSandboxPolicyHit(command);
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
      networkEnforced: true,
      note:
        (mode === 'read-only'
          ? 'sandbox（只读 + 网络'
          : `sandbox（仅工作目录可写 + 网络${writePaths.length ? ` + ${writePaths.length} 个白名单路径` : ''}`) +
        (hasProxy ? `：仅经本地白名单代理（${opts.networkAllow!.join('、')}）（Seatbelt 内核强制）` : '全禁') +
        '；已拒绝读取 ~/.ssh、~/.aws 等凭证目录）',
    };
  }
  if (process.platform === 'linux') {
    if (hasBwrap()) {
      // 白名单出网时不能 --unshare-net（否则连本机代理都不可达）——降为代理环境
      // 变量尽力而为（**非内核强制**：绕过 proxy 变量即可直连）；无白名单保持断网硬隔离。
      const netFlags = hasProxy ? '' : ' --unshare-net';
      const base = `bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp${netFlags} --unshare-uts --unshare-pid`;
      const binds =
        mode === 'workspace-write'
          ? ['', ...writePaths].map((p) => (p ? ` --bind ${JSON.stringify(p)} ${JSON.stringify(p)}` : ` --bind ${JSON.stringify(cwd)} ${JSON.stringify(cwd)}`)).join('')
          : '';
      return {
        command: `${base}${binds} -- env${envPrefix || ' '} ${command}`,
        protected: true,
        networkEnforced: false,
        note:
          (mode === 'read-only' ? 'bwrap（只读 + 网络' : 'bwrap（仅工作目录可写 + 网络') +
          (hasProxy ? `：白名单仅经代理环境变量，非内核强制（非白名单目标可绕过 proxy 直连，尽力而为）` : '全禁') +
          '）',
      };
    }
    // bwrap 缺失 → firejail 回退（第九节 P2）：--net=none 断网 + 只读化根 +
    // workspace-write 用 --whitelist 放行工作目录写入。白名单出网时放开网络、
    // 由代理环境变量约束（firejail 无按 hostname 过滤能力——**非内核强制**，尽力而为）。
    if (hasFirejail()) {
      const ro = mode === 'read-only' ? ' --read-only=/' : '';
      const wl = mode === 'workspace-write'
        ? ['', ...writePaths].map((p) => ` --whitelist=${p || cwd}`).join('')
        : '';
      const netFlag = hasProxy ? '' : ' --net=none';
      return {
        command: `firejail${netFlag} --private=${cwd}${ro}${wl} -- env${envPrefix || ' '} ${command}`,
        protected: true,
        networkEnforced: false,
        note:
          (mode === 'read-only' ? 'firejail（只读 + 网络' : `firejail（仅工作目录可写 + 网络`) +
          (hasProxy ? `：白名单仅经代理（非内核强制，尽力而为）；bwrap 未安装已回退）` : '全禁；bwrap 未安装已回退）') +
        '',
      };
    }
  }
  if (process.platform === 'win32') {
    // Windows 沙箱（2026-09 补课）：AppContainer/受限令牌包装需要原生模块，
    // Node 层无法可靠实现（runas 无法捕获 stdout，会破坏工具结果）；显式声明不支持。
    // 沙箱启用时 sandboxFailClosed **默认为 true**（见 config/index.ts），
    // main.ts 会拒绝执行裸奔命令；仅当用户显式 sandboxFailClosed:false 才降级放行。
    return {
      command,
      protected: false,
      note:
        'Windows 无 OS 沙箱原语（AppContainer/受限令牌包装需原生模块，当前未实现）——' +
        '沙箱启用时默认 fail-closed（sandboxFailClosed）拒绝执行裸奔命令。' +
        '推荐在 WSL 内运行 omni（获得 bwrap 保护）；确要在 Windows 原生下临时放行需显式设 sandboxFailClosed:false（不安全）。',
    };
  }
  return {
    command,
    protected: false,
    note: `沙箱不可用（${process.platform} 需 sandbox-exec / bwrap / firejail）——沙箱启用时默认 fail-closed 拒绝执行；仅在显式 sandboxFailClosed:false 时才降级为直接执行`,
  };
}

/** Windows 沙箱支持状态（供 /status、/doctor 与测试使用；见 wrapSandboxCommand 注释） */
export function windowsSandboxStatus(): { supported: boolean; reason: string } {
  return {
    supported: false,
    reason:
      'AppContainer/受限令牌包装需要原生模块（当前未实现）：沙箱启用时默认 fail-closed（sandboxFailClosed）拒绝裸奔；' +
      '推荐在 WSL 内运行 omni（bwrap 保护），或显式设 sandboxFailClosed=false 在 Windows 原生下放行（不安全）',
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
