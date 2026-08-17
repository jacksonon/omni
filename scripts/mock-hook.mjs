#!/usr/bin/env node
/**
 * mock hook 脚本（hooks e2e 验证用）：读 stdin 的 hook 事件 JSON，
 * 按第一个参数（mode）返回对应的 JSON 决策：
 *   pass     —— 默认放行（approve / continue / 原样）
 *   block    —— PreToolUse / Stop 返回 decision: block + reason（硬拦截 / 要求继续）
 *   updated  —— PreToolUse 返回 decision: approve + updatedInput（改写工具参数）
 *   output   —— PostToolUse 返回 hookSpecificOutput（追加回传上下文，如 lint 结果）
 *   rewrite  —— UserPromptSubmit 返回 updatedPrompt（改写 prompt）
 *   notify   —— Notification 返回 hookSpecificOutput（通知输出）
 *   fail     —— 输出非 JSON（验证失败降级放行）
 *   slow     —— 睡眠 2s 再输出（验证超时降级放行）
 * 用法：node scripts/mock-hook.mjs <mode>
 */
import { readFileSync } from 'node:fs';

const mode = process.argv[2] ?? 'pass';
const input = JSON.parse(readFileSync(0, 'utf8'));
const event = input.hook_event_name;

let out;
switch (mode) {
  case 'block':
    if (event === 'PreToolUse') {
      out = { decision: 'block', reason: 'mock 拦截：禁止写入 .env 类文件' };
    } else if (event === 'Stop') {
      out = { decision: 'block', reason: 'mock 要求继续检查测试' };
    } else {
      out = { decision: 'approve' };
    }
    break;
  case 'updated':
    out = { decision: 'approve', updatedInput: { content: 'hooked-content\n' } };
    break;
  case 'output':
    out = { hookSpecificOutput: ['mock-lint: 0 errors, 0 warnings'] };
    break;
  case 'rewrite':
    out = { updatedPrompt: `${input.prompt}（mock hook 改写）` };
    break;
  case 'notify':
    out = { hookSpecificOutput: ['mock-notification: session complete'] };
    break;
  case 'fail':
    out = '这不是 JSON';
    break;
  case 'slow':
    await new Promise((r) => setTimeout(r, 2000));
    out = { decision: 'approve' };
    break;
  default:
    out = { decision: 'approve' };
    break;
}
console.log(JSON.stringify(out));
