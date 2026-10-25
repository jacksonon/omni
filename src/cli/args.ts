/**
 * CLI 参数解析与帮助文本。
 */
import type { ConfigOverrides } from '../config/index.js';

export interface ParsedArgs {
  taskArgs: string[];
  overrides: ConfigOverrides;
  flags: { noTui: boolean; listSessions: boolean; continueSession: boolean; listAll: boolean; cd: string | null; local: boolean; server: string | null };
  /** --resume/-r <id>：要恢复的会话 id（null = 未指定） */
  resumeId: string | null;
  help: boolean;
  version: boolean;
  /** --lang <zh|en>：仅影响 --help 展示语言（默认英文；--lang zh 显示中文） */
  lang: 'zh' | 'en' | null;
}

/** 解析参数：支持 --flag value 与 --flag=value 两种写法 */
export function parseArgs(args: string[]): ParsedArgs {
  const taskArgs: string[] = [];
  const overrides: ConfigOverrides = {};
  // OMNI_LOCAL=1：测试/CI/离线环境的等价 --local 默认值；显式 --server 优先。
  const envLocal = /^(1|true|yes)$/i.test(process.env.OMNI_LOCAL ?? '');
  const flags = { noTui: false, listSessions: false, continueSession: false, listAll: false, cd: null as string | null, local: envLocal, server: null as string | null };
  let localExplicit = false;
  let resumeId: string | null = null;
  let help = false;
  let version = false;
  let lang: 'zh' | 'en' | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.startsWith('--') && a.includes('=') ? a.indexOf('=') : -1;
    const name = eq >= 0 ? a.slice(0, eq) : a;
    const inlineValue = eq >= 0 ? a.slice(eq + 1) : undefined;
    const takeValue = (): string | undefined => inlineValue ?? args[++i];

    switch (name) {
      case '--local':
        flags.local = true;
        localExplicit = true;
        break;
      case '--server': {
        const value = takeValue();
        if (!value || value.startsWith('--')) throw new Error('--server 缺少服务地址');
        flags.server = value;
        break;
      }
      case '--help':
      case '-h':
        help = true;
        break;
      case '--version':
      case '-v':
      case '-V':
        version = true;
        break;
      case '--model':
      case '-m':
        overrides.model = takeValue();
        break;
      case '--config':
      case '-C':
        overrides.configPath = takeValue();
        break;
      case '--profile':
      case '-p':
        overrides.profile = takeValue();
        break;
      case '--sandbox':
        // OS 级沙箱覆盖（codex -s 对等；omni 的 -s 是 resume，只认长式）
        overrides.sandbox = takeValue();
        break;
      case '-i':
      case '--image': {
        // 初始图片附件（codex -i 对等；可重复；交互首轮/单次/headless 统一消费）
        const v = takeValue();
        if (v) (overrides.images ??= []).push(v);
        break;
      }
      case '--approve-for-me':
        // AI 自动审批（codex 同款；全模式生效， mini 单次/交互/headless 均走 cfg.autoReview）
        overrides.approveForMe = true;
        break;
      case '-a':
      case '--ask-for-approval': {
        // 审批策略覆盖（codex -a 对等；codex 值映射 + 原生档位直通，映射见 config）
        const v = takeValue();
        if (v !== undefined) overrides.askForApproval = v;
        break;
      }
      case '--strict-config':
        // 严格配置校验（codex 同款；未知顶层字段报错，防拼写错误与静默失效的旧字段）
        overrides.strictConfig = true;
        break;
      case '--ignore-user-config':
        // 跳过全局配置文件（codex 同款；只跳用户层，项目/显式 --config/环境变量/CLI 照常）
        overrides.ignoreUserConfig = true;
        break;
      case '--add-dir': {
        // 沙箱额外可写目录（codex --add-dir 对等；可重复，追加语义）
        const v = takeValue();
        if (v) (overrides.addDirs ??= []).push(v);
        break;
      }
      case '--cd':
        // 工作根覆盖（codex -C/--cd 对等；注意 omni 的 -C 是 config，此处只认 --cd）
        flags.cd = takeValue() ?? null;
        break;
      case '--no-tui':
        flags.noTui = true;
        break;
      case '--continue':
      case '-c':
        // 恢复当前项目最近一次会话（-c 已从 --config 让位给继续；config 用 -C）
        flags.continueSession = true;
        break;
      case '--resume':
      case '-r':
      case '-s':
        resumeId = takeValue() ?? null;
        break;
      case '--list-sessions':
      case '-l':
        flags.listSessions = true;
        break;
      case '-lf':
      case '-fl':
        flags.listSessions = true;
        flags.listAll = true;
        break;
      case '--lang':
      case '--language': {
        const v = (takeValue() ?? '').toLowerCase();
        if (v === 'zh' || v === 'zh-cn' || v === 'cn' || v === '中文') lang = 'zh';
        else if (v === 'en' || v === 'en-us' || v === '英文') lang = 'en';
        break;
      }
      default:
        // --lang=zh 粘连写法兼容（上方 eq 切分已处理 name，但 --lang 在 switch 前需取值；
        // 此处兜底：taskArgs 里形如 --lang=zh 的残留不應出現，忽略）
        taskArgs.push(a);
    }
  }
  // -l 的 -f/--full/--all 修饰：仅在列表模式下从位置参数里提取（`omni -l -f`），
  // 避免 `omni exec "任务" -f` 等子命令的参数被顶层误吞（exec 有自己的 flag 体系）。
  if (flags.listSessions) {
    const keep: string[] = [];
    for (const t of taskArgs) {
      if (t === '-f' || t === '--full' || t === '--all') flags.listAll = true;
      else keep.push(t);
    }
    taskArgs.length = 0;
    taskArgs.push(...keep);
  }
  // 显式 --server 覆盖环境默认的 OMNI_LOCAL；显式 --local + --server 仍算冲突。
  if (envLocal && flags.server && !localExplicit) flags.local = false;
  if (flags.local && flags.server) throw new Error('--local 与 --server 不能同时使用');
  return { taskArgs, overrides, flags, resumeId, help, version, lang };
}

