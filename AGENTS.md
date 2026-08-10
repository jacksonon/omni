# AGENTS.md — Omni 项目开发指南

> 本文件是 Omni 项目内所有 AI 协作 Agent（Claude Code / Codex / opencode / 本仓库的 omni 自身）的开发指南。
> **项目演进时本文件会同步更新**；变更记录见文末「演进日志」。

## 项目是什么

Omni 是一个**从零手写的全功能 Coding Agent**（终端型 AI 编程助手），对标 opencode / codex / Claude Code。
当前处于 **MVP 阶段**：单 Agent 循环 + 5 个基础工具，无框架依赖（裸 OpenAI SDK + 手写循环）。

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

## 配置（配置文件 + 环境变量 + CLI 参数）

参考 opencode 的配置体系，支持 JSON / **JSONC**（带注释）。

**优先级（低 → 高）**：默认值 → 全局配置 → 项目配置 → 自定义配置 → 环境变量 → CLI 参数

| 层级 | 位置 | 说明 |
|---|---|---|
| 全局配置 | `~/.config/omni/omni.json` | 用户级默认（尊重 `XDG_CONFIG_HOME`） |
| 项目配置 | `omni.json` / `omni.jsonc` | 从当前目录向上找，最近的生效；git 根与 home 为边界 |
| 自定义配置 | `OMNI_CONFIG` 环境变量 或 `--config <路径>` | 显式指定 |
| 环境变量 | `OMNI_API_KEY` / `OMNI_BASE_URL` / `OMNI_MODEL` / `OMNI_MAX_STEPS` / `OMNI_SHOW_THINKING` / `OMNI_DEBUG` | 覆盖配置文件；`OMNI_DEBUG=1` 打印发往 LLM 的完整请求体 |
| CLI 参数 | `-m, --model <名称>` | 最高优先级 |

**配置字段**：

```jsonc
{
  "model": "deepseek-chat",              // 模型名（默认 gpt-4o-mini）
  "baseURL": "https://api.deepseek.com/v1", // OpenAI 兼容 API 地址
  "apiKey": "sk-xxx",                    // 更推荐用环境变量 OMNI_API_KEY
  "maxSteps": 20,                         // Agent 最大循环步数
  "showThinking": true                    // 展示思考过程（默认 true；false 关闭终端显示，仍落盘 .omni/last-thinking.md）
}
```

示例文件：`omni.example.jsonc`（复制为 `omni.json` 使用）。API Key 也兼容 `OPENAI_API_KEY`。

## 架构速览

```
src/
  index.ts              # CLI 入口：main 调度（参数 → 配置 → 客户端 → 单次/交互）
  version.ts            # 版本号常量
  ui.ts                 # 终端 UI：ANSI 颜色、TTY 检测、spinner
  cli/
    args.ts             # 参数解析（-m/-c/-h/-v）+ 帮助文本
    banner.ts           # 启动 banner（版本/模型/工具/配置来源）
    interactive.ts      # 交互模式：readline 循环，跨轮次保持上下文
  agent/
    loop.ts             # **Agent 主循环**：流式调 LLM → 工具调用 → 执行 → 结果回传
    thinking.ts         # 思考过程：流式显示（浅色保留在屏幕，不折叠）/落盘（reasoning 字段提取）
    messages.ts         # 消息组装：assistant 消息构造、工具参数解析
    types.ts            # RunOptions / ThinkingDisplay 共享类型
  tools/
    index.ts            # 工具注册表（登记新工具处）
    types.ts            # Tool 接口（独立文件避免循环导入）
    util.ts             # 公共小函数：num / resolvePath / truncate / TOOL_OUTPUT_LIMIT
    read-file.ts        # read_file
    write-file.ts       # write_file
    list-directory.ts   # list_directory
    search-code.ts      # search_code
    run-command.ts      # run_command（危险命令拦截）
  config/
    index.ts            # 配置加载：分层合并
    jsonc.ts            # JSONC 解析（注释/尾逗号）
    discover.ts         # 配置发现：目录内查找 + cwd 向上查找
  tui/
    state.ts            # TUI 状态（纯对象，无响应式依赖）
    render.ts           # 命令式渲染：mountTree/repaintTree/startTui（见下方 TUI 说明）
    output.ts           # TuiOutput：事件 → 状态写入 → 30ms 节流重绘 + 退出前 flush
    interactive.ts      # TUI 交互模式：输入框提交等待 + /exit /clear /help + 多轮循环
  tui-entry.ts          # TUI 入口（纯 TS 无 JSX）：TTY 门控 + 回退 console
scripts/mock-server.mjs # 本地 mock OpenAI API，用于无 Key 端到端测试
scripts/tui-snapshot.ts # TUI 快照验证（createTestRenderer 内存渲染断言）
```

