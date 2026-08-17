#!/usr/bin/env node
/**
 * PreToolUse 示例 hook（安全护栏 enforcement）：硬拦截危险 shell 命令。
 *
 * 配置：
 *   "hooks": { "PreToolUse": [{ "matcher": "run_command", "command": "node examples/hooks/guard-dangerous.mjs" }] }
 *
 * 与 /permission 分级的关系：permission=safe 时危险命令是「询问用户」，依赖交互；
 * 本 hook 是**规则型强制**——不依赖模型自觉、不需要用户在场，命中即 block（无副作用），
 * 原因以「已拦截（hook）」回传模型。规则清单与 src/safety/policy.ts 的危险命令库对齐。
 *
 * 注意：PreToolUse 只对该事件的所有 matcher 命中项运行；本脚本也拦截 git push（同库），
 * 若只想拦 push 可用更聚焦的 guard-git-push.mjs。
 */
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const command = String(input.tool_input?.command ?? '');

const DANGEROUS = [
  { re: /(\s|^)rm\s+-[a-z]*r[a-z]*f\s+\//, msg: '对根目录执行 rm -rf' },
  { re: /(\s|^)mkfs/, msg: '格式化磁盘（mkfs）' },
  { re: /(\s|^)dd\s+if=/, msg: 'dd 写盘' },
  { re: /(\s|^)(shutdown|reboot|halt)\b/, msg: '关机/重启命令' },
  { re: /:\(\)\s*\{/, msg: '检测到 fork bomb' },
  { re: /(\s|^)git\s+push\b/, msg: 'git push（不可逆的远程推送）' },
  { re: /(\s|^)chmod\s+-R\s+[0-7]{3}\s+\//, msg: '对根目录递归改权限' },
  { re: /(\s|^)(curl|wget)\b.*\|\s*(ba)?sh\b/, msg: '管道执行远程脚本（curl | sh）' },
];

const hit = DANGEROUS.find(({ re }) => re.test(command));
if (hit) {
  console.log(JSON.stringify({ decision: 'block', reason: `${hit.msg}：${command.slice(0, 120)}` }));
} else {
  console.log(JSON.stringify({ decision: 'approve' }));
}
