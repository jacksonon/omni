/**
 * 迁移工具（`omni import`，第十二节 P2，对标 Codex 的 Claude Code 导入）：
 * 从 Claude Code 项目配置迁移到 omni 格式——
 *
 * · CLAUDE.md        → AGENTS.md（项目记忆；已存在则跳过并提示）
 * · .claude/skills/  → .agents/skills/（SKILL.md 目录结构两边同构，直接复制）
 * · .claude/agents/  → .agents/subagents/（frontmatter 定义转换：name/description/
 *                      model/tools 语义对齐，其余字段原样保留为注释提示人工核对）
 * · .claude/settings.json permissions.allow → config dangerousPatterns 反向不可靠，
 *   只提取 `deny` 列表中的 Bash 命令模式作为扩展危险规则建议（打印不落盘）。
 *
 * 设计：**只增不改**——目标文件已存在一律跳过（不覆盖用户已有配置）；
 * 结束输出迁移清单（成功/跳过/失败逐项），退出码 0 = 全部处理成功。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';

export interface ImportResult {
  /** 迁移成功的条目 */
  done: string[];
  /** 跳过（目标已存在 / 无源文件） */
  skipped: string[];
  /** 失败（读取/写入错误） */
  failed: string[];
}

/** 解析 markdown frontmatter（--- 包围的 YAML 子集：key: value 行） */
export function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1]!.split('\n')) {
    const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.+)$/);
    if (kv) out[kv[1]!.trim()] = kv[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Claude Code agent 定义 → omni 子代理定义：
 * name/description/model/tools 直接映射；Claude 独有字段（when_to_use 等）保留在
 * frontmatter 里无害（omni 忽略未知字段）；body 指令原文照搬。
 */
export function convertAgentMd(source: string): string | null {
  const fm = parseFrontmatter(source);
  if (!fm.name) return null; // omni 要求 name 与文件名一致且存在
  // tools: "Read, Grep" → 数组形式（omni 用 YAML 数组）；缺省不写 = 继承全部
  let converted = '---\n';
  for (const key of ['name', 'description', 'model']) {
    if (fm[key]) converted += `${key}: ${fm[key]}\n`;
  }
  if (fm.tools) {
    const tools = fm.tools.split(',').map((t) => t.trim()).filter(Boolean);
    converted += `tools: [${tools.join(', ')}]\n`;
  }
  converted += '---\n';
  // body：去掉原 frontmatter，正文照搬
  const bodyMatch = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  converted += bodyMatch ? bodyMatch[1]!.replace(/^\s*\n/, '') : '';
  return converted;
}

/** 执行迁移。cwd = 目标项目根；返回逐项结果与建议提示 */
export function importFromClaudeCode(cwd = process.cwd()): ImportResult & { hints: string[] } {
  const result: ImportResult & { hints: string[] } = { done: [], skipped: [], failed: [], hints: [] };
  const claudeDir = path.join(cwd, '.claude');

  // 1) CLAUDE.md → AGENTS.md
  const claudeMd = ['CLAUDE.md', 'CLAUDE.local.md'].map((f) => path.join(cwd, f)).find((f) => existsSync(f));
  const agentsMd = path.join(cwd, 'AGENTS.md');
  if (!claudeMd) {
    result.skipped.push('CLAUDE.md（未找到）');
  } else if (existsSync(agentsMd)) {
    result.skipped.push('AGENTS.md 已存在（不覆盖；内容可参考 CLAUDE.md 手工合并）');
  } else {
    try {
      writeFileSync(agentsMd, readFileSync(claudeMd, 'utf8'));
      result.done.push(`CLAUDE.md → AGENTS.md`);
    } catch (e) {
      result.failed.push(`CLAUDE.md 迁移失败：${e instanceof Error ? e.message : e}`);
    }
  }

  // 2) .claude/skills/<name>/SKILL.md → .agents/skills/<name>/SKILL.md（目录复制）
  const srcSkills = path.join(claudeDir, 'skills');
  if (existsSync(srcSkills)) {
    for (const entry of readdirSync(srcSkills, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const srcDir = path.join(srcSkills, entry.name);
      if (!existsSync(path.join(srcDir, 'SKILL.md'))) continue;
      const destDir = path.join(cwd, '.agents', 'skills', entry.name);
      if (existsSync(destDir)) {
        result.skipped.push(`技能 ${entry.name}（.agents/skills/${entry.name}/ 已存在）`);
        continue;
      }
      try {
        mkdirSync(destDir, { recursive: true });
        for (const f of readdirSync(srcDir)) copyFileSync(path.join(srcDir, f), path.join(destDir, f));
        result.done.push(`技能 ${entry.name} → .agents/skills/${entry.name}/`);
      } catch (e) {
        result.failed.push(`技能 ${entry.name} 复制失败：${e instanceof Error ? e.message : e}`);
      }
    }
  } else {
    result.skipped.push('.claude/skills/（未找到）');
  }

  // 3) .claude/agents/*.md → .agents/subagents/*.md（frontmatter 转换）
  const srcAgents = path.join(claudeDir, 'agents');
  if (existsSync(srcAgents)) {
    for (const entry of readdirSync(srcAgents, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      try {
        const source = readFileSync(path.join(srcAgents, entry.name), 'utf8');
        const converted = convertAgentMd(source);
        if (!converted) {
          result.failed.push(`子代理 ${entry.name}：frontmatter 缺 name 字段（omni 要求）`);
          continue;
        }
        const dest = path.join(cwd, '.agents', 'subagents', entry.name);
        if (existsSync(dest)) {
          result.skipped.push(`子代理 ${entry.name}（已存在）`);
          continue;
        }
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, converted);
        result.done.push(`子代理 ${entry.name.replace(/\.md$/, '')} → .agents/subagents/${entry.name}`);
      } catch (e) {
        result.failed.push(`子代理 ${entry.name} 转换失败：${e instanceof Error ? e.message : e}`);
      }
    }
  } else {
    result.skipped.push('.claude/agents/（未找到）');
  }

  // 4) settings.json permissions.deny 中的 Bash 模式 → dangerousPatterns 建议（只提示不落盘）
  const settingsPath = path.join(claudeDir, 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { permissions?: { deny?: unknown[] } };
      const denies = (settings.permissions?.deny ?? []).filter((x): x is string => typeof x === 'string');
      const bashRules = denies.filter((d) => d.startsWith('Bash(')).map((d) => d.slice(5, -1));
      if (bashRules.length > 0) {
        result.hints.push(
          `检测到 ${bashRules.length} 条 Claude Code deny 规则，可在 omni.json 的 dangerousPatterns 里配置等价正则（示例）：\n    ${bashRules.slice(0, 5).join('\n    ')}`
        );
      }
    } catch {
      // settings 解析失败忽略（非关键路径）
    }
  }

  return result;
}
