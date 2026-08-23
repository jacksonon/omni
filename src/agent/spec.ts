/**
 * Spec-driven 强化（1.0 P1-7，Kiro 三件套轻量版）：
 * `/spec <特性>` —— 一次 LLM 生成三件套落盘 `.omni/specs/<slug>/`：
 * · requirements.md（EARS 格式验收条款：WHEN…THE SYSTEM SHALL…）
 * · design.md（方案设计）
 * · tasks.md（`- [ ]` 任务清单——同步进会话 todoList，TodoWrite 面板可见逐项执行）
 */
import { mkdir, writeFile } from 'node:fs/promises';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

const SPEC_SYSTEM_PROMPT =
  '你是 Omni 的规格工程师。给定一个功能特性，输出实施规格三件套，用以下三个分隔标记组织（标记必须原样出现且各一次）：\n' +
  '=== REQUIREMENTS ===\nEARS 格式验收条款（每条形如「当 <触发/场景> 时，系统应当 <可验证的行为>」），覆盖功能/边界/错误处理，5-10 条。\n' +
  '=== DESIGN ===\n技术方案：改动点按子系统分组、关键接口/数据流变化、风险与回滚。\n' +
  '=== TASKS ===\n实施任务清单，每行一条 `- [ ] 任务描述（含验证方式）`，按依赖排序，5-12 条。\n只输出以上内容，不要额外解释。';

/** slug 化目录名 */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'feature'
  );
}

export interface SpecResult {
  ok: boolean;
  dir?: string;
  tasks?: string[];
  message: string;
}

/** 解析三段标记；缺失段落返回 null */
export function parseSpecSections(text: string): { requirements: string; design: string; tasks: string[] } | null {
  const reqM = text.split('=== REQUIREMENTS ===')[1];
  const designM = reqM ? reqM.split('=== DESIGN ===') : null;
  const tasksM = designM && designM[1] ? designM[1].split('=== TASKS ===') : null;
  if (!reqM || !designM || designM.length < 2 || !tasksM || tasksM.length < 2) return null;
  const requirements = designM[0].trim();
  const design = tasksM[0].trim();
  const tasks = tasksM[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^- \[[ x]?\]/.test(l) || /^- /.test(l))
    .map((l) => l.replace(/^- \[[ x]?\]\s*/, '').replace(/^-\s*/, '').trim())
    .filter(Boolean);
  if (!requirements || !design) return null;
  return { requirements, design, tasks };
}

/** 生成并落盘三件套；tasks 同步进传入的 todoList（会话任务板逐项执行） */
export async function generateSpec(
  client: OpenAI,
  model: string,
  feature: string,
  cwd = process.cwd(),
  todoList?: { content: string; status: 'in_progress' | 'completed' | 'pending' }[]
): Promise<SpecResult> {
  let raw = '';
  try {
    const stream = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SPEC_SYSTEM_PROMPT },
        { role: 'user', content: feature },
      ],
      stream: true,
    });
    for await (const chunk of stream) raw += chunk.choices[0]?.delta?.content ?? '';
  } catch (err) {
    return { ok: false, message: `生成失败（${err instanceof Error ? err.message : err}），请重试。` };
  }
  const sections = parseSpecSections(raw);
  if (!sections) return { ok: false, message: '模型输出缺少三件套标记（REQUIREMENTS/DESIGN/TASKS），请重试或换模型。' };
  const dir = `${cwd}/.omni/specs/${slugify(feature)}`;
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/requirements.md`, `# Requirements：${feature}\n\n${sections.requirements}\n`, 'utf8');
  await writeFile(`${dir}/design.md`, `# Design：${feature}\n\n${sections.design}\n`, 'utf8');
  const taskLines = sections.tasks.map((t) => `- [ ] ${t}`);
  await writeFile(`${dir}/tasks.md`, `# Tasks：${feature}\n\n${taskLines.join('\n')}\n`, 'utf8');
  if (todoList) {
    todoList.splice(0, todoList.length, ...sections.tasks.map((content) => ({ content, status: 'pending' as const })));
  }
  return {
    ok: true,
    dir,
    tasks: sections.tasks,
    message: `已生成规格三件套 → ${dir}/{requirements,design,tasks}.md（${sections.tasks.length} 条任务已同步进会话清单）`,
  };
}
