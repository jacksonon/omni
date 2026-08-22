# 开源终端型 AI 编码 Agent Harness 调研报告

> 调研时间：2026-08-22 · 方法：websearch/webfetch（官方文档、GitHub releases、第三方评测）· 用途：开源编码 agent 1.0 规划参考
> 信息可信度分级：官方文档/release notes 为准；无法核实的标注「未确认」。

---

## 1. opencode（sst/opencode → anomalyco/opencode，V2）

**形态与安装**
- 终端 TUI 为核心，另有桌面应用（Electron，darwin/linux 安装包）与 IDE 扩展（VS Code/Cursor/Windsurf/Zed/Neovim）。TUI 是 server 的一个客户端。
- 安装：`curl -fsSL https://opencode.ai/install | bash`、`npm i -g opencode-ai`、`brew install anomalyco/tap/opencode`、choco/scoop/pacman/AUR/mise/docker 全覆盖。推荐 WezTerm/Alacritty/Ghostty/Kitty 等现代终端。

**开源与否 / license / 社区活跃度**
- MIT license，100% 开源。仓库已从 `sst/opencode` 移交给 **Anomaly Innovations**（`anomalyco/opencode`），公司化运营但保持开源；配套商业产品 OpenCode Zen（精选模型网关）与企业版。
- 社区规模：**~19–20 万 GitHub stars**（2026 年中多个来源口径 155K→189K→199K 不等），为开源编码 agent 第一名；月活开发者数百万（来源口径 6.5M–16M 不一，未确认精确值）；Discord 大社区；发版极快（几乎每日，2026-08-20 为 v1.18.19）。

**架构（V2）**
- TypeScript monorepo：Bun 运行时 + **Effect** 函数式运行时（服务组合/结构化并发）+ Turborepo；TUI 用 SolidJS/@opentui。
- **V2 核心 = 事件溯源会话引擎**：会话事件（PromptSubmitted / MessageCreated / ToolOutput 等）持久化为 durable event stream，projector/subscriber 消费；SQLite + Drizzle 存 sessions/messages/events/credentials/projects/config。
- client/server 彻底分离（见 Headless 一节）。

**核心循环与内置工具集**
- 主循环 = primary agent 循环；内置 primary agents：**Build**（默认，全工具）与 **Plan**（只读，edit/bash 默认 ask）；隐藏系统 agents：compaction（自动压缩）、title（会话标题）、summary（会话摘要）。
- 内置工具（由权限键位表反推）：read / edit / write / **apply_patch** / bash / glob / grep / list / todowrite+todoread / webfetch / websearch / lsp / skill / question(向用户提问) / task(子代理)；另有 external_directory（越界目录访问）与 **doom_loop**（agent 疑似卡死时的恢复提示）。
- **LSP 集成是招牌差异点**：语言服务器诊断/符号实时反馈进上下文（模型在改代码前就能看到编译错误），支持 TS/Python/Rust/Go/C++/Java 等 18+ 语言。

**上下文管理**
- 长对话自动压缩：隐藏 compaction agent 在需要时把旧上下文折成摘要；API 层有 `POST /session/:id/summarize` 手动触发；无公开的 token 预算配置项细节（未确认）。

**子代理 / 编排**
- 内置 subagents：**general**（多步任务、可并行跑多份）、**explore**（只读快速探索）、**scout**（外部依赖研究——把依赖仓库克隆进托管缓存后交叉阅读，不动工作区）。
- 自定义子代理用 markdown 文件（全局 `~/.config/opencode/agents/` 或项目 `.opencode/agents/*.md`），frontmatter 支持：description / mode(primary|subagent|all) / model（每代理可指定不同模型）/ temperature / top_p / **steps**（步数上限，超限强制收尾）/ permission（per-agent 权限）/ **task 权限**（glob 控制该代理能调用哪些其它子代理，如 `"*": "deny", "orchestrator-*": "allow"`）/ hidden（从 @ 补全菜单隐藏）/ color / disable。
- 子代理运行产生 **child session**，TUI 内有 parent/child 会话导航键位（Leader+Down 进子会话、←/→ 切换兄弟、Up 返回父会话）——「会话树」是一等公民。
- `opencode agent create` 交互式生成代理文件。

