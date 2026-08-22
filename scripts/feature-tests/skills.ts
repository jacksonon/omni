/**
 * 功能测试：技能系统（frontmatter 扩展 / 渐进披露 / 安装即时生效 / 子代理执行）。
 * 纯函数断言（import 源文件），无需网络。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestSuite } from './framework.js';
import {
  parseSkillFrontmatter,
  discoverSkills,
  skillMessage,
  refreshSkillInjections,
  createSkillTool,
  SKILL_LIST_MAX,
  SKILL_PREFIX,
} from '../../src/agent/skill.js';

function makeSkillDir(root: string, skills: { name: string; fm: string }[]): void {
  for (const s of skills) {
    const dir = path.join(root, '.agents', 'skills', s.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${s.fm}---\n\n# ${s.name}\n\n指令内容\n`);
  }
}

export function skillsSuite(): TestSuite {
  const suite = new TestSuite('技能系统（frontmatter 扩展 / 渐进披露 / 即时生效 / 子代理）');

  suite.test('frontmatter 扩展解析：全部标准字段', () => {
    const fm = parseSkillFrontmatter(`---
name: react-best-practices
description: React 最佳实践
disable-model-invocation: true
user-invocable: yes
context: fork
agent: reviewer
background: true
---

# body
`);
    suite.assert(fm.name === 'react-best-practices', 'name 解析');
    suite.assert(fm['disable-model-invocation'] === true, 'disable-model-invocation 布尔');
    suite.assert(fm['user-invocable'] === true, 'user-invocable yes → true');
    suite.assert(fm.context === 'fork', 'context: fork');
    suite.assert(fm.agent === 'reviewer', 'agent');
    suite.assert(fm.background === true, 'background');
  });

  suite.test('发现 + SkillInfo 扩展字段（git 根边界隔离）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-skill-'));
    makeSkillDir(tmp, [
      { name: 'git-release', fm: 'name: git-release\ndescription: 发布流程\n' },
      { name: 'secret-handler', fm: 'name: secret-handler\ndescription: 处理密钥\ndisable-model-invocation: true\n' },
      { name: 'fork-skill', fm: 'name: fork-skill\ndescription: 子代理执行技能\ncontext: fork\nagent: reviewer\n' },
    ]);
    fs.mkdirSync(path.join(tmp, '.git'));
    const all = await discoverSkills(tmp);
    const local = all.filter((s) => s.path.startsWith(tmp));
    suite.assert(local.length === 3, `临时技能发现 3 个（实际 ${local.length}）`);
    const secret = all.find((s) => s.name === 'secret-handler');
    suite.assert(secret?.disableModelInvocation === true, 'disable-model-invocation 进 SkillInfo');
    const fork = all.find((s) => s.name === 'fork-skill');
    suite.assert(fork?.context === 'fork' && fork?.agent === 'reviewer', 'context/agent 进 SkillInfo');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  suite.test('清单渐进披露：过滤 disable-model-invocation + 超量截断', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-skill2-'));
    makeSkillDir(tmp, [
      { name: 'a', fm: 'name: a\ndescription: a desc\n' },
      { name: 'b', fm: 'name: b\ndescription: b desc\ndisable-model-invocation: true\n' },
      { name: 'fork-x', fm: 'name: fork-x\ndescription: fork desc\ncontext: fork\n' },
    ]);
    fs.mkdirSync(path.join(tmp, '.git'));
    const all = await discoverSkills(tmp);
    const msg = String(skillMessage(all).content);
    suite.assert(!msg.includes('b desc'), 'disable-model-invocation 技能不进清单');
    suite.assert(msg.includes('a desc'), '普通技能在清单');
    suite.assert(msg.includes('子代理执行'), 'context:fork 标注子代理');
    // 超量截断
    const many = Array.from({ length: SKILL_LIST_MAX + 5 }, (_, i) => ({
      name: `skill-${i}`, description: `desc ${i}`, path: '', global: false,
    }));
    const msgMany = String(skillMessage(many).content);
    suite.assert(msgMany.includes('还有 5 个技能未列出'), '超量提示剩余');
    suite.assert(msgMany.includes('skill-0') && !msgMany.includes(`skill-${SKILL_LIST_MAX}`), '只列前 N 条');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  suite.test('安装即时生效：refreshSkillInjections 注入/替换不重复', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-skill3-'));
    makeSkillDir(tmp, [{ name: 'one', fm: 'name: one\ndescription: 1\n' }]);
    fs.mkdirSync(path.join(tmp, '.git'));
    const all = await discoverSkills(tmp);
    const msgs = [{ role: 'user' as const, content: '你好' }];
    refreshSkillInjections(msgs, all);
    suite.assert(msgs.filter((m) => typeof m.content === 'string' && m.content.startsWith(SKILL_PREFIX)).length === 1, '首次注入 1 条');
    // 新技能安装后再次刷新：替换不重复
    makeSkillDir(tmp, [{ name: 'new-skill', fm: 'name: new-skill\ndescription: 新装\n' }]);
    const more = await discoverSkills(tmp);
    refreshSkillInjections(msgs, more);
    suite.assert(msgs.filter((m) => typeof m.content === 'string' && m.content.startsWith(SKILL_PREFIX)).length === 1, '替换不重复');
    suite.assert(String(msgs.find((m) => typeof m.content === 'string' && m.content.startsWith(SKILL_PREFIX))!.content).includes('new-skill'), '替换后含新技能');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  suite.test('createSkillTool：context:fork 子代理执行 + 降级', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-skill4-'));
    makeSkillDir(tmp, [
      { name: 'fork-skill', fm: 'name: fork-skill\ndescription: fork\ndescription2: x\ncontext: fork\nagent: reviewer\n' },
      { name: 'plain', fm: 'name: plain\ndescription: plain\n' },
    ]);
    fs.mkdirSync(path.join(tmp, '.git'));
    const oldCwd = process.cwd();
    process.chdir(tmp);
    try {
      // 无 delegate → 降级返回内容
      const toolNoDel = createSkillTool({ tools: [] } as never);
      const resNoDel = await toolNoDel.execute({ name: 'fork-skill' });
      suite.assert(resNoDel.includes('降级为直接返回内容'), '无 delegate 降级');
      // 有 delegate → 透传 task/agent
      let called = false;
      const delegateMock = {
        name: 'delegate', description: '', parameters: {},
        execute: async (a: Record<string, unknown>) => {
          called = true;
          suite.assert(String(a.task).includes('fork-skill'), 'task 含技能名');
          suite.assert(a.agent === 'reviewer', 'agent 透传');
          return '[子代理结果] ok';
        },
      };
      const tool = createSkillTool({ tools: [delegateMock] } as never);
      const res = await tool.execute({ name: 'fork-skill' });
      suite.assert(called && res.includes('[子代理结果]'), 'delegate 子代理执行并回传');
      // 普通技能返回内容
      const resPlain = await tool.execute({ name: 'plain' });
      suite.assert(resPlain.includes('指令内容'), '普通技能返回内容');
      // 未知名
      suite.assert((await tool.execute({ name: 'no-such' })).includes('未找到技能'), '未知名报错');
    } finally {
      process.chdir(oldCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  return suite;
}