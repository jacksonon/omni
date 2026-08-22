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
import { prepareContext } from './agent/context.js';
import { createSkillTool } from './agent/skill.js';
import { memorySearchTool, memoryReadTool } from './tools/memory-tools.js';
import { createTodoWriteTool } from './tools/todo.js';
import { createWebFetchTool } from './tools/web-fetch.js';
import { createDiagnoseTool } from './tools/diagnose.js';
import { runAgent } from './agent/loop.js';
import { createSession, findSessionById, formatSessionInfo, latestSession, listSessions, loadSession } from './agent/session.js';
import { EventRecorder } from './agent/events.js';
import type { RunOptions } from './agent/types.js';
import { runInteractive } from './cli/interactive.js';
import { parseArgs, printHelp } from './cli/args.js';
import { loadConfig, type ConfigOverrides, type OmniConfig } from './config/index.js';
import { HookRunner } from './hooks/index.js';
import { formatToolCall } from './output/format.js';
import type { Output } from './output/types.js';
import type { PermissionTier } from './safety/policy.js';
import { Safety, type ApprovalRequest } from './safety/index.js';
import { isTrustedWorkspace, addTrustedWorkspace } from './safety/trust.js';
import { wrapSandboxCommand, type SandboxMode } from './safety/sandbox.js';
import type { Tool } from './tools/types.js';
import { runExec, runMcpServer } from './exec.js';
import { runWeb } from './web/index.js';
import { createAskUserTool } from './tools/ask.js';
import { createDelegateTool } from './tools/delegate.js';
import { discoverSubagents } from './agent/subagent-defs.js';
import { tools } from './tools/index.js';
import { closeMcpClients, discoverMcpServers, buildMcpTools, mcpInstructionsMessage } from './tools/mcp.js';
import { UndoStack, withUndoSnapshot } from './tools/undo.js';
import { dim, red } from './ui.js';
import { VERSION } from './version.js';

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
 * 非 run_command / off / danger-full-access → 原样返回。
 */
