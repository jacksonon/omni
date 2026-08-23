/**
 * 上下文管理：让长对话与多文件任务在有限的上下文窗口里跑得更久。
 *
 * 四条策略（各自独立开关，由 config 注入，入口层统一调用）：
 *   0. **全局记忆**（globalAgentsFile）：~/.config/omni/AGENTS.md（尊重 XDG_CONFIG_HOME）
 *      ——跨项目共享的用户偏好/习惯，所有会话首轮加载，排在项目记忆之前（级联：
 *      项目可覆盖/细化全局，与配置体系「低→高」优先级语义一致）；
 *   1. **项目记忆 AGENTS.md**（agentsFile）：跨会话共享的项目记忆——每次会话首轮
 *      **嵌套加载所有层级的 AGENTS.md**（从 cwd 向上到 git 根/home 边界，每目录一层）：
 *      外层（项目根）整体约定 + 内层（子目录）局部约定，各生成一条 system 消息，
 *      越贴近 cwd 的层级排在越后面、离用户消息越近、权重越高（可覆盖/细化外层）；
 *   2. **相关文件选择性加载**（preloadFiles）：任务文本里出现的现有文件路径
 *      （`src/foo.ts` 等）→ 首轮前把内容预载进上下文（系统消息），模型无需
 *      先 read_file 就能看到关键文件；超限/不存在的路径自动跳过。
 *   3. **长对话摘要压缩**（summarizeAt）：消息数超过阈值时，把最旧的完整回合
 *      压成一段摘要（独立轻量 LLM 调用），保留最近 summarizeWindow 条原文——
 *      交互模式长会话不再因上下文撑爆而丢失早期信息。
 *
 * 安全边界：摘要绝不切开「assistant 工具调用 ↔ 其 tool 结果」的配对
 * （findSummarizeSplit 回退到完整回合边界）；压缩失败静默跳过（不打扰对话）。
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  GLOBAL_MEMORY_PREFIX,
  globalMemoryMessage,
  loadGlobalMemory,
  loadProjectMemory,
  MEMORY_PREFIX,
  memoryMessage,
} from './memory.js';
import { topicsMatchingTask } from './memory-topics.js';
import { discoverSkills, skillMessage, SKILL_PREFIX } from './skill.js';
import { buildRepoMap } from './repomap.js';
import type { EventRecorder } from './events.js';
import type { HookRunner } from '../hooks/index.js';

export interface ContextOptions {
  /** 是否加载全局记忆 ~/.config/omni/AGENTS.md（跨项目共享；默认 true） */
  globalAgentsFile?: boolean;
  /** 是否加载项目记忆 AGENTS.md（跨会话共享；默认 true） */
  agentsFile?: boolean;
  /** 会话结束时把新表达的偏好自动追加进全局记忆（默认 true；供交互退出钩子读取） */
  autoMemory?: boolean;
  /** 消息数超过该值才触发摘要压缩（0 = 关闭；默认 40） */
  summarizeAt?: number;
  /** 压缩时保留最近多少条消息原文（默认 8） */
  summarizeWindow?: number;
  /** 是否预载任务文本中出现的相关文件（默认 true） */
  preloadFiles?: boolean;
  /** 是否启用技能（SKILL.md）发现与注入（默认 true） */
  skills?: boolean;
  /** 最多预载文件数（默认 5） */
  preloadMaxFiles?: number;
  /** 单文件预载字节上限（默认 30KB） */
  preloadMaxBytes?: number;
  /** 是否注入代码库结构感知地图（repo map；默认 true） */
  repoMap?: boolean;
  /** repo map 符号上限（默认 200） */
  repoMapMaxSymbols?: number;
  /** 模型上下文窗口（token；1.0 P1-4）：已知时按占比触发摘要压缩 */
  contextLimit?: number;
  /** 压缩触发占比（1.0 P1-4，默认 0.7）：估算 token > contextLimit × ratio 时触发 */
  compressRatio?: number;
  /** Hooks 运行器（PreCompact：压缩前 fire-and-forget；attachRuntime 注入） */
  hooks?: HookRunner;
}

/** 预载消息内容前缀（同内容重复判断 / 调试识别用） */
const PRELOAD_PREFIX = '[已按任务预载相关文件';

/** repo map 消息前缀（渐进披露/调试识别用） */
const REPO_MAP_PREFIX = '[项目结构地图';

/** 常见源码/配置扩展名（出现在任务文本里且存在 → 视为相关文件） */
const FILE_RE = /[\w./~-]+\.(?:tsx?|jsx?|mjs|cjs|jsonc?|md|py|go|rs|java|c|cpp|h|hpp|sh|yml|yaml|toml|css|html|vue|svelte|sql|txt)\b/g;

