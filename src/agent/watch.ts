/**
 * Watch 模式（`omni watch`，第十二节 P2，Aider AI!/AI? 注释监听同款）：
 * 文件系统监听工作区——检测到源码文件里的 `AI!` / `AI?` 注释标记时触发 agent 执行：
 *
 * · `AI!` —— 执行注释描述的任务，完成后**删除该行注释**（要求必须处理）；
 * · `AI?` —— 执行并把结果**写回为注释**在下一行（咨询，保留原问题行）。
 *
 * 标记语法（任意注释符后跟 AI!/AI?，行内其余文本 = 任务描述）：
 *   # AI! 修复这个函数的边界情况
 *   // AI? 这段逻辑的时间复杂度是多少？
 *
 * 实现：fs.watch 递归监听 cwd（排除 node_modules/.git/dist 等）；去抖聚合事件 →
 * 扫描修改文件的标记行 → 每个标记独立跑一轮 agent（复用 runAgent + 工具链，
 * 权限档位沿用配置）；执行期间暂停监听（防自触发——agent 改文件又扫到标记）。
 */
import { watch, type FSWatcher } from 'node:fs';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type OpenAI from 'openai';
import { runAgent } from './loop.js';
import type { RunOptions } from './types.js';
import type { Output } from '../output/types.js';

/** 监听排除目录（与检查点快照一致 + .omni） */
const WATCH_EXCLUDE = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.omni', '.worktrees',
  'release', 'release-electron', 'coverage', '.next', '.cache', '.venv',
]);

/** 监听的文本扩展名（二进制/媒体无意义） */
const WATCH_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.php',
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.sh', '.zsh', '.css', '.html', '.vue', '.svelte',
]);

/** 单文件扫描上限（1MB；更大不扫） */
const SCAN_MAX_BYTES = 1024 * 1024;

export interface AiMarker {
  file: string;
  line: number;
  /** 任务描述（标记后的文本；空 = 整行就是标记） */
  task: string;
  /** true = AI!（执行并删行）/ false = AI?（执行并回写答案注释） */
  mustFix: boolean;
  /** 原始行内容（写回答案时保持缩进风格） */
  rawLine: string;
}

/**
 * 扫描一个文本文件里的 AI!/AI? 标记行。
 * 匹配：行内出现 `AI!` 或 `AI?`（前面是注释语境——宽松处理为任意位置，Aider 同款）。
 */
export function scanAiMarkers(content: string, file: string): AiMarker[] {
  const out: AiMarker[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const bang = line.includes('AI!');
    const question = !bang && line.includes('AI?');
    if (!bang && !question) continue;
    if (bang && question) {
      // 同行两个标记（罕见）按 AI! 处理
    }
    const tagIdx = bang ? line.indexOf('AI!') : line.indexOf('AI?');
    const task = line.slice(tagIdx + 3).replace(/^[\s:：]+/, '').trim();
    out.push({ file, line: i + 1, task, mustFix: bang, rawLine: line });
  }
  return out;
}

/** 递归收集目录下的候选文本文件（跳过排除目录；上限 2000 防失控） */
async function collectFiles(dir: string, out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 8 || out.length >= 2000) return out;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env') {
      if (WATCH_EXCLUDE.has(e.name)) continue;
    }
    if (WATCH_EXCLUDE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await collectFiles(full, out, depth + 1);
    } else if (WATCH_EXTENSIONS.has(path.extname(e.name))) {
      out.push(full);
      if (out.length >= 2000) return out;
    }
  }
  return out;
}

/**
 * Watch 循环：初始全量扫描 → fs.watch 递归监听 → 去抖处理变更文件。
 * 返回停止函数。onEvent 回调输出进度（watch 启动/发现标记/任务完成）。
 */
