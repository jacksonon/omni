/**
 * 共享主流程：参数解析、配置加载、客户端构建、单次任务 / 交互模式调度。
 *
 * 输出端通过 makeOutput(cfg) 工厂注入：
 * - index.ts（console 入口）→ ConsoleOutput
 * - tui-entry.tsx（TUI 入口）→ TuiOutput
 *
 * 用法：
 *   omni "<任务描述>"              单次执行一个任务
 *   omni -m deepseek-chat "任务"   指定模型
 *   omni                          进入交互模式（/exit 退出，/help 查看帮助）
 */
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { createClient, type ModelEndpoint } from './client.js';
import {
  collectImageAttachments,
  loadImageAttachment,
  MAX_IMAGE_FILES,
  prepareContext,
  userMessageWithImages,
  type ImageAttachment,
} from './agent/context.js';
import { doctorReport, lastAssistantText } from './agent/report.js';
import { resolveCdArg } from './agent/workspace.js';
import { createSkillTool } from './agent/skill.js';
import { memorySearchTool, memoryReadTool } from './tools/memory-tools.js';
import { createTodoWriteTool } from './tools/todo.js';
import { createWebFetchTool } from './tools/web-fetch.js';
import { createWebSearchTool } from './tools/web-search.js';
import { createDiagnoseTool } from './tools/diagnose.js';
import { runAgent } from './agent/loop.js';
import { createSession, deleteSessionFile, findSessionById, formatSessionInfo, latestSession, listSessions, loadSession, persistableMessages, resolveSessionTarget, sessionIdFromPath, updateSessionMeta } from './agent/session.js';
import { EventRecorder } from './agent/events.js';
import type { RunOptions } from './agent/types.js';
import { runInteractive } from './cli/interactive.js';
import { runMiniInteractive, runMiniOneShot, splitMiniOneShotFlags } from './cli/mini.js';
import { parseArgs, parseResumeArgs, printHelp } from './cli/args.js';
import { loadConfig, type ConfigOverrides, type OmniConfig, type ModelEntryConfig } from './config/index.js';
import { autoFillLimit, resolveContextLimit, resolveReasoningEffortOptions } from './config/model-context.js';
import { HookRunner, type HooksConfig } from './hooks/index.js';
import { setEnabledPlugins, pluginHooks, pluginMcpServers } from './agent/plugins.js';
import { TeamBoard } from './agent/team.js';
import { createTaskBoardTool, createSendMessageTool } from './tools/team-tools.js';
import { formatToolCall, approvalDiffText } from './output/format.js';
import { MiniOutput } from './output/mini.js';
import type { Output } from './output/types.js';
import type { PermissionTier } from './safety/policy.js';
import { SubagentSemaphore } from './agent/semaphore.js';
import { Safety, type ApprovalRequest } from './safety/index.js';
import { createAutoReviewer } from './safety/auto-review.js';
import { isTrustedWorkspace, addTrustedWorkspace } from './safety/trust.js';
import { wrapSandboxCommand, touchesSandboxPolicy, type SandboxMode, type SandboxOptions } from './safety/sandbox.js';
import type { Tool } from './tools/types.js';
import { handleExecHelp, readStdinIfPiped, runExec, runMcpServer } from './exec.js';
import { forkSession } from './agent/session-fork.js';
import { runWeb } from './web/index.js';
import { createAskUserTool } from './tools/ask.js';
import { createDelegateTool } from './tools/delegate.js';
import { discoverSubagents } from './agent/subagent-defs.js';
import { tools } from './tools/index.js';
import { closeMcpClients, discoverMcpServers, buildMcpTools, mcpInstructionsMessage, createMcpHandlers } from './tools/mcp.js';
import { UndoStack, withUndoSnapshot } from './tools/undo.js';
import { countDiffLines } from './output/format.js';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dim, green, red, setTerminalTitle, yellow } from './ui.js';
import { VERSION } from './version.js';
import type { AllowlistProxy } from './safety/netproxy.js';

/** 网络白名单代理实例（attachRuntime 启动；进程退出时关闭） */
let proxy: AllowlistProxy | null = null;
process.on('exit', () => {
  proxy?.close().catch(() => {});
});

