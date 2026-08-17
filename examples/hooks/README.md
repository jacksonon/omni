# Hooks 示例集（可运行）

Hooks 生命周期自动化的官方示例脚本。所有脚本遵循 JSON 协议：事件上下文经 **stdin** 喂入、
在 **stdout** 打印一个 JSON 决策对象。每个脚本头注释含用法配置，可直接复制进 `omni.json` 的
`hooks` 字段。

## 安全护栏 enforcement（P1 示例集）

> **语义**：`/permission` 分级的危险命令处理是「询问用户」（依赖交互）；AGENTS.md 里的
> 「不要编辑 .env」只是请求（依赖模型自觉）。PreToolUse hook 是**规则型强制**——
> 命中即 `decision: block`，在安全闸门之前硬拦截、绝不执行（无副作用），不依赖模型、不依赖交互。

| 脚本 | 事件 / matcher | 拦截什么 |
|---|---|---|
| `guard-env.mjs` | PreToolUse · `write_file` | 写入 `.env*` / 含 secret/credential/token 的路径 / `.pem` 证书 |
| `guard-dangerous.mjs` | PreToolUse · `run_command` | 危险命令（rm -rf /、mkfs、dd 写盘、关机重启、fork bomb、git push、chmod -R /、`curl \| sh`） |
| `guard-git-push.mjs` | PreToolUse · `run_command` | `git push`（含 force，不可逆远程推送） |

组合示例（三防全开）：

```jsonc
"hooks": {
  "PreToolUse": [
    { "matcher": "write_file",   "command": "node examples/hooks/guard-env.mjs" },
    { "matcher": "run_command",  "command": "node examples/hooks/guard-dangerous.mjs" },
    { "matcher": "run_command",  "command": "node examples/hooks/guard-git-push.mjs" }
  ]
}
```

> 注意：PreToolUse 按 **matcher 命中**运行——同事件的多个 hook（如上 3 个）都会执行，
> 任一返回 block 即拦截。挂到子代理同样生效（子代理工具调用共用同一 HookRunner）。

## 开发闭环（模型自修复）

| 脚本 | 事件 / matcher | 作用 |
|---|---|---|
| `lint-hook.mjs` | PostToolUse · `write_file` | 编辑后自动跑 ESLint，`hookSpecificOutput` 回传模型自修复 |
| `require-tests.mjs` | Stop | 测试不过不允许收尾（`stop_hook_active` 只续一次防死循环） |
| `rewrite-prompt.mjs` | UserPromptSubmit | 给每条用户消息注入项目规范（`updatedPrompt` 改写） |

## 生命周期事件（P1 事件补全）

| 事件 | 触发时机 | 说明 |
|---|---|---|
| `SessionStart` | 会话开始（每会话一次） | `hookSpecificOutput` 注入首轮系统提示词（如启动策略） |
| `SubagentStart` / `SubagentStop` | 子代理开始 / 结束 | 任务与结论回传（fire-and-forget） |
| `PreCompact` | 长对话摘要压缩前 | 归档/通知（fire-and-forget） |

配置分层：`hooks` 在**全局配置（~/.config/omni/omni.json）与项目配置（omni.json）可同时声明，
各层叠加合并**（同事件全部运行，低层在前）——全局放通用护栏、项目放仓库专属规则，互不覆盖。

## 调试

- `scripts/mock-hook.mjs <mode>`：本地 mock hook（`pass/block/updated/output/rewrite/notify/fail/slow` 八模式）
- `scripts/probe-tmp/probe-hooks.ts`：单元 + 端到端验证（含 P1 事件/分层/子代理）
- 超时（默认 60s）/命令失败/输出非 JSON → 降级放行，失败原因回显到终端（`⚡ hook[事件] …`）