/**
 * 从任务文本提取相关文件并读取内容（过滤：存在 + 是文件 + 未超字节上限）。
 * 返回相对路径（对 cwd）与内容；无匹配或全部不可读时返回空数组。
 */
export async function selectRelevantFiles(
  task: string,
  maxFiles: number,
  maxBytes: number,
  cwd = process.cwd()
): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  const seen = new Set<string>();
  const candidates = [...new Set(task.match(FILE_RE) ?? [])];
  for (const raw of candidates) {
    if (out.length >= maxFiles) break;
    // 去掉引号/包裹符与结尾标点（`"src/foo.ts"` / `src/foo.ts.`）
    const clean = raw.replace(/^['"`(]+/, '').replace(/['"`),.;:!?]+$/, '').replace(/^\.\//, '');
    if (!clean || path.basename(clean).startsWith('.')) continue; // 空 / 隐藏文件（.gitignore 噪音）
    const abs = path.resolve(cwd, clean);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      const st = await stat(abs);
      if (!st.isFile() || st.size > maxBytes) continue;
      const content = await readFile(abs, 'utf8');
      out.push({ path: clean, content: content.slice(0, maxBytes) });
    } catch {
      // 不存在 / 不可读 → 跳过（静默，不打扰）
    }
  }
  return out;
}

/** 预载文件 → 注入消息（系统消息；循环会把自己的 SYSTEM_PROMPT 放在最前） */
function preloadMessage(files: { path: string; content: string }[]): ChatCompletionMessageParam {
  const body = files
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');
  return {
    role: 'system',
    content: `${PRELOAD_PREFIX}，供参考；需要完整内容请用 read_file 定向读取]\n${body}`,
  };
}

/**
 * 计算摘要切分点：messages 前 split 条压缩成摘要，保留后 keepTail 条原文。
 * 安全边界：split 处若前一条是带 tool_calls 的 assistant 消息，则回退到该消息
 * 起点（把「assistant 工具调用 + 其 tool 结果」整组留在 tail），绝不切开配对。
 * 返回 -1 = 不值得压缩（消息太少）。
 */
export function findSummarizeSplit(
  messages: ChatCompletionMessageParam[],
  keepTail: number
): number {
  let split = messages.length - keepTail;
  if (split <= 2) return -1; // 太短：头部没有完整回合可压
  // 切点前一跳是 assistant 工具调用 → 其 tool 结果紧跟其后（在 tail），配对会被切开——
  // 把 assistant 连同结果整组回退留 tail（head 只到上一个完整回合边界）。
  // 只查边界一跳：head 内部更早的完整回合不受影响。
  const prev = messages[split - 1];
  if (
    prev?.role === 'assistant' &&
    'tool_calls' in prev &&
    prev.tool_calls &&
    prev.tool_calls.length > 0
  ) {
    split -= 1;
  }
  return split >= 2 ? split : -1;
}

const SUMMARY_SYSTEM_PROMPT =
  '把以下 Agent 对话压缩成要点摘要（中文，200 字以内）。保留：用户需求、已执行的工具与结论、' +
  '未完成事项、关键路径/命令。只输出摘要本身，不要任何前缀。';

/**
 * 估算一段消息序列的 token 数（轻量启发式）：CJK 字符 ≈ 1 token/字，
 * 其它 ≈ 4 字符/token。用于「按模型上下文窗口占比触发压缩」（不追求精确，
 * 只要比消息数阈值更早感知膨胀即可——真实 tokenizer 是重依赖，刻意不引入）。
 */
export function estimateContextTokens(messages: ChatCompletionMessageParam[]): number {
  let cjk = 0;
  let other = 0;
  const scan = (s: string): void => {
    for (const ch of s) {
      if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++;
      else other++;
    }
  };
  for (const m of messages) {
    if (typeof m.content === 'string') scan(m.content);
    else if (Array.isArray(m.content)) scan(JSON.stringify(m.content));
    if ('tool_calls' in m && Array.isArray((m as { tool_calls?: unknown }).tool_calls)) {
      scan(JSON.stringify((m as { tool_calls?: unknown }).tool_calls));
    }
  }
  return cjk + Math.ceil(other / 4);
}

/**
 * 工具结果清理（1.0 P1-4，opencode clear_tool_uses 等价）：保留最近 keepLast 条
 * 工具结果原文，更早的折成一行占位（`[工具结果已清理：原 N 字符…]`）。
 * **不动 assistant 的 tool_calls**（配对完整性约束），只缩短 tool 消息正文——
 * 早期工具的原始输出对后续推理价值低，但常占掉一半以上上下文。
 * 返回被清理的条数。
 */
