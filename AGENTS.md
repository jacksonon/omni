# AGENTS.md — Omni 项目开发指南

> 本文件是 Omni 项目内所有 AI 协作 Agent（Claude Code / Codex / opencode / 本仓库的 omni 自身）的开发指南。
> 本文件保持**精简**（每次会话首轮完整加载，目标 <40KB）；逐文件说明、TUI 实现细节、工具/命令全表见 [`Doc/agents-reference.md`](Doc/agents-reference.md)，历史迭代记录、路线图全文、发布流程等详见文末「文档地图」。

## 项目是什么

Omni 是一个 **Agent 工程**（终端型 AI 编程助手）。
当前为 **1.0 阶段（Beta 功能完备 + 行业标配补齐）**：单 Agent 循环 + 基础工具集 + 安全护栏 + 上下文管理 + 子代理/并行/编排 + MCP 外部工具（tools/resources/prompts/instructions/HTTP+OAuth）+ 记忆系统/会话持久化/技能系统 + 全屏 TUI + **本地后端服务与 Web 界面（`omni web`）+ Electron 桌面应用（mac/win/linux）+ 纯终端 CLI 模式（`omni mini`，Codex CLI 形态）**，无框架依赖（裸 OpenAI SDK + 主循环）。路线图基础项与 1.0 定义项已全部完成（含 /rewind 三模式 code/chat/both），仅剩进阶项：SWE-bench 评测、Windows 原生沙箱（见 `Doc/roadmap.md`）。2026-09 市场对齐批次（动态工作流/插件系统/后台子代理与远程接入/MCP elicitation·sampling/AI 自动审批/会话 pin·archive·/cd/Vim/LSP/密钥脱敏）见 `Doc/TODO.md` 第二部分 I 节。

设计理念：
- **认知优先**：代码是认知梳理对话（见仓库根目录 `Agent开发认知梳理.md`）的落地，保持最小可读，不为"架构好看"引入抽象；
- **可替换后端**：通过 `OMNI_BASE_URL` 兼容所有 OpenAI 协议的服务（OpenAI / DeepSeek / 智谱 / Moonshot 等）。

## 常用命令

CLI 帮助：`omni help` / `omni --help` 显示简洁导航，首页单列远程与配对（`web auth set / pair / web --tunnel / service`）；`omni help <主题>` 展开 `exec / mini / web / sessions / commands / interactive / options / config`，`remote / pair` 主题指向 Web 与远程帮助，`omni help all` 查看全部；加 `--lang zh` 查看中文。交互内 `/settings help` 按类别列出斜杠命令。