function wrapRunCommandWithSandbox(tool: Tool, mode: SandboxMode): Tool {
  if (tool.name !== 'run_command' || mode === 'off' || mode === 'danger-full-access') return tool;
  const original = tool.execute;
  return {
    ...tool,
    execute: async (args) => {
      const command = String(args.command ?? '');
      const wrapped = wrapSandboxCommand(mode, process.cwd(), command);
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
 */
export function prepareRun(overrides: ConfigOverrides): RunContext {
  const cfg = loadConfig(overrides);
  // 默认模型（cfg.model）的端点配置：顶层缺省字段回退到 models.<model>（每模型独立
  // 密钥/端点/UA 是合法用法——用户把密钥放在 models 里而不写顶层 apiKey 时，
  // 不应报「未找到 API Key」闪退，从默认模型的端点配置解析即可）
  const defModel = cfg.models?.[cfg.model];
  const apiKey = defModel?.apiKey ?? cfg.apiKey;
  if (!apiKey) {
    throw new Error(
      `未找到 API Key。设置方式：
  · 配置文件 omni.json / omni.jsonc 的 "apiKey" 字段（或 models."${cfg.model}".apiKey）
  · 环境变量 OMNI_API_KEY（或 OPENAI_API_KEY）
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
        '首次进入未信任目录：信任后允许写入，并加载项目记忆（AGENTS.md）/技能/子代理定义与 hooks；' +
        '不信任则以只读模式运行（所有写操作被拒绝，项目级配置不加载）',
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
 *   跳过项目级 hooks/skills/子代理定义/项目记忆（防仓库注入恶意配置）；
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
  // Hooks 生命周期自动化（对标 Claude Code）：配置了 hooks 才创建（未配置 = no-op）。
  // **未信任目录跳过 hooks**（项目 omni.json 可注入 PreToolUse hook 执行任意 shell——
  // 这是仓库注入恶意配置的主要载体；全局 hooks 也被跳过，提示用户先信任目录）。
  // hook 输出经 Output.onHookOutput 回显（TUI 对话流 / console dim 行）；超时/失败降级放行
  if (trusted) {
    ctx.runOpts.hooks = new HookRunner({
      hooks: cfg.hooks,
      cwd: process.cwd(),
      onOutput: (event, lines) => output.onHookOutput?.(event, lines),
    });
  }
  const gate = new Safety({
    tier: effectiveTier,
    audit: cfg.auditLog,
    requestApproval,
    summarize: formatToolCall,
    dangerousPatterns: cfg.dangerousPatterns,
  });
  ctx.runOpts.permission = effectiveTier;
  ctx.runOpts.trusted = trusted;
  ctx.runOpts.sandbox = cfg.sandbox;
  // 可用模型列表（顶层 model + config models 展开；/model 切换用）
  // 默认模型端点同样优先取 models.<model>（与 prepareRun 的解析一致）
  // 顶层 model 已在列表首位；models 表里同名的条目跳过，避免 /model 面板重复列出
  // （常见于先 /model add <名> 再 /model <名> 切换——顶层与 models 表各留一份）
  const defModel = cfg.models?.[cfg.model];
  const modelEndpoints: ModelEndpoint[] = [
    {
      name: cfg.model,
      baseURL: defModel?.baseURL ?? cfg.baseURL,
      apiKey: defModel?.apiKey ?? cfg.apiKey,
      userAgent: defModel?.userAgent ?? cfg.userAgent,
      // per-model variants：端点展开时把模型的思考级别配置（缺省回退全局）"烘焙"进端点——
      // /model 切换时 applyEndpoint / switchModel 直接从端点取，无需再查 cfg
      reasoningEffortOptions: defModel?.reasoningEffortOptions ?? cfg.reasoningEffortOptions,
      reasoningEffort: defModel?.reasoningEffort ?? cfg.reasoningEffort,
    },
    ...Object.entries(cfg.models ?? {})
      .filter(([name]) => name !== cfg.model)
      .map(([name, e]) => ({
        name,
        baseURL: e.baseURL ?? cfg.baseURL,
        apiKey: e.apiKey ?? cfg.apiKey,
        userAgent: e.userAgent ?? cfg.userAgent,
        reasoningEffortOptions: e.reasoningEffortOptions ?? cfg.reasoningEffortOptions,
        reasoningEffort: e.reasoningEffort ?? cfg.reasoningEffort,
      })),
  ];
  ctx.runOpts.models = modelEndpoints;
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
  };
  // 动态工具链：静态工具 + 子代理 delegate（可关）+ ask_user（向用户提问，消除歧义）+
  // MCP 外部工具（失败只警告不阻塞）
  // /undo 撤销：先把静态工具表包装（write_file 执行前快照原内容进 UndoStack），
  // 再创建 delegate——子代理共用同一份包装后的工具表，其写入同样被记录
  const undoStack = new UndoStack();
  let tracked = tools.map((t) => withUndoSnapshot(t, undoStack));
  // OS 级沙箱：cfg.sandbox 非 off 时包装 run_command（sandbox-exec / bwrap 限制副作用范围）
  if (cfg.sandbox && cfg.sandbox !== 'off' && cfg.sandbox !== 'danger-full-access') {
    tracked = tracked.map((t) => wrapRunCommandWithSandbox(t, cfg.sandbox));
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
  // diagnose 诊断工具（P1）：运行 typecheck/lint 返回诊断摘要
  toolchain.push(createDiagnoseTool(process.cwd()));
  // 思考级别（/variants）与子代理配置（/agents 展示）：透传给交互命令
  if (cfg.reasoningEffort) ctx.runOpts.reasoningEffort = cfg.reasoningEffort;
  ctx.runOpts.reasoningEffortOptions = cfg.reasoningEffortOptions;
  ctx.runOpts.maxSubagentSteps = cfg.maxSubagentSteps;
  // 第六节「子代理与编排」配置：architect/editor 模型路由（/plan 用 architect、执行用
  // editor，缺省 = 当前模型）+ 嵌套深度上限 + 已发现子代理定义（delegate 的 agent 参数）
  if (cfg.architect) ctx.runOpts.architectModel = cfg.architect;
  if (cfg.editor) ctx.runOpts.editorModel = cfg.editor;
  ctx.runOpts.maxSubagentDepth = cfg.maxSubagentDepth;
  // 未信任目录：跳过项目级子代理定义（.agents/subagents/*.md 可能被仓库植入
  // 恶意模型/权限配置）；delegate 工具本身也不注册（子代理是项目级概念）。
  ctx.runOpts.subagents = trusted ? await discoverSubagents() : [];
  // 基础工具链（静态 + delegate，不含 MCP）：/mcp 重连时以此为基底重建 tools
  ctx.runOpts.baseTools = toolchain;
  ctx.runOpts.mcpServers = cfg.mcpServers;
  // 发现 MCP 服务器（完整句柄：工具 + 资源 + 提示词 + instructions）
  const mcpHandles = await discoverMcpServers(cfg.mcpServers);
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
 * 返回 true = 已处理（调用方应 return）。
 */
export async function printSessions(): Promise<boolean> {
  const list = await listSessions();
  if (list.length === 0) {
    console.log(dim('暂无已保存的会话（交互模式退出时自动落盘，可用 --continue 恢复）。'));
  } else {
    console.log('已保存的会话（--continue 恢复最近一次，-r <id> 恢复指定）：');
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
  // 轨迹事件记录器（/trace 数据源）：恢复/新建会话都挂在同一会话文件
  // （`{"t":"ev"}` 行与消息行共存，loadSession 天然跳过）；单任务模式无会话
  // 文件 → 仅内存记录（flush 为 no-op，供 eval 等复用）。
  runOpts.events = await EventRecorder.open(runOpts.sessionPath ?? null);
  return true;
}

export async function main(makeOutput: (cfg: OmniConfig) => Output): Promise<void> {
  const { taskArgs, overrides, flags, resumeId, help, version } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }
  if (version) {
    console.log(`omni v${VERSION}`);
    return;
  }
  if (flags.listSessions) {
    await printSessions();
    return;
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
  if (taskArgs[0] === 'mcp-server') {
    await runMcpServer(overrides);
    return;
  }
  // omni web：启动本地后端服务（REST + SSE）+ Web 界面——前端可以由 CLI 与网页
  // 共同访问同一个后端 Agent 服务（对标 opencode serve / dsh web 架构）。
  if (taskArgs[0] === 'web') {
    await runWeb(taskArgs.slice(1), overrides);
    return;
  }

  const ctx = prepareRun(overrides);
  const { cfg, client, messages, runOpts } = ctx;
  const output = makeOutput(cfg);
  // 工作区信任（第九节）：首次进入未信任目录时询问；未信任 → 只读 + 跳过项目级配置
  const trust = await resolveWorkspaceTrust(process.cwd(), output);
  await attachRuntime(ctx, output, { trust }); // 安全护栏 + 动态工具链 + 上下文选项（MCP 发现可能耗时）
  output.banner(cfg, runOpts.tools.map((t) => t.name));

  const singleTask = taskArgs.join(' ').trim();
  // 会话持久化：--continue / -r 恢复历史；交互模式自动创建会话文件
  const ok = await prepareSessionPersistence(flags, resumeId, cfg, messages, runOpts, Boolean(singleTask));
  if (!ok) return;
  if (singleTask) {
    // 单次任务模式：Ctrl+C 清掉 spinner 行后退出（交互模式保留 readline 默认的清行行为）
    // TUI 模式由渲染器自行处理 Ctrl+C（output.exitOnCtrlC），这里跳过避免打断全屏退出清理
    if (!output.exitOnCtrlC) {
      process.on('SIGINT', () => {
        process.stderr.write('\n');
        process.exit(130);
      });
    }
    let userPrompt = singleTask;
    // Hooks：UserPromptSubmit——hook 返回 updatedPrompt 可改写 prompt（补上下文/策略）
    if (runOpts.hooks?.has('UserPromptSubmit')) {
      userPrompt = (await runOpts.hooks.userPromptSubmit(singleTask)).prompt;
    }
    messages.push({ role: 'user', content: userPrompt });
    await prepareContext(client, cfg.model, messages, runOpts.context ?? {}, runOpts.events);
    await runAgent(client, cfg.model, messages, runOpts, output);
    return;
  }

  await runInteractive(client, cfg.model, messages, runOpts, output);
}
