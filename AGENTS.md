# AGENTS.md — Omni 项目开发指南

> 本文件是 Omni 项目内所有 AI 协作 Agent（Claude Code / Codex / opencode / 本仓库的 omni 自身）的开发指南。
> 本文件保持**精简**（每次会话首轮完整加载，目标 <40KB）；历史迭代记录、TUI 实现细节、路线图全文、发布流程等详见文末「文档地图」。

## 项目是什么

Omni 是一个 **Agent 工程**（终端型 AI 编程助手）。
当前为 **1.0 阶段（Beta 功能完备 + 行业标配补齐）**：单 Agent 循环 + 基础工具集 + 安全护栏 + 上下文管理 + 子代理/并行/编排 + MCP 外部工具（tools/resources/prompts/instructions/HTTP+OAuth）+ 记忆系统/会话持久化/技能系统 + 全屏 TUI + **本地后端服务与 Web 界面（`omni web`）+ Electron 桌面应用（mac/win/linux）**，无框架依赖（裸 OpenAI SDK + 主循环）。路线图基础项与 1.0 定义项已全部完成，仅剩进阶项：SWE-bench 评测、/rewind 三模式（code/conversation/both）、agent teams 完整版（见 `Doc/roadmap.md`）。

设计理念：
- **认知优先**：代码是认知梳理对话（见仓库根目录 `Agent开发认知梳理.md`）的落地，保持最小可读，不为"架构好看"引入抽象；
- **可替换后端**：通过 `OMNI_BASE_URL` 兼容所有 OpenAI 协议的服务（OpenAI / DeepSeek / 智谱 / Moonshot 等）。

## 常用命令