### 核心循环（src/agent.ts）

```
for step in 1..maxSteps:
  1. 流式调用 LLM（携带全部历史消息）
  2. 无工具调用 → 输出最终回答，结束
  3. 有工具调用 → 解析 JSON 参数 → 执行工具
  4. 结果以 role=tool 回传 → 回到 1
```

关键机制：
- **自我纠错**：工具执行失败时，错误信息作为工具结果返回给模型，由模型自己修正；
- **截断**：工具结果超过 8000 字符会被截断并提示模型"用 read_file 定向获取"，防止上下文被撑爆；
- **防死循环**：`maxSteps` 上限（默认 20）。

### TUI 渲染（src/tui/，重要背景）

> **为什么不用 OpenTUI 的 solid 集成？** 踩坑结论：`@opentui/solid` 的 JSX 转换依赖 preload 注册插件，而**入口文件在插件注册前就被转换**（bun 的时序问题），JSX 被编译成 react 风格（静态求值），信号变更完全无法触发重绘（`createEffect` 一次都不执行）。bunfig preload、动态 import + 手动 `plugin()`、Bun.build + 显式插件均无法修复。
>
> **当前方案（命令式渲染）**：直接用 `@opentui/core` 的 renderable（BoxRenderable/TextRenderable/InputRenderable）构建渲染树，状态变更后显式调用 `renderer.loop()` 重绘（与测试库 renderOnce 内部机制一致）。确定性强、无响应式魔法。
>
> 关键点：
> - `state.ts` 是纯可变对象（lines[]/status/model/version），不是 signal；
> - 每次重绘**全量重建**文本子节点（remove 旧的 + add 新的）——MVP 阶段内容量小，简单可靠；
> - 布局：根 Box（`flexGrow:1` 撑满视口）带边框+标题（`Omni vX · 模型`），内容行 → 状态栏 → 输入框（可选）；输入框用 `marginTop:auto` 吸收剩余空间，**始终钉在视口最底部**（内容从顶部增长，超出尾部窗口后自动裁剪）；内容行用 `insertBefore` 插到状态栏之前；
> - `computeRows` 尾部窗口裁剪 + **滚动**：高度 - 根框固定(4) - 输入框+状态栏(4 或 1)，超出的部分默认自动跟随最新；`scrollTop` 非 null 时回看历史（内容窗 cap-1 行 + 底部 dim 提示行「↑ 已上滚 N 行 · 共 M 行」）；`scrollIntent`（按键发出的一次性指令）在 computeRows 内消费，滚动数学集中一处；**长行自动折行**（`wrapChunks`：CJK 全角算 2 列、优先空格断行（词边界）、其次标点后断行（中文散文友好，标点留行尾）、否则硬断、不切代理对）后设置 `wrapMode:'none'`——折行后每行恰好 1 个终端行，行数预算精确成立（否则 TextBuffer 默认 word 换行会把实际渲染行数撑过预算，yoga 把状态栏/输入框挤出视口）；视口 <8 行时隐藏状态栏保证输入框完整；
> - `TuiOutput.schedulePaint` 30ms 节流合并突发 chunk；**退出前必须 `flush()`**（清掉节流计时器并强制画最后一帧），否则“任务完成”等最终状态会丢；
> - `renderer.loop()` 在 d.ts 中是 private，但运行时存在（test-renderer 内部也调它），用类型断言调用；
> - **交互模式（交互式 TUI）**：`dev:tui` 无任务参数时进入——底部 `InputRenderable` 输入框 + 消息滚动区，多轮对话；Enter 提交走 `input.on('enter')` 事件（InputRenderable 重写了 submit()，**不走父类的 onSubmit 回调**）；输入框自带 return/kpenter/linefeed → submit 绑定；状态栏显示“等待输入…”；/exit /clear /help 内联处理；按键时通过 `session.onKeyPress` 兜底重绘；
> - **Markdown 行式渲染**（`tui/markdown.ts`）：最终回答按行解析成带样式片段（加粗/行内代码/斜体/标题/引用/水平线/围栏代码块），语法标记（`**`、` `、```` ``` ````、`#`）隐藏（conceal），代码块行统一着色；流式友好（每次重绘对完整文本重解析，未闭合标记按纯文本处理）。刻意不用 MarkdownRenderable——它是动态高度块，无法参与尾部窗口裁剪；行式方案每行高度固定为 1；
> - 快照验证（`tui:snapshot`）用 `createTestRenderer` 内存渲染，与 CLI 共用 mountTree/repaintTree 同一渲染路径，5 个场景断言（布局/溢出跟随/增量重绘/TuiOutput+flush/Markdown 渲染与 conceal，含输入框与用户消息）。

