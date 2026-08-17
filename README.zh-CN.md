# Omni

[English](README.md) | [中文](README.zh-CN.md)

**Agent 工程**（终端型 AI 编程助手）。

当前处于 **Beta 阶段（功能完备）**：单 Agent 循环 + 6 个基础工具（+ delegate 子代理 + MCP 外部工具）+ 安全护栏 + 上下文管理 + 记忆系统/会话持久化/技能系统，无框架依赖（裸 OpenAI SDK + 主循环），并带一个全屏 TUI 界面。

## 特性

- **Agent 主循环**：流式调用 LLM → 工具调用（并行执行）→ 执行 → 结果回传，支持自我纠错（工具失败信息回传由模型自行修正）
- **8 个工具（6 基础 + 2 注入）**：基础 `read_file` / `write_file` / `list_directory` / `search_code`（优先 ripgrep）/ `run_command`（危险命令拦截）/ `skill`（技能 SKILL.md 按需加载）+ 运行时注入 `delegate`（子代理）+ `mcp_*`（MCP 外部工具）
- **安全护栏**：权限分级（full / safe / ask / read）+ 危险命令确认 + 审批 UI + 审计日志
- **上下文管理**：工具结果截断、相关文件预载、长对话摘要压缩
- **思考过程展示**：流式实时显示（浅色保留在屏幕），完整思考落盘 `.omni/last-thinking.md`
- **TUI 全屏界面**：内容区滚动、底部多行输入框交互模式（多轮对话）、Markdown 行式渲染（表格/列表/代码块）、工具卡片点击展开、**输入框 `@` 提及文件**（目录逐层浏览、Tab/Enter/点击插入）、25 个 `/` 命令（主题/权限/计划/思考折叠/撤销/重做/模型切换/思考级别/技能/记忆生成/子代理/MCP/压缩/导出/状态/上下文/恢复/改名/审查/diff/诊断/配置 等）——`/` 命令联想与 `@` 提及都是**圆角背景浮层**（悬停在输入框上方，非模态，可继续输入）
- **技能系统（Agent Skill）**：自动发现 `.opencode/skills`、`.claude/skills`、`.agents/skills` 下的 SKILL.md（项目向上 + 全局），首轮注入技能清单，模型用 `skill` 工具按需加载；`/skill` 命令列出 / `find <词>` 网络检索 skills.sh / `add` 安装
- **记忆系统（AGENTS.md）**：项目记忆 + 全局记忆（`~/.config/omni/AGENTS.md`）级联加载（每次会话首轮自动注入，超长截断），`/init` 项目 / `/init --global` 全局一键生成，会话结束自动提取新偏好写入全局记忆（偏好去重/矛盾合并）
- **会话持久化**：交互对话 JSONL 落盘（`~/.config/omni/sessions/`），`--continue` / `-r <id>` / `-l` / `/resume` 跨进程恢复，会话标题（终端窗口标题 + meta 落盘）
- **Hooks（生命周期自动化）**：在生命周期事件上挂 shell 命令——改写用户 prompt（`UserPromptSubmit`）、硬拦截工具调用（`PreToolUse`）、把工具后的输出回传模型（`PostToolUse`，如 lint 结果）、要求 agent 修完再停（`Stop`）、会话完成通知（`Notification`），另有 `SessionStart` 注入上下文、子代理 hooks（`SubagentStart`/`SubagentStop` + 子代理工具 Pre/Post）、`PreCompact`；JSON 协议（stdin 喂入 / stdout 返回），matcher 工具名通配，配置分层合并（全局+项目），stderr 捕获，超时/失败降级放行
- **可替换后端**：`OMNI_BASE_URL` 兼容所有 OpenAI 协议服务（OpenAI / DeepSeek / 智谱 / Moonshot / Grok 等）
- **分层配置**：默认值 → 全局配置 → 项目配置 → 自定义配置 → 环境变量 → CLI 参数（JSONC 支持注释）
- **四种产物**：单文件 JS 包（`dist/omni.cjs`，console 版）、原生二进制（`release/omni`，TUI 版）、console npm 包（`omni-<版本>.tgz`）、TUI npm 包（`omni-tui-<版本>.tgz`，需 bun）；GitHub Actions 打 tag 自动构建发布

## 快速开始

### 方式一：npm 全局安装（console 版，需 Node ≥ 18）