export async function runWatch(
  client: OpenAI,
  model: string,
  messages: never,
  opts: RunOptions,
  output: Output,
  onEvent: (text: string) => void,
  cwd = process.cwd()
): Promise<() => void> {
  /** 处理单个标记：跑一轮 agent → 按标记类型改写文件 */
  const processMarker = async (marker: AiMarker): Promise<void> => {
    const label = path.relative(cwd, marker.file);
    onEvent(`${label}:${marker.line} ${marker.mustFix ? 'AI!' : 'AI?'} ${marker.task.slice(0, 60) || '（无描述）'}`);
    // 独立消息上下文（每标记一轮，互不污染）
    const msgs: import('openai/resources/chat/completions').ChatCompletionMessageParam[] = [
      {
        role: 'user',
        content:
          `${marker.mustFix ? '代码里有一个 AI! 标记（要求必须处理并删除标记行）' : '代码里有一个 AI? 标记（咨询类：回答问题，不要改动问题行）'}：\n` +
          `文件：${marker.file} 第 ${marker.line} 行\n标记内容：${marker.rawLine.trim()}\n\n` +
          (marker.task ? `任务：${marker.task}` : '请根据上下文判断需要做什么并完成。'),
      },
    ];
    try {
      await runAgent(client, model, msgs, opts, output);
      // 改写文件：AI! → 删除标记行（若仍存在）；AI? → 在标记行下方插入答案注释
      const content = await readFile(marker.file, 'utf8');
      const lines = content.split('\n');
      if (marker.mustFix) {
        const idx = lines.findIndex((l) => l === marker.rawLine);
        if (idx >= 0) lines.splice(idx, 1);
      } else {
        const answerText = [...msgs].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string');
        const answer = answerText && typeof answerText.content === 'string' ? answerText.content.trim().split('\n').slice(0, 10).join('\n') : '（无回答）';
        const idx = lines.findIndex((l) => l === marker.rawLine);
        if (idx >= 0) {
          const indent = marker.rawLine.match(/^\s*/)?.[0] ?? '';
          const commentPrefix = marker.rawLine.trimStart().match(/^(\/\/|#|--|;|\/\*|\*)/)?.[0] ?? '#';
          const answerLines = answer.split('\n').map((l) => `${indent}${commentPrefix} AI答: ${l}`);
          lines.splice(idx + 1, 0, ...answerLines);
        }
      }
      await writeFile(marker.file, lines.join('\n'), 'utf8');
      onEvent(`✓ ${label}:${marker.line} 处理完成`);
    } catch (err) {
      onEvent(`✗ ${label}:${marker.line} 处理失败：${err instanceof Error ? err.message : err}`);
    }
  };

  /** 扫描文件集合并处理全部标记（执行期间调用方已停监听） */
  const scanAndProcess = async (files?: string[]): Promise<void> => {
    const targets = files ?? (await collectFiles(cwd));
    for (const f of targets) {
      try {
        const st = await stat(f);
        if (!st.isFile() || st.size > SCAN_MAX_BYTES) continue;
        const content = await readFile(f, 'utf8');
        const markers = scanAiMarkers(content, f);
        for (const m of markers) await processMarker(m);
      } catch {
        // 读失败（权限/竞态删除）跳过
      }
    }
  };

  // 初始全量扫描
  onEvent(`👁 Watch 模式启动（${cwd}）——监听 AI!/AI? 注释标记`);
  await scanAndProcess();

  let pending: NodeJS.Timeout | null = null;
  let changed = new Set<string>();
  let watcher: FSWatcher | null = null;
  let stopped = false;
  const startWatching = (): void => {
    if (stopped) return;
    try {
      watcher = watch(cwd, { recursive: true }, (_event, filename) => {
        if (!filename || stopped) return;
        const p = String(filename);
        if (p.split(path.sep).some((s) => WATCH_EXCLUDE.has(s))) return;
        if (!WATCH_EXTENSIONS.has(path.extname(p))) return;
        changed.add(path.join(cwd, p));
        if (pending) clearTimeout(pending);
        pending = setTimeout(async () => {
          pending = null;
          // 处理期间停监听（防自触发），完成再恢复
          watcher?.close();
          watcher = null;
          const batch = [...changed];
          changed = new Set();
          await scanAndProcess(batch);
          startWatching();
        }, 800); // 去抖：编辑器保存常连发多事件
      });
    } catch {
      onEvent('⚠ fs.watch 不可用（平台限制），只做了初始扫描');
    }
  };
  startWatching();

  onEvent('提示：在任意被监听文件中写入「# AI! <任务>」触发执行，「# AI? <问题>」触发问答（Ctrl+C 退出）');
  return () => {
    stopped = true;
    watcher?.close();
    if (pending) clearTimeout(pending);
  };
}
