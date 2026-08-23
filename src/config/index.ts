/**
 * 配置加载（参考 opencode 的配置体系）。
 *
 * 分层合并，优先级从低到高：
 *   默认值 → 全局配置(~/.config/omni/omni.json) → 项目配置(omni.json/omni.jsonc，cwd 向上找)
 *   → 自定义配置(OMNI_CONFIG / --config) → 环境变量 → CLI 参数
 *
 * 配置文件支持 JSON 与 JSONC（带注释、容忍尾逗号）。
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOK_EVENTS, type HookDefinition, type HooksConfig } from '../hooks/index.js';
import type { PermissionTier } from '../safety/index.js';
import type { SandboxMode } from '../safety/sandbox.js';
import type { McpServerConfig } from '../tools/mcp.js';
import { parseJsonc } from './jsonc.js';
import { findInDir, findProjectConfig } from './discover.js';

export interface OmniConfig {
  model: string;
  baseURL?: string;
  apiKey?: string;
  maxSteps: number;
  /** 自定义 User-Agent（部分网关的 WAF 会拦截 SDK 默认 UA，可配置浏览器 UA 绕过） */
  userAgent?: string;
  /** 是否在终端展示思考过程（默认 true；关闭后仍会落盘 .omni/last-thinking.md） */
  showThinking: boolean;
  /**
   * 安全护栏权限分级：full（直通，任意命令含危险命令）/ safe（危险命令询问）/ ask（全部询问）/ read（只读）。
   * 默认 safe——危险命令不直接拦截，改为询问用户，用户允许后执行。
   */
  permission: PermissionTier;
  /** 是否写审计日志（~/.config/omni/audit.log；默认 true） */
  auditLog: boolean;
  /** 是否加载项目记忆 AGENTS.md（跨会话共享；默认 true） */
  agentsFile: boolean;
  /** 是否加载全局记忆 ~/.config/omni/AGENTS.md（跨项目共享；默认 true） */
  globalAgentsFile: boolean;
  /** 会话结束时把新表达的偏好自动追加进全局记忆（默认 true） */
  autoMemory: boolean;
  /** 长对话摘要压缩：消息数超过该值触发（0 = 关闭；默认 40） */
  summarizeAt: number;
  /** 压缩时保留最近多少条消息原文（默认 8） */
  summarizeWindow: number;
  /** 是否预载任务文本中出现的相关文件（默认 true） */
  preloadFiles: boolean;
  /** 是否启用技能（SKILL.md）发现与 skill 工具（默认 true） */
  skills: boolean;
  /**
   * 当前模型思考级别（reasoning_effort，OpenAI 系 low/medium/high；
   * 不配置则不带该参数——部分网关（DeepSeek 等）不认会回退不带）。
   * /variants 命令可切换；TUI 面板选项来自 reasoningEffortOptions。
   */
  reasoningEffort?: string;
  /** /variants 支持的思考级别选项（默认 low/medium/high，可自行配置支持哪些） */
  reasoningEffortOptions: string[];
  /**
   * 多模型配置：{ 模型名: { baseURL?, apiKey?, userAgent?, reasoningEffortOptions?, reasoningEffort? } }（/model 切换）。
   * 每个模型可有自己的端点/密钥/UA；缺省字段回退到顶层 baseURL/apiKey/userAgent。
   * **per-model variants**：reasoningEffortOptions = 该模型 /variants 支持的思考级别选项、
   * reasoningEffort = 该模型的当前思考级别——两者缺省回退顶层同名字段（只配置了端点
   * 的模型自动继承全局思考级别配置）。/model 切换到该模型时自动带出（面板选项/请求同步）。
   * 顶层 `model` 为默认模型（总是可用）。
   */
  models?: Record<
    string,
    {
      baseURL?: string;
      apiKey?: string;
      userAgent?: string;
      reasoningEffortOptions?: string[];
      reasoningEffort?: string;
    }
  >;
  /** 最多预载文件数（默认 5） */
  preloadMaxFiles: number;
  /** 单文件预载字节上限（默认 30KB） */
  preloadMaxBytes: number;
  /** 是否启用子代理（delegate 工具；默认 true） */
  allowSubagents: boolean;
  /** 子代理最大循环步数（默认 10） */
  maxSubagentSteps: number;
  /**
   * 子代理最大嵌套深度（第六节 P1：子代理可再委托，默认 5 层上限）。
   * 嵌套层级由 delegate 工具按深度注入新 delegate 控制。
   */
  maxSubagentDepth: number;
  /**
   * architect/editor 模型路由（第六节 P1，对标 Aider 双模型成本优化）：
   * · architect —— /plan 计划模式使用的强推理模型（缺省 = model）
   * · editor   —— 执行模式使用的轻量模型（缺省 = model）
   * 成本省 30-50%（强模型只规划、便宜模型执行）；同一端点下发模型名切换
   *（不同端点的 architect/editor 需配 models 表，MVP 不做跨端点路由）。
   */
  architect?: string;
  editor?: string;
  /**
   * TUI 底部状态行（输入区域下方的对话信息）显示哪些段、按什么顺序：
   * 段 id 数组，如 ['rounds','llm','speed','cache','tokens']；空数组 = 不显示状态行。
   * /settings statusline 可视化配置（空格勾选、←/→ 排序、Enter 保存生效并持久化）。
   * 合法 id：rounds（轮次/步数）· llm（LLM/工具耗时）· speed（首token/速率）· cache（缓存命中）· tokens（输入/输出）。
   */
  statusline: string[];
  /**
   * TUI 界面语言：'zh' 中文（默认） / 'en' 英文。
   * /settings 语言面板切换并持久化；界面 chrome（菜单/状态栏/footer/待发送/审批卡等）
   * 即时切换，命令面板的具体输出内容（/status 列表等）暂保持中文。
   */
  language: 'zh' | 'en';
  /**
   * fallback 模型回退链（第七节 P0，对标 Claude Code fallbackModel）：主模型请求
   * 失败（429 限流 / 超时 / 5xx 网关错误——非 401 鉴权、非 abort）时**按序自动切换**
   * 备用端点重试本轮（最多 3 级），提示「已回退到 X」。条目为 models 表里的模型名
   * （缺省字段回退顶层 baseURL/apiKey）；空数组 = 不启用。
   */
  fallbackModels?: string[];
  /**
   * 自动 git commit（第五节 P2 git 集成深化，Aider 原子提交）：每轮对话结束后，
   * 若工作区有未提交改动则 `git add -A && git commit`（消息 = 该轮用户消息摘要）。
   * 仅在 git 仓库内生效；commit 失败静默（不打扰对话）。默认 false（显式开启）。
   */
  autoCommit?: boolean;
  /**
   * MCP 服务器（外部工具生态）：{ 名称: { command, args?, env? } } */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * 用户/项目级危险命令扩展正则列表（config `dangerousPatterns` 字段）。
   * 匹配的命令会在 safe 及以上档位触发审批；正则写在配置里，可用注释说明。
   * 示例：["(\s|^)docker\s+rm\s+-f\b", "(\s|^)az\s+logout\b"]
   */
  dangerousPatterns?: string[];
  /** OS 级沙箱档位：'off'（默认）| 'read-only' | 'workspace-write' | 'danger-full-access' */
  sandbox: SandboxMode;
  /**
   * workspace-write 沙箱的额外可写白名单（绝对路径；TODO 第九节 P2）。
   * 允许沙箱内命令写工作目录之外的指定路径（如 /tmp/omni-shared、家目录子集）；
   * 非绝对路径忽略。仅 workspace-write 档位生效（read-only 保持全禁写）。
   */
  sandboxWritePaths?: string[];
  /** 是否注入代码库结构感知地图（repo map，P1；默认 true） */
  repoMap?: boolean;
  /** repo map 符号上限（默认 200） */
  repoMapMaxSymbols?: number;
  /** WebFetch 工具域名允许列表（空 = 全部） */
  webFetchDomains?: string[];
  /**
   * Web / Electron 上次使用的工作目录（`omni web` 与桌面应用启动时自动应用，
   * 界面「设置 → 工作目录」切换时持久化到这里）。优先级：OMNI_WEB_WORKSPACE
   * 环境变量 > 该字段 > 启动 cwd（cwd 为 "/" 时回退 home——Dock/Finder 启动场景）。
   */
  webWorkspace?: string;
  /**
   * 已知工作区列表（界面切换过的工作区都会记进来，去重、上限 20）。
   * 设置面板据此渲染可一键切换的工作区清单，无需每次重新浏览/输入。
   */
  webWorkspaces?: string[];
  /**
   * Hooks 生命周期自动化（对标 Claude Code）：{ 事件: [{ matcher?, command, timeoutMs? }] }。
   * 事件：UserPromptSubmit（改写 prompt）/ PreToolUse（硬拦截/改写参数）/ PostToolUse（输出回传上下文）/ Stop（要求继续修）/ Notification（通知）。
   * JSON 协议：事件上下文经 stdin 喂入，stdout 返回 JSON 决策（decision/updatedPrompt/updatedInput/hookSpecificOutput）。
   * matcher 按工具名过滤（`*`=全部，`read_*` 前缀通配）；超时/失败降级放行不阻塞主流程。
   */
  hooks?: HooksConfig;
  /**
   * 配置 profile 档案（第十二节 P2）：{ 档案名: { 部分配置字段 } }。
   * `--profile <名>` 把档案字段覆盖合并到层叠配置之上（工作/个人/离线多套一键切换）。
   * 仅 loadConfig 内部消费——最终返回的 OmniConfig 会删除该字段。
   * @internal
   */
  profiles?: Record<string, unknown>;
  /** 生效的配置来源（按优先级排列，用于 banner 展示与调试） */
  sources: string[];
}