```bash
npm run dev -- "<任务>"   # 开发运行（tsx 直接执行）
npm run typecheck         # TypeScript 类型检查
npm run build             # typecheck + tsc 编译 + bun 打包单文件（dist/）
npm start -- "<任务>"     # 运行 tsc 产物（node dist/index.js）
npm run mock              # 启动本地 mock API 服务器（无 Key 端到端验证，端口 8787）
npm run dev:tui -- "<任务>"   # TUI 全屏模式（bun + 真实 TTY）
npm run tui:snapshot      # TUI 快照验证（无 TTY，内存渲染断言）
npm run dev:web           # Web 服务（本地后端 + 网页界面，默认 3080 端口，不自动开浏览器）
npm run web:sync          # 构建 vendor.js + 同步 web/ 静态资源到 src/web/assets.ts（bundle 内嵌副本；开发热更新不需要——server 优先从 web/ 目录读取）
npm run probe:web         # Web 服务 e2e 探针（mock 离线：对话流/审批/提问/取消/模型切换/会话管理）
npm run electron:dev      # Electron 桌面应用（开发：bundle 后端 + electron 窗口）
npm run electron:build    # Electron 桌面应用打包（npm run web:sync + bundle + electron-builder）
npm run eval              # 评估：真实 API 跑任务集 + 完成率报告（eval-report.json）
npm run eval:mock         # 评估：离线 mock（确定性，可进 CI）
npm run dev -- exec "<任务>" --output-format json   # Headless：stdout 只出结果、进度走 stderr（可 | jq / 管道分支）
npm run dev -- mcp-server # Headless：作为 MCP server（omni_exec / omni_reply 工具）
npm run dev -- preset browser # 能力一键预设：浏览器自动化双雄 MCP 写入全局配置
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
| `release/omni`（~57M） | `npm run compile` | **原生二进制**（bun compile，含运行时，零依赖、无需 Node），平台相关（arm64/x64），适合直接分发 |
| `omni-<版本>.tgz` | `npm pack` | **npm 安装包**（自动 prepack 构建），`npm install -g omni-0.1.0.tgz` 全局安装后可直接用 `omni` 命令 |

打包注意：
- 原生二进制输出到 `release/`（已 gitignore），**不进 npm 包**（平台相关）；
- npm 包只发布 `dist/`（`files` 字段），体积约 150K；
- 全局安装测试：`npm install -g ./omni-0.1.0.tgz --prefix <前缀>`。

**GitHub Actions 自动发布**（`.github/workflows/release.yml`）：推送 `v*` tag → 五平台矩阵构建（原生二进制）+ Electron 四平台打包（zip/exe/AppImage）→ GitHub Release 附 10 产物 + npm 平台子包/主包自动发布（Secrets 需 `NPM_TOKEN`）。**完整流程与关键坑**（musl 补装、Electron 镜像、发布脚本、版本重发策略）见 `Doc/release-guide.md`。
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
  "baseURL": "https://api.deepseek.com/v1", // OpenAI 兼容 API 地址
  "apiKey": "sk-xxx",                    // 更推荐用环境变量 OMNI_API_KEY
  "maxSteps": 50,                         // Agent 最大循环步数（防死循环兜底；典型任务 15 次内完成）
  "showThinking": true,                   // 展示思考过程（默认 true；false 关闭终端显示，仍落盘 .omni/last-thinking.md）
  "permission": "safe",                  // 安全护栏权限分级：full（任意命令直通）/ safe（危险命令询问，默认）/ ask / read
  "dangerousPatterns": [],               // 危险命令扩展正则（可选）：内置清单之外的命令在 safe 及以上档位触发审批
  "sandbox": "off",                      // OS 级沙箱：off（默认）/ read-only / workspace-write / danger-full-access（sandbox-exec / bwrap 包裹 run_command）
  "repoMap": true,                       // 代码库结构感知：首轮注入紧凑符号地图（函数/类/常量，默认 true）
  "repoMapMaxSymbols": 200,              // repo map 符号上限
  "webFetchDomains": [],                 // web_fetch 工具域名允许列表（空 = 全部允许）
  "webSearchApiKey": "",                 // web_search 工具 API key（Brave Search；缺省回退环境变量 BRAVE_API_KEY）
  "auditLog": true,                       // 写审计日志（~/.config/omni/audit.log；默认 true）
  "agentsFile": true,                     // 项目记忆 AGENTS.md：每次会话首轮**嵌套加载**所有层级的 AGENTS.md（从 cwd 向上到 git 根/home 边界，越贴近 cwd 权重越高；默认 true）
  "globalAgentsFile": true,               // 全局记忆 ~/.config/omni/AGENTS.md：跨项目用户偏好，排在项目记忆之前（级联；默认 true）
  "autoMemory": true,                     // 交互模式退出时把新偏好自动追加进全局记忆（默认 true；单次任务不触发）
  "summarizeAt": 40,                      // 长对话摘要压缩阈值（消息数；0 = 关闭）
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
                                      //   per-model variants：reasoningEffortOptions = 该模型 /variants 面板支持的思考级别选项、reasoningEffort = 当前级别——缺省回退顶层同名字段；
                                      //   /model 切换到该模型自动带出（面板/请求同步），/variants 切换持久化到 providers."<组>".models."<名>".reasoningEffort（仅该模型生效）
                                      //   命名 variants（1.0）：variants = { id: { description?, reasoningEffort?, body?, headers? } } 请求叠加层，variant = 当前选中 id；/variants 面板同时列出思考级别和命名 variants
                                      //   apiModel = 发给 API 的真实模型名（目录友好名 ≠ API 名），displayName = 面板显示名，limit/modalities/capabilities = 元数据
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

```
src/
  index.ts              # CLI 入口：main 调度（参数 → 配置 → 客户端 → 单次/交互 / exec / mcp-server / web）
  client.ts             # OpenAI 客户端工厂：按「模型端点配置」创建（/model 切换不同端点时重建）+ ModelRuntime 共享引用（主循环/子代理）
  version.ts            # 版本号常量
  ui.ts                 # 终端 UI：ANSI 颜色、TTY 检测、spinner、窗口标题（OSC 0）
  exec.ts               # **Headless 执行（`omni exec`）+ MCP server（`omni mcp-server`）**：stdout 只出结果/stderr 进度；
                        #   --output-format text|json|stream-json（复用 events.ts ev 序列，末行 t=result）· stdin 两形态
                        #   （`-` 整段 prompt / prompt+stdin 注入上下文）· --max-turns · --allowed-tools（纯工具过滤）·
                        #   --output-schema（JSON Schema 子集校验，不符 → 非零退出）· exit code 0/1 管道分支 ·
                        #   exec resume <id> 会话续跑（复用 session JSONL）· MCP server 暴露 omni_exec/omni_reply
                        #   （协议与 tools/mcp.ts 客户端对称，外部 harness 把 omni 当子代理用）
  web/
    index.ts            # **Web 服务入口（`omni web`）**：解析 web 参数（--port/--host/--no-open）→ prepareRun +
                        #   attachRuntime（routingOutput 路由审批/提问到当前运行会话）→ startWebService；自动打开浏览器
    server.ts           # **REST + SSE 本地后端**：Node 内置 http（零依赖）；SSE（/api/events）广播运行事件
                        #   （thinking/tool/answer/approval/ask/usage/status…）· REST（会话创建/列表/历史/发送/取消/审批/提问/设置）·
                        #   **全局单运行**（同时只有一个会话在跑，共享 runOpts/闸门/撤销栈无并发交错）· 会话落盘复用 session.ts
                        #   JSONL + 首轮后自动生成标题 · 静态页面优先读 web/ 目录（开发热更新）否则回退内嵌 assets.ts
    output.ts           # **WebOutput**：Output 实现——所有事件带 sessionId 广播；审批/提问经 PendingRegistry 注册
                        #   （SSE 发 request，客户端按钮 POST 路由 resolve 后 loop 继续）
    events.ts           # **Web 事件协议**：事件名与 payload 的单一来源（客户端 web/app.js 按名渲染）
    assets.ts           # **内嵌页面资源**（web/ 的副本，scripts/web-sync.mjs 生成；bundle 单文件发布免外部文件）
  electron/
    main.cjs            # **Electron 桌面应用（`omni`）**：主进程以 Electron 自带 Node（ELECTRON_RUN_AS_NODE=1）
                        #   执行 `dist/omni.cjs web --no-open --port <p>`（无需系统 Node）→ 轮询 /api/status 就绪 →
                        #   开 BrowserWindow 加载 http://127.0.0.1:<p> · 单实例锁 · 应用菜单（选择工作目录/重载/DevTools/
                        #   退出）· 退出时终止后端子进程 · 自动找空闲端口 · 开发模式（OMNI_WEB_DEV=1）走 tsx 源码
                        #   打包配置在 package.json `build` 字段（electron-builder：mac zip（arm64+x64，dmg 在 CI runner
                        #   上 hdiutil 产物校验损坏不可用）· win nsis exe x64 · linux AppImage x64）
  web/                  # **浏览器页面（仓库根目录）**：index.html + style.css + app.js（vanilla HTML/CSS/JS 零框架；
                        #   src/web/assets.ts 的源，`npm run web:sync` 重新生成内嵌副本）
                        #   消息操作按钮：**常显**（无需 hover）——用户消息 复制/重新编写（原文带回输入框，按钮堆在
                        #   气泡正下方右对齐）、助手消息 复制/重试（重发前一条用户消息）；图标按钮，
                        #   `.msg-actions` 放 bubble/md-body 外（流式重绘不丢）
                        #   右上角通知（Alert notification）：`#notifications` 容器 + app.js `notify(msg, type)`
                        #   ——复制成功/模型切换/保存成功/所有错误提示统一走这里（替代浏览器 alert），
                        #   info/success/error 三型，自动消失、悬停暂停、✕ 关闭、同屏最多 4 条
                        #   设置·模型配置为单一滚动视图（列表完全展开，随 .settings-content 整体一滚到底，无嵌套滚动）；
                        #   模型列表加载时（空列表）不显示灰底（.mc-tbody.bare —— 简体 loading），自动获取只在首次
                        #   （localStorage 持久化 omni.mcAutoFetched_<provider> 标记，之后需手动点「获取/刷新模型列表」）
  cli/
    args.ts             # 参数解析（-m/-c/-h/-v）+ 帮助文本
    banner.ts           # 启动 banner（版本/模型/工具/权限/配置来源）
    interactive.ts      # 交互模式：readline 循环，跨轮次保持上下文（含 /init、/plan、/undo、/permission、/compact、/agents、/review、/variants）
  agent/
    loop.ts             # **Agent 主循环**：流式调 LLM → 工具调用（并行）→ 安全过闸 → 执行 → 结果回传
    thinking.ts         # 思考过程：流式显示（浅色保留在屏幕，不折叠）/落盘（reasoning + reasoningMs 耗时字段提取，恢复会话回放 thinking 块带「· 耗时」头行）
    messages.ts         # 消息组装：assistant 消息构造、工具参数解析
    context.ts          # 上下文管理：全局/项目记忆级联注入（项目记忆按层级嵌套，内层贴近用户消息）+ 相关文件预载（selectRelevantFiles）+ 长对话摘要压缩（summarizeContext）
    report.ts           # 会话状态/上下文用量/导出/诊断/配置路径 共享逻辑（/status /context /export /doctor /config）
    memory.ts           # **记忆系统**：全局记忆（~/.config/omni/AGENTS.md，XDG-aware）+ 项目记忆（AGENTS.md **嵌套加载**：override/AGENTS.md/fallback 三级选择，从 cwd 向上收集所有层级到 git 根/home 边界，每层独立 40KB 截断 + 合计 32KB 上限）发现/读取 + system 消息构建 + 会话结束自动提取写入（autoMemory：全局偏好去重合并 + TTL 归档；项目级待提交片段 .omni/memory-pending.md + /memory-apply 应用）
    repomap.ts          # **代码库结构感知（repo map，P1）**：正则提取函数/类/常量定义行 → 紧凑符号地图注入首轮（[项目结构地图 前缀）
    init.ts             # **/init [--global] [<子目录>]**：扫描项目/全局环境 → LLM 生成 AGENTS.md → 写入项目根/子目录/全局配置目录（已存在不覆盖）
    session.ts          # **会话持久化**：交互对话 JSONL 落盘（~/.config/omni/sessions/，XDG-aware）+ 列表/最近/按 id 恢复 + 脚手架消息过滤 + meta 刷新（--continue / -r / -l）
    undo.ts             # **/undo 文件撤销**：UndoStack（write_file 执行前快照原内容/新建标记，1MB 上限）+ applyUndo（恢复/删除）+ withUndoSnapshot 包装器（主循环与子代理共用）
    subagent-defs.ts    # **子代理定义**：.agents/subagents/*.md frontmatter 解析（name/description/model/permission/tools/skills/maxSteps）+ 发现/按名加载
    subagent.ts         # 子代理：隔离上下文嵌套循环（无 UI、小步数上限、共用安全闸；per-agent 模型/权限/工具白名单/技能预载 + 嵌套 depth 上限）
    orchestrate.ts      # **编排**：/orchestrate 固定 pipeline（fan-out 并行 delegate → 汇总 → 对抗审查）+ /goal 目标机制（自动推导验收标准 → 循环执行直至达标，判定反馈驱动下一轮）
    title.ts            # 会话标题：首轮后异步生成，设为终端窗口标题
    review.ts           # 代码审查（/review）：typecheck + git diff → LLM 审查
    events.ts           # **轨迹事件记录器**：EventRecorder 内存累积 + 会话文件追加 `{"t":"ev"}` 行（/trace 面板与 /compact 事件源；恢复会话读回续号；可选实时监听回调——headless stream-json 输出）
    trace.ts            # **轨迹投影层**：foldTrace 纯函数把事件序列折叠成 TraceRow（turn/user/request/answer/tool/compact）+ buildTraceTextLines（console 账本）
    types.ts            # RunOptions / ThinkingDisplay 共享类型
  safety/
    index.ts            # Safety 闸门：policy 判定 + 审批回调 + 审计记录（loop/子代理共用）
    policy.ts           # 权限分级（full/safe/ask/read）+ 危险命令检测（内置 + 扩展正则）+ per-tool 审批模式
    audit.ts            # 审计日志落盘（~/.config/omni/audit.log）
    trust.ts            # **工作区信任**：信任清单（~/.config/omni/trusted-workspaces.json）判定/增删；未信任 = 只读 + 跳过项目级配置
    sandbox.ts          # **OS 级沙箱**：read-only / workspace-write（macOS sandbox-exec / Linux bwrap 包裹 run_command）
  hooks/
    index.ts            # **Hooks 生命周期自动化**（对标 Claude Code）：HookRunner（JSON 协议——stdin 喂入事件上下文、stdout 返回决策）+ 5 事件（UserPromptSubmit 改写 prompt / PreToolUse 硬拦截+改写参数 / PostToolUse 输出回传上下文 / Stop 要求继续修 / Notification 通知）+ matcher 通配 + 超时/失败降级放行
  tools/
    index.ts            # 静态工具注册表（新增工具登记处）
    types.ts            # Tool 接口（独立文件避免循环导入）
    util.ts             # 公共小函数：num / resolvePath / truncate / TOOL_OUTPUT_LIMIT
    read-file.ts        # read_file
    write-file.ts       # write_file
    list-directory.ts   # list_directory
  search-code.ts      # search_code
  run-command.ts      # run_command（超时 + 输出截断；危险拦截兜底在 safety/policy）
  skill.ts            # skill 技能工具：按 name 加载 SKILL.md 完整内容（模型按需使用）
  ask.ts              # ask_user 向用户提问工具（createAskUserTool 工厂，运行时注入提问回调）
  memory-tools.ts     # 记忆渐进披露工具：memory_search（多关键词 AND + 命中数排序）/ memory_read（按路径读完整记忆）
  todo.ts             # TodoWrite 任务清单工具：模型维护结构化 todo（in_progress/completed/pending，存 runOpts.todoList）
  web-fetch.ts        # WebFetch 内置工具：URL 抓取 → htmlToText 转纯文本 → 截断（域名白名单 webFetchDomains 可配）
  web-search.ts       # WebSearch 内置工具：关键词 → 搜索结果（title/url/snippet），Brave Search API（webSearchApiKey / env BRAVE_API_KEY）
  diagnose.ts         # 诊断反馈工具（LSP 轻量版）：detectCheckCommand 探测 typecheck→lint→test + 运行返回诊断摘要
    delegate.ts         # delegate 子代理工具（运行时由入口按配置注入）
    mcp.ts              # MCP 客户端：stdio/streamable-HTTP 双传输 + JSON-RPC + 运行时发现注册（tools/resources/prompts/instructions、工具白黑名单、审批模式烘焙、OAuth 登录）
    mcp-oauth.ts        # MCP OAuth 登录：RFC 8414 discovery + 授权码 PKCE + token 持久化
  config/
    index.ts            # 配置加载：分层合并（含权限/审计/上下文/子代理/MCP 字段）
    jsonc.ts            # JSONC 解析（注释/尾逗号）
    discover.ts         # 配置发现：目录内查找 + cwd 向上查找
    model-context.ts         # **模型能力自动识别（数据源查表，1.0 P1）**：三级匹配（精确→裸 id→后缀）、
                             #   上下文窗口 / 思考级别档位推导 + **/models refresh 热替换**（用户级 JSON 覆盖内置）——显式配置永远优先、查表只补缺、MISS 保守回退
    model-context-builder.ts # 快照构建纯逻辑（拉取/归一化/建表/双序列化）——scripts 生成器与运行时 /models refresh 共用一份实现
    model-context-snapshot.ts # models.dev 离线内置快照（scripts/build-model-context-snapshot.ts 生成；进 repo）
  tui/
    state.ts            # TUI 状态（纯对象，无响应式依赖；含审批卡片/联想/菜单/轨迹面板状态）
    trace.ts            # **轨迹面板（右侧栏，/trace）**：TraceRow 投影截断成面板行（tracePanelLines，窗口滚动/选中收敛）+ refreshTrace（交互每轮刷新）
    render.ts           # 渲染编排：mountTree/repaintTree/startTui（行构建在 rows.ts）
    rows.ts             # 内容行构建：buildBody/computeRows/卡片与审批卡/点击命中（纯函数）
    layout.ts           # 布局常量 + 按显示列数的折行/截断数学（不依赖 OpenTUI）
    theme.ts            # 主题色板与取色（system/light/dark）
    output.ts           # TuiOutput：事件 → 状态写入 → 30ms 节流重绘 + 退出前 flush
    interactive.ts      # TUI 交互模式：输入框提交等待 + 命令/审批按键 + 多轮循环
  tui-entry.ts          # TUI 入口（纯 TS 无 JSX）：TTY 门控 + 回退 console
  agent/skill.ts        # **技能系统**：SKILL.md 发现（项目 .opencode/.claude/.agents/skills 向上 + 全局）+ frontmatter 解析（含扩展：disable-model-invocation/context:fork/agent/background）+ 按名加载 + 渐进披露（15 条）+ npx skills CLI 封装 + refreshSkillInjections（安装即时生效）+ createSkillTool（context:fork 子代理执行）
  tools/skill.ts        # skill 工具：模型按 name 加载 SKILL.md 全文（系统只常驻 name+description 清单；运行时被 createSkillTool 替换以支持子代理执行）