/** `omni resume [id] [--last] [--all] [后续任务]` 参数解析（codex resume 对等）。
 * 首个非 flag 词 = 会话 id（UUID/完整 id 精确匹配；codex 的 name 模糊不在此列），
 * 其余拼成续跑 prompt；`--last` + id 同给算互斥；未知 --flag 直接报错。 */
export interface ResumeArgs {
  /** 会话 id（位置参数首词；无则 null） */
  id: string | null;
  /** --last：最近一次会话 */
  last: boolean;
  /** --all：最近/列表取消目录过滤 */
  all: boolean;
  /** 续跑 prompt 词（拼回 taskArgs 即单任务直跑） */
  promptWords: string[];
}
export function parseResumeArgs(args: string[], cmd = 'resume'): ResumeArgs {
  let last = false;
  let all = false;
  const rest: string[] = [];
  for (const a of args) {
    if (a === '--last') last = true;
    else if (a === '--all') all = true;
    else if (a.startsWith('-') && a !== '-') {
      throw new Error(`未知参数：${a}（用法：omni ${cmd} [id] [--last] [--all] [后续任务]）`);
    } else rest.push(a);
  }
  // `--last` 优先：`resume abc --last` 的 abc 按 prompt 处理（id 槽只在无 --last 时填充，
  // 故 id+last 不可能共存，无需互斥检查）
  let id: string | null = null;
  let promptWords: string[] = [];
  if (!last && rest.length > 0) {
    id = rest[0] ?? null;
    promptWords = rest.slice(1);
  } else {
    promptWords = rest;
  }
  return { id, last, all, promptWords };
}

// 保留既有导入路径；帮助内容与参数解析分开维护。
export { printHelp } from './help.js';