```bash
npm install -g omni-0.4.0.tgz   # 或发布后 npm install -g omni
omni "帮我看看这个目录的结构"
```

### 方式二：TUI 版 npm 包安装（需 bun ≥ 1.3）

官方 `omni` npm 包运行在 Node 上，无法包含 TUI（OpenTUI 依赖 bun 原生 FFI）。全屏 TUI 由独立包 `omni-tui` 分发（bin 同为 `omni`，打包时原生库外置，安装时按平台经 `optionalDependencies` 自动装上对应 `@opentui/core-*` 变体）：

```bash
npm install -g ./omni-tui-0.4.0.tgz
omni "帮我看看这个目录的结构"     # 真实 TTY 下自动进入全屏 TUI（单任务）
omni                            # 交互式多轮对话
```

> ⚠️ `omni-tui` 与 `omni` 的 bin 同名，安装前先 `npm uninstall -g omni`。

### 方式三：开发运行（需 Node ≥ 18）

```bash
npm install
npm run dev -- "列出当前目录的文件"
```

### 方式四：TUI 开发运行（需 bun）

```bash
npm run dev:tui -- "任务描述"     # 单任务
npm run dev:tui                   # 交互式多轮对话
```

### 配置 API Key

```bash
export OMNI_API_KEY=sk-xxx
export OMNI_BASE_URL=https://api.deepseek.com/v1   # 可选，默认 OpenAI
export OMNI_MODEL=deepseek-chat                     # 可选
```

或复制 `omni.example.jsonc` 为 `omni.json` 按需修改（⚠️ 项目配置已 gitignore，避免 API Key 明文入库）。

## 配置

支持 JSON / JSONC（带注释）。优先级（低 → 高）：

```
默认值 → 全局配置 → 项目配置 → 自定义配置 → 环境变量 → CLI 参数
```

| 层级 | 位置 | 说明 |
|---|---|---|
| 全局配置 | `~/.config/omni/omni.json` | 用户级默认（尊重 `XDG_CONFIG_HOME`） |
| 项目配置 | `omni.json` / `omni.jsonc` | 从当前目录向上找，最近的生效 |
| 自定义配置 | `OMNI_CONFIG` 或 `--config <路径>` | 显式指定 |
| 环境变量 | `OMNI_API_KEY` / `OMNI_BASE_URL` / `OMNI_MODEL` / `OMNI_MAX_STEPS` / `OMNI_SHOW_THINKING` / `OMNI_PERMISSION` / `OMNI_DEBUG` | 覆盖配置文件 |
| CLI 参数 | `-m, --model <名称>` | 最高优先级 |

常用环境变量：`OMNI_DEBUG=1` 打印发往 LLM 的完整请求体；`OMNI_SHOW_THINKING=0` 关闭终端思考显示（仍落盘）。

配置字段（示例见 `omni.example.jsonc`）：

```jsonc
{
  "model": "deepseek-chat",              // 模型名（默认 gpt-4o-mini）
  "baseURL": "https://api.deepseek.com/v1", // OpenAI 兼容 API 地址
  "apiKey": "sk-xxx",                    // 更推荐用环境变量 OMNI_API_KEY
  "userAgent": "Mozilla/5.0 …",          // 自定义 UA（部分网关 WAF 拦截 SDK 默认 UA 时可配置）
  "maxSteps": 50,                        // Agent 最大循环步数（防死循环兜底）
  "showThinking": true,                  // 展示思考过程（仍落盘）
  "permission": "safe",                  // 安全护栏：full / safe（默认）/ ask / read
  "auditLog": true,                      // 写审计日志（默认 true）
  "agentsFile": true,                    // 项目记忆 AGENTS.md：每次会话首轮自动加载（默认 true）
  "globalAgentsFile": true,              // 全局记忆 ~/.config/omni/AGENTS.md：跨项目偏好，级联在项目记忆之前
  "autoMemory": true,                    // 会话结束时把新表达的偏好自动追加进全局记忆
  "summarizeAt": 40,                     // 长对话摘要压缩阈值（0 = 关闭）
  "preloadFiles": true,                  // 预载任务相关文件（默认 true）
  "allowSubagents": true,                // 启用子代理（默认 true）
  "maxSubagentSteps": 10,                // 子代理最大循环步数（默认 10）
  "skills": true,                        // 技能（SKILL.md）发现与 skill 工具（默认 true）
  "reasoningEffort": "medium",            // 当前模型思考级别（reasoning_effort；不配置 = 不带该参数，用模型默认）
  "reasoningEffortOptions": ["low", "medium", "high"], // /variants 支持的思考级别选项（可自定义）
  "models": {                           // 多模型端点（/model 切换/添加）：不同模型可配不同 baseURL/apiKey/userAgent；缺省字段回退顶层；/model add 可运行时添加并持久化
    "glm-4-flash": { "baseURL": "https://open.bigmodel.cn/api/paas/v4", "apiKey": "sk-glm" },
    "moonshot-v1-8k": { "baseURL": "https://api.moonshot.cn/v1" }
  },
  "mcpServers": {                        // MCP 外部工具：{ 名称: { command, args?, env? } }
    "demo": { "command": "node", "args": ["scripts/mock-mcp.mjs"] }
  },
  "hooks": {                              // 生命周期自动化（可选，对标 Claude Code）：{ 事件: [{ matcher?, command, timeoutMs? }] }
    "PostToolUse": [{ "matcher": "write_file", "command": "sh scripts/lint-hook.sh" }]
  }
}
```