**生命周期扩展**
- **Plugins**：TypeScript 插件，hook 生命周期事件（工具执行前后等），可加工具/改行为。
- **Custom commands**：markdown 定义斜杠命令（支持模板参数、指定 agent/model 执行）。
- **Agent Skills**：SKILL.md 目录式技能（name/description 渐进披露 + skill 工具按需加载全文），兼容 Claude skills 生态位置（`.claude/skills` 等）。
- **Formatters**：文件写入后自动跑格式化器并把结果反馈给模型。
- Policies：企业级策略配置。

**MCP**
- 完整 client（stdio/http）；server API 支持运行时动态添加（`POST /mcp`）；per-tool 权限用通配符（`"mymcp_*": "deny"`）。

**记忆**
- AGENTS.md 规则体系：`/init` 分析项目生成 AGENTS.md（建议提交进 git）；全局 `~/.config/opencode/AGENTS.md` + 项目根 + rules 配置目录多层级注入。

**会话管理**
- SQLite 存储；session 可 share（生成公开链接，默认不共享）；**fork at message**（从任意消息分叉）；revert/unrevert（消息级撤销+恢复）；undo/redo 文件变更回滚；session 树（parentID/children）；todo 列表 per-session；abort；标题/摘要自动生成。

**权限与安全**
- 三态权限 allow/ask/deny，per-tool key 细粒度：edit、bash（支持命令 glob 白名单，如 `"git push": "ask"`、`"*": "ask"` 后跟具体放行规则，last-match-wins）、webfetch/websearch/lsp/skill/question/task/external_directory 等；per-agent 覆盖全局。
- 权限响应带 remember 选项；Plan agent 即权限系统的产物。

**Headless / CI / server**
- `opencode serve` 起 headless HTTP server（默认 4096 端口），发布 **OpenAPI 3.1 spec**（`/doc`），官方 SDK 由 spec 自动生成（JS/TS SDK，另有 Python SDK 未确认）。
- API 面：sessions CRUD/fork/share/revert/summarize、messages（同步 prompt 与 `prompt_async`）、slash command 执行、shell 执行、files/find（文本/文件名/LSP 符号搜索）、lsp/formatter/mcp 状态、agents 列表、SSE `/event` 事件流、`/tui/*` 端点驱动 TUI（IDE 插件即用此实现）。
- 多前端共享同一 server：TUI / desktop / IDE / web / GitHub & GitLab 集成（PR 里 @opencode 干活）；basic auth（OPENCODE_SERVER_PASSWORD）保护远程访问。

**模型配置**
- models.dev 式 provider 目录（75+ providers/models），BYOK；OpenCode Zen 官方测过的精选模型列表（含订阅制）；GitHub Copilot / ChatGPT 订阅直连登录（2026-01 Anthropic 封锁第三方消费订阅后转向 OpenAI 合作）；本地 Ollama/LM Studio；provider/model 二段式 ID（`anthropic/claude-...`）；per-agent model + 额外参数透传（reasoningEffort、textVerbosity）。

**评测与差异化 UI/UX**
- 无权威 SWE-bench 公开成绩（未确认）；差异化：LSP 反馈、client/server 架构、会话树、share 链接、主题/键位深度定制、桌面端。

**近半年重大新特性**
- V2 事件溯源架构落地（session engine 重写）；scout 子代理；desktop 应用；task 权限 glob；doom_loop 卡死恢复；apply_patch 工具；Zen 订阅与 Copilot/OpenAI 订阅打通；企业版（SOC 2 Type II）。

## 2. Goose（Block 开源，已移交 Linux Foundation）

**形态与安装**
- Rust 编写的通用 AI agent：**桌面应用（mac/Linux/Win）+ CLI + API/SDK** 三形态；CLI 安装 `curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash`。
- 2026 年 Block 把治理权移交 **Linux Foundation**（vendor-neutral），仓库出现 aaif-goose 镜像；「不卖模型、只做宿主」定位。

**开源与否 / license / 社区活跃度**
- **Apache-2.0**，开源；~5 万 stars（AI Agent Index 口径 51K、500+ 贡献者；block/goose 主仓口径略低，未确认精确值）；发版密集（2026 年 3 月 v1.28/v1.29，年中至 v1.41+）。