scripts/build-model-context-snapshot.ts # 模型能力快照生成器（npm run models:snapshot：拉 models.dev api.json →
                                         #   白名单过滤 → 归一化 {c,r,ro} → src/config/model-context-snapshot.ts；
                                         #   tsx 跑，复用 src/config/model-context-builder.ts 纯逻辑）
scripts/mock-server.mjs # 本地 mock OpenAI API（含标题/摘要/usage/MOCK_JSON 分支——最终回答为 JSON 对象，headless schema e2e）
scripts/mock-mcp.mjs    # mock MCP 服务器（stdio JSON-RPC，验证 MCP 链路）
scripts/tui-snapshot.ts # TUI 快照验证（47 场景：渲染/滚动/命令/审批/权限/上下文/记忆/计划/会话/轨迹面板/ask 提问/hero 初始界面）
scripts/probe-tmp/probe-drag-select.ts # 拖选复制探针（colToChar 列→字符/highlight 克隆/selectionText 单行多行/selectionMoved/down·drag·up 状态机/渲染高亮）
scripts/probe-tmp/probe-exec.ts # Headless 探针：parseExecArgs/schema 校验单元 + runHeadless 全链路 e2e（text/json/stream-json、
                                 #   max-turns/allowed-tools/stdin 两形态/exec resume/schema 通过·不符）+ MCP server 握手
