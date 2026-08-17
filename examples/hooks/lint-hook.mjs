#!/usr/bin/env node
/**
 * PostToolUse 示例 hook：write_file 后自动跑 ESLint，结果回传模型自修复。
 *
 * 配置：
 *   "hooks": { "PostToolUse": [{ "matcher": "write_file", "command": "node examples/hooks/lint-hook.mjs" }] }
 *
 * 从 stdin 读事件 JSON（{ cwd, tool_name, tool_input }），对写入的文件跑 eslint，
 * 返回 { hookSpecificOutput: [lint 输出] } —— 输出以「[hook 输出]」追加进工具结果，
 * 模型看到后即可自行修复（自我纠错闭环）。eslint 不可用时降级返回通过提示（fail-open）。
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const input = JSON.parse(readFileSync(0, 'utf8'));
const file = String(input.tool_input?.path ?? '');
const cwd = String(input.cwd ?? process.cwd());
if (!file) {
  console.log(JSON.stringify({})); // 无路径 → 无输出，放行
  process.exit(0);
}
try {
  const out = execSync(`npx eslint --no-color --no-warn-ignored "${file}" 2>&1`, {
    timeout: 30_000,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
  console.log(JSON.stringify({ hookSpecificOutput: [out ? `eslint ${file}:\n${out}` : `eslint ${file}: 通过`] }));
} catch (err) {
  const e = err; // 纯 JS（.mjs）：eslint 失败时 stdout/stderr 带输出，超时/不可用只 message
  const msg = String(e.stdout || e.stderr || e.message || '').trim();
  console.log(JSON.stringify({ hookSpecificOutput: [`eslint ${file}: 存在错误\n${msg || '（eslint 不可用或超时）'}`] }));
}