完整协议与用例见 [Hooks（生命周期自动化）](#hooks生命周期自动化)。

## Hooks（生命周期自动化）

Hooks 在生命周期事件上挂 shell 命令（对标 Claude Code hooks）。事件上下文经 **stdin** 喂入 hook 脚本，脚本在 **stdout** 返回 JSON 决策——可以改写 prompt、硬拦截工具调用、把额外上下文回传模型（如 lint 结果）、要求 agent 修完再停，或发送通知。

### 配置

```jsonc
"hooks": {
  "UserPromptSubmit": [{ "command": "node scripts/rewrite-prompt.mjs" }],
  "PreToolUse": [
    { "matcher": "write_file", "command": "sh scripts/guard-env.sh", "timeoutMs": 10000 }
  ],
  "PostToolUse": [
    { "matcher": "write_file", "command": "sh scripts/lint-hook.sh", "timeoutMs": 30000 }
  ],
  "Stop": [{ "command": "node scripts/require-tests.mjs" }],
  "Notification": [{ "command": "sh scripts/notify.sh" }]
}
```

每个 hook 条目：

| 字段 | 说明 |
|---|---|
| `command` | 要执行的 shell 命令（必填）——如 `sh lint.sh` / `node guard.mjs` / `python check.py` |
| `matcher` | PreToolUse / PostToolUse 的工具名过滤：`*` = 全部（默认）、`read_*` / `*_file` 通配；其它事件忽略该字段 |
| `timeoutMs` | 超时毫秒（默认 `60000`）；超时 kill 后该事件**降级放行** |

失败放行：未知事件名、空命令、命令启动失败、输出非 JSON、非零退出码都会被忽略——坏掉的 hook 永远不会卡住 agent（失败原因会回显到终端）。

**配置分层**：`hooks` 字段按配置层级**合并**而非覆盖（全局 `~/.config/omni/omni.json` → 项目 `omni.json` → 自定义），hook 累积生效，同 matcher 时后层优先。hook 的 **stderr 也捕获**并与 stdout 一起回显（前缀 `⚡ hook[<事件>] …`）。

### 事件与 JSON 协议

事件上下文写入 hook 的 stdin：`{ "cwd", "hook_event_name", "source", "session_id", "tool_name", "tool_input", "tool_response", "prompt", "stop_hook_active" }`（字段随事件出现）。hook 在 stdout 打印一个 JSON 对象：

| 事件 | 触发时机 | 相关输出字段 |
|---|---|---|
| `UserPromptSubmit` | 用户提交 prompt 后 | `updatedPrompt`（替换 prompt）· `hookSpecificOutput` |
| `PreToolUse` | 工具调用前（参数解析后、安全闸门前） | `decision: "approve" \| "block"` + `reason`（**硬拦截**）· `updatedInput`（合并进工具参数）· `hookSpecificOutput` |
| `PostToolUse` | 工具调用后 | `hookSpecificOutput`（字符串数组，追加进工具结果，如 lint 输出供模型自修复） |
| `Stop` | agent 准备结束 | `decision: "continue" \| "block"` + `reason`（block → 要求 agent 继续修；`stop_hook_active` 置 true 后**只允许续一次**，防死循环） |
| `Notification` | 会话完成（fire-and-forget，不等待） | `hookSpecificOutput` |
| `SessionStart` | 会话开始、首轮之前（仅一次） | `sessionStartOutput`（字符串数组，追加进首个 system 提示作为上下文）· `hookSpecificOutput` |
| `SubagentStart` | delegate 子代理启动 | `hookSpecificOutput` |
| `SubagentStop` | delegate 子代理结束 | `hookSpecificOutput` |
| `PreCompact` | 长对话摘要压缩之前 | `decision: "continue" \| "block"`（block → 本次跳过压缩）· `hookSpecificOutput` |

hook 输出会回显到终端（`⚡ hook[<事件>] …`；TUI 以对话流 dim 行展示，截断 5 行防刷屏）——完整 `hookSpecificOutput` 仍会回传模型。

### 用例

1. **编辑后自动 lint（PostToolUse）**——对刚写入的文件跑 linter 并把结果回传，让模型自己修：
   ```jsonc
   "hooks": { "PostToolUse": [{ "matcher": "write_file", "command": "node examples/hooks/lint-hook.mjs" }] }
   ```
   `examples/hooks/lint-hook.mjs`：从 stdin 读事件 JSON（`.tool_input.path`），对写入的文件跑 ESLint，打印 `{"hookSpecificOutput": ["lint 输出…"]}`——输出以 `[hook 输出]` 追加进工具结果，模型看到后即可修复。
2. **敏感写入防护（PreToolUse）**——无论模型想写什么，`.env` / 密钥类文件一律硬拦截：
   ```jsonc
   "hooks": { "PreToolUse": [{ "matcher": "write_file", "command": "node examples/hooks/guard-env.mjs" }] }
   ```
   `examples/hooks/guard-env.mjs` 检查 `.tool_input.path`，命中 `.env*` / 密钥 / 证书即打印 `{"decision": "block", "reason": "…"}`——调用在**安全闸门之前**被拦截、绝不执行（无副作用），原因以 `已拦截（hook）` 回传模型。
3. **测试不过不许停（Stop）**——测试套件为红时阻止 agent 收尾：
   ```jsonc
   "hooks": { "Stop": [{ "command": "node examples/hooks/require-tests.mjs" }] }
   ```
   `examples/hooks/require-tests.mjs` 跑 `npm test`，失败则打印 `{"decision": "block", "reason": "测试未通过…"}`——要求 agent 继续修（仅一次；`stop_hook_active` 防无限循环），请按项目实际测试命令修改。
4. **改写 prompt（UserPromptSubmit）**——给每条用户消息注入项目策略或额外上下文：
   ```jsonc
   "hooks": { "UserPromptSubmit": [{ "command": "node examples/hooks/rewrite-prompt.mjs" }] }
   ```
   `examples/hooks/rewrite-prompt.mjs` 打印 `{"updatedPrompt": "<原文> + 策略"}`——改写后的 prompt 才是模型实际看到的（UI 仍回显你输入的原话）。
5. **会话完成通知（Notification）**——每次会话结束发通知（fire-and-forget，不阻塞流程）。
6. **危险命令防护（PreToolUse enforcement）**——无论模型意图如何，`rm -rf /`、磁盘擦写等破坏性命令一律硬拦截：
   ```jsonc
   "hooks": { "PreToolUse": [{ "matcher": "run_command", "command": "node examples/hooks/guard-dangerous.mjs" }] }
   ```
   `examples/hooks/guard-dangerous.mjs` 对 `.tool_input.command` 扫描破坏性命令模式，命中即打印 `{"decision": "block", "reason": "…"}`——命令绝不执行（与内置 `safe` 档位互补，这是**规则强制**而非模型自觉）。
7. **拦截 git push（PreToolUse enforcement）**——阻止 agent 推送到远程仓库：
   ```jsonc
   "hooks": { "PreToolUse": [{ "matcher": "run_command", "command": "node examples/hooks/guard-git-push.mjs" }] }
   ```
   `examples/hooks/guard-git-push.mjs` 拦截一切 `git push …` 调用，提示用户自行推送。

> 可运行的示例在 `examples/hooks/`（guard-env / guard-dangerous / guard-git-push / lint-hook / require-tests / rewrite-prompt）——完整目录见 `examples/hooks/README.md`。另附 mock hook（`scripts/mock-hook.mjs`，模式 `pass/block/updated/output/rewrite/notify/fail/slow`）用于测试——单元 + 端到端覆盖见 `scripts/probe-tmp/probe-hooks.ts`。

## Headless 模式（`exec` / `mcp-server`）

把 omni 变成可组合的 Unix 命令（对标 `codex exec` / `claude -p`）：脚本、管道、CI 里非交互执行。

```bash
omni exec "修复 src/foo.test.ts 里失败的测试"                # stdout 只出最终回答
omni exec "总结一下" --output-format json                   # 单个 JSON 对象 → | jq
omni exec "分析这个 diff" --output-schema '{"type":"object","properties":{"verdict":{"type":"string"}},"required":["verdict"]}'
cat test-output.txt | omni exec "修复下面的失败"              # stdin 注入为上下文
omni exec resume <session_id> "接着上次继续"
```

关键语义：

| 维度 | 行为 |
|---|---|
| **stdout 纯净** | stdout 只输出最终结果；进度（思考/工具步骤/错误）全部走 **stderr** —— 可安全 `\| jq` / `> file` |
| **`--output-format`** | `text`（默认，纯文本回答）· `json`（单对象 `{ result, cost_usd, duration_ms, num_turns, session_id, exit_code }`）· `stream-json`（每行一个轨迹事件 `{"t":"ev",…}`，末行 `{"t":"result",…}`——`tail -1` 即得结构化结果） |
| **stdin 两形态** | 任务为 `-` = 整段 stdin 即 prompt；任务给定 + stdin 被管道 = 注入为 `[stdin 输入]` 上下文 |
| **`--max-turns N`** | 步数上限（超出 → 非零退出；管道里 `&&` / `\|\|` 分支） |
| **`--allowed-tools`** | 逗号分隔的工具白名单（纯工具过滤，复用 /plan 只读过滤语义） |
| **`--output-schema`** | 最终回答强制符合 JSON Schema 子集（内联 JSON 或文件路径；不符 → 非零退出 + stderr 列出错误路径） |
| **exit code** | `0` = 正常完成 · `1` = 请求失败 / 触达步数上限 / schema 校验失败 |
| **会话** | 每次执行落盘 JSONL 会话（json 输出带 `session_id`）；`exec resume <id>` 续跑 |

### `omni mcp-server`

以 **MCP server** 形态跑在 stdio JSON-RPC 上，暴露 `omni_exec`（新建会话）与 `omni_reply`（按 `session_id` 继续会话）——外部 harness（Claude Code / opencode …）可把 omni 当子代理用。协议与内置 `tools/mcp.ts` 客户端对称：

```bash
omni mcp-server     # stdio JSON-RPC：initialize / tools/list / tools/call
```

### CI 集成

`examples/ci/omni-fix-ci.yml` —— 对标 anthropics/claude-code-action 的「agent 修 CI」工作流：**只读 job**（只暴露 `OMNI_API_KEY`）复现失败 → 把失败输出管道进 `omni exec "修复…"` → 把 `git diff` 作为 artifact 上传；**独立的有写权限 job** 应用补丁、推送分支、开 PR——生成补丁的 job 里没有任何密钥。安全边界、使用步骤与变体见 `examples/ci/README.md`。

## 架构

```
src/
  index.ts              # CLI 入口：参数 → 配置 → 客户端 → 单次/交互
  main.ts               # attachRuntime：Safety 闸门 + MCP 工具发现 + delegate 注入 + 上下文准备
  client.ts             # OpenAI 客户端工厂：按「模型端点配置」创建（/model 切换不同端点时重建）+ ModelRuntime 共享引用
  exec.ts               # **Headless 执行（`omni exec`）+ MCP server（`omni mcp-server`）**：stdout 只出结果/stderr 进度；--output-format text|json|stream-json（复用 events.ts ev 序列，末行 t=result）；stdin 两形态；--max-turns / --allowed-tools / --output-schema（JSON Schema 子集校验）；exit code 0/1；exec resume <id>；omni_exec/omni_reply MCP 工具
  ui.ts                 # 终端 UI：ANSI 颜色、TTY 检测、spinner、窗口标题
  version.ts            # 版本号常量
  cli/                  # 参数解析 / banner / 交互模式（25 个 / 命令）
  agent/
    loop.ts             # Agent 主循环：流式调 LLM → 并行工具调用 → 执行 → 回传
    thinking.ts         # 思考过程：流式显示 / 落盘
    messages.ts         # 消息组装：assistant 消息构造、工具参数解析
    context.ts          # 上下文管理：相关文件预载 + 长对话摘要压缩（保留脚手架）+ 记忆注入
    memory.ts           # 记忆系统：全局/项目记忆级联发现、加载、截断 + 会话结束自动提取写入（去重/矛盾合并）
    init.ts             # /init [--global]：扫描项目/全局环境 → LLM 生成 AGENTS.md
    session.ts          # 会话持久化：JSONL 落盘 + 列表/恢复（--continue / -r / -l / /resume）
    report.ts           # 会话状态/上下文用量/导出/诊断/配置路径共享逻辑（/status /context /export /doctor /config）
    review.ts           # 代码审查（/review）：typecheck + git diff → LLM 审查
    skill.ts            # 技能系统：SKILL.md 发现 / frontmatter 解析 / 按名加载 / npx skills CLI
    subagent.ts         # 子代理：隔离上下文嵌套循环（共用 Safety 闸门）
    title.ts            # 会话标题：首轮后异步生成，设为终端窗口标题
  safety/               # 安全护栏：权限分级（policy）/ 审批 / 审计日志（audit）
  hooks/                # 生命周期自动化：HookRunner（9 事件、JSON 协议 stdin/stdout、matcher 通配、stderr 捕获、超时/失败降级放行；配置分层合并全局+项目）
  tools/                # 工具注册表：5 基础工具 + skill 静态注册；delegate / mcp_* 运行时注入
    undo.ts             # /undo 文件撤销：write_file 快照 + 恢复 + redo 重做栈
  output/               # 输出层：console / TUI 共用格式化（format.ts 工具卡片、types.ts 接口）
  config/               # 分层合并 / JSONC 解析 / 配置发现
  tui/                  # 命令式渲染的全屏 TUI（state / render / rows / layout / theme / width / markdown / commands / interactive / output / crashlog）
scripts/
  mock-server.mjs       # 本地 mock OpenAI API（无 Key 端到端测试，含标题/摘要/usage 分支）
  mock-mcp.mjs          # mock MCP 服务器（stdio JSON-RPC）
  tui-snapshot.ts       # TUI 快照验证（内存渲染断言）
  pack-tui.sh           # 一键打包 TUI：版本同步 + bundle + npm pack（--compile 额外出原生二进制）
  eval/                 # 评估任务集 + 运行器（mock 离线 / 真实 API）
packages/
  omni-tui/             # TUI npm 包：bundle 产物 + package.json（bin: omni，@opentui/core 平台原生库走 optionalDependencies）
```

核心循环：

```
for step in 1..maxSteps:
  1. 流式调用 LLM（携带全部历史消息 + 系统提示词）
  2. 无工具调用 → 输出最终回答，结束
  3. 有工具调用 → 解析 JSON 参数 → 并行执行（每个调用先过 Safety 闸门）
  4. 结果以 role=tool 回传 → 回到 1
```

关键机制：自我纠错、工具结果 8000 字符截断（提示模型定向读取）、安全护栏（权限分级 + 审批 + 审计）、并行工具执行、子代理隔离上下文、`maxSteps` 防死循环。

## 开发

```bash
npm run dev -- "<任务>"       # 开发运行（tsx）
npm run typecheck             # TypeScript 类型检查
npm run build                 # typecheck + tsc 编译 + bun 打包单文件
npm run mock                  # 本地 mock API 服务器（端口 8787，无 Key 验证）
npm run dev:tui -- "<任务>"    # TUI 全屏模式（bun + 真实 TTY）
npm run tui:snapshot          # TUI 快照验证（内存渲染断言）
npm run bundle:tui            # 打包 TUI bundle（产物 packages/omni-tui/dist/）
npm run pack:tui              # 一键打包 TUI npm 包（版本同步 + bundle + npm pack → omni-tui-<版本>.tgz）
npm run pack:tui:compile      # 一键打包 + 原生二进制（release/omni，零依赖）
npm run eval                  # 评估：真实 API 跑任务集 + 完成率报告
npm run eval:mock             # 评估：离线 mock（确定性，可进 CI）
```

打包需 bun：`npm run bundle`（单文件 JS）、`npm run compile`（原生二进制）、`npm pack`（console npm 包）、`npm run pack:tui`（TUI npm 包一键打包——自动把 `packages/omni-tui/package.json` 版本同步到根版本、清理旧 bundle、平台原生库经 `optionalDependencies` 自动安装）。推送 `v*` tag 后 GitHub Actions 自动构建发布（附 Linux 二进制 + npm 包）。

## 路线图

- [x] MVP：Agent 循环 + 5 基础工具 + mock 端到端测试
- [x] 上下文管理：工具结果截断 → 消息摘要压缩 → 相关文件选择性加载
- [x] 安全护栏：危险命令确认、权限分级、审计日志
- [x] 评估体系：自建任务集 + 完成率统计（mock 离线可进 CI）
- [x] MCP 接入（外部工具生态）
- [x] 子代理（subagent）与并行工具执行
- [x] **记忆系统**：全局记忆 + 项目记忆级联加载（`/init` 项目 / `/init --global` 全局 / 会话结束自动写入 + 偏好去重/矛盾合并）
- [x] **会话持久化**：交互对话 JSONL 落盘 + `--continue` / `-r <id>` / `-l` 跨进程恢复
- [x] **/plan 计划模式**：只读工具过滤 + 输出实施计划，确认后再执行
- [x] **/undo 文件撤销**：write_file 自动快照 + `/undo` / `/undo all` 回滚本次会话修改
- [x] **/permission 运行时权限切换**：低=read 只读 / 中=safe 危险询问（默认）/ 高=ask 全询问 / 全量=full 直通——TUI 面板 + CLI 参数即时切换，子代理同步
- [x] **技能系统（Agent Skill / SKILL.md）**：自动发现 + 清单注入 + `skill` 工具按需加载 + `/skill` 命令（列出 / find 网络检索 / add 安装），对标 opencode
- [x] **更多交互命令**：`/compact` 手动压缩上下文 · `/agents` 查看子代理配置 · `/review` 代码审查（typecheck + git diff → LLM）· `/variants` 切换模型思考级别（reasoning_effort）· `/model` 切换/添加模型（config `models` 可配多端点，切换时重建客户端，子代理同步；`/model add <名称> [--base-url] [--api-key]` 运行时添加并持久化到配置文件）· `/status` 会话状态 · `/context` 上下文用量 · `/export` 导出 Markdown · `/config` 查看配置 · `/mcp` 管理 MCP 服务器（reconnect）· `/diff` 查看改动 · `/rename` 会话改名（meta 落盘）· `/resume` 恢复历史会话 · `/redo` 重做撤销 · `/doctor` 环境诊断
- [x] **Hooks 生命周期自动化**：`UserPromptSubmit` 改写 prompt / `PreToolUse` 硬拦截 + 改写参数 / `PostToolUse` 输出回传（lint）/ `Stop` 要求继续（限一次）/ `Notification` 通知 + `SessionStart` 上下文注入 / `SubagentStart`·`SubagentStop` 子代理 hooks / `PreCompact`——JSON 协议 + matcher 通配 + 配置分层合并（全局+项目）+ stderr 捕获，超时/失败降级放行；enforcement 示例（guard-env / guard-dangerous / guard-git-push）在 `examples/hooks/`
- [x] **Headless 与 CI 集成（对标 codex exec / claude -p）**：`omni exec "任务"`（stdout 只出结果 / stderr 进度、`--output-format text|json|stream-json`、stdin 两形态、`--max-turns`、`--allowed-tools` 工具过滤、exit code 0/1 管道分支）+ `--output-schema` 结构化校验 + `exec resume <id>` 会话续跑 + `omni mcp-server`（omni_exec / omni_reply）+ CI 工作流模板（`examples/ci/omni-fix-ci.yml`：只读 job 生成补丁 → 独立 job 开 PR，密钥不进生成补丁的 job）
- [ ] 进阶：SWE-bench 评测、MCP 资源/提示（prompts）协议、记忆渐进披露/TTL、嵌套 AGENTS.md

## 技术栈

TypeScript strict · ESM（NodeNext）· 裸 openai SDK · @opentui/core（命令式渲染）· 无框架依赖