scripts/pack-tui.sh     # 一键打包 TUI（npm run pack:tui）：版本同步 packages/omni-tui → bundle → npm pack；--compile 追加原生二进制
scripts/eval/tasks.ts   # 评估任务集（mock 离线 / 真实 API 两套）
scripts/eval/run-eval.ts# 评估运行器：跑任务集 + 完成率报告（npm run eval[:mock]）
```

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
- **安全护栏**：每个工具调用（含 MCP 外部工具与子代理）过 `Safety.gate`——权限分级（full 直通/safe 危险命令询问/ask 全询问/read 只读）+ 审批 UI（console readline / TUI 审批卡片，管道模式自动拒绝）+ 审计日志；
- **并行工具**：一次响应的多个 tool_calls 并发执行（Promise.all），结果按调用顺序回传；
- **截断**：工具结果超过 8000 字符会被截断并提示模型"用 read_file 定向获取"，防止上下文被撑爆；
- **防死循环**：`maxSteps` 上限（默认 50；典型任务 15 次内完成，20 对复杂任务偏紧）。

### TUI 渲染（src/tui/）

> 实现级细节（OpenTUI 踩坑结论、布局预算数学、细胞池复用、浮层坐标、宽度判宽对齐、各交互模块）见 `Doc/tui-architecture.md`——修改 TUI 前必读。要点：

- **命令式渲染**：直接用 `@opentui/core` 的 renderable 构建渲染树，状态变更后显式 `renderer.loop()` 重绘——放弃 `@opentui/solid`（JSX 转换时序坑：入口文件先于 preload 转换，信号失效无法重绘）；
- **细胞池复用**（非全量重建）：池只增不减，行内容原位更新，防原生 TextBuffer 耗尽（早期每帧 remove+new ~1365 次重绘后崩）；`state.ts` 是纯可变对象，不是 signal；
- **布局**：无边框根 Box + 内容行 → 状态栏 → 底部灰色块（圆角/蓝线/多行输入/模型行）+ 灰块外底行（左文件夹全路径 …… 右输入/输出 · 缓存 · 上下文迷你条，左右与输入区文本对齐、与灰块隔 1 行），`marginTop:auto` 钉底；模型行 = `Build/Plan · 模型名 组名 · 思考级别 · 会话平均 tok/s · ⠹ esc 打断`（loading+esc 打断提示仅会话进行中显示在速率右侧，accentBlue 转圈；超宽按 均值→loading 顺序隐藏）；旧底部统计行与 `/settings statusline` 面板已移除（`statusline`/`statuslineAlign` 配置保留兼容、被忽略）；内容行预算 = 高度 - 9 - inputLines，视口 <11 行隐藏状态栏；长行 CJK 感知折行（`wrapChunks`），每行恰 1 终端行；
- **提交与打断**：Enter=queue / Cmd|Ctrl|Super|Option+Enter=steer（同一轮内插入打断消息）；Esc 取消当前对话；待发送小视图（每条一行「N 排队/打断 · 文本」，steer 插最前；**点击直接编辑**——文本取回输入框，↑/↓ 选中、←/→ 排序、Backspace 删除）；todo 小视图（输入框上方、待发送区上方：todo_write 经 RunOptions.onTodo 实时镜像 ✓/▸/· 各状态）；create/流式/工具三阶段经 `waitAbort` 全部可立即取消；
- **浮层体系**：`/` 命令联想与 `@` 提及文件选择（输入区同款风格：同底色 + 左侧深灰竖线 + 与输入区同宽，扁平无边框、窗口滚动、鼠标点击）、命令菜单面板（/theme /settings /model 等）与命令输出面板（/mcp /status 等）——**扁平无边框 + 顶部留白 1 行**（同联想下拉：留白/标题/内容/提示行，无圆角卡片线）、与输入区同宽同左、底边**贴住灰色块**（hero 居中时保持 hero 跟随 0.75 居中输入区，打开面板不把输入区拉到底部；操作提示渲染在面板内部，不写状态栏）、轨迹面板（右侧栏 + 详情页）、ask 提问面板（**扁平面板**同命令面板风格，bottomBlock 流式节点紧贴输入区；自定义输入独立于主输入框）——全部绝对定位、不占内容流、不遮输入区；
- **交互细节**：思考段落/工具卡片/token 统计点击展开收起；工具卡片=超淡黄底完整长方形，收起态只显示命令，展开态含 **Claude Code Edit 风格统一 diff**（write_file：文件路径头 ✦ + 行号 gutter 双列 + `+`/`-` 标记，新增绿/删除红/上下文灰行级着色）与多读合并（read_file）；**字符级拖选复制**（OpenTUI 无选区 API，omni 自绘）：左键按在内容行建立选区（`tree.sel`，行下标 + 显示列；`colToChar` 把事件 x → 字符，CJK/emoji 全角 2 列、不断代理对），拖动实时更新焦点行/列（渲染层 `selecRow`/`markRowSelected` 命中行 chunks 重建 + `selBg`/`selFg` 高亮块），松开若有位移则 `selectionText` 提取选区文本（跨行 `\n` 连接）写系统剪贴板（OSC52 + pbcopy/xclip/Set-Clipboard 回退），成功后**右上角 toast「✓ 已复制」**；纯点击（无位移）清空不复制，浮层打开/内容区外不触发；**右上角 toast（Alert notification）**：`pushToast(state, text, type)` 设置 + 过期时间戳，`repaintTree` 渲染绝对定位右上角浮层（`toastBox`，zIndex 11 最高；宽度由内容自适应，类型着色 success 绿/error 深红/info 默认；过期即清除，`state.schedulePaint` 由 TuiOutput 注入驱动自动消失）——**拖选复制/模型切换（/model 面板与 CLI）/思考级别切换/命令面板短结果（/mcp 添加移除）/请求失败错误**统一收口到 toast，`TuiOutput.pushToast` 供 Output 通道使用；
- **主题与 i18n**：system/light/dark 自适应（OSC 10/11 检测 + `/settings theme` 强制）；中英双语 chrome（`/settings language`）；Markdown 行式渲染（含 GFM 表格 box-drawing 方框）；
- **验证**：`scripts/tui-snapshot.ts`（`npm run tui:snapshot`）内存渲染 51 场景，与 CLI 共用同一渲染路径。
### 工具列表（src/tools/）

静态注册表 6 个基础工具；`ask_user`（向用户提问）、`delegate`（子代理）与 MCP 外部工具由入口 `attachRuntime` 按配置**运行时注入**（MCP 工具名带 server 前缀，如 `demo_ping`）。

| 工具 | 作用 |
|---|---|
| `read_file` | 按行号读取文件，支持 offset/limit 分段 |
| `write_file` | 创建或整体覆盖写入文件 |
| `list_directory` | 列出目录内容 |
| `search_code` | 代码搜索（优先 ripgrep，兜底内置扫描） |
| `run_command` | 执行 shell 命令（带超时 + 输出截断；危险命令拦截在安全护栏闸门）
| `skill` | **技能**：按 name 加载已安装技能（SKILL.md）的完整指令内容（对标 opencode；只读，不修改文件） |
| `web_search` | **Web 搜索**（运行时注入，Brave Search API）：关键词 → 搜索结果列表（标题/URL/摘要）；key 配 `webSearchApiKey` 或环境变量 `BRAVE_API_KEY`，结果可再交 `web_fetch` 抓取 |
| `ask_user` | **向用户提问**（运行时注入，同 delegate）：agent 遇歧义/需要用户决策时——TUI 输入区上方**扁平面板**（无边框/无底色，紧贴输入区；A-D 勾选 / **独立自定义输入**——打字进面板缓冲不进主输入框 / Esc 取消）、console readline 询问；结果回传模型继续（取消/非交互则模型自行决定） |
| `delegate` | **子代理**：把独立子任务委托给隔离上下文的小循环（可选，`allowSubagents`；支持 `agent` 参数按名加载子代理定义——per-agent 模型/权限/工具白名单/技能，嵌套委托 depth 上限 5）
| `/skill` 命令 | **技能管理**（TUI/CLI 交互）：`/skill` 列出已发现（含标签：全局/仅手动/子代理）· `/skill find <词>` 走 `npx skills find` 网络检索 skills.sh · `/skill add <repo> [--skill <名>] [--global]` 安装（本会话即时生效，`refreshSkillInjections` 刷新注入清单）· `/skill show <名>` 查看内容（含 frontmatter 扩展属性） |
| `/compact` 命令 | **手动压缩上下文**：把旧消息合并为摘要（复用 summarizeContext，保留最近 8 条原文）
| `/agents` 命令 | **查看子代理配置**：delegate 启用状态 / 模型 / 步骤上限 / 子代理可用工具 + 已发现子代理定义（`.agents/subagents/*.md`，只读）
| `/orchestrate` 命令 | **编排**：fan-out 并行 delegate（默认 3 worker）→ 汇总 → 对抗审查 → 最终报告（`/orchestrate <任务>`）
| `/goal` 命令 | **目标机制**（别名 `/loop`）：自动推导验收标准并循环执行直至达标（`/goal <目标>`，缺省「目标拆解器」LLM 推导 2-3 条可验证标准 / `--accept <标准>` 显式指定 / `--max N` 迭代上限 / 含迭代日志与判定反馈） |
| `/review` 命令 | **代码审查**：先跑项目自带 typecheck（无则 lint），再收集 git diff，一次独立 LLM 调用输出问题与建议
| `/variants` 命令 | **切换模型思考级别**（reasoning_effort）：面板/CLI 切换，优先级 = 配置 reasoningEffortOptions（omni.json，显式空数组=明确关闭）> models.dev 快照查表（effort 子集/仅开关 none·auto）> 默认档位（low/medium/high/xhigh/max + none/auto）；none/auto 不随请求下发参数 |
| `/models` 命令 | **模型能力快照（CLI/TUI/Web 三端）**：`/models` 查看状态（来源：内置/用户更新 · 条数 · 生成时间天龄）· `/models refresh` 在线拉取 models.dev 重建快照 → 写 `~/.config/omni/model-context-snapshot.json` + **热替换内存表立即生效**（默认不自动更新；删除该文件恢复内置；开发者更新内置快照用 `npm run models:snapshot`） |
| `/model` 命令 | **切换/添加模型**（多端点）：`/model` 面板 · `/model <名称>` 切换 · `/model add <名称> [--base-url <url>] [--api-key <key>] [--user-agent <ua>]` **添加并持久化**（运行时注册进 runOpts.models + 切换，纯 JSON 配置自动追加 **providers 单模型分组**，JSONC 提示手动加）；选项来自配置 providers 分组（端点/密钥的唯一格式，缺省字段回退网关级/环境变量）；切换时用 createClient 重建客户端并更新 ModelRuntime（主循环与子代理同步） |
| `/status` 命令 | **会话状态汇总**：模型/权限/计划模式/思考级别/token 用量/会话文件/已加载脚手架（记忆/技能/预载）；共享逻辑在 `agent/report.ts`（TUI+CLI 复用） |
| `/context` 命令 | **上下文用量**：消息数（user/assistant/tool）+ token 估算 + 已加载脚手架 + 距自动压缩阈值建议 |
| `/export` 命令 | **导出会话**为 Markdown（`.omni/export-<时间戳>.md`；脚手架 system 消息不导出） |
| `/config` 命令 | **查看配置文件**：全局/项目/自定义路径 + 配置来源（TUI 不 spawn 编辑器，console 用 $EDITOR 打开） |
| `/mcp` 命令 | **管理 MCP 服务器**：列出已配置服务器/已发现工具/资源/提示词；`/mcp reconnect` 重连；`/mcp resources /mcp prompts` 查看资源/提示词；`/mcp add <名> <command|--url>` 运行时添加并持久化；`/mcp remove <名>` 移除；`/mcp login <名>` OAuth 登录（HTTP 服务器） |
| `/diff` 命令 | **查看未提交改动**（复用 review.ts 的 collectDiff，输出前 60 行） |
| `/rename` 命令 | **改会话标题**：终端窗口标题（OSC 0）+ 会话 meta 落盘（SessionMeta.title，/resume 还原） |
| `/resume` 命令 | **恢复历史会话**：无参列出 / `<id>` 恢复（替换 messages + sessionPath + 重置落盘计数 + 历史回放进对话流；onResume 回调由 interactive 组装） |
| `/fork` 命令 | **会话 fork**：从当前会话历史某点分叉独立新会话（原会话不丢）——`/fork` 无参列出可保留消息序号摘要，`/fork <N>` 保留前 N 条并自动切换（复用 onResume 链路；Web 端文件级 fork 侧栏可见） |
| `/send` 命令 | **跨会话消息**：`/send <会话id> <消息>` 向指定会话发消息取结果——串行执行（保存当前上下文 → 载入目标会话 → 跑一轮 → 落盘 → 恢复），结果以 `[跨会话响应]` system 消息注入当前上下文（TUI/CLI 支持；Web 提示全局单运行限制） |
| `/session` 命令 | **会话管理（加载同目录历史会话并继续）**：无参列出**当前目录**（同目录）的历史会话——TUI 打开选择面板（↑↓/数字 + Enter 继续）、CLI 文本列出；`/session <id>` 直接继续（支持 id 前缀匹配，多个命中列出候选不静默选）；`/session all` 列出全部跨目录；列表/匹配均排除当前会话；恢复后清理空占位会话文件（同 `/resume` 共用 restoreSession：替换 messages + 会话文件 + 重置落盘计数） |
| `/memory-apply` 命令 | **应用待提交的项目记忆片段**：`.omni/memory-pending.md` → 项目根 AGENTS.md（退出时自动提取项目持久事实生成待确认片段；确认后应用并清片段） |
| `/redo` 命令 | **重做上次撤销**：UndoStack 新增 redo 栈——/undo 时 popForUndo 捕获「撤销前」状态，/redo 恢复；新写入清空 redo 历史 |
| `/trace` 命令 | **轨迹面板（右侧栏）**：每轮请求/工具/消息账本——`/trace` 展开/收起；数据源 = 事件记录器（event.ts 内存全量事件，interactive 每轮 refreshTrace 投影），console 端 `/trace` 打印文本账本；TUI 面板 ↑/↓ 选择 + **点击推入详情页**（顶部返回按钮 + 完整内容）+ Esc 收起，展开时内容宽度收缩（面板不盖对话流） |
| `/doctor` 命令 | **环境诊断**：Node/Bun 版本、API Key、端点连通性（5s 超时 fetch）、配置/MCP/权限/模型 |
| `mcp_*` | **MCP 外部工具**：经 stdio（本地子进程）或 streamable HTTP（远端端点）调用外部服务器（可选，`mcpServers`）；同名 server 资源/提示词辅助工具（`<server>_read_resource` / `<server>_get_prompt`）随声明自动注册；server instructions 注入系统提示；per-tool 审批模式（`defaultToolsApprovalMode`）过安全闸门 |

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
- [ ] 进阶：SWE-bench 评测、/rewind 三模式（code/conversation/both）、agent teams 完整版
## 文档地图

| 文档 | 内容 |
|---|---|
| `Doc/evolution-log.md` | 全部迭代记录（第一次 ~ 第一百七十三次，按时间倒序） |
| `Doc/tui-architecture.md` | TUI 渲染实现细节（OpenTUI 踩坑/布局预算/交互设计） |
| `Doc/roadmap.md` | 路线图全量条目 |
| `Doc/release-guide.md` | 构建与发布完整流程（CI/npm/关键坑） |
| `Doc/TODO.md` | 可做事项 backlog + 1.0 调研与规划（合并版：当前待办 / 调研・差距矩阵 / 1.0 TODO / 发布工程 / 不做清单 / 领先项） |
| `Doc/Usage-Guide.md` · `Doc/使用指导.md` | 用户手册（英 / 中） |
| `Doc/Headless-Protocol.md` | Headless 协议冻结说明 |
| `Doc/research-terminal-agents-2026.md` | 全市场 Agent Harness 调研原始报告 |
| `README.md` · `README.zh-CN.md` | 项目总览 / 快速开始 |
| `config.schema.json` · `schemas/` | 配置 JSON Schema / 协议冻结 Schema |
