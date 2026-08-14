/**
 * skill：模型按需加载已安装技能（Agent Skill / SKILL.md）的完整内容。
 *
 * 对标 opencode 的 skill 工具：系统只常驻技能清单（name + description，见
 * agent/skill.ts 的 skillMessage），模型发现任务匹配某个技能时按 name 加载全文。
 * 技能只读（加载指令内容），不修改任何文件，不经过安全护栏的写操作语义。
 */
import { loadSkillContent } from '../agent/skill.js';
import type { Tool } from './types.js';

export const skillTool: Tool = {
  name: 'skill',
  description:
    '加载一个已安装技能（Agent Skill）的完整 SKILL.md 指令内容。' +
    '技能清单（name + description）在系统消息的 [已发现技能] 段里；' +
    '当任务需要某项专门技能（如 git-release、react-best-practices）时按 name 加载它，' +
    '按其中给出的步骤执行。技能只读，不修改文件。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名（如 git-release；来自 [已发现技能] 清单）' },
    },
    required: ['name'],
  },
  async execute(args) {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return '错误：缺少技能名 name';
    const content = await loadSkillContent(name);
    return content ?? `错误：未找到技能「${name}」。可用技能见系统消息的技能清单（/skill 命令可查看）。`;
  },
};