/** 来自 CLI 的覆盖项 */
export interface ConfigOverrides {
  /** --config <path> */
  configPath?: string;
  /** --model <name> */
  model?: string;
  /** --profile <名>：套用配置档案（config profiles 字段；工作/个人/离线多套快照一键切换） */
  profile?: string;
}

/**
 * 配置 profile 档案（第十二节 P2，对标 Codex profiles）：
 * cfg.profiles = { 档案名: { 部分配置字段 } }；--profile <名> 把该档案的字段
 * **覆盖合并**到已加载的层叠结果之上（在项目/自定义配置之后、环境变量之前——
 * 环境变量仍可临时覆盖 profile）。档案里可放 model/baseURL/apiKey/maxSteps/
 * permission/sandbox/fallbackModels/models 等任意合法字段。
 * 未知名 → 报错提示可用名单（不静默——拼错名字继续跑比失败更危险）。
 */
function applyProfile(cfg: OmniConfig, profile: string, sources: string[]): void {
  const chosen = cfg.profiles?.[profile];
  if (!chosen || typeof chosen !== 'object' || Array.isArray(chosen)) {
    const names = Object.keys(cfg.profiles ?? {});
    console.error(`⚠️ 配置档案「${profile}」不存在。可用：${names.length > 0 ? names.join('、') : '（配置中无 profiles 定义）'}`);
    return;
  }
  // 档案子对象复用 apply 的字段解析（同一套类型校验）；sources 记为 profile 来源
  const tmpSources: string[] = [];
  apply(cfg, chosen as Record<string, unknown>, `profile:${profile}`, tmpSources);
  addSource(sources, `profile:${profile}`);
}

