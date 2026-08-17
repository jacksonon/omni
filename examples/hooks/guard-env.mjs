#!/usr/bin/env node
/**
 * PreToolUse 示例 hook：硬拦截对敏感文件的写入（.env / 密钥 / 证书）。
 *
 * 配置：
 *   "hooks": { "PreToolUse": [{ "matcher": "write_file", "command": "node examples/hooks/guard-env.mjs" }] }
 *
 * 从 stdin 读事件 JSON（{ tool_name, tool_input }），命中敏感路径时返回
 * { decision: "block", reason } —— 调用在安全闸门前被拦截、绝不执行（无副作用），
 * 原因以「已拦截（hook）」回传模型。其余写入返回 { decision: "approve" } 放行。
 */
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const filePath = String(input.tool_input?.path ?? '');
const base = filePath.split('/').pop() ?? '';
// 命中规则：.env* 文件名 / 含 secret|credential 的路径 / 证书后缀
if (/^\.env(\.|$)/.test(base) || /(secret|credential|token)/i.test(filePath) || /\.pem$/.test(base)) {
  console.log(JSON.stringify({ decision: 'block', reason: `禁止写入敏感文件：${filePath}` }));
} else {
  console.log(JSON.stringify({ decision: 'approve' }));
}