**核心循环与内置工具集**
- 主循环 + 内置基础扩展：Developer（shell 命令/文件编辑/代码分析）、Computer Controller（系统自动化/网页抓取）、Memory（跨会话持久存储）、Todo、Extension Manager（运行时启停扩展）、Chat Recall(检索历史会话)。
- 架构哲学：**一切能力皆 MCP 扩展**——内置工具极少，靠挂 MCP server 组合能力；支持自定义发行版（CUSTOM_DISTROS：预配 provider/extensions/品牌的分发包）。

**上下文管理**
- 官方文档有 context window 管理与摘要机制，但公开细节少（未确认具体阈值）；GOOSE_INPUT_LIMIT 可配置输入上限。

**子代理 / 编排**
- 演进路径很有代表性：早期实验性 subagents → skills → **2026-02 v1.25 起统一为 `summon` 扩展**（PR #6964）：
  - `load()` 列出/注入知识源（recipes、skills、agents 统一抽象为 Source，本地 > 全局 > env 优先级）；
  - `delegate(instructions)` 在隔离子代理中跑任务，支持 `async: true` 后台执行（CancellationToken 管理 + turn 计数 + MOIM 状态上报）；
  - 子代理内禁再 delegate（防递归）；DEFAULT_SUBAGENT_MAX_TURNS 25→50。
- **v1.29（2026-03）加入 Orchestration support**；桌面 UI 可管理子 recipes、展示 delegate 子代理日志。
- **Recipes** 是特色编排原语：可参数化、可复用、可分享的任务模板（保存 prompt+配置），团队级标准化工作流。

**生命周期扩展**
- Recipes（如上）、hooks（生命周期事件跑 shell）、slash commands（内置/skill/recipe 三类，已进 ACP server）、skills（SKILL.md，并入 summon 的 load 体系）、MCP Apps（把 MCP 工具带 UI 元数据暴露给桌面端）。

**MCP**
- 最深度的 MCP 集成之一：70+ 官方扩展注册表；stdio/HTTP；**MCP Roots、MCP Apps（UI 元数据）、elicitation 路由**等新特性跟进快；WebMCP；会话恢复时重注册 MCP 扩展。

**记忆**
- `.goosehints` / AGENT.md 项目指令；全局 profiles.yaml（provider/extension 配置）；内置 Memory 扩展做持久记忆。

**会话管理**
- 会话持久化、命名恢复（`goose session --resume`）；Chat Recall 检索过往对话。

**权限与安全**
- 工具执行默认确认（approve 模式），兼容 Claude Code 的 approve 权限路由语义；**v1.28 加入对抗性 agent（防信息泄露）**；本地优先可全离线（Ollama）。沙箱细节未见官方方案（未确认）。

**Headless / CI / server**
- CLI 可非交互跑 recipe/任务；**goose 作为 ACP server 对外提供服务**（session/set_config 等）；API 形态嵌入产品；Telegram Gateway 远程访问（v1.29 文档）。

**模型配置**
- 15+ providers（Anthropic/OpenAI/Google/Ollama/OpenRouter/Azure/Bedrock…）；**ACP provider 创新**：直接用 Claude Code/Codex/Gemini 订阅当后端（claude-acp/codex-acp/gemini-acp）；本地推理依赖做了 feature-gate。

**评测与差异化**
- 无权威榜单成绩（未确认）；差异化 = Linux Foundation 中立治理 + MCP-first 扩展模型 + recipes 团队标准化 + 桌面/CLI/API 三端同核。第三方评价：内核好但打磨度低于 Claude Code。

**近半年重大新特性**
- summon 统一扩展（替代 subagent+skills）；Orchestration support；ACP providers（Claude Code/Codex/Gemini 订阅复用）；MCP Roots/Apps/elicitations；对抗性安全 agent；TUI 命令；BYOM/MCP Apps in desktop；Linux Foundation 移交。

---

## 3. Crush（Charmbracelet）

**形态与安装**
- Go 单二进制 TUI（Bubble Tea 生态）；安装覆盖极广：apt/yum 官方源、Homebrew、`go install`、release 二进制——**macOS/Linux/Windows/FreeBSD/OpenBSD/NetBSD/Android(Termux)** 全平台同类最广。

**开源与否 / license / 社区活跃度**
- License：**FSL-1.1-MIT**（Functional Source License，两年后自动转 MIT）——source-available 但非 OSI 开源，商用再分发受限期内的合规注意点。
- ~20K–26K stars（口径随时间增长，2026-01 为 20.7K，2026 年中 ~26K）；发版节奏约每周多版（2026-06 已到 v0.81.x，累计 100 releases）；HN 发布帖 367 分。