// 轮次上限默认 50：典型任务（探索 ~3 + 修改 ~4 + 验证 ~2 + 修复迭代 ~4）在 15 次内
// 完成，20 对复杂任务偏紧；50 只作防死循环兜底，多数任务远用不满
const DEFAULTS = {
  model: 'gpt-4o-mini',
  maxSteps: 50,
  showThinking: true,
  permission: 'safe' as PermissionTier,
  auditLog: true,
  agentsFile: true,
  globalAgentsFile: true,
  autoMemory: true,
  summarizeAt: 40,
  summarizeWindow: 8,
  preloadFiles: true,
  skills: true,
  reasoningEffortOptions: ['low', 'medium', 'high'],
  preloadMaxFiles: 5,
  preloadMaxBytes: 30 * 1024,
  allowSubagents: true,
  maxSubagentSteps: 10,
  maxSubagentDepth: 5,
  statusline: ['rounds', 'llm', 'speed', 'cache', 'tokens'],
  language: 'zh' as 'zh' | 'en',
  sandbox: 'off' as SandboxMode,
};

function readJson(file: string): Record<string, unknown> | null {
  try {
    const data = parseJsonc(readFileSync(file, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
    return null;
  } catch (err) {
    console.error(`⚠️ 配置文件解析失败（${file}）：${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function addSource(sources: string[], s: string): void {
  if (!sources.includes(s)) sources.push(s);
}

function apply(cfg: OmniConfig, data: Record<string, unknown> | null, label: string, sources: string[]): void {
  if (!data) return;
  if (typeof data.model === 'string') cfg.model = data.model;
  if (typeof data.baseURL === 'string') cfg.baseURL = data.baseURL;
  if (typeof data.apiKey === 'string') cfg.apiKey = data.apiKey;
  if (typeof data.userAgent === 'string') cfg.userAgent = data.userAgent;
  if (typeof data.maxSteps === 'number' && Number.isFinite(data.maxSteps)) {
    cfg.maxSteps = Math.max(1, Math.floor(data.maxSteps));
  }
  if (typeof data.showThinking === 'boolean') cfg.showThinking = data.showThinking;
  if (['full', 'safe', 'ask', 'read'].includes(String(data.permission))) {
    cfg.permission = data.permission as PermissionTier;
  }
  if (typeof data.auditLog === 'boolean') cfg.auditLog = data.auditLog;
  if (typeof data.agentsFile === 'boolean') cfg.agentsFile = data.agentsFile;
  if (typeof data.globalAgentsFile === 'boolean') cfg.globalAgentsFile = data.globalAgentsFile;
  if (typeof data.autoMemory === 'boolean') cfg.autoMemory = data.autoMemory;
  if (typeof data.summarizeAt === 'number' && Number.isFinite(data.summarizeAt)) {
    cfg.summarizeAt = Math.max(0, Math.floor(data.summarizeAt));
  }
  if (typeof data.summarizeWindow === 'number' && Number.isFinite(data.summarizeWindow)) {
    cfg.summarizeWindow = Math.max(2, Math.floor(data.summarizeWindow));
  }
  if (typeof data.preloadFiles === 'boolean') cfg.preloadFiles = data.preloadFiles;
  if (typeof data.skills === 'boolean') cfg.skills = data.skills;
  if (typeof data.reasoningEffort === 'string' && data.reasoningEffort.trim()) {
    cfg.reasoningEffort = data.reasoningEffort.trim();
  }
  if (data.models && typeof data.models === 'object' && !Array.isArray(data.models)) {
    const models: Record<string, { baseURL?: string; apiKey?: string; userAgent?: string; reasoningEffortOptions?: string[]; reasoningEffort?: string }> = {};
    for (const [name, v] of Object.entries(data.models as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const e = v as Record<string, unknown>;
      models[name] = {
        ...(typeof e.baseURL === 'string' ? { baseURL: e.baseURL } : {}),
        ...(typeof e.apiKey === 'string' ? { apiKey: e.apiKey } : {}),
        ...(typeof e.userAgent === 'string' ? { userAgent: e.userAgent } : {}),
        // per-model variants：只收非空字符串数组/字符串；非法值丢弃（回退顶层）
        ...(Array.isArray(e.reasoningEffortOptions)
          ? {
              reasoningEffortOptions: (e.reasoningEffortOptions as unknown[]).filter(
                (x): x is string => typeof x === 'string' && !!x.trim()
              ),
            }
          : {}),
        ...(typeof e.reasoningEffort === 'string' && e.reasoningEffort.trim()
          ? { reasoningEffort: e.reasoningEffort.trim() }
          : {}),
      };
    }
    if (Object.keys(models).length > 0) cfg.models = models;
  }
  if (Array.isArray(data.reasoningEffortOptions)) {
    const arr = (data.reasoningEffortOptions as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim());
    if (arr.length > 0) cfg.reasoningEffortOptions = arr;
  }
  if (typeof data.preloadMaxFiles === 'number' && Number.isFinite(data.preloadMaxFiles)) {
    cfg.preloadMaxFiles = Math.max(0, Math.floor(data.preloadMaxFiles));
  }
  if (typeof data.preloadMaxBytes === 'number' && Number.isFinite(data.preloadMaxBytes)) {
    cfg.preloadMaxBytes = Math.max(1024, Math.floor(data.preloadMaxBytes));
  }
  if (typeof data.allowSubagents === 'boolean') cfg.allowSubagents = data.allowSubagents;
  if (typeof data.maxSubagentSteps === 'number' && Number.isFinite(data.maxSubagentSteps)) {
    cfg.maxSubagentSteps = Math.max(1, Math.floor(data.maxSubagentSteps));
  }
  if (typeof data.maxSubagentDepth === 'number' && Number.isFinite(data.maxSubagentDepth)) {
    cfg.maxSubagentDepth = Math.max(1, Math.min(10, Math.floor(data.maxSubagentDepth)));
  }
  if (typeof data.architect === 'string' && data.architect.trim()) cfg.architect = data.architect.trim();
  if (typeof data.editor === 'string' && data.editor.trim()) cfg.editor = data.editor.trim();
  if (typeof data.repoMap === 'boolean') cfg.repoMap = data.repoMap;
  if (typeof data.repoMapMaxSymbols === 'number' && Number.isFinite(data.repoMapMaxSymbols)) {
    cfg.repoMapMaxSymbols = Math.max(10, Math.min(2000, Math.floor(data.repoMapMaxSymbols)));
  }
  if (Array.isArray(data.webFetchDomains)) {
    const arr = (data.webFetchDomains as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim());
    if (arr.length > 0) cfg.webFetchDomains = arr;
  }
  // 危险命令扩展正则：只收合法字符串（非法正则会在 dangerousCommand 里兜底忽略）
  if (Array.isArray(data.dangerousPatterns)) {
    const arr = (data.dangerousPatterns as unknown[]).filter(
      (x): x is string => typeof x === 'string' && !!x.trim()
    );
    if (arr.length > 0) cfg.dangerousPatterns = arr;
  }
  // fallback 回退链：最多 3 级、去重、不与主模型同名（与主模型相同无意义）
  if (Array.isArray(data.fallbackModels)) {
    const arr = [...new Set((data.fallbackModels as unknown[]).filter(
      (x): x is string => typeof x === 'string' && !!x.trim()
    ).map((x) => x.trim()))].slice(0, 3);
    if (arr.length > 0 && !(arr.length === 1 && arr[0] === data.model)) cfg.fallbackModels = arr;
  }
  if (typeof data.autoCommit === 'boolean') cfg.autoCommit = data.autoCommit;
  // OS 级沙箱档位：非法值回退 off
  const sb = String(data.sandbox ?? '');
  if (['off', 'read-only', 'workspace-write', 'danger-full-access'].includes(sb)) {
    cfg.sandbox = sb as SandboxMode;
  }
  // workspace-write 白名单：只收绝对路径字符串
  if (Array.isArray(data.sandboxWritePaths)) {
    const arr = [...new Set((data.sandboxWritePaths as unknown[]).filter(
      (x): x is string => typeof x === 'string' && x.startsWith('/')
    ))];
    if (arr.length > 0) cfg.sandboxWritePaths = arr;
  }
  // 状态行段配置：只保留合法 id（非法/未知 id 丢弃，避免渲染层找不到段）；
  // 空数组 = 不显示状态行（用户全部取消勾选）；未配置保持默认全段
  if (Array.isArray(data.statusline)) {
    const arr = (data.statusline as unknown[])
      .filter((x): x is string => typeof x === 'string')
      .filter((x) => ['rounds', 'llm', 'speed', 'cache', 'tokens'].includes(x));
    cfg.statusline = arr;
  }
  // 界面语言：只认 zh/en，其余回退默认中文
  if (data.language === 'zh' || data.language === 'en') cfg.language = data.language;
  // Web/Electron 上次工作目录（界面切换时持久化；启动时自动应用）
  if (typeof data.webWorkspace === 'string' && data.webWorkspace.trim()) {
    cfg.webWorkspace = data.webWorkspace.trim();
  }
  // 已知工作区列表：只收非空字符串、去重、上限 20
  if (Array.isArray(data.webWorkspaces)) {
    const arr: string[] = [];
    for (const x of data.webWorkspaces as unknown[]) {
      if (typeof x === 'string' && x.trim() && !arr.includes(x.trim())) arr.push(x.trim());
    }
    if (arr.length > 0) cfg.webWorkspaces = arr.slice(0, 20);
  }
  if (data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks)) {
    // **分层叠加合并**（全局 → 项目 → 自定义）：同一事件各层的 hook 全部保留并按层顺序运行
    //（低层在前）——项目 hook 与全局 hook 共存，无需在单层重复声明。
    for (const [eventName, defs] of Object.entries(data.hooks as Record<string, unknown>)) {
      if (!HOOK_EVENTS.includes(eventName as (typeof HOOK_EVENTS)[number])) continue; // 未知事件丢弃
      if (!Array.isArray(defs)) continue;
      const list: HookDefinition[] = [];
      for (const d of defs) {
        if (!d || typeof d !== 'object') continue;
        const v = d as Record<string, unknown>;
        if (typeof v.command !== 'string' || !v.command.trim()) continue;
        list.push({
          command: v.command.trim(),
          matcher: typeof v.matcher === 'string' && v.matcher.trim() ? v.matcher.trim() : undefined,
          timeoutMs:
            typeof v.timeoutMs === 'number' && Number.isFinite(v.timeoutMs)
              ? Math.max(1000, Math.floor(v.timeoutMs))
              : undefined,
        });
      }
      if (list.length === 0) continue;
      // 追加到既有列表（低层已写入的保留在前），实现跨层叠加
      cfg.hooks = {
        ...cfg.hooks,
        [eventName]: [...(cfg.hooks?.[eventName as keyof HooksConfig] ?? []), ...list],
      };
    }
  }
  if (data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)) {
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, v] of Object.entries(data.mcpServers as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        const raw = v as Record<string, unknown>;
        if (typeof raw.command !== 'string' && typeof raw.url !== 'string') continue; // 至少一种传输
        const mode = raw.defaultToolsApprovalMode;
        const cfg: McpServerConfig = {
          command: typeof raw.command === 'string' ? raw.command : undefined,
          args: Array.isArray(raw.args) ? (raw.args as string[]) : undefined,
          env: raw.env && typeof raw.env === 'object' ? (raw.env as Record<string, string>) : undefined,
          url: typeof raw.url === 'string' ? raw.url : undefined,
          headers: raw.headers && typeof raw.headers === 'object'
            ? (raw.headers as Record<string, string>)
            : undefined,
          enabledTools: Array.isArray(raw.enabledTools)
            ? (raw.enabledTools as string[]).filter((s) => typeof s === 'string')
            : undefined,
          disabledTools: Array.isArray(raw.disabledTools)
            ? (raw.disabledTools as string[]).filter((s) => typeof s === 'string')
            : undefined,
          defaultToolsApprovalMode:
            mode === 'auto' || mode === 'prompt' || mode === 'writes' || mode === 'approve'
              ? mode
              : undefined,
        };
        servers[name] = cfg;
      }
    }
    if (Object.keys(servers).length > 0) cfg.mcpServers = servers;
  }
  // 配置 profile 档案定义：原样保留在 cfg 上（--profile 消费；不参与字段级校验——
  // 档案内容千差万别，只在被选中时经 applyProfile 二次解析）
  if (data.profiles && typeof data.profiles === 'object' && !Array.isArray(data.profiles)) {
    cfg.profiles = { ...(cfg.profiles ?? {}), ...(data.profiles as Record<string, unknown>) };
    // 不留在最终配置上暴露给运行时（仅 loadConfig 内部消费）——导出前由 loadConfig 删除
  }
  addSource(sources, label);
}

/** 加载并合并全部配置层，返回最终配置 */
export function loadConfig(overrides: ConfigOverrides = {}): OmniConfig {
  const cfg: OmniConfig = { ...DEFAULTS, sources: [] };
  const sources = cfg.sources;

  // 1) 全局配置：$XDG_CONFIG_HOME/omni/ 或 ~/.config/omni/
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const globalFile = findInDir(path.join(configHome, 'omni'));
  if (globalFile) apply(cfg, readJson(globalFile), globalFile, sources);

  // 2) 项目配置：cwd 向上找
  const projectFile = findProjectConfig(process.cwd());
  if (projectFile) apply(cfg, readJson(projectFile), projectFile, sources);

  // 3) 自定义配置：--config 优先于 OMNI_CONFIG
  const customFile = overrides.configPath || process.env.OMNI_CONFIG;
  if (customFile) {
    const p = path.resolve(customFile);
    if (existsSync(p)) {
      apply(cfg, readJson(p), p, sources);
    } else {
      console.error(`⚠️ 自定义配置文件不存在：${p}`);
    }
  }

  // 3.5) 配置 profile（--profile / OMNI_PROFILE）：档案字段覆盖层叠结果
  //（环境变量在其后仍可临时覆盖——profile 是持久预设，env 是临时指定）
  const profileName = overrides.profile || process.env.OMNI_PROFILE;
  if (profileName) applyProfile(cfg, profileName, sources);
  // profiles 定义只在加载期消费，不暴露给运行时（/status 等不需要看到）
  delete cfg.profiles;

  // 4) 环境变量
  if (process.env.OMNI_API_KEY) {
    cfg.apiKey = process.env.OMNI_API_KEY;
    addSource(sources, '环境变量 OMNI_API_KEY');
  }
  if (process.env.OMNI_BASE_URL) {
    cfg.baseURL = process.env.OMNI_BASE_URL;
    addSource(sources, '环境变量 OMNI_BASE_URL');
  }
  if (process.env.OMNI_MODEL) {
    cfg.model = process.env.OMNI_MODEL;
    addSource(sources, '环境变量 OMNI_MODEL');
  }
  if (process.env.OMNI_MAX_STEPS) {
    const n = Number(process.env.OMNI_MAX_STEPS);
    if (Number.isFinite(n) && n >= 1) cfg.maxSteps = Math.floor(n);
    addSource(sources, '环境变量 OMNI_MAX_STEPS');
  }
  if (process.env.OMNI_SHOW_THINKING) {
    cfg.showThinking = !['0', 'false', 'no', 'off'].includes(process.env.OMNI_SHOW_THINKING.toLowerCase());
    addSource(sources, '环境变量 OMNI_SHOW_THINKING');
  }
  if (process.env.OMNI_PERMISSION) {
    const p = process.env.OMNI_PERMISSION.toLowerCase();
    if (['full', 'safe', 'ask', 'read'].includes(p)) {
      cfg.permission = p as PermissionTier;
      addSource(sources, '环境变量 OMNI_PERMISSION');
    }
  }

  // 5) CLI 参数
  if (overrides.model) {
    cfg.model = overrides.model;
    addSource(sources, 'CLI --model');
  }

  // 兼容：未设置 OMNI_API_KEY 时读 OPENAI_API_KEY
  if (!cfg.apiKey && process.env.OPENAI_API_KEY) {
    cfg.apiKey = process.env.OPENAI_API_KEY;
    addSource(sources, '环境变量 OPENAI_API_KEY');
  }

  return cfg;
}