```bash
npm run dev -- "<任务>"   # 开发运行（tsx 直接执行）
npm run typecheck         # TypeScript 类型检查
npm run build             # typecheck + tsc 编译 + bun 打包单文件（dist/）
npm start -- "<任务>"     # 运行 tsc 产物（node dist/index.js）
npm run mock              # 启动本地 mock API 服务器（无 Key 端到端验证，端口 8787）
npm run dev:tui -- "<任务>"   # TUI 全屏模式（bun + 真实 TTY）
npm run dev:mini             # 纯终端 CLI 模式（Codex CLI 形态；不带参数 = 交互会话；bun/TTY 下也不进全屏 TUI）
npm run tui:snapshot      # TUI 快照验证（无 TTY，内存渲染断言）
npm run dev:web           # Web 服务（本地后端 + 网页界面，默认 3080 端口，不自动开浏览器）
npx tsx src/index.ts web auth set   # 设置 Web 登录账号密码（scrypt 哈希写全局配置）
npx tsx src/index.ts web --host 0.0.0.0 --tunnel   # 局域网直连 / Cloudflare 快速隧道（需先设置密码）
npx tsx src/index.ts pair                           # 局域网配对：终端链接 + 二维码（一次性配对码）
npx tsx src/index.ts service install --tunnel omni  # 安装 Web+隧道登录服务（macOS LaunchAgent）
npx tsx src/index.ts service start|stop|status|enable|disable|uninstall
npm run web:sync          # 构建 vendor.js + 同步 web/ 静态资源到 src/web/assets.ts（bundle 内嵌副本；开发热更新不需要——server 优先从 web/ 目录读取）
npm run probe:web         # Web 服务 e2e 探针（mock 离线：对话流/审批/提问/取消/模型切换/会话管理）
npm run electron:dev      # Electron 桌面应用（开发：bundle 后端 + electron 窗口）
npm run electron:build    # Electron 桌面应用打包（npm run web:sync + bundle + electron-builder）
npm run eval              # 评估：真实 API 跑任务集 + 完成率报告（eval-report.json）
npm run eval:mock         # 评估：离线 mock（确定性，可进 CI）
npm run dev -- exec "<任务>" --output-format json   # Headless：stdout 只出结果、进度走 stderr（可 | jq / 管道分支）
npm run dev -- mcp-server # Headless：作为 MCP server（omni_exec / omni_reply 工具）
npm run dev -- preset browser # 能力一键预设：浏览器自动化双雄 MCP 写入全局配置
npm run dev -- plugin list    # 插件管理：install/list/enable/disable/remove（plugin.json 打包技能/子代理/hooks/MCP）
npm run models:snapshot   # 模型能力快照重建（models.dev → src/config/model-context-snapshot.ts）
npm run dev -- "spec <特性>" # /spec 规格三件套（requirements-EARS/design/tasks 落盘 .omni/specs/）
npx tsx scripts/eval/run-headless-eval.ts # headless 结构化评测（含 token/成本/空转/失败类别报告）
curl -fsSL <release>/scripts/install.sh | sh # 一键安装原生二进制（零依赖，含 TUI）
```

> ⚠️ **打包需要 bun**（`bundle` / `compile` / `npm pack` 的 prepack 都会调用 bun）：`bun --version` 验证。开发运行（`dev`）不需要。


## 构建与发布（三种产物）

| 产物 | 命令 | 说明 |
|---|---|---|
| `dist/omni.cjs`（~730K） | `npm run bundle` | **单文件 JS 包**（内联 openai SDK），需 Node ≥18；npm 安装即用此文件 |
| `release/omni`（~57M） | `npm run compile` | **原生二进制**（bun compile，含运行时，零依赖、无需 Node），平台相关（arm64/x64），适合直接分发；macOS 自动 ad-hoc 重新签名（`scripts/sign-macos.mjs`） |
| `omni-<版本>.tgz` | `npm pack` | **npm 安装包**（自动 prepack 构建），`npm install -g omni-0.1.0.tgz` 全局安装后可直接用 `omni` 命令 |

打包注意：
- 原生二进制输出到 `release/`（已 gitignore），**不进 npm 包**（平台相关）；
- npm 包只发布 `dist/`（`files` 字段），体积约 150K；
- 全局安装测试：`npm install -g ./omni-0.1.0.tgz --prefix <前缀>`。

**GitHub Actions 自动发布**（`.github/workflows/release.yml`）：推送 `v*` tag → 五平台矩阵构建（原生二进制）+ Electron 四平台打包（zip/exe/AppImage）→ GitHub Release 附 10 产物 + npm 平台子包/主包自动发布（Secrets 需 `NPM_TOKEN`）。平台包安装验证对 registry 延迟最多重试约 15 分钟（60 × 15s，不含安装耗时），非 404 类错误立即失败。**完整流程与关键坑**（musl 补装、Electron 镜像、发布脚本、版本重发策略）见 `Doc/release-guide.md`。
## 配置（配置文件 + 环境变量 + CLI 参数）

参考 opencode 的配置体系，支持 JSON / **JSONC**（带注释）。

**优先级（低 → 高）**：默认值 → 全局配置 → 项目配置 → 自定义配置 → 环境变量 → CLI 参数

