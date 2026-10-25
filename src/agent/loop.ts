import { StreamingRate } from '../output/token-rate.js';
/**
 * Agent 主循环（整个系统的核心）：
 *
 * ```
 * while True:
 *   1. 调 LLM（携带全部历史消息，流式）
 *   2. 无工具调用 → 输出最终回答，结束
 *   3. 有工具调用 → 解析 JSON 参数 → 执行工具 → 结果以 role=tool 回传
 *   4. 回到 1（直到结束或达到 maxSteps）
 * ```
 *
 * 自我纠错机制：工具执行失败时，错误信息会作为工具结果返回给模型，
 * 由模型自己决定如何修正——这是 Agent 最强大的能力来源。
 *
 * 输出解耦：循环只发出 Output 事件（思考/正文/工具步骤/结果），
 * 由 ConsoleOutput / TuiOutput 各自渲染（见 src/output/）。
 */
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { createClient, findEndpointByName, getClient, resolveModelRoute, withRequestSession, MODEL_DEFAULTS, type ModelEndpoint } from '../client.js';
import {
  shouldUseResponses,
  isProtocolUnsupportedError,
  chatToolsToResponsesTools,
  chatMessagesToResponsesInput,
  buildResponsesParams,
  ResponsesAccumulator,
  createResponsesStream,
  type ResponsesStream,
} from './responses.js';
import { formatToolCall, previewOutput, isExitCodeZeroLine, approvalDiffText } from '../output/format.js';
import { estimateCost } from '../config/model-pricing.js';
import type { Output, ToolResultDetail } from '../output/types.js';
import { Safety, type PermissionTier } from '../safety/index.js';
import { truncate, type Tool } from '../tools/index.js';
import { extractReasoning, saveThinking } from './thinking.js';
import { appendInterruptedToolResults, buildAssistantMessage, parseArgs, repairToolPairing, stripNonStandardFields, type ToolCallAccum } from './messages.js';
import type { RunOptions } from './types.js';
import { appendWriteDiff, sessionIdFromPath } from './session.js';
import { buildStreamParams, extractCachedTokens } from './loop-params.js';
import { buildSystemPrompt, buildToolSchemas, PLAN_MODE_NOTE } from './loop-prompts.js';
import { abortError, isAbortLike, isRetryableRequestError, messagesHaveImage, sleep, waitAbort } from './loop-runtime.js';

// 从本文件抽出的纯函数/常量：保持对外导出路径不变（外部与测试按 './loop.js' 引用；
// 见 loop-prompts.ts / loop-params.ts / loop-runtime.ts）。
export { extractCachedTokens } from './loop-params.js';
export { buildSystemPrompt, buildToolSchemas, PLAN_MODE_NOTE, READ_ONLY_TOOLS } from './loop-prompts.js';
export { isAbortLike, isRetryableRequestError, messagesHaveImage } from './loop-runtime.js';

/** 工具返回的错误前缀（用于 ✓/✗ 判定与自我纠错提示） */
const TOOL_ERROR_PREFIX = /^(错误|执行失败|已拦截)/;

/** 展示层可见行数（非空 + 非「退出码: 0」）——mini 的折叠提示基数，与 previewOutput 过滤口径一致 */
function displayLines(result: string): number {
  let n = 0;
  for (const line of result.split('\n')) {
    if (line.trim() !== '' && !isExitCodeZeroLine(line)) n++;
  }
  return n;
}

/**
 * 运行 Agent 循环（对外入口）：先进入本会话的动态请求头上下文——`{sessionId}` 占位符
 * （如 OpenCode Go 要求的 x-opencode-session）解析为该会话 id，web 并发多会话经
 * AsyncLocalStorage 互不串号；循环 / 子代理 / 压缩 / 工具内嵌套 LLM 调用全覆盖。
 */
export async function runAgent(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  opts: RunOptions,
  output: Output
): Promise<void> {
  await withRequestSession(
    opts.sessionPath ? sessionIdFromPath(opts.sessionPath) : undefined,
    () => runAgentInner(client, model, messages, opts, output)
  );
}

/**
 * 循环本体。messages 会被就地追加（assistant 消息与 tool 结果），
 * 因此交互模式下可跨轮次保持对话上下文。
 */
