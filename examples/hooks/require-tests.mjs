#!/usr/bin/env node
/**
 * Stop 示例 hook：测试套件为红时阻止 agent 收尾，要求继续修复。
 *
 * 配置：
 *   "hooks": { "Stop": [{ "command": "node examples/hooks/require-tests.mjs" }] }
 *
 * 从 stdin 读事件 JSON（{ cwd, stop_hook_active }）：
 *   · 测试通过 / stop_hook_active=true → { decision: "continue" }（放行收尾）；
 *   · 测试失败 → { decision: "block", reason }（要求 agent 继续修）。
 * stop_hook_active=true 后自动放行——只允许续一次，防 hook 让 agent 无限循环。
 * 注意：npm test 不是每个项目都有，请按项目实际测试命令修改。
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const input = JSON.parse(readFileSync(0, 'utf8'));
const cwd = String(input.cwd ?? process.cwd());
if (input.stop_hook_active === true) {
  console.log(JSON.stringify({ decision: 'continue' })); // 已续过一次 → 放行
  process.exit(0);
}
try {
  execSync('npm test --silent 2>&1', { timeout: 120_000, cwd, stdio: 'ignore' });
  console.log(JSON.stringify({ decision: 'continue' }));
} catch {
  console.log(JSON.stringify({ decision: 'block', reason: '测试未通过，请继续修复并重新验证' }));
}