| 层级 | 位置 | 说明 |
|---|---|---|
| 全局配置 | `~/.config/omni/omni.json` | 用户级默认（尊重 `XDG_CONFIG_HOME`） |
| 项目配置 | `omni.json` / `omni.jsonc` | 从当前目录向上找，最近的生效；git 根与 home 为边界 |
| 自定义配置 | `OMNI_CONFIG` 环境变量 或 `--config <路径>` | 显式指定 |
| 环境变量 | `OMNI_API_KEY` / `OMNI_BASE_URL` / `OMNI_MODEL` / `OMNI_MAX_STEPS` / `OMNI_SHOW_THINKING` / `OMNI_PERMISSION` / `OMNI_DEBUG` | 覆盖配置文件；`OMNI_DEBUG=1` 打印发往 LLM 的完整请求体 |
| CLI 参数 | `-m, --model <名称>` | 最高优先级 |

**配置字段**：

```jsonc
{
  "model": "deepseek-chat",              // 模型名（默认 gpt-4o-mini）
  // 端点/密钥只认下方 providers 分组（或环境变量 OMNI_BASE_URL / OMNI_API_KEY）——配置文件不再解析顶层 baseURL/apiKey/userAgent
  "maxSteps": 50,                         // Agent 最大循环步数（防死循环兜底；典型任务 15 次内完成）
  "showThinking": true,                   // 展示思考过程（默认 true；false 关闭终端显示，仍落盘 .omni/last-thinking.md）
  "permission": "safe",                  // 安全护栏权限分级：full（任意命令直通）/ safe（危险命令询问，默认）/ ask / read
  "dangerousPatterns": [],               // 危险命令扩展正则（可选）：内置清单之外的命令在 safe 及以上档位触发审批
  "sandbox": "off",                      // OS 级沙箱：off（默认）/ read-only / workspace-write / danger-full-access（macOS sandbox-exec / Linux bwrap·firejail 包裹 run_command；Windows 原生未支持→沙箱启用时默认 fail-closed）
  "sandboxFailClosed": true,             // 沙箱启用（read-only/workspace-write）时**默认 true**：无沙箱原语/网络无法内核强制则拒绝执行；显式 false 退回降级（不安全）；sandbox=off / danger-full-access 不受影响
  "repoMap": true,                       // 代码库结构感知：首轮注入紧凑符号地图（函数/类/常量，默认 true）
  "repoMapMaxSymbols": 200,              // repo map 符号上限
  "webAuth": { "username": "omni", "passwordHash": "scrypt$…", "secret": "…", "sessionDays": 30 }, // Web 账号密码（omni web auth set 生成；局域网/隧道/小程序；口令只存哈希）
  "webFetchDomains": [],                 // web_fetch 工具域名允许列表（空 = 全部允许）
  "webSearchApiKey": "",                 // web_search 工具 API key（Brave Search；缺省回退环境变量 BRAVE_API_KEY）
  "auditLog": true,                       // 写审计日志（~/.config/omni/audit.log；默认 true）
  "agentsFile": true,                     // 项目记忆 AGENTS.md：每次会话首轮**嵌套加载**所有层级的 AGENTS.md（从 cwd 向上到 git 根/home 边界，越贴近 cwd 权重越高；默认 true）
  "globalAgentsFile": true,               // 全局记忆 ~/.config/omni/AGENTS.md：跨项目用户偏好，排在项目记忆之前（级联；默认 true）
  "autoMemory": true,                     // 交互模式退出时把新偏好自动追加进全局记忆（默认 true；单次任务不触发）
  "summarizeAt": 40,                      // 长对话摘要压缩阈值（消息数；0 = 关闭）
  "redactSecrets": true,                  // 密钥脱敏（2026-09）：会话 JSONL / 回放时把 sk-*/Bearer/AWS 等替换为 [REDACTED]（默认开）
  "autoReview": false,                    // AI 自动审批（2026-09，对标 Codex --approve-for-me）：需要审批的操作先经模型审阅，失败回退人工；不改变权限/沙箱边界
  "vimMode": false,                       // TUI 输入框 Vim 键位（2026-09）：Esc normal / i insert；/vim 运行时切换
  "maxConcurrentSubagents": 4,           // delegate 子代理并发上限（2026-09，前后台共享信号量，超限排队）
  "plugins": ["my-plugin"],              // 启用的插件（2026-09）：~/.config/omni/plugins/<名>/plugin.json，加载 skills/agents/hooks/mcpServers
  // 手动覆盖上下文窗口（单位 token，如 512000 = 512K；缺省跟随模型自动；/context 256|400|512|750|1000|默认 调整并持久化）
  // "contextLimit": 512000,
  "preloadFiles": true,                   // 预载任务文本中出现的相关文件（默认 true）
  "allowSubagents": true,                 // 启用子代理 delegate 工具（默认 true）
  "skills": true,                          // 启用技能（SKILL.md）发现与 skill 工具（默认 true）
  "reasoningEffort": "medium",             // 当前模型思考级别（reasoning_effort；不配置 = 不带该参数，用模型默认）
  "reasoningEffortOptions": ["low", "medium", "high", "xhigh", "max"], // /variants 思考级别选项——优先级：不写=查表（models.dev）→ 未命中回退默认档位（low/medium/high/xhigh/max + none/auto）；写了（含空数组=明确关闭）则最高优先
  "statuslineAlign": "center",             // 兼容保留（底部状态行已移除，忽略）
  "architect": "gpt-5",                  // 模型路由：/plan 计划模式用强模型（缺省回退当前模型）
  "editor": "gpt-5-mini",                // 模型路由：执行阶段用轻模型（缺省回退当前模型）
  "providers": {                      // 多模型端点（/model 切换）——**端点/密钥的唯一格式**（旧版扁平 models 表与顶层 baseURL/apiKey/userAgent 解析已移除）：
                                      //   一个网关挂多模型，baseURL/apiKey 只写一次；模型条目缺省字段回退网关；
                                      //   分组级 headers：自定义请求头（设置→模型配置可编辑）——值支持 {sessionId}/{session} 占位符 = 当前会话 id
                                      //   （OpenCode Go 等网关要求的 x-opencode-session 在此配置，请求发出前解析、并发会话互不串号）；
                                      //   per-model variants：reasoningEffortOptions = 该模型 /variants 面板支持的思考级别选项、reasoningEffort = 当前级别——缺省回退顶层同名字段；
                                      //   /model 切换到该模型自动带出（面板/请求同步），/variants 切换持久化到 providers."<组>".models."<名>".reasoningEffort（仅该模型生效）
                                      //   命名 variants（1.0）：variants = { id: { description?, reasoningEffort?, body?, headers? } } 请求叠加层，variant = 当前选中 id；/variants 面板同时列出思考级别和命名 variants
                                      //   apiModel = 发给 API 的真实模型名（目录友好名 ≠ API 名），displayName = 面板显示名，limit/modalities/capabilities = 元数据
                                      //   protocol = 传输协议 completions（默认，/chat/completions）/ responses（/responses；muse-spark 等 Responses-only 模型，未配时按名自动走 responses，Chat 400 协议不支持也会自动切一次）
                                      //   端点兜底只来自环境变量 OMNI_BASE_URL / OMNI_API_KEY；模型名带 / 时改挂 "<网关>/<模型>"
    "bigmodel": { "baseURL": "https://open.bigmodel.cn/api/paas/v4", "apiKey": "sk-glm", "models": { "glm-4-flash": { … } } }
  },
  "mcpServers": {                         // MCP 外部工具（可选）：{ 名称: { command, args?, env? } | { url, headers? }；enabledTools?/disabledTools? 白黑名单；defaultToolsApprovalMode? = auto|prompt|writes|approve }
    "demo": { "command": "node", "args": ["scripts/mock-mcp.mjs"] }
  },
  "hooks": {                              // Hooks 生命周期自动化（可选，对标 Claude Code）：{ 事件: [{ matcher?, command, timeoutMs? }] }
    // 事件：UserPromptSubmit（改写 prompt）/ PreToolUse（JSON 返回 decision:block 硬拦截 + updatedInput 改写参数）/ PostToolUse（hookSpecificOutput 回传上下文）/ Stop（block 要求继续修）/ Notification
    "PostToolUse": [
      { "matcher": "write_file", "command": "sh scripts/lint-hook.sh", "timeoutMs": 30000 }
    ]
  }
}
```