### 工具列表（src/tools.ts）

| 工具 | 作用 |
|---|---|
| `read_file` | 按行号读取文件，支持 offset/limit 分段 |
| `write_file` | 创建或整体覆盖写入文件 |
| `list_directory` | 列出目录内容 |
| `search_code` | 代码搜索（优先 ripgrep，兜底内置扫描） |
| `run_command` | 执行 shell 命令（带超时 + 危险命令拦截 + 输出截断） |

## 对 AI Agent 的协作规范

1. **改代码前先读**相关文件，不要凭空猜测；
2. 遵守现有风格：TypeScript strict、ESM（NodeNext）、无框架依赖、中文注释 + 英文命名；
3. **保持 MVP 简洁**：能不加抽象就不加；新功能先写直白代码，出现明显重复再考虑提炼；
4. **修改工具时**：必须同步更新 `tools.ts` 中的 JSON Schema 与 `description`（description 是写给模型看的说明书，直接决定模型会不会用）；
5. **架构或命令有变化时**：同步更新本文件，并在「演进日志」追加一行；
6. 涉及破坏性操作（删文件、全局安装、git 推送等）前先与用户确认。

## 路线图

> 来源：仓库根目录 `Agent开发认知梳理.md` 的认知地图（概念层 → 设计层 → 实现层 → 交付层）。

- [x] **MVP**：Agent 循环 + 5 基础工具 + mock 端到端测试
- [ ] 上下文管理：工具结果截断（✅ 已实现）→ 消息摘要压缩 → 相关文件选择性加载
- [ ] 安全护栏：危险命令确认、权限分级、审计日志
- [ ] 评估体系：自建任务集 + 完成率统计；进阶 SWE-bench
- [ ] CLI 体验：ANSI 着色、TUI 状态展示（对标 opencode）
- [ ] MCP 接入（外部工具生态）
- [ ] 子代理（subagent）与并行工具执行

## 演进日志