/** 读文件当前内容（write_file diff 审批统计用）；不存在/读失败返回 null */
function readIfExists(p: string): string | null {
  try {
    const abs = path.resolve(process.cwd(), p);
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

// 抑制第三方依赖（openai SDK 等）触发的 Node 过时 API 警告，保持终端干净
process.removeAllListeners('warning');

/** Agent 运行所需的共享上下文（配置 + 客户端 + 消息 + 运行选项） */
export interface RunContext {
  cfg: OmniConfig;
  client: OpenAI;
  messages: ChatCompletionMessageParam[];
  runOpts: RunOptions;
}

/**
 * 把 run_command 工具包进 OS 级沙箱（read-only / workspace-write）：
 * 执行前把命令经 wrapSandboxCommand 包装（sandbox-exec / bwrap），结果附带沙箱提示。
 * 1.0 P0-4 沙箱 2.0 增强：
 * · fail-closed——平台无沙箱原语且 config sandboxFailClosed=true 时**拒绝执行**；
 * · 策略面保护——沙箱内命令试图改 omni 配置/hooks/审计/信任清单 → 拒绝（防自我提权）；
 * · 网络白名单代理与凭证 masking 由 opts 传入（attachRuntime 启动代理后注入端口）。
 * 非 run_command / off / danger-full-access → 原样返回。
 */
function wrapRunCommandWithSandbox(tool: Tool, mode: SandboxMode, sandboxOpts: SandboxOptions & { failClosed?: boolean }): Tool {
  if (tool.name !== 'run_command' || mode === 'off' || mode === 'danger-full-access') return tool;
  const original = tool.execute;
  return {
    ...tool,
    execute: async (args) => {
      const command = String(args.command ?? '');
      // 策略面保护：沙箱内不允许修改 omni 自身的配置/审计/信任清单
      const policyHit = touchesSandboxPolicy(command);
      if (policyHit) {
        return `已拒绝（沙箱保护）：该命令试图访问 omni 策略文件（匹配 ${policyHit}）。` +
          `如确需操作，请在关闭沙箱（config sandbox=off）或经审批后手动执行。`;
      }
      const wrapped = wrapSandboxCommand(mode, process.cwd(), command, sandboxOpts);
      if (!wrapped.protected && sandboxOpts.failClosed) {
        return `已拒绝（fail-closed）：当前平台没有可用的沙箱实现（sandbox-exec / bwrap / firejail），` +
          `且配置了 sandboxFailClosed=true——宁可不执行也不裸奔。` +
          `安装 bwrap/firejail，或将 sandboxFailClosed 设为 false 以降级放行。`;
      }
      let result = await original({ ...args, command: wrapped.command });
      if (wrapped.note) {
        const warn = wrapped.protected ? wrapped.note : `⚠️ ${wrapped.note}`;
        result = `${result}\n\n${warn}`;
      }
      return result;
    },
  };
}

/**
 * 解析配置并构建客户端（console 入口与 TUI 入口共用，避免重复逻辑）。
 *
 * 抛错而非 process.exit：让入口层决定如何清理（TUI 需先退出全屏再报错）。
 *
 * opts.allowMissingKey（web/Electron 专用）：没有 API Key 时用占位 Key 构建
 * 客户端而不是抛错——桌面应用首次安装没有任何配置，若启动即崩，用户永远到不了
 * 设置面板填 Key（死循环）。占位客户端只在真正发请求时才报 401，届时设置里
 * 填入真实 Key 后 /api/settings 会按新 Key 重建客户端。
 */
export function prepareRun(
  overrides: ConfigOverrides,
  opts: { allowMissingKey?: boolean } = {}
): RunContext {
  const cfg = loadConfig(overrides);
  // 默认模型（cfg.model）的端点配置：从 providers 展开后的内部 models 表解析（每模型
  // 独立密钥/端点/UA 是合法用法——用户把密钥放在 providers 分组里而不写顶层 apiKey 时，
  // 不应报「未找到 API Key」闪退，从默认模型的端点配置解析即可）
  const defModel = cfg.models?.[cfg.model];
  let apiKey = defModel?.apiKey ?? cfg.apiKey;
  if (!apiKey && opts.allowMissingKey) {
    apiKey = 'missing-api-key'; // 占位：OpenAI SDK 构造时要求非空；发请求时才会 401
  }
  if (!apiKey) {
    // 诊断信息：配置分层（全局 → 项目 → 自定义 → 环境变量）合并后，很容易出现
    // 「项目配置改了 model，但该模型没挂在任何 providers 分组下」——只报「未找到 API Key」
    // 用户无从下手（实测踩过：项目 omni.json 写 model: hy3，而 hy3 只在 modelCatalog 里）。
    // 这里把「哪些模型已挂载」和「配置来源（优先级递增）」一并列出。
    const groups = Object.entries(cfg.providers ?? {})
      .map(([name, g]) => ({ name, models: Object.keys(g.models ?? {}) }))
      .filter((g) => g.models.length > 0);
    const catalog = groups.map(
      (g) => `  · ${g.name}: ${g.models.slice(0, 8).join(', ')}${g.models.length > 8 ? ` …（共 ${g.models.length} 个）` : ''}`
    );
    const mounted = groups.some((g) => g.models.includes(cfg.model));
    throw new Error(
      `未找到 API Key。设置方式：
  · 配置文件 omni.json / omni.jsonc 的 providers 分组（providers."<组>".apiKey，模型 ${cfg.model} 须在该分组 models 中）
  · 环境变量 OMNI_API_KEY（或 OPENAI_API_KEY）
${
  mounted
    ? ''
    : `模型 ${cfg.model} 未挂在任何 providers 分组的 models 下——只有分组的 models 提供端点/密钥，modelCatalog（/model fetch 的目录快照）不算。\n`
}${catalog.length > 0 ? `providers 已挂载的模型：\n${catalog.join('\n')}\n` : ''}生效配置来源（越靠后优先级越高）：${cfg.sources.length ? cfg.sources.join(' → ') : '默认值'}
临时换个可用模型：-m <模型名>；会话内可用 /model 切换
更多帮助见 omni --help`
    );
  }

  // timeout/maxRetries：端点不可达时快速失败（SDK 默认单请求超时 10 分钟 + 多次重试，会长时间无反馈）
  // defaultHeaders：部分网关 WAF 拦截 SDK 默认 UA，配置 userAgent 可绕过
  const client = createClient(
    {
      name: cfg.model,
      baseURL: defModel?.baseURL ?? cfg.baseURL,
      apiKey,
      userAgent: defModel?.userAgent ?? cfg.userAgent,
    },
    apiKey
  );
  const messages: ChatCompletionMessageParam[] = [];
  const runOpts: RunOptions = { tools, stream: true, maxSteps: cfg.maxSteps, showThinking: cfg.showThinking };
  return { cfg, client, messages, runOpts };
}

/**
 * 解析工作区信任（第九节）：已信任 → true；
 * 未信任且有审批 UI（TUI 卡片 / console readline）→ 询问用户——批准 = 加入信任清单并返回 true，
 * 拒绝 = 返回 false（attachRuntime 降级为只读）；无审批 UI（管道/非交互）→ false（fail-safe 只读）。
 */
export async function resolveWorkspaceTrust(cwd: string, output: Output): Promise<boolean> {
  if (isTrustedWorkspace(cwd)) return true;
  if (!output.requestApproval) return false;
  try {
    const ok = await output.requestApproval({
      tool: 'workspace-trust',
      summary: cwd,
      reason:
        '首次进入未信任目录：信任后允许写入，并加载项目记忆（AGENTS.md）/技能/子代理定义/MCP 服务器与 hooks；' +
        '不信任则以只读模式运行（拒绝所有写操作，且 hooks/MCP 服务器/技能/子代理定义/项目记忆都不加载；' +
        '/permission 锁定为只读）',
    });
    if (ok) addTrustedWorkspace(cwd);
    return ok;
  } catch {
    return false; // 审批流程异常 → fail-safe 只读
  }
}

/**
 * 组装运行时（console 与 TUI 入口共用）：安全护栏 + 动态工具链 + 上下文管理选项。
 *
 * · 安全护栏：权限分级 + 审计 + 审批回调（由 Output 层实现 UI——console readline /
 *   TUI 审批卡片；管道模式回调返回 false = 自动拒绝，fail-safe）
 * · 动态工具链：静态 5 工具 + delegate 子代理工具（可关）+ MCP 外部工具（配置了才连）
 * · 上下文管理：相关文件预载 + 长对话摘要压缩（按配置注入 runOpts.context）
 * · 工作区信任（第九节）：opts.trust=false（未信任目录）→ 强制 read 档位 +
 *   跳过 hooks/MCP 服务器/技能/子代理定义/项目记忆——它们都能执行命令或注入内容，
 *   是"仓库注入恶意配置"的载体（防注入，信任目录后全部恢复）；
 * · OS 级沙箱：cfg.sandbox 非 off 时包装 run_command（sandbox-exec / bwrap）。
 */
export async function attachRuntime(
  ctx: RunContext,
  output: Output,
  opts: { trust?: boolean } = {}
): Promise<void> {
  const { cfg, client } = ctx;
  const trusted = opts.trust !== false; // 缺省信任（兼容既有调用）
  // 未信任目录 → 强制只读档位（fail-safe）；注意不改 cfg（/status 读的是运行时 runOpts.permission）
  const effectiveTier: PermissionTier = trusted ? cfg.permission : 'read';
  // 审批回调缺省 = 拒绝（fail-safe）；Output 实现了 requestApproval 则用它。
  // 注意 bind(output)：实现里用了 this（ConsoleOutput 串行队列 / TuiOutput 审批队列），
  // 未绑定直接传递会在 Safety 侧以普通函数调用 → this 错位 → 静默抛错被 fail-safe 吞掉（审批永不弹出）
  const requestApproval: (req: ApprovalRequest) => Promise<boolean> | boolean = output.requestApproval
    ? output.requestApproval.bind(output)
    : () => false;
  // ask_user 提问回调（Output 层实现 UI——console readline / TUI 选项面板）；
  // 未实现/非交互 → undefined（工具返回「无法询问」，模型自行决定）
  const askUser = output.askUser ? output.askUser.bind(output) : undefined;
  // 插件系统（2026-09 PLG）：启用清单来自配置；未信任目录整体忽略插件
  //（插件 hooks/MCP 会执行命令——信任边界与全局 hooks 一致处理）
  setEnabledPlugins(trusted ? cfg.plugins : []);
  // Hooks 生命周期自动化（对标 Claude Code）：配置了 hooks 才创建（未配置 = no-op）。
  // **未信任目录跳过 hooks**（项目 omni.json 可注入 PreToolUse hook 执行任意 shell——
  // 这是仓库注入恶意配置的主要载体；全局 hooks 也被跳过，提示用户先信任目录）。
  // hook 输出经 Output.onHookOutput 回显（TUI 对话流 / console dim 行）；超时/失败降级放行
  if (trusted) {
    // 插件 hooks 先合并（用户配置在同 matcher 上优先——后层覆盖）
    const mergedHooks: HooksConfig = { ...pluginHooks() };
    for (const [event, defs] of Object.entries(cfg.hooks ?? {})) {
      if (!Array.isArray(defs)) continue;
      const key = event as keyof HooksConfig;
      mergedHooks[key] = [...(mergedHooks[key] ?? []), ...defs] as never;
    }
    ctx.runOpts.hooks = new HookRunner({
      hooks: mergedHooks,
      cwd: process.cwd(),
      onOutput: (event, lines) => output.onHookOutput?.(event, lines),
    });
  }
  // AI 自动审批（2026-09 补课）：config autoReview 或 exec --approve-for-me（cfg 已在 runExec 覆盖）。
  // 审阅器共享给主循环（loop 自建 Safety）与子代理（delegate 的共用闸门）。
  // 审阅器始终创建（构造极轻），运行时开关由 cfg.autoReview 实时判断——/auto on|off 即时生效。
  const autoReviewer = createAutoReviewer({
    client,
    model: cfg.model,
    describeContext: () => ({ cwd: process.cwd(), tier: effectiveTier, sandbox: cfg.sandbox }),
    onVerdict: (req, verdict) => output.onAutoReview?.(req, verdict),
  });
  const autoReviewGate = (req: ApprovalRequest) => (cfg.autoReview ? autoReviewer(req) : Promise.resolve(null));
  ctx.runOpts.autoReview = autoReviewGate;
  const gate = new Safety({
    tier: effectiveTier,
    audit: cfg.auditLog,
    requestApproval,
    summarize: formatToolCall,
    dangerousPatterns: cfg.dangerousPatterns,
    hooks: ctx.runOpts.hooks, // PermissionRequest hook（1.0 P1-1）
    // AI 自动审批（2026-09 补课）：模型审阅放行/拒绝，失败回退人工审批
    ...(autoReviewGate ? { autoReview: autoReviewGate } : {}),
    // write_file diff 确认审批（P2）：需要审批的写操作把变更统计附进审批卡片
    //（数据源 = UndoStack 执行前快照——与 write_file 卡片 diff 同源；快照在工具执行前
    // 打，这里 gate 先于 execute 读「最近一次同路径快照」即为当前盘上内容）
    writeDiffSummary: (tool, args) => {
      if (tool !== 'write_file') return null;
      const snap = undoStack.latestFor(String(args.path ?? ''));
      const content = String(args.content ?? '');
      // 无快照（本会话首写该文件）→ 直接读盘上现状做统计
      const original = snap ? (snap.existed ? snap.content : null) : readIfExists(String(args.path ?? ''));
      try {
        return approvalDiffText(original, content);
      } catch {
        return null;
      }
    },
  });
  ctx.runOpts.permission = effectiveTier;
  ctx.runOpts.trusted = trusted;
  ctx.runOpts.sandbox = cfg.sandbox;
  // 可用模型列表（顶层 model + config models/providers 展开；/model 切换用）
  // 默认模型端点同样优先取 models.<model>（与 prepareRun 的解析一致）
  // 顶层 model 已在列表首位；models 表里同名的条目跳过，避免 /model 面板重复列出
  // （常见于先 /model add <名> 再 /model <名> 切换——顶层与 models 表各留一份）。
  // disabled 条目不出现在列表（1.0 模型元数据）；元数据字段原样携带供 loop 消费。
  const defModel = cfg.models?.[cfg.model];
  // 数据源自动档（1.0 P1）：用户未显式配置的思考级别选项与上下文窗口从 models.dev
  // 快照查表补缺（显式配置永远优先，绝不覆盖）——见 src/config/model-context.ts
  const autoNames = (name: string, e: ModelEntryConfig | undefined): (string | undefined)[] => [name, e?.apiModel];
  const expandEndpoint = (name: string, e: ModelEntryConfig | undefined): ModelEndpoint => ({
    name,
    provider: e?.provider,
    baseURL: e?.baseURL ?? cfg.baseURL,
    apiKey: e?.apiKey ?? cfg.apiKey,
    userAgent: e?.userAgent ?? cfg.userAgent,
    headers: e?.headers,
    reasoningEffortOptions: resolveReasoningEffortOptions(
      // 显式配置优先：per-model > 顶层（非空才算显式——cfg 默认 [] 是「未配置」语义，
      // 直接透传会被当成「明确关闭」跳过查表，models.dev 自动档整体失效）
      e?.reasoningEffortOptions ?? (cfg.reasoningEffortOptions.length > 0 ? cfg.reasoningEffortOptions : undefined),
      ...autoNames(name, e)
    ),
    reasoningEffort: e?.reasoningEffort ?? cfg.reasoningEffort,
    variant: e?.variant,
    variants: e?.variants,
    apiModel: e?.apiModel,
    displayName: e?.displayName,
    limit: autoFillLimit(e?.limit, ...autoNames(name, e)),
    modalities: e?.modalities,
    capabilities: e?.capabilities,
    disabled: e?.disabled,
  });
  const providerForModel = (name: string, entry: ModelEntryConfig | undefined): string | undefined =>
    entry?.provider ?? Object.entries(cfg.providers ?? {}).find(([, provider]) => provider.models?.[name])?.[0];
  const modelEndpoints: ModelEndpoint[] = [
    { ...expandEndpoint(cfg.model, defModel), provider: providerForModel(cfg.model, defModel) },
    ...Object.entries(cfg.models ?? {})
      .filter(([name]) => name !== cfg.model)
      .filter(([, e]) => !e.disabled)
      .map(([name, e]) => ({ ...expandEndpoint(name, e), provider: providerForModel(name, e) })),
  ];
  ctx.runOpts.models = modelEndpoints;
  ctx.runOpts.fallbackApiKey = cfg.apiKey;
  // 兼容性字段（P2）：自定义网关 reasoning 字段名（loop 组装请求时传给 extractReasoning）
  if (cfg.compatibility) ctx.runOpts.compatibility = cfg.compatibility;
  // 当前选中命名 variant（per-model 配置 variant 字段）：/variants <id> 切换的初始值
  if (defModel?.variant) ctx.runOpts.activeVariant = defModel.variant;
  // fallback 回退链（第七节 P0）：config fallbackModels 按名展开为完整端点
  //（缺省字段回退顶层；不在 models 表的名字忽略——没有端点信息无法回退）
  if (cfg.fallbackModels?.length) {
    const fallbackEndpoints = cfg.fallbackModels
      .map((name) => modelEndpoints.find((m) => m.name === name))
      .filter((e): e is ModelEndpoint => !!e);
    if (fallbackEndpoints.length > 0) ctx.runOpts.fallbackEndpoints = fallbackEndpoints;
  }
  // 完整配置（/status /context /doctor /config 等命令读取；interactive 透传给 ctx）
  ctx.runOpts.cfg = cfg;
  // 当前模型运行时引用：/model 切换时重建 client 并更新 → 主循环与子代理（delegate）共用
  ctx.runOpts.modelRuntime = { client, model: cfg.model };
  ctx.runOpts.auditLog = cfg.auditLog;
  ctx.runOpts.requestApproval = requestApproval;
  // 共用闸门（delegate 子代理用它）：/permission 切换时 setTier 同步，子代理与主循环权限一致
  ctx.runOpts.safetyGate = gate;
  // 上下文管理选项（interactive/single-task 每轮输入后调 prepareContext 用）。
  // 未信任目录：跳过项目记忆（agentsFile）与技能清单（skills）——仓库可注入 AGENTS.md
  // / SKILL.md 恶意指令；全局记忆（globalAgentsFile）保留（用户自己的偏好，可信）。
  ctx.runOpts.context = {
    agentsFile: trusted ? cfg.agentsFile : false,
    globalAgentsFile: cfg.globalAgentsFile,
    autoMemory: cfg.autoMemory,
    summarizeAt: cfg.summarizeAt,
    summarizeWindow: cfg.summarizeWindow,
    preloadFiles: cfg.preloadFiles,
    preloadMaxFiles: cfg.preloadMaxFiles,
    preloadMaxBytes: cfg.preloadMaxBytes,
    skills: trusted ? cfg.skills : false,
    hooks: ctx.runOpts.hooks, // PreCompact：长对话压缩前 fire-and-forget
    repoMap: cfg.repoMap !== false,
    repoMapMaxSymbols: cfg.repoMapMaxSymbols,
    // 压缩 2.0（1.0 P1-4）：按模型上下文窗口占比提前触发（消息数阈值仍生效）。
    // 窗口 = 手动覆盖（/context <档位>）> 模型端点 limit.context（数据源自动化）
    contextLimit: resolveContextLimit(cfg.contextLimit, modelEndpoints.find((m) => m.name === cfg.model)?.limit?.context),
    compressRatio: cfg.contextCompressRatio,
  };
  // 动态工具链：静态工具 + 子代理 delegate（可关）+ ask_user（向用户提问，消除歧义）+
  // MCP 外部工具（失败只警告不阻塞）
  // /undo 撤销：先把静态工具表包装（write_file 执行前快照原内容进 UndoStack），
  // 再创建 delegate——子代理共用同一份包装后的工具表，其写入同样被记录
  const undoStack = new UndoStack();
  let tracked = tools.map((t) => withUndoSnapshot(t, undoStack));
  // OS 级沙箱（1.0 P0-4 沙箱 2.0）：cfg.sandbox 非 off 时包装 run_command。
  // 网络白名单：配置了 sandboxNetworkAllow 时启动内置过滤代理（CONNECT 按 hostname
  // 白名单放行，不解密 TLS），Seatbelt 把「允许网络」收紧为「仅连代理端口」；
  // 凭证 masking：默认开启——环境变量名命中 *_KEY/*_TOKEN/*_SECRET/*_PASSWORD 的
  // 值在沙箱命令里替换为 sentinel（防凭据被 echo 进上下文）。
  if (cfg.sandbox && cfg.sandbox !== 'off' && cfg.sandbox !== 'danger-full-access') {
    let proxyPort: number | undefined;
    if (cfg.sandboxNetworkAllow?.length) {
      try {
        const { startAllowlistProxy } = await import('./safety/netproxy.js');
        proxy = await startAllowlistProxy(cfg.sandboxNetworkAllow);
        proxyPort = proxy.port;
      } catch (err) {
        console.error(`⚠️ 网络白名单代理启动失败（${err instanceof Error ? err.message : err}）——本次运行保持全禁网。`);
      }
    }
    // masking 名单：显式 sandboxMaskEnv=false 关闭；默认自动收集当前环境里的敏感命名
    const autoMask =
      cfg.sandboxMaskEnv !== false &&
      Object.keys(process.env)
        .filter((k) => /(KEY|TOKEN|SECRET|PASSWORD|PASSWD)$/i.test(k))
        .slice(0, 64);
    tracked = tracked.map((t) =>
      wrapRunCommandWithSandbox(t, cfg.sandbox, {
        writePaths: cfg.sandboxWritePaths,
        networkAllow: proxyPort ? cfg.sandboxNetworkAllow : undefined,
        proxyPort,
        maskEnvVars: autoMask === false ? undefined : autoMask,
        failClosed: cfg.sandboxFailClosed === true,
      })
    );
  }
  // skills=false（含未信任目录）时从工具链移除 skill 工具（模型不可见/不可调用）
  if (cfg.skills === false || !trusted) tracked = tracked.filter((t) => t.name !== 'skill');
  // 记忆渐进披露工具（memory_search / memory_read）：trusted 时注入（防未信任仓库污染记忆）
  if (trusted) {
    tracked.push(memorySearchTool, memoryReadTool);
  }
  // 技能启用：用带运行时上下文的 skill 工具替换静态版（支持 frontmatter 扩展：
  // context:fork → 子代理执行 / agent / background；delegate 运行时在 tools 里找）
  if (cfg.skills !== false && trusted) {
    tracked = tracked.map((t) => (t.name === 'skill' ? createSkillTool(ctx.runOpts) : t));
  }
  const toolchain = [...tracked];
  if (cfg.allowSubagents && trusted) {
    // delegate：子代理委托工具——嵌套/agent 参数/模型路由/进度事件（第六节 P1）。
    // runOpts 传引用：/plan、/model、/settings 等运行时切换即时生效；
    // onEvent 把子代理生命周期分发给 Output（TUI 卡片 live 状态 / console dim 行）
    toolchain.push(
      createDelegateTool({
        modelRuntime: ctx.runOpts.modelRuntime!,
        tools: tracked,
        gate,
        maxSteps: cfg.maxSubagentSteps,
        hooks: ctx.runOpts.hooks,
        runOpts: ctx.runOpts, // planMode/architectModel/editorModel/maxSubagentDepth/subagents/events
        subagents: ctx.runOpts.subagents,
        depth: 0,
        maxDepth: cfg.maxSubagentDepth,
        onEvent: (ev) => output.onSubagentEvent?.(ev),
        auditLog: cfg.auditLog,
        requestApproval,
        summarize: formatToolCall,
      })
    );
  }
  // ask_user：运行时注入提问回调（非交互输出（管道/单任务无 UI）时仍注册——工具
  // 返回「无法询问」让模型自行决定，不打断任务）
  toolchain.push(createAskUserTool(askUser));
  // TodoWrite 任务清单工具（P1）：模型管理结构化 todo 列表
  toolchain.push(createTodoWriteTool(ctx.runOpts));
  // WebFetch 内置工具（P1）：URL 抓取 → 转纯文本
  toolchain.push(createWebFetchTool(cfg.webFetchDomains));
  // WebSearch 内置工具（P1）：关键词 → 搜索结果（title/url/snippet）
  toolchain.push(createWebSearchTool(cfg.webSearchApiKey));
  // diagnose 诊断工具（P1）：运行 typecheck/lint 返回诊断摘要
  toolchain.push(createDiagnoseTool(process.cwd()));
  // Team 协作（2026-09 DYN）：共享任务看板 + SendMessage（主代理/子代理共用）
  ctx.runOpts.team = new TeamBoard();
  toolchain.push(createTaskBoardTool(ctx.runOpts));
  toolchain.push(createSendMessageTool(ctx.runOpts));
  // 思考级别（/variants）与子代理配置（/agents 展示）：透传给交互命令。
  // 初始值取**默认模型端点**（首位 = cfg.model 展开）：per-model reasoningEffort 与
  // 端点展开时已查表推导的档位选项随模型带出——cfg.reasoningEffortOptions 默认 []
  //（未配置语义），直接透传会让 TUI/CLI/Web 的 /variants 首屏显示「无可切换」
  // 而不是当前模型按数据源推导的正确档位
  const defaultEndpoint = modelEndpoints[0];
  if (defaultEndpoint?.reasoningEffort) ctx.runOpts.reasoningEffort = defaultEndpoint.reasoningEffort;
  ctx.runOpts.reasoningEffortOptions = defaultEndpoint?.reasoningEffortOptions ?? cfg.reasoningEffortOptions;
  ctx.runOpts.maxSubagentSteps = cfg.maxSubagentSteps;
  // 第六节「子代理与编排」配置：architect/editor 模型路由（/plan 用 architect、执行用
  // editor，缺省 = 当前模型）+ 嵌套深度上限 + 已发现子代理定义（delegate 的 agent 参数）
  if (cfg.architect) ctx.runOpts.architectModel = cfg.architect;
  if (cfg.editor) ctx.runOpts.editorModel = cfg.editor;
  ctx.runOpts.maxSubagentDepth = cfg.maxSubagentDepth;
  // 2026-09 FLT/DYN：子代理并发预算（前后台共享信号量）+ 后台结果队列/回调
  ctx.runOpts.subagentSemaphore = new SubagentSemaphore(
    Math.max(1, Math.min(16, cfg.maxConcurrentSubagents ?? 4))
  );
  ctx.runOpts.backgroundResults = ctx.runOpts.backgroundResults ?? [];
  ctx.runOpts.onBackgroundResult = (r) => output.onBackgroundSubagentDone?.(r);
  // 未信任目录：跳过项目级子代理定义（.agents/subagents/*.md 可能被仓库植入
  // 恶意模型/权限配置）；delegate 工具本身也不注册（子代理是项目级概念）。
  ctx.runOpts.subagents = trusted ? await discoverSubagents() : [];
  // 基础工具链（静态 + delegate，不含 MCP）：/mcp 重连时以此为基底重建 tools
  ctx.runOpts.baseTools = toolchain;
  // MCP 服务器：插件声明 + 用户配置（同名用户配置优先），2026-09 PLG
  // **未信任目录整体跳过**（与 hooks 同口径）：stdio server 会在启动时拉起配置里的任意
  // 命令、HTTP server 可外联，且 MCP 工具的默认审批模式是 auto——同属"仓库注入恶意配置"
  // 的载体（项目 omni.json 一条 mcpServers 即可，无需任何审批）。配置层无法区分某个
  // server 来自全局还是项目，故一并跳过，信任目录后恢复（/mcp 会提示原因）。
  const mergedMcpServers = trusted ? { ...pluginMcpServers(), ...(cfg.mcpServers ?? {}) } : {};
  ctx.runOpts.mcpServers = mergedMcpServers;
  // 发现 MCP 服务器（完整句柄：工具 + 资源 + 提示词 + instructions）；
  // 反向请求处理器（elicitation→askUser；sampling→当前模型）声明 2026-07-28 能力
  const mcpHandlers = createMcpHandlers({ client, model: cfg.model, askUser });
  const mcpHandles = trusted ? await discoverMcpServers(mergedMcpServers, mcpHandlers) : [];
  // 组装 MCP 工具链（server 工具 + Resources/Prompts 辅助工具）
  const mcpTools = buildMcpTools(mcpHandles);
  toolchain.push(...mcpTools);
  ctx.runOpts.tools = toolchain;
  ctx.runOpts.mcpHandles = mcpHandles; // 供 /mcp 命令列出 resources/prompts
  ctx.runOpts.undoStack = undoStack;
  // MCP server instructions 注入系统提示（首轮；多条时按 server 名顺序叠放）
  const instrContent = mcpInstructionsMessage(mcpHandles);
  if (instrContent) {
    // 用前缀标记做去重：attachRuntime 只调用一次，但 /mcp reconnect 会替换旧消息
    const instrPrefix = '[MCP server instructions';
    const existingIdx = ctx.messages.findIndex(
      (m) => typeof m.content === 'string' && m.content.startsWith(instrPrefix)
    );
    const instrMsg = { role: 'system' as const, content: `${instrPrefix}]\n${instrContent}` };
    if (existingIdx >= 0) {
      ctx.messages[existingIdx] = instrMsg;
    } else {
      ctx.messages.unshift(instrMsg);
    }
  }
}

/**
 * -l / --list-sessions：列出已保存的会话（无需 API Key，先于 prepareRun 处理）。
 * 默认仅当前目录；-f/--full/--all 查看全部（跨目录）。
 * 返回 true = 已处理（调用方应 return）。
 */
export async function printSessions(all = false): Promise<boolean> {
  const list = await listSessions(all ? undefined : process.cwd());
  if (list.length === 0) {
    if (all) {
      console.log(dim('暂无已保存的会话（交互模式退出时自动落盘，可用 --continue 恢复）。'));
    } else {
      console.log(dim('当前目录暂无已保存的会话（-l -f 查看全部；交互模式退出时自动落盘，可用 --continue 恢复）。'));
    }
  } else {
    if (all) {
      console.log('已保存的会话（全部目录；--continue 恢复最近一次，-r <id> 恢复指定）：');
    } else {
      console.log('已保存的会话（当前目录；-l -f 查看全部；--continue 恢复最近一次，-r <id> 恢复指定）：');
    }
    for (const s of list) console.log(formatSessionInfo(s));
  }
  return true;
}

/**
 * 会话恢复 + 交互模式创建（console 与 TUI 入口共用）：
 * · --continue → 恢复当前项目最近一次会话；-r <id> → 恢复指定会话（找不到 → 打印错误并返回 false = 终止）；
 * · 恢复成功 → 历史消息载入 messages，runOpts.sessionPath 指向原文件（继续追加）；
 * · 无恢复 → 交互模式自动创建新会话文件（单任务模式不落盘）。
 */
export async function prepareSessionPersistence(
  flags: { continueSession: boolean },
  resumeId: string | null,
  cfg: OmniConfig,
  messages: ChatCompletionMessageParam[],
  runOpts: RunOptions,
  singleTask: boolean
): Promise<boolean> {
  if (flags.continueSession || resumeId) {
    const file = resumeId
      ? await findSessionById(resumeId)
      : ((await latestSession(process.cwd()))?.path ?? null);
    if (!file) {
      if (resumeId) {
        console.error(red(`会话「${resumeId}」不存在（用 -l / --list-sessions 查看可用会话）。`));
        return false;
      }
      console.log(dim('未找到当前项目的历史会话，从新会话开始。'));
    } else {
      const loaded = await loadSession(file);
      if (loaded) {
        messages.push(...loaded.messages);
        runOpts.sessionPath = file; // 恢复后继续追加到同一会话文件
        console.log(dim(`已恢复会话 ${loaded.meta.id}（${loaded.messages.length} 条消息 · 模型 ${loaded.meta.model}）`));
      }
    }
  }
  // 交互模式：无恢复时创建新会话文件（单任务模式不落盘）
  if (!singleTask && !runOpts.sessionPath) {
    runOpts.sessionPath = (await createSession({ project: process.cwd(), model: cfg.model })) ?? undefined;
  }
  // 轨迹事件记录器（/compact 事件 + console/web /trace 账本源）：恢复/新建会话都挂在同一会话文件
  // （`{"t":"ev"}` 行与消息行共存，loadSession 天然跳过）；单任务模式无会话
  // 文件 → 仅内存记录（flush 为 no-op，供 eval 等复用）。
  runOpts.events = await EventRecorder.open(runOpts.sessionPath ?? null);
  return true;
}

/** 顶层 resume/fork 共用 picker（无 id 无 --last 时）：空列表提示/非 TTY 指引/TTY 箭头选择。
 * --all 显示全目录（project 后缀区分同名会话）。返回选中的会话信息；null = 已处理直接返回。
 * 非 TTY 无 id 时置退出码 1（调用方直接 return）；空列表/Esc 取消不置码。 */
async function pickSessionId(
  all: boolean,
  emptyHint: string,
  nonTtyHint: string
): Promise<import('./agent/session.js').SessionInfo | null> {
  const list = all ? await listSessions() : await listSessions(process.cwd());
  if (list.length === 0) {
    console.log(dim(emptyHint));
    return null;
  }
  if (!process.stdin.isTTY) {
    console.error(red(nonTtyHint));
    process.exitCode = 1;
    return null;
  }
  const { pickFromList } = await import('./cli/picker.js');
  const items = list.map((sv) => ({
    label: `${sv.pinned ? '★ ' : ''}${sv.title || '（无标题）'}（${sv.messages} 条）${all ? ` · ${sv.project}` : ''}`,
    value: sv.id,
  }));
  const idx = await pickFromList(process.stdin, items, { selected: 0 });
  if (idx < 0) return null;
  return list[idx]!;
}

/**
 * 非交互子命令表（tui-entry 共用：命中则恒走 console 路径，不被全屏 TUI 接管）。
 * 与下方 main 分发保持同步；`doctor` 仅裸调用算子命令（带参是任务文本）。
 */
export const CONSOLE_COMMANDS: ReadonlySet<string> = new Set([
  'exec', 'review', 'resume', 'fork', 'archive', 'unarchive', 'delete',
  'mcp-server', 'acp', 'web', 'mcp', 'plugin', 'completion', 'preset',
  'import', 'watch', 'mini',
]);

/** tui-entry 路由判定：子命令恒 console；其余（空/任务文本）按 TTY 进 TUI */
export function isConsoleCommand(args: string[]): boolean {
  const [head, ...rest] = args;
  if (head === undefined) return false;
  if (head === 'doctor') return rest.length === 0;
  if (head === 'e') return true; // exec 别名（main 侧归一化；此处直接认，避免 TUI 吞掉）
  return CONSOLE_COMMANDS.has(head);
}

export async function main(makeOutput: (cfg: OmniConfig) => Output): Promise<void> {
  const { taskArgs, overrides, flags, resumeId, help, version, lang } = parseArgs(process.argv.slice(2));
  // `e` = `exec` 别名（codex aliases: e；归一化后全链路按 exec 走，含帮助与 TUI 路由）
  if (taskArgs[0] === 'e') taskArgs[0] = 'exec';
  // `omni exec --help` 打专属帮助（codex exec --help 对等；与 tui-entry 共用预检）
  if (handleExecHelp(process.argv.slice(2), lang)) return;
  if (help) {
    printHelp(lang ?? 'en');
    return;
  }
  if (version) {
    console.log(`omni v${VERSION}`);
    return;
  }
  if (flags.listSessions) {
    await printSessions(flags.listAll);
    return;
  }
  // --cd <目录>：工作根覆盖（codex exec --cd 对等；omni 的 -C 是 config，不冲突）。
  // 必须在 prepareRun/子命令分发之前 chdir——配置发现/信任/会话/MCP 全跟随新 cwd。
  if (flags.cd) {
    const cd = resolveCdArg(flags.cd, process.cwd());
    if (cd.kind === 'error') {
      console.error(red(`--cd 失败：${cd.error}`));
      process.exitCode = 1;
      return;
    }
    if (cd.kind === 'change') process.chdir(cd.dir);
  }

  // Headless 子命令（把 omni 变成可组合 Unix 命令）：
  //   omni exec "<任务>"  —— 非交互执行（stdout 结果 / stderr 进度；--output-format json|stream-json）
  //   omni mcp-server     —— 作为 MCP server（stdio JSON-RPC，omni_exec / omni_reply 工具）
  // Web 服务（本地后端 + 网页界面，对标 dsh web / opencode serve）：
  //   omni web            —— 启动 REST+SSE 后端服务并托管 Web UI（默认 http://127.0.0.1:3080）
  if (taskArgs[0] === 'exec') {
    process.exitCode = await runExec(taskArgs.slice(1), overrides);
    return;
  }
  // omni review：顶层非交互审查（codex review 对等；即 exec review，不建会话；
  // 注意：首词 review 即走审查，想让模型聊 review 话题请换说法或加前置词）
  if (taskArgs[0] === 'review') {
    process.exitCode = await runExec(['review', ...taskArgs.slice(1)], overrides);
    return;
  }
  // omni resume [id|--last] [--all] [后续任务]：恢复会话进交互模式（codex resume 对等）。
  // picker：无 id 无 --last 且 TTY → 箭头选择（缺省当前目录，--all 全目录）；
  // 非 TTY 指路 --last/-l；prompt 词拼回 taskArgs 即单任务直跑（与 -c "follow-up" 同机制）
  let resumeIdEff: string | null = null;
  if (taskArgs[0] === 'resume') {
    const r = parseResumeArgs(taskArgs.slice(1));
    if (r.id) {
      // 精确 id 优先、前缀匹配次之（与 /resume 同 resolver；歧义列候选不静默选）
      const t = await resolveSessionTarget(r.id);
      if (!t.ok) {
        console.error(red(t.error + (t.candidates?.length ? `：${t.candidates.map((c) => c.id).join('、')}` : '（-l 查看可用会话）')));
        process.exitCode = 1;
        return;
      }
      resumeIdEff = sessionIdFromPath(t.file);
    } else if (r.last) {
      if (r.all) {
        const latest = (await listSessions(undefined, { includeArchived: false }))[0] ?? null;
        if (!latest) {
          console.error(red('暂无可恢复的会话（-l 查看全部）'));
          process.exitCode = 1;
          return;
        }
        resumeIdEff = latest.id;
      } else {
        flags.continueSession = true;
      }
    } else {
      const picked = await pickSessionId(
        r.all,
        '没有已保存的会话（交互模式退出时自动落盘；-l 查看，或 resume --last）',
        '非交互下请指定会话 id（-l 查看）或 --last 恢复最近'
      );
      if (!picked) return;
      resumeIdEff = picked.id;
    }
    taskArgs.splice(0, taskArgs.length, ...r.promptWords);
  }
  // omni archive/unarchive/delete <id>：会话归档管理（codex 同名命令对等；id 支持前缀匹配，歧义列候选）。
  // delete 永久删除：TTY 下 y/N 确认，非交互必须 --yes（否则拒绝执行防误删）。
  if (taskArgs[0] === 'archive' || taskArgs[0] === 'unarchive' || taskArgs[0] === 'delete') {
    const sub = taskArgs[0];
    const rest = taskArgs.slice(1);
    const yes = rest.includes('--yes');
    const idArg = rest.find((a) => a !== '--yes');
    if (!idArg || idArg.startsWith('-')) {
      console.error(red(`缺少会话 id：omni ${sub} <id>（-l 查看可用会话${sub === 'delete' ? '；非交互加 --yes' : ''}）`));
      process.exitCode = 1;
      return;
    }
    const t = await resolveSessionTarget(idArg);
    if (!t.ok) {
      console.error(red(t.error + (t.candidates?.length ? `：${t.candidates.map((c) => c.id).join('、')}` : '（-l 查看可用会话）')));
      process.exitCode = 1;
      return;
    }
    const sid = sessionIdFromPath(t.file);
    if (sub === 'delete') {
      if (!yes) {
        if (!process.stdin.isTTY) {
          console.error(red('非交互下删除会话必须加 --yes（永久删除，不可恢复）'));
          process.exitCode = 1;
          return;
        }
        const { confirm } = await import('./cli/plugin.js');
        if (!(await confirm(`永久删除会话 ${sid}？不可恢复`))) {
          console.log(dim('已取消'));
          process.exitCode = 1;
          return;
        }
      }
      const d = await deleteSessionFile(t.file);
      if (!d.ok) {
        console.error(red(d.error));
        process.exitCode = 1;
        return;
      }
      console.log(dim(`已永久删除会话 ${d.id}`));
      return;
    }
    const wantArchived = sub === 'archive';
    const loaded = await loadSession(t.file);
    if (loaded && (loaded.meta.archived ?? false) === wantArchived) {
      console.log(dim(`会话 ${sid}已${wantArchived ? '归档' : '取消归档'}（无变化）`));
      return;
    }
    if (!(await updateSessionMeta(t.file, { archived: wantArchived }))) {
      console.error(red(`会话 ${sid} 更新失败（文件写入异常）`));
      process.exitCode = 1;
      return;
    }
    console.log(dim(`${wantArchived ? '已归档' : '已取消归档'}会话 ${sid}`));
    return;
  }
  // omni fork [id|--last] [--all] [后续任务]：分叉出新会话，进交互模式继续（codex fork 对等）。
  // picker 与 resume 共用；分叉执行在 prepareRun 之后（新会话 meta.model 取当前模型）
  let forkSpec: { kind: 'id'; id: string } | { kind: 'last'; all: boolean } | { kind: 'pick'; all: boolean } | null = null;
  let forkPrompt: string[] = [];
  if (taskArgs[0] === 'fork') {
    const r = parseResumeArgs(taskArgs.slice(1), 'fork');
    if (r.id) forkSpec = { kind: 'id', id: r.id };
    else if (r.last) forkSpec = { kind: 'last', all: r.all };
    else forkSpec = { kind: 'pick', all: r.all };
    forkPrompt = r.promptWords;
    taskArgs.splice(0, taskArgs.length, ...forkPrompt);
  }
  if (taskArgs[0] === 'mcp-server') {
    await runMcpServer(overrides);
    return;
  }
  // omni acp：ACP（Agent Client Protocol）端点（stdio JSON-RPC，Zed 等编辑器生态集成）
  if (taskArgs[0] === 'acp') {
    const { runAcpServer } = await import('./acp.js');
    await runAcpServer(overrides);
    return;
  }
  // omni web：启动本地后端服务（REST + SSE）+ Web 界面——前端可以由 CLI 与网页
  // 共同访问同一个后端 Agent 服务（对标 opencode serve / dsh web 架构）。
  if (taskArgs[0] === 'web') {
    await runWeb(taskArgs.slice(1), overrides);
    return;
  }
  // omni mcp：MCP 服务器只读查看（codex mcp list/get 对等；写操作走 TUI/配置文件）
  if (taskArgs[0] === 'mcp') {
    const { runMcpCommand } = await import('./cli/mcp.js');
    process.exitCode = await runMcpCommand(taskArgs.slice(1), overrides);
    return;
  }
  // omni plugin：插件安装/卸载/启用清单管理（2026-09 PLG）
  if (taskArgs[0] === 'plugin') {
    const { runPluginCommand } = await import('./cli/plugin.js');
    process.exitCode = await runPluginCommand(taskArgs.slice(1));
    return;
  }
  // omni preset：能力一键预设（1.0 P1-6）——omni preset browser 装浏览器自动化双雄 MCP
  // omni completion：打印 shell 补全脚本（codex completion 对等；bash/zsh）
  if (taskArgs[0] === 'completion') {
    const { runCompletionCommand } = await import('./cli/completion.js');
    process.exitCode = runCompletionCommand(taskArgs.slice(1));
    return;
  }
  if (taskArgs[0] === 'preset') {
    const { runPreset } = await import('./agent/preset.js');
    const r = await runPreset(taskArgs[1] ?? '');
    for (const l of r.lines) console.log(l);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  // omni import：从 Claude Code 迁移配置（CLAUDE.md/skills/agents → omni 格式）
  if (taskArgs[0] === 'import') {
    const { importFromClaudeCode, reportImportResult } = await import('./cli/import-claude.js');
    const r = importFromClaudeCode();
    reportImportResult(r);
    process.exitCode = r.failed.length > 0 ? 1 : 0;
    return;
  }
  // omni watch：Watch 模式——监听 AI!/AI? 注释标记触发 agent 执行（第十二节 P2，Aider 同款）。
  // 复用交互模式的运行时装配（工具链/安全闸/审批回调），console 输出；Ctrl+C 退出。
  if (taskArgs[0] === 'watch') {
    const ctxW = prepareRun(overrides);
    const outputW = makeOutput(ctxW.cfg);
    const trustW = await resolveWorkspaceTrust(process.cwd(), outputW);
    await attachRuntime(ctxW, outputW, { trust: trustW });
    const { runWatch } = await import('./agent/watch.js');
    const stop = await runWatch(
      ctxW.client, ctxW.cfg.model, undefined as never,
      ctxW.runOpts, outputW, (text) => console.log(dim(text))
    );
    // Ctrl+C 退出（清理 watcher）
    process.on('SIGINT', () => {
      stop();
      process.exit(130);
    });
    return; // watch 常驻：runWatch 内部监听循环保持进程存活
  }

  // omni mini：纯终端 CLI 模式（Codex CLI 形态）——同一套运行时/交互循环/斜杠命令，
  // 只换渲染层（MiniOutput：圆角信息框 + `• Ran` 项目符号 + 回合分隔线）。
  const miniMode = taskArgs[0] === 'mini';
  if (miniMode) taskArgs.shift();

  const ctx = prepareRun(overrides);
  const { cfg, client, messages, runOpts } = ctx;
  // 全局 -i/--image：交互循环首个用户回合消费（单次/headless 走各自显式通道，此处只喂交互）
  if (overrides.images?.length) runOpts.initialImages = [...overrides.images];
  // 顶层 fork 执行：源会话全量消息 fork 成新会话，预载进上下文（落盘计数天然对齐：savedCount 按预载算）
  if (forkSpec) {
    let srcFile: string | null = null;
    if (forkSpec.kind === 'id') {
      const t = await resolveSessionTarget(forkSpec.id);
      if (!t.ok) {
        console.error(red(t.error + (t.candidates?.length ? `：${t.candidates.map((c) => c.id).join('、')}` : '（-l 查看可用会话）')));
        process.exitCode = 1;
        return;
      }
      srcFile = t.file;
    } else if (forkSpec.kind === 'last') {
      const latest = forkSpec.all
        ? ((await listSessions(undefined, { includeArchived: false }))[0] ?? null)
        : await latestSession(process.cwd());
      if (!latest) {
        console.error(red('暂无可分叉的会话（先跑一次交互，或用 -l 查看全部）'));
        process.exitCode = 1;
        return;
      }
      srcFile = latest.path;
    } else {
      const picked = await pickSessionId(
        forkSpec.all,
        '没有已保存的会话（交互模式退出时自动落盘；-l 查看，或 fork --last）',
        '非交互下请指定会话 id（-l 查看）或 --last 分叉最近'
      );
      if (!picked) return;
      srcFile = picked.path;
    }
    const loaded0 = await loadSession(srcFile);
    const count = loaded0 ? persistableMessages(loaded0.messages).length : 0;
    if (count === 0) {
      console.error(red('源会话无可 fork 的消息（空会话无法分叉）'));
      process.exitCode = 1;
      return;
    }
    const forkFile = await forkSession(srcFile, count, process.cwd(), cfg.model);
    const forked = forkFile ? await loadSession(forkFile) : null;
    if (!forked) {
      console.error(red('fork 失败（读会话或写文件出错）'));
      process.exitCode = 1;
      return;
    }
    messages.push(...forked.messages);
    runOpts.sessionPath = forkFile!;
    console.log(green(`已分叉新会话 ${forked.meta.id}（${forked.messages.length} 条消息 · 原会话保留）`));
    if (forked.meta.title) setTerminalTitle(forked.meta.title);
  }
  // omni doctor：环境诊断（codex doctor 对等；此前会被当成任务文本发给模型）
  if (taskArgs[0] === 'doctor' && taskArgs.length === 1) {
    for (const l of await doctorReport(cfg)) console.log(l);
    return;
  }
  const output: Output = miniMode
    ? new MiniOutput({ showThinking: cfg.showThinking, stream: true })
    : makeOutput(cfg);
  // 工作区信任（第九节）：首次进入未信任目录时询问；未信任 → 只读 + 跳过项目级配置
  const trust = await resolveWorkspaceTrust(process.cwd(), output);
  await attachRuntime(ctx, output, { trust }); // 安全护栏 + 动态工具链 + 上下文选项（MCP 发现可能耗时）
  output.banner(cfg, runOpts.tools.map((t) => t.name));

  // mini 单次 flags：在 taskArgs 里剥离（只认 mini 分支）：
  // `-o/--output-last-message` 落盘最终回答；`--approve-for-me` 开 AI 自动审批
  //（codex exec 同款；审阅器读 cfg.autoReview 实时开关，此处置位即对本轮生效）；
  // `-i/--image` 显式图片附件（codex exec -i 对等，与 @图.png 提及合并）
  let outputLastMessage: string | null = null;
  let miniImages: string[] = [];
  if (miniMode) {
    const split = splitMiniOneShotFlags(taskArgs);
    taskArgs.splice(0, taskArgs.length, ...split.taskArgs);
    outputLastMessage = split.outputLastMessage;
    miniImages = split.images;
    if (split.approveForMe && cfg) cfg.autoReview = true;
  }
  let singleTask = taskArgs.join(' ').trim();
  // 会话持久化：--continue / -r 恢复历史；交互模式自动创建会话文件
  const ok = await prepareSessionPersistence(flags, resumeId ?? resumeIdEff, cfg, messages, runOpts, Boolean(singleTask));
  if (!ok) {
    // 会话恢复失败（id 不存在等）：非零退出（此前静默 0，曾让 `resume 坏id` 看似成功）
    process.exitCode = 1;
    return;
  }
  if (singleTask) {
    // 单次任务模式：Ctrl+C 清掉 spinner 行后退出（交互模式保留 readline 默认的清行行为）
    // TUI 模式由渲染器自行处理 Ctrl+C（output.exitOnCtrlC），这里跳过避免打断全屏退出清理
    if (!output.exitOnCtrlC) {
      process.on('SIGINT', () => {
        process.stderr.write('\n');
        process.exit(130);
      });
    }
    // stdin 两形态（codex exec 对等，与 exec.ts 同口径；只在单次分支读 stdin，
    // 交互模式的 stdin 是 readline 通道，绝不能碰）：
    // · 任务为 `-` → 整段 stdin 即 prompt（无输入报错）；
    // · 任务非空且 stdin 被管道 → 追加 `[stdin 输入]` 上下文块。
    if (singleTask === '-') {
      const s = readStdinIfPiped();
      if (!s) {
        console.error(red('任务为 `-` 但 stdin 无输入（echo "任务" | omni mini -）'));
        process.exitCode = 1;
        return;
      }
      singleTask = s;
    }
    let userPrompt = singleTask;
    // Hooks：UserPromptSubmit——hook 返回 updatedPrompt 可改写 prompt（补上下文/策略）
    if (runOpts.hooks?.has('UserPromptSubmit')) {
      userPrompt = (await runOpts.hooks.userPromptSubmit(singleTask)).prompt;
    }
    const piped = readStdinIfPiped();
    if (piped) userPrompt = `${userPrompt}\n\n[stdin 输入]\n${piped}`;
    const singleImages: ImageAttachment[] = await collectImageAttachments(userPrompt, process.cwd()).catch(() => []);
    {
      // 显式图片附件（codex -i 对等）：mini 单次 flags + 全局 -i，双通道合并（互斥，不重复）；
      // console 单次同理（此前只认 mini 通道，全局 -i 会被静默丢弃）
      const extra = [...(miniMode ? miniImages : []), ...(overrides.images ?? [])];
      if (extra.length > 0) {
        const seen = new Set(singleImages.map((a) => path.resolve(process.cwd(), a.path)));
        for (const p of extra) {
          if (singleImages.length >= MAX_IMAGE_FILES) break;
          const abs = path.resolve(process.cwd(), p);
          if (seen.has(abs)) continue;
          seen.add(abs);
          const att = await loadImageAttachment(abs, p).catch(() => null);
          if (att) singleImages.push(att);
        }
      }
    }
    if (singleImages.length > 0) {
      console.log(dim(`（已附加 ${singleImages.length} 张图片：${singleImages.map((i) => i.path).join('、')}）`));
    }
    messages.push(userMessageWithImages(userPrompt, singleImages));
    await prepareContext(client, cfg.model, messages, runOpts.context ?? {}, runOpts.events);
    if (miniMode) {
      // mini 单次任务：回显输入 + 回合耗时线（与交互模式同一终端形态）；
      // `-o` 把最终回答落盘（codex --output-last-message 对等，写失败非零退出）
      await runMiniOneShot(client, cfg.model, messages, runOpts, output, singleTask);
      if (outputLastMessage) {
        try {
          writeFileSync(outputLastMessage, lastAssistantText(messages));
        } catch (err) {
          console.error(red(`最终回答落盘失败（${outputLastMessage}）：${(err as Error)?.message ?? err}`));
          process.exitCode = 1;
        }
      }
      return;
    }
    await runAgent(client, cfg.model, messages, runOpts, output);
    return;
  }

  if (miniMode) {
    await runMiniInteractive(client, cfg.model, messages, runOpts, output);
    return;
  }
  await runInteractive(client, cfg.model, messages, runOpts, output);
}