示例文件：`omni.example.jsonc`（复制为 `omni.json` 使用）。API Key 也兼容 `OPENAI_API_KEY`。

## 架构速览

### 模块分层

> 完整 `src/`/`scripts/` 逐文件说明、TUI 渲染实现要点、工具与斜杠命令全表见 [`Doc/agents-reference.md`](Doc/agents-reference.md)。

- **入口与客户端**：`src/index.ts`（CLI 调度：main / exec / mcp-server / web / doctor / completion / review / resume / fork / 会话归档 / mcp 子命令）→ `main.ts` 参数调度 → `client.ts` 按模型端点建 OpenAI 客户端（`/model` 切换重建；`ModelRuntime` 共享引用让主循环/子代理同步）；headless `omni exec` 与 MCP server 在 `src/exec.ts`；CLI 分层帮助在 `src/cli/help.ts`，console / TUI 启动入口共用，先于配置加载与终端初始化。
- **Agent 核心** `src/agent/`：`loop.ts` 主循环；`context.ts` 全局/项目记忆级联注入 + 相关文件预载 + 长对话摘要压缩；`messages.ts` / `thinking.ts`；`session.ts` 会话 JSONL 落盘；`undo.ts` 撤销 + 重做；`subagent.ts` / `subagent-registry.ts` 子代理与 Agent View；`orchestrate.ts` 动态工作流 + `/goal`；`team.ts` 共享看板；`memory.ts` 记忆；`skill.ts` 技能；`redact.ts` 密钥脱敏；`events.ts` / `trace.ts` 轨迹。
- **工具** `src/tools/`：静态 8 个（read_file / write_file / edit_file / list_directory / search_code / run_command / skill / lsp）+ 运行时注入（delegate / ask_user / task_board / send_message / web_search / web_fetch / MCP `<server>_<tool>`）。
- **安全** `src/safety/`：`index.ts` 统一闸门（policy 判定 + 审批 + 审计）、`policy.ts` 权限分级与危险命令检测、`trust.ts` 工作区信任、`sandbox.ts` OS 沙箱、`audit.ts` 审计、`auto-review.ts` AI 自动审批。
- **前端/渲染**（同一运行时，多套 Output）：`ui.ts` + `cli/`（console / interactive / mini）· `src/tui/`（全屏 OpenTUI，命令式渲染；**改前必读 `Doc/tui-architecture.md`**）· `src/web/`（REST + SSE 本地后端）· `electron/`（桌面应用）。
- **配置** `src/config/`：分层加载（默认 → 全局 → 项目 → 自定义 → 环境变量 → CLI）+ JSONC + `model-context.ts` 模型能力查表（`/settings models refresh` 热替换）。
- **扩展**：`src/hooks/` 生命周期自动化 · `agent/plugins.ts` 插件系统 · MCP `tools/mcp.ts` + `mcp-oauth.ts`。