async function runAgentInner(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  opts: RunOptions,
  output: Output
): Promise<void> {
  const maxSteps = opts.maxSteps ?? 50;
  // 轮数统计（footer）：每次回合（交互每轮用户提交 / 单次任务）计 1 轮
  output.onTurnStart?.();
  // 轨迹事件：轮开始（turn 号内部递增；loop 打断 continue 时同一轮号延续）
  opts.events?.turnStart();
  // 计划模式（/plan）：只暴露只读工具 + 系统提示词追加只读说明（由 buildToolSchemas 过滤）
  const planMode = opts.planMode === true;
  const toolSchemas = buildToolSchemas(opts.tools, planMode);
  // architect/editor 模型路由（第六节 P1，对标 Aider 双模型）：/plan 用 architect
  // 强推理模型、执行模式用 editor 轻模型（缺省 = 当前模型）。
  // 1.0 P0-3 跨端点路由：按模型名从 runOpts.models 反查端点——architect/editor 配在
  // 不同网关时自动换对应客户端（缓存复用，getClient）；同端点复用默认 client。
  const routedModel = planMode ? (opts.architectModel ?? model) : (opts.editorModel ?? model);
  // 本回合实际发请求用的 client/model：fallback 回退成功后切换为备用端点
  //（本轮内后续请求继续用备用；下一回合重新从主模型开始——主模型可能已恢复）
  let activeClient = client;
  let routedModelRuntime = routedModel;
  /** 当前生效端点（元数据消费：max_tokens / variants / modalities 校验） */
  let activeEndpoint: ModelEndpoint | undefined;
  /** fallback 已接管本回合（不再重算基础路由——保持回退语义） */
  let fallbackActive = false;
  /** Responses 协议偏好（Chat 遇到协议不支持 400 后自动切 Responses，本回合剩余步骤沿用） */
  let responsesPreferred = false;
  // 安全护栏：权限分级 + 审批 + 审计。所有工具（含 MCP 外部工具 / 子代理）统一过闸；
  // 缺省 full + 无审批回调 = 拒绝（fail-safe），入口层负责注入真实回调。
  // write_file diff 确认审批（P2）：需要审批的写操作把变更统计附进审批 reason
  //（数据源 = UndoStack 执行前快照，与 write_file 卡片 diff 同源）
  const safety = new Safety({
    tier: opts.permission ?? 'full',
    audit: opts.auditLog ?? false,
    requestApproval: opts.requestApproval ?? (() => false),
    summarize: formatToolCall,
    dangerousPatterns: opts.cfg?.dangerousPatterns,
    hooks: opts.hooks, // PermissionRequest hook（1.0 P1-1）
    // AI 自动审批（2026-09 补课）：模型审阅放行/拒绝，失败回退人工
    ...(opts.autoReview ? { autoReview: opts.autoReview } : {}),
    writeDiffSummary: (tool, args) => {
      if (tool !== 'write_file') return null;
      const snap = opts.undoStack?.latestFor(String(args.path ?? ''));
      const content = String(args.content ?? '');
      const original = snap ? (snap.existed ? snap.content : null) : null;
      try {
        return approvalDiffText(original, content);
      } catch {
        return null;
      }
    },
  });

  // Stop hook 的续命标记：模型已被要求继续过一次后为 true（只允许续一次，防 hook 无限循环）。
  // 每次 runAgent = 一个用户回合 → 每回合一次续命机会
  let stopHookActive = false;
  // Hooks：SessionStart——会话开始（每会话一次，sessionStart 内部标记去重）。
  // hookSpecificOutput 注入**首轮系统提示词**（如启动策略/环境快照）——不污染消息历史；
  // 后续回合 sessionStart 返回空（不再触发）
  // 缓存稳定性：首轮非空结果记忆到 opts.sessionHookNote，后续回合继续拼相同内容——
  // 否则次回合起 system 前缀变化、整段 Prompt Cache 失效（配了 SessionStart hook 的会话每轮 miss）。
  if (!opts.sessionHookNote && opts.hooks?.has('SessionStart')) {
    const lines = await opts.hooks.sessionStart();
    if (lines.length > 0) opts.sessionHookNote = `\n\n[SessionStart hook]\n${lines.join('\n')}`;
  }
  const sessionNote = opts.sessionHookNote ?? '';

  /**
   * 后台子代理结果注入（2026-09 FLT）：delegate background=true 完成的结果写队列，
   * 主循环每步请求前 / 回合结束前 drain 成 user 消息（模型可见并据此继续工作）。
   * 每回合结束仍未到达的结果留到下一轮（下次 drain）。
   */
  const drainBackgroundResults = (): number => {
    const q = opts.backgroundResults;
    if (!q || q.length === 0) return 0;
    // 多会话（Web 并发）：只取本会话的结果；其它会话的记录留在队列等其所属 run drain
    const mine: typeof q = [];
    const rest: typeof q = [];
    for (const r of q) {
      if ((r.sessionPath ?? '') === (opts.sessionPath ?? '')) mine.push(r);
      else rest.push(r);
    }
    if (mine.length === 0) return 0;
    q.splice(0, q.length, ...rest.slice(-100)); // 防御：其它会话积压上限 100
    for (const r of mine) {
      const label = r.status === 'ok' ? '完成' : '失败';
      const body = r.result.length > 4000 ? r.result.slice(0, 4000) + '\n…（已截断）' : r.result;
      messages.push({
        role: 'user',
        content: `[后台子代理${label}：${r.name}（${r.id}）· ${(r.durationMs / 1000).toFixed(1)}s]\n${body}`,
      });
    }
    return mine.length;
  };

  /** Team 消息注入（2026-09 DYN）：发给 main 的 send_message 在下一步请求前兑现 */
  const drainTeamMessages = (): number => {
    const board = opts.team;
    if (!board) return 0;
    const inbox = board.takeMessages('main');
    for (const m of inbox) {
      messages.push({ role: 'user', content: `[team 消息 from ${m.from}] ${m.text}` });
    }
    return inbox.length;
  };

  for (let step = 0; step < maxSteps; step++) {
    // 后台子代理完成结果 / team 消息：请求前注入（本轮内完成的可在同轮被模型消费）
    drainBackgroundResults();
    drainTeamMessages();
    // 系统提示词：每轮请求前构造带 system 消息的副本（不能 push 进 messages——
    // 该数组被原地追加 assistant/tool 消息用于跨轮上下文，直接 push 会每轮重复累积）。
    // buildSystemPrompt 每轮调用 → persona 里的 model/cwd/权限档位始终是最新值
    //（/model、/permission 运行时切换即时生效）
    const systemPrompt =
      buildSystemPrompt(model, process.cwd(), opts.permission) + sessionNote + (opts.systemNote ?? '');
    // 剥离非标准字段（reasoning——已持久化供 web 刷新恢复 thinking，但不能发给 API）；
    // 再修复 tool_calls ↔ tool 结果配对（中断/旧会话脏历史）——悬空配对会让网关 400，
    // 且一次污染后该会话每轮都失败，必须在发送前兜底自愈（非破坏性，不改 messages）
    const apiMessages = repairToolPairing(stripNonStandardFields(messages));
    const requestMessages: ChatCompletionMessageParam[] = [
      { role: 'system', content: planMode ? systemPrompt + PLAN_MODE_NOTE : systemPrompt },
      ...apiMessages,
    ];

    // 1.0 跨端点路由：每步重算基础路由（/model、/plan 运行时切换即时生效）；
    // fallback 已接管时保持备用端点不重算。找不到端点 = 默认 client + 原模型名。
    if (!fallbackActive) {
      const route = resolveModelRoute(opts, routedModel, client, model);
      activeClient = route.client;
      activeEndpoint = route.endpoint;
      routedModelRuntime = route.model;
    }
    // 多模态前置校验（1.0 P0-3 元数据消费点④）：消息含图片而该模型 input 无 image
    // → 明确报错而非等网关侧模糊失败；未声明 modalities 按兜底假设（含 image）放行。
    const inputMods = activeEndpoint?.modalities?.input ?? MODEL_DEFAULTS.modalities.input ?? [];
    if (!inputMods.includes('image') && messagesHaveImage(requestMessages)) {
      const err = new Error(
        `当前模型「${activeEndpoint?.name ?? routedModel}」不支持图片输入（modalities.input=${inputMods.join('/')}）。` +
          `请切换 vision 模型（/model）或移除图片后重试。`
      );
      output.onRequestFailed(err);
      opts.events?.turnEnd('error', err.message);
      return;
    }

    // 本轮传输协议：显式 protocol=responses，或 muse-spark 等 Responses-only 模型默认 responses；
    // 一旦因协议 400 自动切过（responsesPreferred），本回合剩余步骤沿用 Responses。
    let useResponses = responsesPreferred || shouldUseResponses(activeEndpoint, routedModelRuntime);

    // 调试开关：OMNI_DEBUG=1 时打印发往 LLM 的请求体（用 stderr，避免污染流式输出）
    if (process.env.OMNI_DEBUG) {
      console.error(`\n[OMNI_DEBUG] 第 ${step + 1} 轮请求 → POST {baseURL}/${useResponses ? 'responses' : 'chat/completions'}`);
      console.error(`[OMNI_DEBUG] model=${routedModelRuntime} · messages=${requestMessages.length} 条（含 system）· tools=${toolSchemas.length} 个`);
      console.error(JSON.stringify({ model: routedModelRuntime, messages: requestMessages, tools: toolSchemas }, null, 2).slice(0, 6000));
    }

    // 轨迹事件：LLM 请求快照（模型 + 可调工具名 + 消息数；轻量版，不存提示词全文）
    opts.events?.requestHeader(step, routedModelRuntime, toolSchemas.map((s) => s.function.name), requestMessages.length);

    output.onRound(step, maxSteps);
    // 思考计时起点：与 TUI onRound 预建 think 模块的时刻对齐（首 chunk 前等待也计入）。
    // reasoningMs 只对**真正有思考内容**的轮次设置（reasoning 非空才在 finishThinking 结算）。
    const thinkT0 = Date.now();
    let reasoningMs: number | undefined;
    // LLM 请求计时：墙钟（含重试回退）与首 token 延迟（footer 统计用）
    const llmT0 = Date.now();
    let firstTokenAt: number | null = null; // 首个有意义内容（reasoning/content/tool_call）的到达时间
    let lastContentAt: number | null = null; // 最后一个非空内容 chunk 的到达时间（生成耗时 = lastContentAt - firstTokenAt）
    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> | null = null;
    let responsesStream: ResponsesStream | null = null;
    /** fallback 回退链（P0）：主模型失败时按序尝试的 [client, model] 对（惰性构建一次） */
    let fallbacks: { client: OpenAI; model: string; endpoint?: ModelEndpoint }[] | null = null;
    try {
      if (useResponses) {
        // Responses 协议：input + 扁平 tools + reasoning.effort + max_output_tokens，
        // 不带任何 Chat 专有字段（网关会 400 拒绝）。
        const flatTools = chatToolsToResponsesTools(toolSchemas);
        const input = chatMessagesToResponsesInput(requestMessages);
        const built = buildResponsesParams(activeEndpoint, routedModelRuntime, input, flatTools, {
          reasoningEffort: opts.reasoningEffort ?? activeEndpoint?.reasoningEffort,
          signal: opts.abortSignal,
        });
        responsesStream = await waitAbort(
          createResponsesStream(activeClient, built.params, built.options),
          opts.abortSignal
        );
        responsesPreferred = true;
      } else {
      // 附加参数：stream_options.include_usage（TUI footer token 用量）+ reasoning_effort
      //（/variants 思考级别）+ max_tokens（元数据 limit.output）+ 命名 variants 叠加层。
      // 个别网关不认会直接报错 → 回退为不带这些参数的普通流式请求。
      // **create 阶段也可立即取消**：bun 的 fetch 不响应 in-flight abort，create 会挂到
      // 首 chunk 才 resolve——waitAbort 包一层，abort 立即 reject（连接后台继续收完自然关闭）
      try {
        const built = buildStreamParams(activeEndpoint, routedModelRuntime, requestMessages, toolSchemas, {
          includeUsage: true,
          signal: opts.abortSignal,
          reasoningEffort: opts.reasoningEffort,
          activeVariant: opts.activeVariant,
        });
        stream = await waitAbort(
          activeClient.chat.completions.create(built.params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, built.options),
          opts.abortSignal
        );
      } catch (createErr) {
        if ((createErr as Error)?.name === 'AbortError') throw createErr;
        // 协议自动切换：Chat 400 协议不支持 → 同参数改走 Responses 重试一次
        //（muse-spark 未配 protocol 的零配置自愈；成功后本回合沿用 Responses）。
        if (isProtocolUnsupportedError(createErr)) {
          const flatTools = chatToolsToResponsesTools(toolSchemas);
          const input = chatMessagesToResponsesInput(requestMessages);
          const built = buildResponsesParams(activeEndpoint, routedModelRuntime, input, flatTools, {
            reasoningEffort: opts.reasoningEffort ?? activeEndpoint?.reasoningEffort,
            signal: opts.abortSignal,
          });
          responsesStream = await waitAbort(
            createResponsesStream(activeClient, built.params, built.options),
            opts.abortSignal
          );
          useResponses = true;
          responsesPreferred = true;
        } else {
        // 回退：不带 include_usage/reasoning_effort/max_tokens/cache_control 等增强参数的普通流式请求
        const plain = buildStreamParams(activeEndpoint, routedModelRuntime, requestMessages, toolSchemas, {
          signal: opts.abortSignal,
          disableCacheControl: true,
        });
        delete plain.params.stream_options;
        delete plain.params.reasoning_effort;
        delete plain.params.max_tokens;
        stream = await waitAbort(
          activeClient.chat.completions.create(plain.params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, plain.options),
          opts.abortSignal
        );
        }
      }
      }
    } catch (err) {
      // 取消/打断优先判定：abort 信号已触发时（如工具执行期间被 steer 打断），create 立刻抛
      // AbortError——打断则取走消息**同一轮内继续**（模型直接回答打断消息）；
      // 取消（/stop / Esc）时槽为空 → 优雅结束本轮（abort 不是请求错误，不报「请求失败」）
      if (isAbortLike(err)) {
        output.onLlmLap?.(Date.now() - llmT0, null);
        const interrupt = opts.takeInterrupt?.() ?? null;
        if (interrupt) {
          messages.push({ role: 'user', content: interrupt });
          output.onUserMessage(interrupt, 'steer');
          opts.events?.user(interrupt, 'interrupt'); // 轨迹：打断消息进当前轮
          opts.rearmAbort?.(); // 换新信号：abort 已消费，后续请求/取消用新信号
          continue;
        }
        opts.events?.turnEnd('aborted'); // 轨迹：创建阶段取消（/stop / Esc）
        if (output.thinking.shown) output.thinking.finish(); // 预建的 thinking 头行复位
        return;
      }
      // **fallback 模型回退链（第七节 P0）**：可重试错误（429 限流 / 超时 / 5xx 网关 /
      // 网络错误——非 401 鉴权、非 400 参数）按序切换备用端点重试本轮；成功后提示
      // 「已回退到 X」（meta 行 + 轨迹），本轮后续请求继续用该备用端点（activeClient）。
      // 401/400 是配置问题——换端点也一样失败，直接走失败路径不浪费重试。
      // Responses 协议下跳过 Chat fallback 链（备用端点同样按各自 protocol 在下一步重算时生效）
      if (!useResponses && isRetryableRequestError(err) && (opts.fallbackEndpoints?.length ?? 0) > 0) {
        // 1.0：备用端点客户端走缓存工厂（同 provider 复用连接池）；请求参数同样带
        // 该端点的 max_tokens / 命名 variant（同 id 存在于备用端点时叠加）。
        fallbacks ??= opts.fallbackEndpoints!.map((ep) => ({
          client: getClient(ep, opts.fallbackApiKey ?? ep.apiKey ?? ''),
          model: ep.apiModel?.trim() || ep.name,
          endpoint: ep,
        }));
        for (let fi = 0; fi < fallbacks.length; fi++) {
          const fb = fallbacks[fi];
          // 跨端点切换前指数退避等待（对齐 SDK 同款策略：1s 起步、每换一个备用端点
          // 翻倍 1s → 2s → 4s，让上游网关压力释放；fallback 上限 3 级所以封顶 4s）。
          // 切换期间 abort 仍能立即打断（waitAbort 包 sleep）。取消时不再继续
          // 后续 fallback。
          if (fi > 0 && !opts.abortSignal?.aborted) {
            const delay = 1000 * Math.pow(2, fi - 1);
            await waitAbort(sleep(delay), opts.abortSignal);
          }
          if (opts.abortSignal?.aborted) {
            err = abortError();
            break;
          }
          try {
            const fbBuilt = buildStreamParams(fb.endpoint, fb.model, requestMessages, toolSchemas, {
              signal: opts.abortSignal,
              reasoningEffort: opts.reasoningEffort,
              activeVariant: opts.activeVariant,
            });
            stream = await waitAbort(
              fb.client.chat.completions.create(fbBuilt.params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, fbBuilt.options),
              opts.abortSignal
            );
            activeClient = fb.client;
            routedModelRuntime = fb.model;
            activeEndpoint = fb.endpoint;
            fallbackActive = true;
            output.onFallback?.(fb.model);
            break; // 该备用端点可用：跳出回退循环
          } catch (fbErr) {
            if (isAbortLike(fbErr)) {
              err = fbErr; // 取消：交给下方失败路径（不是请求错误，按 abort 处理）
              break;
            }
            if (!isRetryableRequestError(fbErr)) {
              err = fbErr; // 401/400 等配置问题：换端点也救不回来，停止继续试
              break;
            }
            err = fbErr; // 该备用也挂（5xx/429/网络）：记下错误继续下一个备用
          }
        }
      }
      // 全部备用端点都不可用 / 未配置 fallback：优雅结束本轮（原语义）
      if (stream === null && responsesStream === null) {
        output.onLlmLap?.(Date.now() - llmT0, null); // 失败也计入 LLM 墙钟（首 token 无）
        output.onRequestFailed(err);
        opts.events?.turnEnd('error', (err as Error)?.message); // 轨迹：请求失败结束本轮
        if (output.thinking.shown) output.thinking.finish(); // 同上：不留 thinkingShown 残留
        return;
      }
    }

    // 流式累积：思考（reasoning）、正文（content）与工具调用（tool_calls）
    let content = '';
    let reasoning = '';
    let streamTokens = 0;
    let streamEndedAt: number | null = null;
    const streamRate = new StreamingRate(llmT0);
    let lastUsage: OpenAI.Completions.CompletionUsage | null = null;
    const generationUsage = () => ({
      tokens: lastUsage?.completion_tokens ?? 0, // OpenAI completion/output tokens 已含 reasoning，不能再加一次。
      ms: Math.max(0, (streamEndedAt ?? Date.now()) - llmT0),
      basis: 'request' as const,
    });
    const toolCalls = new Map<number, ToolCallAccum>();
    let streamStarted = false;
    const thinking = output.thinking;
    const finishThinking = () => {
      if (thinking.shown) thinking.finish(); // 思考区结束：补换行，后续内容从新行开始（思考内容保留在屏幕上）
      // 思考耗时结算（供持久化）：仅在**确有思考内容**时记录=input（从 onRound 到首段
      // reasoning 停止的时间）。多次调用只取第一次（Reasoning 区结束即定格）。
      if (reasoning && reasoningMs === undefined) reasoningMs = Date.now() - thinkT0;
    };

    try {
      if (useResponses && responsesStream) {
        // Responses 协议流式消费：事件折叠为同构累积（content/reasoning/toolCalls/usage），
        // 下游（assistant 组装/工具执行）与 Chat 完全复用；取消语义同样抛给下方统一 catch。
        const accum = new ResponsesAccumulator();
        const riter = responsesStream[Symbol.asyncIterator]();
        for (;;) {
          const next = await waitAbort(
            riter.next(),
            opts.abortSignal,
            () => {
              void riter.return?.().catch(() => {});
            }
          );
          if (next.done) break;
          const ev = next.value as Record<string, unknown>;
          if (!streamStarted) {
            streamStarted = true;
            output.onStreamStart();
          }
          const inc = accum.consume(ev);
          const hasContent = Boolean(inc.text || inc.reasoning || inc.tokenText);
          if (hasContent) {
            const now = Date.now();
            firstTokenAt ??= now;
            lastContentAt = now;
            let deltaText = '';
            if (inc.text) deltaText += inc.text;
            if (inc.reasoning) deltaText += inc.reasoning;
            deltaText += inc.tokenText ?? '';
            const sample = streamRate.add(deltaText, now);
            streamTokens = sample.tokens;
            const liveGenMs = now - llmT0;
            const firstTokenMs = firstTokenAt - llmT0;
            output.onStreamProgress?.({ liveGenMs, streamTokens, tps: sample.tps, firstTokenMs, estimated: true });
          }
          if (inc.reasoning) {
            reasoning += inc.reasoning;
            thinking.write(inc.reasoning);
          }
          if (inc.text) {
            finishThinking();
            content += inc.text;
            output.onAnswer(inc.text);
          }
          if (inc.toolDelta) finishThinking();
          if (inc.usage && accum.usage) {
            const u = accum.usage;
            lastUsage = {
              prompt_tokens: u.input_tokens ?? 0,
              completion_tokens: u.output_tokens ?? 0,
              total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
              prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens ?? 0 },
            completion_tokens_details: { reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? 0 },
            } as unknown as OpenAI.Completions.CompletionUsage;
            if (u.output_tokens) streamTokens = u.output_tokens;
          }
        }
        for (const [k, v] of accum.toolCalls) toolCalls.set(k, v);
        if (!lastUsage && accum.usage) {
          const u = accum.usage;
          lastUsage = {
            prompt_tokens: u.input_tokens ?? 0,
            completion_tokens: u.output_tokens ?? 0,
            total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
            prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens ?? 0 },
            completion_tokens_details: { reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? 0 },
          } as unknown as OpenAI.Completions.CompletionUsage;
        }
      } else {
      // **手动驱动流式迭代 + waitAbort**：abort 立即中断（不等下一个 chunk——真实模型
      // 思考中 chunk 间隔可能数秒，逐 chunk 检查会让取消延迟、ESC 后新消息「先排队等一会」，
      // 用户反馈）。onAbort 里 iter.return() 让 SDK 迭代器收尾（finally → controller.abort 断连）
      const iter = stream![Symbol.asyncIterator]();
      for (;;) {
        const next = await waitAbort(
          iter.next(),
          opts.abortSignal,
          () => {
            void iter.return?.().catch(() => {});
          }
        );
        if (next.done) break;
        const chunk = next.value;
        if (!streamStarted) {
          streamStarted = true;
          output.onStreamStart();
        }
        if (chunk.usage) lastUsage = chunk.usage; // include_usage 时末 chunk 携带用量
        const delta = chunk.choices[0]?.delta;
        const piece = extractReasoning(delta, opts.compatibility?.reasoningField);
        // 首 token 计时锚点 = 首个**有实际内容**的 delta（reasoning/content/tool_call），
        // 而非首个 chunk——有些网关先发 role-only 空 delta，会让 TTFT 偏小。
        // lastContentAt 同步刷新到最后一个内容 chunk：生成耗时 = lastContentAt - firstTokenAt
        // （排除首 token 等待，tok/s 才是真实生成速率而非含 prefill 的平均吞吐）。
        const hasContent = Boolean(piece || delta?.content || delta?.tool_calls?.some(tc => tc.function?.name || tc.function?.arguments));
        if (hasContent) {
          const now = Date.now();
          firstTokenAt ??= now;
          lastContentAt = now;

          // 累积生成 token 估算（按实际估算值累加，不设单 chunk 保底——
          // 小 chunk 密集时保底 1 会虚增峰值）
          let deltaText = '';
          if (piece) deltaText += piece;
          if (delta?.content) deltaText += delta.content;
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.function?.name) deltaText += tc.function.name;
              if (tc.function?.arguments) deltaText += tc.function.arguments;
            }
          }
          const sample = streamRate.add(deltaText, now);
          streamTokens = chunk.usage?.completion_tokens ?? sample.tokens;
          const liveGenMs = now - llmT0;
          output.onStreamProgress?.({
            liveGenMs, streamTokens, tps: sample.tps,
            firstTokenMs: firstTokenAt - llmT0, estimated: true,
          });
        }
        if (piece) {
          reasoning += piece;
          thinking.write(piece);
        }
        if (delta?.content) {
          finishThinking(); // 正文开始 → 结束思考区（思考保留显示，正文另起一行）
          content += delta.content;
          output.onAnswer(delta.content);
        }
        for (const tc of delta?.tool_calls ?? []) {
          finishThinking(); // 工具调用开始 → 结束思考区
          const cur = toolCalls.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id += tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolCalls.set(tc.index, cur);
        }
      }
      } // end Chat 分支 else
      streamEndedAt = Date.now(); // 流结束立即定格，后续工具执行/思考落盘不计入请求吞吐。
    } catch (err) {
      // 用户点击「取消」（abort 中断流式响应）：优雅结束本轮——已输出的内容保留，
      // 半截 assistant 消息不入上下文（push 在流结束后），下一轮不受污染
      if (isAbortLike(err)) {
        if (content) output.onAnswerEnd();
        output.onLlmLap?.(
          Date.now() - llmT0,
          firstTokenAt !== null ? firstTokenAt - llmT0 : null,
          firstTokenAt !== null && lastContentAt !== null ? Math.max(0, lastContentAt - firstTokenAt) : undefined
        );
        if (thinking.shown) finishThinking();
        // 打断（steer，Cmd/Ctrl+Enter）：取走打断消息 push 进 messages（作为当前轮的
        // 新 user 消息），**同一轮内继续**——模型直接回答打断消息，不结束本轮；
        // 取消（/stop / Esc）时槽为空 → takeInterrupt 返回 null → 优雅结束本轮
        const interrupt = opts.takeInterrupt?.() ?? null;
        if (interrupt) {
          messages.push({ role: 'user', content: interrupt });
          output.onUserMessage(interrupt, 'steer');
          opts.events?.user(interrupt, 'interrupt'); // 轨迹：打断消息进当前轮
          opts.rearmAbort?.(); // 换新信号：abort 已消费，后续请求/取消用新信号
          continue; // 下一轮循环：模型看到打断消息并回答
        }
        opts.events?.turnEnd('aborted'); // 轨迹：流式阶段取消（/stop / Esc）
        return;
      }
      // SDK 的 APIUserAbortError 可能在我们已消费打断消息后从迭代器内部再次冒出：
      // 这里兜底按取消优雅结束（不向上抛——runAgent 上抛会变成 unhandledRejection）
      if (isAbortLike(err)) {
        opts.events?.turnEnd('aborted');
        return;
      }
      throw err;
    }
    if (thinking.shown) finishThinking(); // 流结束仍展开 → 兜底结束思考区
    if (content) output.onAnswerEnd();
    output.onLlmLap?.(
      (streamEndedAt ?? Date.now()) - llmT0,
      firstTokenAt !== null ? firstTokenAt - llmT0 : null,
      firstTokenAt !== null && lastContentAt !== null ? Math.max(0, lastContentAt - firstTokenAt) : undefined
    );
    if (lastUsage) {
      // 缓存命中 token：OpenAI 系 prompt_tokens_details.cached_tokens；DeepSeek 系 prompt_cache_hit_tokens；Anthropic 系 cache_read_input_tokens
      const promptTokens = lastUsage.prompt_tokens ?? 0;
      const completionTokens = lastUsage.completion_tokens ?? 0;
      // 本轮成本估算（统一 estimator；失败静默不带，不阻塞）
      let costUsd: number | undefined;
      let est: ReturnType<typeof estimateCost> | undefined;
      try {
        est = estimateCost(promptTokens, completionTokens, routedModelRuntime, {
          endpointPrice: activeEndpoint?.price,
          apiModel: activeEndpoint?.apiModel,
          cachedTokens: extractCachedTokens(lastUsage),
        });
        if (Number.isFinite(est.costUsd) && est.costUsd > 0) costUsd = est.costUsd;
        else est = undefined;
      } catch {
        /* 不带成本，流程继续 */
      }
      output.onUsage({
        prompt: promptTokens,
        completion: completionTokens,
        generation: generationUsage(),
        total: lastUsage.total_tokens ?? 0,
        cached: extractCachedTokens(lastUsage),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(est !== undefined ? { prices: est.prices, priceSource: est.source } : {}),
      });
    }

    // 思考内容落盘 + 管道模式提示（提示仅当思考展示开启时输出，保持管道输出可控）
    if (reasoning) {
      const saved = await saveThinking(reasoning);
      output.onThinkingSaved(reasoning.length, saved);
    }

    // 轨迹与消息持久化用量
    const cachedTokens = extractCachedTokens(lastUsage);
    const usageMeta = lastUsage
      ? {
          prompt: lastUsage.prompt_tokens ?? 0,
          completion: lastUsage.completion_tokens ?? 0,
          generation: generationUsage(),
          total: lastUsage.total_tokens ?? ((lastUsage.prompt_tokens ?? 0) + (lastUsage.completion_tokens ?? 0)),
          cached: cachedTokens,
        }
      : undefined;
    const durMs = (streamEndedAt ?? Date.now()) - llmT0;
    const genMs = firstTokenAt !== null && lastContentAt !== null ? Math.max(0, lastContentAt - firstTokenAt) : undefined;

    // 组装 assistant 消息并追加进历史（reasoning + reasoningMs + usage + model 一并持久化——
    // web/TUI/console 恢复后回放 thinking 块与 turn-footer 统计；firstTokenMs 落盘供 turn-footer 首 token 段）
    const assistantMsg = buildAssistantMessage(content, toolCalls, reasoning, reasoningMs, {
      usage: usageMeta,
      model,
      durMs,
      genMs,
      firstTokenMs: firstTokenAt !== null ? firstTokenAt - llmT0 : null,
    });
    messages.push(assistantMsg);

    // 轨迹：assistant 消息（正文 + 用量 + LLM 墙钟/首 token 延迟）
    opts.events?.assistant(
      step,
      content,
      lastUsage
        ? {
            input: lastUsage.prompt_tokens ?? 0,
            cached: cachedTokens,
            output: lastUsage.completion_tokens ?? 0,
          }
        : undefined,
      Date.now() - llmT0,
      firstTokenAt !== null ? firstTokenAt - llmT0 : null
    );

    // 没有工具调用 → 模型给出了最终回答，循环结束（先过 Stop hook）
    if (toolCalls.size === 0) {
      // 后台子代理/team 消息恰好在本回合收尾前到达 → 注入并让模型继续消费
      if (drainBackgroundResults() > 0 || drainTeamMessages() > 0) continue;
      // Hooks：Stop——agent 准备结束时 hook 返回 block（reason）可要求继续修；
      // stop_hook_active=true 后 hook 的 block 被忽略（只允许续一次，防 hook 无限循环）
      if (opts.hooks?.has('Stop')) {
        const stop = await opts.hooks.stop(stopHookActive);
        if (!stop.allow) {
          messages.push({
            role: 'system',
            content: `[Stop hook 要求继续] ${stop.reason ?? '请继续修复问题'}`,
          });
          stopHookActive = true; // 已续一次：后续 Stop 的 block 不再生效
          continue; // 下一轮：模型看到要求并继续修
        }
      }
      // Hooks：Notification——会话完成通知（fire-and-forget，不等待）
      opts.hooks?.notification({ message_type: 'session_complete', stop_hook_active: stopHookActive });
      opts.events?.turnEnd('completed'); // 轨迹：正常完成
      return;
    }

    // 并行执行：一次响应里的多个工具调用并发跑（Promise.all），结果按原顺序回传。
    // 副作用工具（多个 run_command 写同一文件等）由模型自行负责顺序/冲突；
    // 安全护栏（审批/审计）逐调用独立。
    const calls = assistantMsg.tool_calls!;
    const toolsT0 = Date.now();
    const batchSignal = opts.abortSignal;
    // 工具配对序号（跨 step 递增，会话内唯一）：并行工具结果可能乱序到达，
    // 前端按 toolSeq 把 tool.start/tool.result 配到同一张卡片（不能靠到达顺序）
    let toolSeq = 0;
    // **工具执行阶段可被 abort 立即结束**（用户反馈「esc 取消后再次发消息会先排队」）：
    // 工具本身不可中断（execute 无 signal），但取消/打断不必等它跑完——abort 后立即
    // 结束本轮（工具继续在后台执行完，副作用已发生，但结果不再回传等待——否则工具
    // 执行几十秒期间取消无效、ESC 后新消息要等工具结束才发送）
    let results: string[];
    try {
      results = await waitAbort(
        Promise.all(
          calls.map(async (call) => {
            const tool = opts.tools.find((t) => t.name === call.function.name);
            if (!tool) {
              return `错误：未知工具「${call.function.name}」。可用工具：${opts.tools.map((t) => t.name).join(', ')}`;
            }
            const parsed = parseArgs(call.function.arguments);
            if (!parsed.ok) {
              return `错误：工具参数不是合法 JSON：${call.function.arguments}`;
            }
            if (batchSignal?.aborted) return '已取消：工具调用所属回合已中断';
            const seq = ++toolSeq;
            output.onToolStep(step, maxSteps, tool.name, formatToolCall(tool.name, parsed.args), parsed.args, seq);
            // 轨迹：工具调用（callId = OpenAI 调用 id，与 tool/result 天然配对）
            opts.events?.toolCall(step, call.id, tool.name, JSON.stringify(parsed.args));
            // Hooks：PreToolUse——JSON 返回 decision:block 可**硬拦截**（规则型护栏，
            // 不依赖模型自觉）；updatedInput 合并进工具参数（hook 可修正/补充参数）
            let args = parsed.args;
            let hookBlocked: string | null = null;
            if (opts.hooks?.has('PreToolUse')) {
              const pre = await opts.hooks.preToolUse(tool.name, args);
              if (!pre.allow) {
                hookBlocked = pre.reason ?? 'PreToolUse hook 阻止了该调用';
              } else if (pre.updatedInput && typeof pre.updatedInput === 'object') {
                args = { ...args, ...pre.updatedInput };
              }
            }
            // 安全护栏过闸：拒绝 → 结果回传模型（自我纠错）；需要审批 → 用户决定
            //（hook 已拦截则跳过闸门与执行——规则型拦截是硬性的）
            const gate = hookBlocked ? null : await safety.gate(tool, args);
            if (batchSignal?.aborted) return '已取消：工具调用所属回合已中断';
            let result: string;
            if (hookBlocked) {
              result = `已拦截（hook）：${hookBlocked}\n请向用户说明情况，由其决定如何继续。`;
            } else if (!gate!.allow) {
              result = `已拦截：${gate!.reason}\n请向用户说明情况，由其决定如何继续。`;
            } else {
              try {
                // run_command 实时输出：通过 ToolContext.onCommandOutput 注入回调，
                // 渲染端（TUI/Web/console）订阅后做原地刷新 / DOM 追加。
                // toolSeq：本次调用的配对序号——delegate 工具透传进子代理事件，
                // 子代理进度据此路由到正确卡片（并行多委托不互相覆盖）。
                const toolCtx: import('../tools/types.js').ToolContext = {
                  cwd: process.cwd(),
                  toolSeq: seq,
                  ...(opts.sessionPath ? { sessionPath: opts.sessionPath } : {}),
                  ...(tool.name === 'run_command' && output.onCommandOutput
                    ? {
                        onCommandOutput: (line: string, isErr: boolean) => {
                          if (!batchSignal?.aborted) output.onCommandOutput!(line, isErr, seq);
                        },
                      }
                    : {}),
                };
                result = await tool.execute(args, toolCtx);
                if (batchSignal?.aborted) return result;
              } catch (err: any) {
                if (batchSignal?.aborted) return '已取消：工具调用所属回合已中断';
                // 自我纠错：把错误信息喂回模型，让它自己修正
                result = `执行失败：${err?.message ?? err}`;
                // PostToolUseFailure（1.0 P1-1）：失败诊断提示追加回传，加速自修复
                if (opts.hooks?.has('PostToolUseFailure')) {
                  const fail = await opts.hooks.postToolUseFailure(tool.name, args, result).catch(() => ({ extra: [] }));
                  if (fail.extra.length > 0) result = `${result}\n\n[失败诊断 hook]\n${fail.extra.join('\n')}`;
                }
              }
              // Hooks：PostToolUse——hookSpecificOutput 追加回传上下文（如 lint 结果让
              // 模型自修复）；工具结果照常回传，hook 输出是补充信息
              if (opts.hooks?.has('PostToolUse')) {
                const post = await opts.hooks.postToolUse(tool.name, args, result);
                if (post.extra.length > 0) result = `${result}\n\n[hook 输出]\n${post.extra.join('\n')}`;
              }
              // LSP 反馈闭环（1.0 P1-3，opencode/Crush 招牌差异点）：config diagnoseAfterEdit
              // 开启时，write_file 成功后跑一次快速项目检查（typecheck→lint），诊断摘要
              // 追加回传——模型即时自修复，不用等用户手动跑检查。限时 12s，失败静默。
              if (tool.name === 'write_file' && opts.cfg?.diagnoseAfterEdit) {
                try {
                  const { detectCheckCommand: detect2 } = await import('../tools/diagnose.js');
                  const { captureCommand } = await import('./review.js');
                  const checkCmd = detect2(process.cwd());
                  if (checkCmd) {
                    const diag = await captureCommand(`npm run ${checkCmd.name} --silent`, 12_000);
                    if (diag.output && diag.output !== '（无输出）') {
                      result = `${result}\n\n[诊断（${checkCmd.name}）]\n${diag.output.slice(0, 2500)}`;
                    }
                  }
                } catch {
                  // 诊断是可选增强，失败静默
                }
              }
            }
            // 预览只取前几行（终端展示用），完整结果仍回传给模型；
            // write_file 附带写入前后对比（original 取自 UndoStack 执行前快照——execute
            // 前已 snapshotWrite，此处读栈取「写入前」内容；新建文件 original=null）
            // edit_file 附带局部替换 diff（old_string / new_string 直接来自 args——execute
            // 已成功证明二者与文件实际内容匹配，无需读 UndoStack 重建 diff）
            let detail: ToolResultDetail | undefined;
            if (tool.name === 'write_file') {
              const snap = opts.undoStack?.latestFor(String(args.path ?? ''));
              if (snap) {
                detail = {
                  diff: {
                    path: String(args.path ?? ''),
                    original: snap.existed ? snap.content : null,
                    content: String(args.content ?? ''),
                  },
                };
                // 改前落盘（重载会话后历史 diff 左半的来源；fire-and-forget，失败静默；
                // 新建文件 original=null 也记——历史据此确信"是新建"而非"记录缺失"）
                if (opts.sessionPath) {
                  const sp = opts.sessionPath;
                  const orig = snap.existed && typeof snap.content === 'string' ? snap.content : null;
                  const rec = { callId: call.id, path: String(args.path ?? ''), original: orig };
                  void appendWriteDiff(sp, rec).catch(() => {});
                }
              }
            } else if (tool.name === 'edit_file') {
              const oldStr = String(args.old_string ?? '');
              const newStr = args.new_string === undefined ? '' : String(args.new_string ?? '');
              detail = {
                edit: {
                  path: String(args.path ?? ''),
                  oldLines: oldStr ? oldStr.split('\n') : [],
                  newLines: newStr ? newStr.split('\n') : [],
                },
              };
            }
            if (batchSignal?.aborted) return result;
            output.onToolOutput?.(result, seq);
            output.onToolResult(
              !TOOL_ERROR_PREFIX.test(result),
              result.length,
              previewOutput(result),
              detail,
              seq,
              displayLines(result)
            );
            // 轨迹：工具结果（与 tool/call 按 callId 配对；耗时 = result - call）
            opts.events?.toolResult(call.id, !TOOL_ERROR_PREFIX.test(result), result.length);
            return result;
          })
        ),
        opts.abortSignal
      );
    } catch (err) {
      // assistant(tool_calls) 已在执行前入历史（见上方 push），这里无论取消还是异常都必须
      // 先补齐每个调用的 tool 配对占位——否则下一条 user 消息紧跟悬空 tool_calls，
      // 网关按 OpenAI 协议直接 400（且脏历史落盘后该会话每轮都失败）。
      appendInterruptedToolResults(messages, calls);
      // 工具执行阶段 abort：立即结束本轮——打断（steer）取消息**同一轮内继续**；
      // 取消（Esc //stop）优雅结束。工具结果丢弃不回传（后台工具继续跑完）
      if (isAbortLike(err)) {
        const interrupt = opts.takeInterrupt?.() ?? null;
        if (interrupt) {
          messages.push({ role: 'user', content: interrupt });
          output.onUserMessage(interrupt, 'steer');
          opts.events?.user(interrupt, 'interrupt'); // 轨迹：打断消息进当前轮
          opts.rearmAbort?.(); // 换新信号：abort 已消费，后续请求/取消用新信号
          continue; // 打断：下一轮循环，模型看到打断消息并回答
        }
        opts.events?.turnEnd('aborted'); // 轨迹：工具执行阶段取消（/stop / Esc）
        if (output.thinking.shown) output.thinking.finish(); // 同上：不留 thinkingShown 残留
        return; // 取消：结束本轮
      }
      throw err;
    }
    // 结果按原调用顺序回传（OpenAI 按 tool_call_id 关联，顺序无关但保持一致更稳）
    results.forEach((result, i) => {
      messages.push({ role: 'tool', tool_call_id: calls[i].id, content: truncate(result) });
    });
    output.onToolsLap?.(Date.now() - toolsT0); // 该轮工具执行墙钟（footer 统计用）
  }

  output.onMaxSteps(maxSteps);
  opts.events?.turnEnd('max-steps'); // 轨迹：触达轮次上限
}