export function foldOldToolResults(messages: ChatCompletionMessageParam[], keepLast = 8): number {
  // 从尾向前收集 tool 消息下标
  const toolIdx: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') toolIdx.push(i);
  }
  let folded = 0;
  for (let k = keepLast; k < toolIdx.length; k++) {
    const m = messages[toolIdx[k]!]!;
    if (typeof m.content === 'string' && !m.content.startsWith('[工具结果已清理')) {
      const len = m.content.length;
      messages[toolIdx[k]!] = { ...m, content: `[工具结果已清理：原 ${len} 字符。早期工具输出已被清理以释放上下文；其关键结论已体现在后续对话中，如需原始内容请重新读取。]` };
      folded++;
    }
  }
  return folded;
}

/**
 * 长对话摘要压缩：消息数超过 summarizeAt 时，把最旧完整回合压成一条 system 摘要。
 * 就地修改 messages；压缩失败（网络/无 Key）静默返回（不打扰对话）。
 * recorder：轨迹事件记录器（可选）——压缩成功时记录 compact 事件。
 */
export async function summarizeContext(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  opts: ContextOptions,
  recorder?: EventRecorder
): Promise<void> {
  // 触发条件（1.0 P1-4 压缩 2.0）：消息数阈值（原逻辑）**或** 估算 token 超过
  // 模型上下文窗口 × 占比（contextLimit 已知时）——两者取先到。
  const threshold = opts.summarizeAt ?? 0;
  const limit = opts.contextLimit;
  const ratio = opts.compressRatio ?? 0.7;
  let overRatio = false;
  if (limit && limit > 0) {
    overRatio = estimateContextTokens(messages) > limit * ratio;
  }
  const overCount = threshold > 0 && messages.length > threshold;
  if (!overCount && !overRatio) return;
  // 先做工具结果折叠（clear_tool_uses 等价）：早期工具原文折成占位，
  // 可能直接把 token 压回阈值以下——折叠后不再超限则跳过 LLM 摘要（省一次往返）
  foldOldToolResults(messages, 8);
  if (overRatio && !overCount && limit && estimateContextTokens(messages) <= limit * ratio) {
    recorder?.compact(0); // 轨迹：记录一次纯折叠压缩
    return;
  }
  const split = findSummarizeSplit(messages, opts.summarizeWindow ?? 8);
  if (split < 0) return;
  // 开头连续 system 消息（项目记忆 AGENTS.md / 预载文件等上下文脚手架）**不压缩**：
  // 它们是跨轮共享的项目知识，若被折叠进摘要，长会话会丢失项目记忆。
  // 摘要只覆盖从首个非 system 消息到 split 的对话区，脚手架保持在原位。
  let headStart = 0;
  while (headStart < split && messages[headStart].role === 'system') headStart++;
  if (headStart >= split) return; // 全是 system（不应发生）→ 不压缩
  // Hooks：PreCompact——压缩真正发生前 fire-and-forget（可归档/通知；失败静默）
  opts.hooks?.preCompact(messages.length);
  const head = messages.slice(headStart, split);
  const summary = await summarizeMessages(client, model, head);
  if (!summary) return; // 失败静默
  messages.splice(headStart, split - headStart, { role: 'system', content: `[历史对话摘要]\n${summary}` });
  recorder?.compact(split - headStart); // 轨迹：压缩移除 N 条
  opts.hooks?.postCompact(summary.length); // PostCompact（1.0 P1-1）：fire-and-forget
}

/** 独立轻量 LLM 调用（流式与主循环一致，兼容各家网关）；失败返回 null */
async function summarizeMessages(
  client: OpenAI,
  model: string,
  head: ChatCompletionMessageParam[]
): Promise<string | null> {
  const transcript = head
    .map((m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      return `${m.role}: ${content.slice(0, 500)}`;
    })
    .join('\n');
  try {
    const stream = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: transcript },
      ],
      stream: true,
      max_tokens: 300,
    });
    let text = '';
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? '';
      if (text.length > 2000) break;
    }
    const t = text.trim();
    return t || null;
  } catch {
    return null;
  }
}

/**
 * 上下文准备（入口在每轮用户输入后调用）：
 *   1. 项目记忆 AGENTS.md：首轮（尚未注入过）**嵌套加载**所有层级的 AGENTS.md
 *      （从 cwd 向上到 git 根/home 边界，每层一条 system 消息，内层贴近用户消息权重最高）；
 *   2. 首轮（尚未预载过）按任务文本预载相关文件；
 *   3. 长对话做摘要压缩。
 */
