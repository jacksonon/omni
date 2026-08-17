/**
 * 上下文管理：让长对话与多文件任务在有限的上下文窗口里跑得更久。
 *
 * 四条策略（各自独立开关，由 config 注入，入口层统一调用）：
 *   0. **全局记忆**（globalAgentsFile）：~/.config/omni/AGENTS.md（尊重 XDG_CONFIG_HOME）
 *      ——跨项目共享的用户偏好/习惯，所有会话首轮加载，排在项目记忆之前（级联：
 *      项目可覆盖/细化全局，与配置体系「低→高」优先级语义一致）；
 *   1. **项目记忆 AGENTS.md**（agentsFile）：跨会话共享的项目记忆——每次会话首轮
 *      自动加载最近的 AGENTS.md 进上下文（system 消息），模型无需重新摸索项目
 *      （查找规则与配置发现一致：从 cwd 向上找，git 根与 home 为边界）；
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
import { discoverSkills, skillMessage, SKILL_PREFIX } from './skill.js';
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
  /** Hooks 运行器（PreCompact：压缩前 fire-and-forget；attachRuntime 注入） */
  hooks?: HookRunner;
}

/** 预载消息内容前缀（同内容重复判断 / 调试识别用） */
const PRELOAD_PREFIX = '[已按任务预载相关文件';

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
  const threshold = opts.summarizeAt ?? 0;
  if (threshold <= 0 || messages.length <= threshold) return;
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
 *   1. 项目记忆 AGENTS.md：首轮（尚未注入过）自动加载最近的 AGENTS.md；
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
  //    在预载之后 unshift → 排在预载文件之前，紧跟循环的 SYSTEM_PROMPT）
  const agentsFile = opts.agentsFile !== false;
  const hasMemory = messages.some(
    (m) => typeof m.content === 'string' && m.content.startsWith(MEMORY_PREFIX)
  );
  if (agentsFile && !hasMemory && messages.length > 0) {
    const mem = await loadProjectMemory();
    if (mem) messages.unshift(memoryMessage(mem));
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
    if (skills.length > 0) messages.unshift(skillMessage(skills));
  }
  // 3) 长对话摘要压缩（recorder：压缩成功时记 compact 轨迹事件）
  await summarizeContext(client, model, messages, opts, recorder);
}