### 核心循环（src/agent/loop.ts）

```
for step in 1..maxSteps:
  1. 流式调用 LLM（携带全部历史消息 + 系统提示词）
  2. 无工具调用 → 输出最终回答，结束
  3. 有工具调用 → 解析 JSON 参数 → **并行执行**（Promise.all）
     · 每个调用先过 Safety 闸门（权限分级 + 审批 + 审计）
  4. 结果按原顺序以 role=tool 回传 → 回到 1
```

关键机制：
- **自我纠错**：工具执行失败/被拒时，错误信息作为工具结果返回给模型，由模型自己修正；
- **安全护栏**：每个工具调用（含 MCP 外部工具与子代理）过 `Safety.gate`——权限分级（full 直通/safe 危险命令询问/ask 全询问/read 只读）+ 审批 UI（console readline / TUI 审批卡片，管道模式自动拒绝）+ OS 沙箱（沙箱启用时默认 fail-closed，`sandboxFailClosed` 缺省 true）+ 审计日志；
- **并行工具**：一次响应的多个 tool_calls 并发执行（Promise.all），结果按调用顺序回传；
- **截断**：工具结果超过 8000 字符会被截断并提示模型"用 read_file 定向获取"，防止上下文被撑爆；
- **防死循环**：`maxSteps` 上限（默认 50；典型任务 15 次内完成，20 对复杂任务偏紧）。