export async function prepareContext(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  opts: ContextOptions,
  recorder?: EventRecorder
): Promise<void> {
  // 1) 相关文件预载：只在尚未预载过时执行一次（会话首个用户消息）
  const preload = opts.preloadFiles !== false;
  const hasPreload = messages.some(
    (m) => typeof m.content === 'string' && m.content.startsWith(PRELOAD_PREFIX)
  );
  if (preload && !hasPreload && messages.length > 0) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser && typeof lastUser.content === 'string') {
      const files = await selectRelevantFiles(
        lastUser.content,
        opts.preloadMaxFiles ?? 5,
        opts.preloadMaxBytes ?? 30 * 1024
      );
      if (files.length > 0) messages.unshift(preloadMessage(files));
    }
  }
  // 2) 项目记忆 AGENTS.md：跨会话共享，首轮注入一次（system 消息；
  //    在预载之后 unshift → 排在预载文件之前，紧跟循环的 SYSTEM_PROMPT）。
  //    嵌套多层级：loadProjectMemory 返回 [内层, …, 外层]（从内到外），
  //    依次 unshift → 最终顺序 [外层, …, 内层]——外层靠 system prompt、
  //    内层贴近用户消息、权重最高（内层可覆盖/细化外层）。
  const agentsFile = opts.agentsFile !== false;
  const hasMemory = messages.some(
    (m) => typeof m.content === 'string' && m.content.startsWith(MEMORY_PREFIX)
  );
  if (agentsFile && !hasMemory && messages.length > 0) {
    const mems = await loadProjectMemory();
    for (const mem of mems) {
      messages.unshift(memoryMessage(mem));
    }
  }
  // 0) 全局记忆 ~/.config/omni/AGENTS.md：跨项目共享，首轮注入一次；
  //    在项目记忆之后 unshift → 排在项目记忆之前（级联：全局在前、项目在后）
  const globalFile = opts.globalAgentsFile !== false;
  const hasGlobal = messages.some(
    (m) => typeof m.content === 'string' && m.content.startsWith(GLOBAL_MEMORY_PREFIX)
  );
  if (globalFile && !hasGlobal && messages.length > 0) {
    const mem = await loadGlobalMemory();
    if (mem) messages.unshift(globalMemoryMessage(mem));
    // globs 条件注入（1.0 P1-2，Amp 方案）：任务文本命中主题 frontmatter 的
    // glob 模式时把该主题全文内联（不用等模型主动 memory_search）
    const lastUserForTopics = [...messages].reverse().find((m) => m.role === 'user');
    const taskText0 =
      lastUserForTopics && typeof lastUserForTopics.content === 'string' ? lastUserForTopics.content : undefined;
    const matched = await topicsMatchingTask(taskText0);
    if (matched.length > 0) {
      const body = matched.map((m) => `### ${m.topic}\n${m.content}`).join('\n\n');
      messages.unshift({ role: 'system', content: `[全局记忆主题（任务命中自动加载）]\n${body}` });
    }
  }
  // -1) 技能清单：跨会话共享（SKILL.md 已安装），首轮注入一次——
  //     只列 name+description，模型需要时用 skill 工具按名加载全文（对标 opencode）。
  //     注入顺序在全局记忆之后 → 排在记忆之前、紧跟 SYSTEM_PROMPT（技能是通用能力）。
  const skillsFile = opts.skills !== false;
  const hasSkills = messages.some(
    (m) => typeof m.content === 'string' && m.content.startsWith(SKILL_PREFIX)
  );
  if (skillsFile && !hasSkills && messages.length > 0) {
    const skills = await discoverSkills();
    if (skills.length > 0) {
      // 任务文本 = 最近一条用户消息（技能清单按任务相关性排序——第十节 P2）
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const taskText = lastUser && typeof lastUser.content === 'string' ? lastUser.content : undefined;
      messages.unshift(skillMessage(skills, taskText));
    }
  }
  // -0.5) 代码库结构感知（repo map，P1）：首轮注入一次紧凑符号地图（文件: 符号列表）——
  //       模型对项目结构有概览，避免盲目 list_directory。可配置关闭。
  const repoMap = opts.repoMap !== false;
  const hasRepoMap = messages.some(
    (m) => typeof m.content === 'string' && m.content.startsWith(REPO_MAP_PREFIX)
  );
  if (repoMap && !hasRepoMap && messages.length > 0) {
    const map = await buildRepoMap(process.cwd(), { maxSymbols: opts.repoMapMaxSymbols ?? 200 });
    if (map) {
      messages.unshift({ role: 'system', content: `${REPO_MAP_PREFIX}，供快速了解项目结构]\n${map}` });
    }
  }
  // 3) 长对话摘要压缩（recorder：压缩成功时记 compact 轨迹事件）
  await summarizeContext(client, model, messages, opts, recorder);
}
