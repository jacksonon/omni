#!/usr/bin/env node
/**
 * PreToolUse 示例 hook（安全护栏 enforcement）：硬拦截 git push（含 force）。
 *
 * 配置：
 *   "hooks": { "PreToolUse": [{ "matcher": "run_command", "command": "node examples/hooks/guard-git-push.mjs" }] }
 *
 * 场景：仓库 AGENTS.md 里写「不要 push」只是请求（模型可能忽略）；
 * 挂上本 hook 后 `git push` / `git push --force` 在安全闸门前被硬拦截、绝不执行——
 * 「规则」与「保证」的分界线（Claude Code 观点）。需要放行时移除 hook 或改 matcher。
 */
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const command = String(input.tool_input?.command ?? '');

if (/(\s|^)git\s+push\b/.test(command)) {
  console.log(JSON.stringify({ decision: 'block', reason: 'git push 被 guard-git-push hook 拦截（不可逆的远程推送）' }));
} else {
  console.log(JSON.stringify({ decision: 'approve' }));
}