- **2026-08-10（第一次）**：初始化 MVP。Agent 循环（流式 + 工具调用 + 自我纠错）+ 5 工具 + mock server 端到端验证。技术栈：TypeScript / NodeNext / 裸 openai SDK。
- **2026-08-10（第二次）**：安全与健壮性加固——run_command 危险命令拦截（rm -rf /、mkfs、dd 写盘、fork bomb、git push 等）；统一截断逻辑（tools.ts 单一实现）；search_code 兜底支持正则匹配；参数 NaN 防护；交互模式新增 `/clear`；CLI 新增 `--version`；mock server 简化（恒流式）。
- **2026-08-10（第三次）**：打包完善——bun 单文件打包（`dist/omni.cjs`）、bun 原生二进制（`release/omni`，零依赖）、npm pack 发布链路（`omni-0.1.0.tgz`，仅含 dist）；全局安装 + 端到端验证通过。
- **2026-08-10（第四次）**：配置文件体系（参考 opencode）——`src/config.ts` 分层合并（默认/全局/项目/自定义/环境变量/CLI）；JSONC 解析；`omni.json`/`omni.jsonc` 自动发现；新增 `-m/--model`、`-c/--config` 参数；banner 展示配置来源；示例 `omni.example.jsonc`。
- **2026-08-10（第五次）**：真实 API 接入——工作区根目录 `omni.json`（gemini-3.1-pro-preview @ ai.centos.hk）；OpenAI 客户端加固（`timeout: 60s, maxRetries: 1`），端点不可达时快速失败而非静默挂起。
- **2026-08-10（第六次）**：新增 `OMNI_DEBUG=1` 调试开关（打印发往 LLM 的完整请求体，stderr 输出不污染流式内容）；排查结论：请求格式为标准 OpenAI 兼容（DeepSeek 官方端点 401 验证格式正确），`ai.centos.hk` 对本机网络不可达（TCP 超时，与请求格式无关）。
- **2026-08-10（第七次）**：真实 API 端到端跑通——切换智谱（`glm-4-flash` @ open.bigmodel.cn/api/paas/v4）；真实模型完成 list_directory 与 run_command 两次工具调用并正确总结；`GLM-4.7-Flash` 当前 429 拥堵，付费模型余额不足，`glm-4-flash` 可用。
- **2026-08-10（第八次）**：切换 `grok-4.5` @ `frapi.centos.hk`——两个关键修复：① baseURL 不能含 `/chat/completions`（SDK 自动追加）；② 新增配置字段 `userAgent`（该网关 WAF 拦截 SDK/curl 默认 UA，配浏览器 UA 后连通）；验证多步探索与并行工具调用。
- **2026-08-10（第九次）**：CLI 输出优化——新增 `src/ui.ts`（ANSI 颜色、TTY 检测：管道输出自动无色、支持 NO_COLOR/FORCE_COLOR、spinner）；思考中 spinner（stderr，不污染 stdout）；步骤日志改为 `[n/max] 工具名(参数)` + ✓/✗ 结果标记；抑制 Node 过时 API 警告；SIGINT 优雅退出；彩色 banner 与交互提示。
- **2026-08-10（第十次）**：思考过程显示与折叠——流式捕获 `reasoning_content`/`reasoning`/`thinking` 三种字段；TTY 下灰色 `💭` 内联实时显示；正文或工具调用开始时自动折叠为一行摘要（ANSI 光标上移+清行），光标紧贴折叠行不留空白；完整思考落盘 `.omni/last-thinking.md`；管道模式只提示不内联（保持可 grep）；审查确认思考内容不进入回传 messages。
- **2026-08-10（第十一次）**：思考展示开关——新增配置字段 `showThinking`（默认 `true`）与环境变量 `OMNI_SHOW_THINKING`；关闭后终端完全静默（无内联显示、无管道提示），但思考仍捕获并落盘 `.omni/last-thinking.md` 供调试。
- **2026-08-10（第十二次）**：思考**流式显示修复**——原实现是"行缓冲"（只有遇到 `\n` 才输出），而 grok 等模型的 reasoning 是一长段无换行文本，导致思考内容从未显示、直接折叠（用户报告的 bug）。重写为逐字符实时流式输出（像打字一样边想边显示）：自行按终端宽度折行（displayWidth 估算 CJK 宽度）、前缀延迟到行首字符到达才输出、折叠行数模型 `n = 换行数 + (末尾未换行 ? 1 : 0)` 精确清行；审查修复 `col` 实时累计（chunk 内折行判断）+ `\r` 归一化。mock 支持 `MOCK_REASONING=long` 复现无换行场景。真实 PTY 验证：11 行思考显示后折叠无残留。
- **2026-08-10（第十三次）**：**模块拆分重构**——5 个大文件拆为 18 个细粒度单元（见上方架构速览）：`tools/` 每工具一文件 + 独立 `types.ts`（避免循环导入）；`agent/` 拆出 thinking（思考显示）/ messages（消息组装）/ loop（主循环）；`config/` 拆出 jsonc / discover；`cli/` 拆出 args / banner / interactive。构建（tsc+bun）与三种产物验证通过。
- **2026-08-10（第十四次）**：**思考不折叠 + 执行过程展示**——按用户要求：① 去掉折叠行为，思考内容以浅色（dim）实时显示后**完整保留在屏幕**（原 ANSI 折叠数学全部删除，接口 collapse → finish 只负责归位光标）；② 工具执行日志增强为 `→ [n/max] 工具名(参数)` + `✓/✗ 返回 N 字符`，每步动作清晰可见（思考开关不影响执行步骤展示）。
- **2026-08-10（第十五次）**：**TUI 全屏界面（命令式渲染）**——按用户要求加入 OpenTUI。深挖排障后确认 `@opentui/solid` 在此环境 JSX 转换时序不可修复（入口文件先于 preload 转换、信号失效），**彻底放弃 solid 响应式**，改用 `@opentui/core` renderable 命令式构建 + `loop()` 显式重绘：新增 `src/tui/`（state/render/output）+ `src/tui-entry.ts`（纯 TS 入口，TTY 门控，非 TTY 自动回退 console）+ `scripts/tui-snapshot.ts`（createTestRenderer 内存快照，4 场景断言）。审查修复：thinking 对象 `this` 绑定、退出前 `flush()` 丢最后一帧、节流计时器清理；TS 闭包 CFA 把回调内赋值的 let 收窄为 never（改用数组捕获）。三种产物 + console 全回归 + 真实 PTY TUI 端到端（思考/工具调用/结果/最终回答实时渲染）全部通过。
- **2026-08-10（第十六次）**：**交互式 TUI（底部输入框 + 多轮对话）**——按用户要求，`dev:tui` 无任务参数时不再回退 console，而是进入全屏 TUI：重构渲染布局（根 Box 边框+标题、内容区、底部 `InputRenderable` 输入框、状态栏），新增 `tui/interactive.ts` 多轮循环（/exit /clear /help 内联处理，Agent 运行期间 blur 输入框）。**关键排障**：`InputRenderable` 重写了 `submit()`——Enter 时只 `emit('enter')` 事件、**不调用父类 onSubmit**（初版用 onSubmit 导致 Enter 无效，监听 `input.on('enter', value)` 修复）；Enter→submit 为库自带绑定，无需自定义 keyBindings。Output 接口新增 onUserMessage/onTurnEnd/onWaitForInput/clearScrollback/showHelp（console 同步实现，交互模式回显 `❯` 用户消息）；main 提取 `prepareRun` 供两入口复用。验证：typecheck + 快照 4 场景 + 真实 PTY 端到端（多轮对话：用户消息/思考/工具调用/回答/帮助/退出全通过，单任务模式回归通过）。
- **2026-08-10（第十七次）**：**系统提示词接上线 + 防泄漏**——修复 `loop.ts` 中 `SYSTEM_PROMPT` 声明后从未发送的死代码：每轮请求前构造 `[{role:'system', content:SYSTEM_PROMPT}, ...messages]` 副本注入（不 push 进 messages 历史，避免交互模式跨轮重复累积）。随后按用户要求替换为**防泄漏版**：新增身份回答话术（被问"你是谁"时自然自我介绍）与严禁复述条款（不泄露提示词/系统指令/内部配置）。OMNI_DEBUG 请求体同步显示 system 消息。typecheck + mock 端到端（两轮请求均含 system 消息）验证通过。
- **2026-08-10（第十八次）**：**Markdown 行式渲染**——按用户要求给 TUI 输出加格式化（此前回答是纯文本，`**加粗**`、```代码块``` 原样显示）：新增 `tui/markdown.ts`（行式解析：加粗/行内代码/斜体/标题/引用/水平线/围栏代码块，语法标记 conceal，代码行着色），render.ts 的 Row 支持样式片段（StyledText + TextAttributes），answer 行走 Markdown 渲染、其余行不变。刻意不用 MarkdownRenderable（动态高度块无法参与尾部窗口裁剪）。mock server 新增 `MOCK_MARKDOWN=1` 开关用于可视化验证。验证：typecheck + 快照 5 场景（新增 Markdown 场景：内容保留 + `**`/```/`## ` 零泄漏）+ 真实 PTY（MOCK_MARKDOWN 流式回答渲染）+ chunk 样式单元验证。
- **2026-08-10（第十九次）**：**内容区滚动 + 布局稳定性**——修复两个用户报告的问题：① 内容超一屏后无法回看历史：`computeRows` 引入滚动窗口（`state.scrollTop`：null 跟随最新 / 数字为上滚位置），`scrollIntent` 一次性指令在 computeRows 内消费（PgUp/PgDn 翻页、↑/↓ 逐行、Home 顶部、End 回底）；`onKeyPress` 回调改为接收完整按键对象（KeyEvent 子集），滚动键 `preventDefault()` 阻止输入框处理；冲突规则：输入框（Textarea）占用 ↑/↓/Home/End 编辑键，输入框为空时这些键才滚动，PgUp/PgDn/Ctrl+↑/↓/Ctrl+Home/End 始终可滚；上滚时底部显示 dim 提示行「↑ 已上滚 N 行 · 共 M 行 · End 回到最新」，新内容到达时锚定当前视口不跳动。② 输入框"不能完整消失"：根因是 TextRenderable 默认 `wrapMode:'word'` 会把长行（如粘贴的 SYSTEM_PROMPT）换行成多行，实际渲染行数撑过预算，yoga 把输入框挤出视口底部只剩半截——改为行级截断（按显示列数，CJK 全角 2 列，超长加省略号）+ 内容行/状态栏 `wrapMode:'none'`，每行恰好 1 个终端行；视口 <8 行时隐藏状态栏优先保证输入框完整。验证：typecheck + 快照 8 场景（新增场景 7 滚动窗口/提示行断言、场景 8 长行截断 + 输入框完整断言）+ 真实 PTY 端到端（3 轮对话 + PgUp×2 上滚出现提示行 + End 回底 + /exit 干净退出，用自建 CJK 感知终端模拟器重建终屏确认三轮渲染与布局均正确）。
- **2026-08-10（第二十次）**：**长行截断改为自动折行**——用户反馈"消息会被截断而不是换行"：把上次的 `truncateRow`/`truncateText`（超长加省略号）替换为列宽感知折行 `wrapChunks`/`wrapRow`——CJK 全角算 2 列、优先在空格断行（词边界，空格丢弃）、其次在标点后断行（中文散文无空格，`，。、；：！？` 等标点留行尾，长 URL 借 '.' 断行）、否则硬断；`fitCount` 不切断代理对（emoji 整对保留/舍弃）；修复 chunk 累积时 `used` 列数记账（多 chunk 拼同一行会溢出宽度的隐患）；折行后每行仍恰好 1 个终端行，行数预算不变，输入框布局不受影响。mock 新增 `MOCK_LONGLINE=1` 开关（追加长无换行散文）。验证：typecheck + 快照 8 场景（场景 8 改为断言普通行与 Markdown 行均折行完整显示、行尾内容不丢失、输入框完整）+ 真实 PTY 端到端（长回答中段/尾段全部可见、答案首行经 PgUp 上滚可回看、语法标记零泄漏、EXIT=0）。