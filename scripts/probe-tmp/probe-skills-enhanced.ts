/**
 * 技能系统探针（第十节）：frontmatter 扩展 + 渐进披露 + 安装即时生效 + context:fork 子代理执行。
 *
 * 运行：npx tsx scripts/probe-tmp/probe-skills-enhanced.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseSkillFrontmatter,
  discoverSkills,
  skillMessage,
  refreshSkillInjections,
  createSkillTool,
  SKILL_LIST_MAX,
  SKILL_PREFIX,
} from '../../src/agent/skill.js';

let failed = 0;
function assert(cond: boolean, label: string, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed++;
    console.error(`  ✗ ${label}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`);
  }
}

/** 构造临时技能目录树 */
function makeSkillDir(root: string, skills: { name: string; fm: string }[]): void {
  for (const s of skills) {
    const dir = path.join(root, '.agents', 'skills', s.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${s.fm}---\n\n# ${s.name}\n\n指令内容\n`);
  }
}

async function main(): Promise<void> {
  console.log('=== A. frontmatter 扩展解析（agentskills.io 标准字段）===');
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
  assert(fm.name === 'react-best-practices', 'name 解析');
  assert(fm['disable-model-invocation'] === true, 'disable-model-invocation 布尔解析');
  assert(fm['user-invocable'] === true, 'user-invocable yes → true');
  assert(fm.context === 'fork', 'context: fork 解析');
  assert(fm.agent === 'reviewer', 'agent 解析');
  assert(fm.background === true, 'background 解析');

  console.log('=== B. 发现 + SkillInfo 扩展字段 ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-skill-'));
  makeSkillDir(tmp, [
    { name: 'git-release', fm: 'name: git-release\ndescription: 发布流程\n' },
    { name: 'secret-handler', fm: 'name: secret-handler\ndescription: 处理密钥\ndisable-model-invocation: true\n' },
    { name: 'fork-skill', fm: 'name: fork-skill\ndescription: 子代理执行技能\ncontext: fork\nagent: reviewer\n' },
  ]);
  fs.mkdirSync(path.join(tmp, '.git')); // git 根边界：阻止向上扫到真实全局技能
  const all = await discoverSkills(tmp);
  const localSkills = all.filter((s) => s.path.startsWith(tmp));
  assert(localSkills.length === 3, `临时技能发现 3 个（实际 ${localSkills.length}）`);
  assert(all.length >= 3, `总发现 ≥3（含全局，实际 ${all.length}）`);
  const secret = all.find((s) => s.name === 'secret-handler');
  assert(secret?.disableModelInvocation === true, 'disable-model-invocation 进 SkillInfo');
  const fork = all.find((s) => s.name === 'fork-skill');
  assert(fork?.context === 'fork' && fork?.agent === 'reviewer', 'context/agent 进 SkillInfo');

  console.log('=== C. 清单渐进披露（skillMessage）===');
  // 过滤 disable-model-invocation
  const visible = all.filter((s) => !s.disableModelInvocation);
  const msg = skillMessage(all);
  const content = String(msg.content);
  assert(!content.includes('secret-handler'), 'disable-model-invocation 技能不进清单');
  assert(content.includes('git-release'), '普通技能在清单');
  assert(content.includes('子代理执行'), 'context:fork 技能标注子代理');
  // 超量截断
  const many = Array.from({ length: SKILL_LIST_MAX + 5 }, (_, i) => ({
    name: `skill-${i}`, description: `desc ${i}`, path: '', global: false,
  }));
  const msgMany = String(skillMessage(many).content);
  assert(msgMany.includes('还有 5 个技能未列出'), `超量提示剩余（${SKILL_LIST_MAX}+5 时）`);
  assert(msgMany.includes('skill-0') && !msgMany.includes(`skill-${SKILL_LIST_MAX}`), '只列前 N 条');

  console.log('=== D. 安装即时生效（refreshSkillInjections）===');
  const msgs = [{ role: 'user' as const, content: '你好' }];
  // 首次：追加
  refreshSkillInjections(msgs, all);
  const injected = msgs.filter((m) => typeof m.content === 'string' && m.content.startsWith(SKILL_PREFIX));
  assert(injected.length === 1, '首次注入 1 条清单');
  // 再次：替换不重复
  const more = [...all, { name: 'new-skill', description: '新装', path: '', global: false }];
  refreshSkillInjections(msgs, more);
  const injected2 = msgs.filter((m) => typeof m.content === 'string' && m.content.startsWith(SKILL_PREFIX));
  assert(injected2.length === 1, '重复注入仍 1 条（替换）');
  assert(String(injected2[0].content).includes('new-skill'), '替换后含新技能');
  // 消息顺序：清单在 user 之前
  const userIdx = msgs.findIndex((m) => m.role === 'user');
  const skillIdx = msgs.findIndex((m) => typeof m.content === 'string' && m.content.startsWith(SKILL_PREFIX));
  assert(skillIdx >= 0 && skillIdx < userIdx, '清单消息在 user 之前');

  console.log('=== E. createSkillTool：context:fork 子代理执行 ===');
  const oldCwd = process.cwd();
  process.chdir(tmp); // createSkillTool 的 execute 用 process.cwd() 发现技能
  // 无 delegate 工具 → 降级返回内容
  const toolNoDelegate = createSkillTool({ tools: [] } as never);
  const resNoDel = await toolNoDelegate.execute({ name: 'fork-skill' });
  assert(resNoDel.includes('降级为直接返回内容') && resNoDel.includes('指令内容'), '无 delegate → 降级返回内容');
  // 有 delegate 工具 → 调用 delegate.execute 传 task/agent
  let delegateCalled = false;
  const delegateMock = {
    name: 'delegate',
    description: '',
    parameters: {},
    execute: async (a: Record<string, unknown>) => {
      delegateCalled = true;
      assert(String(a.task).includes('fork-skill'), `delegate task 含技能名（${String(a.task).slice(0, 40)}…）`);
      assert(a.agent === 'reviewer', `delegate agent 透传（${a.agent}）`);
      return '[子代理结果] 完成';
    },
  };
  const toolWithDelegate = createSkillTool({ tools: [delegateMock] } as never);
  const resWithDel = await toolWithDelegate.execute({ name: 'fork-skill' });
  assert(delegateCalled && resWithDel.includes('[子代理结果]'), 'context:fork → delegate 子代理执行并回传');
  // 普通技能：返回内容
  const resNormal = await toolWithDelegate.execute({ name: 'git-release' });
  assert(resNormal.includes('指令内容'), '普通技能返回内容');
  // 未知名
  const resUnknown = await toolWithDelegate.execute({ name: 'no-such' });
  assert(resUnknown.includes('未找到技能'), '未知名报错');
  process.chdir(oldCwd);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed === 0 ? '\n✓✓ 技能系统探针全部通过' : `\n✗✗ ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