**架构**
- **本地 client/server over Unix socket（Windows named pipe）**：常驻 agent 进程 + Bubble Tea TUI 客户端连接——多数终端 agent 没有的持久进程模型；状态 = 全局 config JSON + SQLite（`~/.config/crush`、`~/.local/share/crush`）。
- **REST API over 本地 socket**（Swagger/OpenAPI 文档化）：workspaces/sessions/agents/LSP/MCP 全可编程 → CI/脚本/第三方工具集成入口。

**核心循环与内置工具集**
- 标准文件读写/编辑/shell 工具集 + **LSP 驱动上下文**（gopls/typescript-language-server/rust-analyzer/nil 等，模型拿到与编辑器相同的类型/符号/诊断）；crush.json 配置 LSP/MCP/providers/hooks。

**上下文管理**
- 会话持久化于 SQLite，多会话 per-project；压缩机制未确认（未见专门文档）。

**子代理 / 编排**
- 无一等 subagent 系统（未确认）；主打单 agent + LSP 深度。

**生命周期扩展**
- **Hook 引擎**：crush.json 里定义 shell hook（pre-tool-use、post-session 等事件），**格式兼容 Claude Code**——现成 hook 脚本可直接复用（刻意设计）。
- **Skills 系统**：markdown 技能文件（项目级/全局配置目录），内置 `crush-config`、`crush-hooks` 技能让 agent 自我配置。
- LSP servers 可配任意语言服务器。

**MCP**
- client 支持 stdio/HTTP/SSE 三传输；**所有 command/args/env/headers/url 字段支持完整 bash 变量展开**（含 `$(cat /path/to/token)` 命令替换）——密钥管理做成一等公民（含 Windows）；近期版本改进 MCP OAuth。

**记忆**
- CRUSH.md 项目规则文件（repo 内有 CRUSH.md 自身示例）。

**会话管理**
- 多会话持久化、切换模型不丢会话上下文；worktree resume 改进（v2.1.x 时代特性编号混入 Claude Code 口径，以官方 release notes 为准）。

**权限与安全**
- 默认逐操作确认；`--yolo` 全自主模式（建议沙箱环境）；无分级权限体系文档（未确认）。

**Headless / CI / server**
- 本地 socket REST API 即 headless 入口；无独立 exec 子命令文档（未确认）。

**模型配置**
- 多 provider：Anthropic/OpenAI/Gemini/Bedrock/Cerebras/MiniMax 及任意 OpenAI-/Anthropic- 兼容端点（内部 Fantasy 抽象层，零代码接入新网关）；**Catwalk 社区维护的开源模型目录**自动同步新模型，无需升级 Crush 本体；Charm 自家订阅网关 Charm Hyper（HYPER_API_KEY）。

**评测与差异化**
- 无公开 SWE-bench 成绩；差异化 = Charm 系终端美学（公认品类最佳 TUI UX 之一）+ Unix socket client/server + Catwalk 目录 + Claude Code 兼容 hooks。

**近半年重大新特性**
- Hook 引擎（Claude Code 格式兼容）、Skills 系统、REST API over socket、MCP OAuth 改进、Catwalk 目录持续扩充。

## 4. Amp（Sourcegraph，ampcode.com）

**形态与安装**
- 终端 CLI（`curl -fsSL https://ampcode.com/install.sh | bash`、brew ampcode/tap/ampcode、npm @ampcode/cli）+ **web/移动端**（ampcode.com 上直接开线程）+ IDE 连接模式（VS Code 系/Zed/Neovim，CLI 常驻后 `ide connect`）。**闭源商业产品**（未公开源码仓库），由 Sourcegraph 运营。

**定价（2026-08 口径）**
- Free：每日赠送额度（2025-10 起曾靠广告支撑、广告业务年化 $10M+；**2026-03-30 宣布去广告**、改为定向赠予并逐步收缩老版本用户额度）；订阅两档：**Megawatt $20/mo**（low/medium 模式 + 750 小时小 orbs）、**Gigawatt $200/mo**（全模式含 high/ultra + 1000 小时 orbs）；**Unconstrained**：企业 API 计价/BYOK。