## 对 AI Agent 的协作规范

1. **改代码前先读**相关文件，不要凭空猜测；
2. 遵守现有风格：TypeScript strict、ESM（NodeNext）、无框架依赖、中文注释 + 英文命名；
3. **保持 MVP 简洁**：能不加抽象就不加；新功能先写直白代码，出现明显重复再考虑提炼；
4. **修改工具时**：必须同步更新 `tools.ts` 中的 JSON Schema 与 `description`（description 是写给模型看的说明书，直接决定模型会不会用）；
5. **架构或命令有变化时**：同步更新本文件，并在 `Doc/evolution-log.md` 追加一行；
6. 涉及破坏性操作（删文件、全局安装、git 推送等）前先与用户确认。

## 路线图（摘要）

> 全部历史条目见 `Doc/roadmap.md`；可做事项 backlog 与 1.0 规划（调研/差距矩阵/发布工程）见合并后的 `Doc/TODO.md`。

- [x] **MVP → 完整能力（已完成）**：Agent 循环 + 工具 + mock e2e → 安全护栏（权限分级/审批/审计/工作区信任/OS 沙箱 2.0）→ 上下文管理（截断/摘要压缩/预载）→ 评估体系 → CLI/TUI → MCP（双传输/Resources/Prompts/OAuth/通知流）→ 子代理与编排 → 记忆系统（嵌套 AGENTS.md/渐进披露/TTL/结构化）→ 会话持久化/检查点/撤销 → 技能系统 → Web/Electron 多前端 → Headless 与 CI（协议冻结 + omni-action）→ **1.0**（providers 模型层/Web 多会话并发/子代理 worktree 隔离/Hooks 扩展/压缩 2.0/LSP 反馈/预设/规格/遥测/eval 成本报告/发布工程）
- [x] **2026-09 市场对齐批次（第一百七十八次）**：动态工作流 / Mission 编排（task_board + send_message + 并发预算 + `/team`）· 插件系统（plugin.json + `omni plugin` + 运行时加载）· 后台子代理 + `/tasks` + Web 远程令牌 · MCP elicitation/sampling + 2026-07-28 分页发现 + DCR/CIMD · AI 自动审批（autoReview）· 会话 pin/archive/`/cd`/Vim/LSP/密钥脱敏 · 修复 MCP 子进程阻止退出（stdio unref）
- [ ] 进阶：SWE-bench 评测、Windows 原生沙箱（AppContainer 需原生模块）

## 文档地图

| 文档 | 内容 |
|---|---|
| `Doc/evolution-log.md` | 全部迭代记录（第一次 ~ 第二百四十七次，按时间倒序） |
| `Doc/tui-architecture.md` | TUI 渲染实现细节（OpenTUI 踩坑/布局预算/交互设计） |
| `Doc/roadmap.md` | 路线图全量条目 |
| `Doc/release-guide.md` | 构建与发布完整流程（CI/npm/关键坑） |
| `Doc/TODO.md` | 可做事项 backlog + 1.0 调研与规划（合并版：当前待办 / 调研・差距矩阵 / 1.0 TODO / 发布工程 / 不做清单 / 领先项） |
| `Doc/Usage-Guide.md` · `Doc/使用指导.md` | 用户手册（英 / 中） |
| `Doc/Headless-Protocol.md` | Headless 协议冻结说明 |
| `Doc/research-terminal-agents-2026.md` | 全市场 Agent Harness 调研原始报告 |
| `README.md` · `README.zh-CN.md` | 项目总览 / 快速开始 |
| `config.schema.json` · `schemas/` | 配置 JSON Schema / 协议冻结 Schema |
| `Doc/agents-reference.md` | 详细架构参考（完整 `src/`/`scripts/` 文件树 / TUI 实现要点 / 工具与斜杠命令全表） |
| `Doc/specs/` | 功能规格历史文档（从仓库根目录迁入，见 `Doc/specs/README.md`） |
