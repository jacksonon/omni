#!/usr/bin/env node
/**
 * UserPromptSubmit 示例 hook：给每条用户消息追加项目规范。
 *
 * 配置：
 *   "hooks": { "UserPromptSubmit": [{ "command": "node examples/hooks/rewrite-prompt.mjs" }] }
 *
 * 从 stdin 读事件 JSON（{ prompt }），返回 { updatedPrompt } 替换 prompt——
 * 改写后的 prompt 才是模型实际看到的（UI 仍回显你输入的原话）。
 */
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const original = String(input.prompt ?? '');
console.log(
  JSON.stringify({
    updatedPrompt: `${original}\n\n（项目规范：改动前先读文件；不要修改 .env；提交前跑测试）`,
    hookSpecificOutput: ['已注入项目规范'],
  })
);