**核心循环与内置工具集**
- 单一强 agent + 4 档「能力旋钮」模式：**low / medium(默认) / high / deep(深度思考)** / ultra——模式是能力预算而非固定模型选择，Amp 决定模型路由（多模型混用：GPT-5.x Sol、Claude Fable 5 等，随前沿更新，「无情删除不拉不动力的功能」哲学）。
- 内置工具 `amp tools list` 可查；特色工具见下。

**上下文管理**
- 无手动 compact 命令的公开文档；官方方法论是「一个线程一个任务」+ **/handoff**（把任务移交新线程，替代旧线程无限膨胀）；线程引用（@thread-id / URL）可跨线程提取相关信息续接。传统 compaction 未确认。

**子代理 / 编排**
- **自动 subagents**：medium 模式下主 agent 自动为适合并行/隔离的任务派生子代理（各自独立上下文窗口，只回传最终摘要；互相不通气、不可中途干预——官方坦承局限）。可用插件自定义子代理（parentThreadID 关联父线程）。
- 特色专职 subagent：
  - **Oracle**：「第二意见」强推理模型工具——调试/审查/架构决策时主 agent 自主调用或用户点名；
  - **Librarian**：跨仓库代码研究（GitHub 公共库 + 授权私库，走 Sourcegraph 索引）;
  - **Painter**：GPT Image 2 生图/改图工具（UI mockup/图标/截图脱敏）。
- **Orbs**：远端托管机器跑线程（合上笔记本继续干活），分尺寸计费；**Runners**：把自己任意机器变成 runner（`amp --no-tui` 纯无头 runner 或 TUI 兼任），web 端发起任务落到指定机器。
- **Schedules**：agent 给自己定 cron 式日程自唤醒续跑（带完整上下文）。

**生命周期扩展**
- **Plugins**（TypeScript/JS，受 Pi 启发）：事件钩子（session.start / agent.start/end / tool.call / tool.result）+ 注册 tool/command/skill/UI；tool.call 钩子可 allow/reject-and-continue/**modify 输入**/synthesize 结果——权限系统即由此实现；agent.end 返回 continue 可自动追加消息驱动循环（需防死循环标记）。
- **Skills**：SKILL.md 目录式（name/description 渐进披露），查找路径极宽（个人/工作区/项目 `.agents/skills/` + Claude 兼容位置 + 插件捆绑技能 `<plugin>:<skill>` 限定名）；skill 可捆绑 mcp.json（MCP server 随 skill 加载，工具默认隐藏直到 skill 触发——控制上下文占用的推荐做法）；个人/工作区 skills 存独立 git 仓库，agent 可自己改自己提交发布。
- **2026-01 删除 custom commands（用 skills 取代）、删除 Amp Tab 补全、杀死编辑器扩展**——激进做减法。

**MCP**
- client 本地(command)+远程(url/headers)；OAuth 自动注册流程；加载优先级 CLI flag > workspace > user > skills；**workspace MCP 需显式信任批准**（防开仓投毒）；2026-08 新增 MCP in Orbs/Puck。最佳实践：MCP 尽量捆进 skill 按需暴露。

**记忆**
- AGENTS.md 全层级：cwd+父目录必载、子树按读取触发、系统级(/etc/ampcode 等)与 ~/.config/amp/AGENTS.md 常载；兼容 AGENT.md/CLAUDE.md 回退；**globs frontmatter 条件注入**（被提及文件声明 glob，命中才进上下文）；@-mention 其它文件/glob 引用。

**会话管理**
- **Threads 是持久对象**：唯一 ID(T-xxxx)、云端存储、URL 分享、团队 feed 检索（label/file/repo/author/parent 等查询语法）、归档、@@ 引用其它线程；分支 fork（同历史开新线程）；消息排队/Enter Enter steer/Esc Esc 强停。

**权限与安全**
- **默认零审批直通**（理念：不打断专家流），安全交给 plugin 权限策略或 legacy permissions 配置激活内置规则插件；guardedFiles allowlist；建议不可信代码用隔离环境。无分级审批 UI（未确认）。

**Headless / CI / server**
- `amp -x/--execute` 单次执行；`--no-tui` runner；streaming JSON 输出；SDK（Thread 对象编程接口：createThread/appendUserMessage/waitForResponse，插件内也能开线程）；架构 = 云端编排 + 本地执行器（与传统本地 server 反向）。

**评测与差异化**
- 无权威榜单成绩（未确认）；差异化 = 前沿模型组合路由 + Oracle/Librarian/Painter 专职子代理 + threads 云协作 + orbs 远程执行 + schedules 自唤醒 + 极简激进的产品裁剪风格。2026 年初报道称 4 万+ 团队采用（未确认）。

**近半年重大新特性**
- deep/ultra 模式、Puck 语音控制 agent（实时语音）、Global Plugins & Skills（工作区共享 remix）、MCP in Orbs、教育半价、去广告免费额度调整、handoff、schedules。

---

## 5. Factory Droid（droid CLI）

**形态与安装**
- 终端交互 REPL + headless exec 双模；安装 `curl -fsSL https://app.factory.ai/cli | sh` / brew --cask droid / npm i -g droid / Windows PowerShell。**闭源商业产品**，需 Factory 账号登录；背后是 Factory「Agent-Native SDLC」平台（App/云计算机群/企业版）。

**核心循环与内置工具集**
- 提议-审批循环（propose plan → diff → approve → 执行 validators）；TUI 快捷键体系（! 直接 bash、transcript 视图、? 快捷键面板）；Specification Mode（先写规格再动手，`--use-spec`、`--spec-model` 规格阶段换强模型）。
- 工具白名单控制：`--restrict-tools ApplyPatch,Execute` / `--additional-tools`。

**上下文管理**
- `/compress` 手动压缩会话释放上下文；自动压缩未确认。

**子代理 / 编排**
- **Custom Droids**（`.factory/droids` 定义专用子代理，`/droids` 管理）；
- **Missions**：多 agent 编排模式（规划→委派→验证→checkpoint），`/missions` 或 `droid exec --mission`（要求 --auto high）；Mission Control 浮层监控 orchestrator 会话。

**生命周期扩展**
- **Hooks**（`/hooks`，agent 生命周期 shell 钩子）；
- **Skills**（`/skills`、`/create-skill` 打包可复用过程）；
- **Plugins + marketplace**（`droid plugin install droid-control@factory-plugins`——命令/droids/skills/hooks 打包分发，有官方 marketplace）；
- 斜杠命令生态丰富（/review、/readiness-report 就绪度评估等）。

**MCP**
- `droid mcp add <名> <url|--type http|command>`；stdio/http 双传输；`/mcp` 管理。

**记忆**
- AGENTS.md 官方支持（docs 有专章）；平台侧还有知识库/集成上下文（Jira/Notion/Slack/Linear/PagerDuty 原生集成喂上下文——超出纯文件记忆范畴）。

**会话管理**
- 会话持久化、`--resume`、**fork**（复制会话到新会话并打印 resume 命令）、`droid search` 全局检索历史会话内容、收藏/favorite、重命名。

**权限与安全**
- **四级自主度阶梯**：default 只读侦察 → --auto low 安全编辑 → medium 装依赖/build/test/本地 commit → high push/部署/长任务 → `--skip-permissions-unsafe` 仅限一次性容器。交互内逐操作 approve/reject。

**Headless / CI / server**
- `droid exec`：-f 文件 prompt、stdin 管道、`-o text|json|stream-json|stream-jsonrpc` 结构化输出、exit code 驱动管道、`exec -s` 续跑会话、`--max-turns` 类约束未确认；**BYOM 计算机**（`droid computer register` 把本机注册为云端可调度机器，SSH/端口转发经 relay）；`droid daemon` 本地常驻服务；REST API 驱动 sessions/computers/wikis/analytics。
- `-w/--worktree [name]`：会话直接在隔离 git worktree 中运行。

**模型配置**
- 多模型 mid-session 切换（/model，claude-opus-4-7 等 ID）、`-r reasoning-effort` 覆盖思考级别、/fast 快速档、「model independence」平台能力；也支持 BYOK 方向（未确认细节）。

**评测与差异化**
- 无公开权威成绩（未确认）；差异化 = 企业级平台整合（Slack 应用/自动 code review 安装器/readiness 报告）+ Missions 编排 + BYOM 云机 + 四级自主度。

**近半年重大新特性**
- Missions 多 agent 编排成熟、plugins/marketplace、BYOM computers relay、droid search、worktree flag、spec mode 强化。

<!-- TBC -->
