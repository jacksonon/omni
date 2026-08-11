# AGENTS.md — Omni 项目开发指南

> 本文件是 Omni 项目内所有 AI 协作 Agent（Claude Code / Codex / opencode / 本仓库的 omni 自身）的开发指南。
> **项目演进时本文件会同步更新**；变更记录见文末「演进日志」。

## 项目是什么

Omni 是一个 **Agent 工程**（终端型 AI 编程助手）。
当前为 **MVP+ 阶段**：单 Agent 循环 + 5 个基础工具 + 安全护栏 + 上下文管理 + 子代理/并行工具 + MCP 外部工具，无框架依赖（裸 OpenAI SDK + 主循环）。

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
npm run eval              # 评估：真实 API 跑任务集 + 完成率报告（eval-report.json）
npm run eval:mock         # 评估：离线 mock（确定性，可进 CI）
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
  "permission": "safe",                  // 安全护栏权限分级：full / safe（危险命令询问，默认）/ ask / read
  "auditLog": true,                       // 写审计日志（~/.config/omni/audit.log；默认 true）
  "summarizeAt": 40,                      // 长对话摘要压缩阈值（消息数；0 = 关闭）
  "preloadFiles": true,                   // 预载任务文本中出现的相关文件（默认 true）
  "allowSubagents": true,                 // 启用子代理 delegate 工具（默认 true）
  "mcpServers": {                         // MCP 外部工具（可选）：{ 名称: { command, args?, env? } }
    "demo": { "command": "node", "args": ["scripts/mock-mcp.mjs"] }
  }
}
```

示例文件：`omni.example.jsonc`（复制为 `omni.json` 使用）。API Key 也兼容 `OPENAI_API_KEY`。

## 架构速览

```
src/
  index.ts              # CLI 入口：main 调度（参数 → 配置 → 客户端 → 单次/交互）
  version.ts            # 版本号常量
  ui.ts                 # 终端 UI：ANSI 颜色、TTY 检测、spinner、窗口标题（OSC 0）
  cli/
    args.ts             # 参数解析（-m/-c/-h/-v）+ 帮助文本
    banner.ts           # 启动 banner（版本/模型/工具/权限/配置来源）
    interactive.ts      # 交互模式：readline 循环，跨轮次保持上下文（含上下文准备）
  agent/
    loop.ts             # **Agent 主循环**：流式调 LLM → 工具调用（并行）→ 安全过闸 → 执行 → 结果回传
    thinking.ts         # 思考过程：流式显示（浅色保留在屏幕，不折叠）/落盘（reasoning 字段提取）
    messages.ts         # 消息组装：assistant 消息构造、工具参数解析
    context.ts          # 上下文管理：相关文件预载（selectRelevantFiles）+ 长对话摘要压缩（summarizeContext）
    subagent.ts         # 子代理：隔离上下文嵌套循环（无 UI、小步数上限、共用安全闸）
    title.ts            # 会话标题：首轮后异步生成，设为终端窗口标题
    types.ts            # RunOptions / ThinkingDisplay 共享类型
  safety/
    index.ts            # Safety 闸门：policy 判定 + 审批回调 + 审计记录（loop/子代理共用）
    policy.ts           # 权限分级（full/safe/ask/read）+ 危险命令检测
    audit.ts            # 审计日志落盘（~/.config/omni/audit.log）
  tools/
    index.ts            # 静态工具注册表（新增工具登记处）
    types.ts            # Tool 接口（独立文件避免循环导入）
    util.ts             # 公共小函数：num / resolvePath / truncate / TOOL_OUTPUT_LIMIT
    read-file.ts        # read_file
    write-file.ts       # write_file
    list-directory.ts   # list_directory
    search-code.ts      # search_code
    run-command.ts      # run_command（超时 + 输出截断；危险拦截兜底在 safety/policy）
    delegate.ts         # delegate 子代理工具（运行时由入口按配置注入）
    mcp.ts              # MCP 客户端：stdio JSON-RPC + 运行时工具发现注册（McpClient/discoverMcpTools）
  config/
    index.ts            # 配置加载：分层合并（含权限/审计/上下文/子代理/MCP 字段）
    jsonc.ts            # JSONC 解析（注释/尾逗号）
    discover.ts         # 配置发现：目录内查找 + cwd 向上查找
  tui/
    state.ts            # TUI 状态（纯对象，无响应式依赖；含审批卡片/联想/菜单状态）
    render.ts           # 渲染编排：mountTree/repaintTree/startTui（行构建在 rows.ts）
    rows.ts             # 内容行构建：buildBody/computeRows/卡片与审批卡/点击命中（纯函数）
    layout.ts           # 布局常量 + 按显示列数的折行/截断数学（不依赖 OpenTUI）
    theme.ts            # 主题色板与取色（system/light/dark）
    output.ts           # TuiOutput：事件 → 状态写入 → 30ms 节流重绘 + 退出前 flush
    interactive.ts      # TUI 交互模式：输入框提交等待 + 命令/审批按键 + 多轮循环
  tui-entry.ts          # TUI 入口（纯 TS 无 JSX）：TTY 门控 + 回退 console
scripts/mock-server.mjs # 本地 mock OpenAI API（含标题/摘要/usage 分支）
scripts/mock-mcp.mjs    # mock MCP 服务器（stdio JSON-RPC，验证 MCP 链路）
scripts/tui-snapshot.ts # TUI 快照验证（24 场景：渲染/滚动/命令/审批/权限/上下文）
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

### TUI 渲染（src/tui/，重要背景）

> **为什么不用 OpenTUI 的 solid 集成？** 踩坑结论：`@opentui/solid` 的 JSX 转换依赖 preload 注册插件，而**入口文件在插件注册前就被转换**（bun 的时序问题），JSX 被编译成 react 风格（静态求值），信号变更完全无法触发重绘（`createEffect` 一次都不执行）。bunfig preload、动态 import + 手动 `plugin()`、Bun.build + 显式插件均无法修复。
>
> **当前方案（命令式渲染）**：直接用 `@opentui/core` 的 renderable（BoxRenderable/TextRenderable/InputRenderable）构建渲染树，状态变更后显式调用 `renderer.loop()` 重绘（与测试库 renderOnce 内部机制一致）。确定性强、无响应式魔法。
>
> 关键点：
> - `state.ts` 是纯可变对象（lines[]/status/model/version），不是 signal；
> - 内容行用**细胞池复用**（非全量重建）：池只增不减，行数变化只切 `visible`，行内容原位更新 `content/attributes/fg`——每个 TextRenderable 持有原生 TextBuffer，早期「每帧 remove+new」会耗尽原生对象池（实测 ~1365 次重绘后 `createTextBuffer` 抛错且内容区被清空），复用后一次会话只分配一次、永不耗尽；
> - 布局：根 Box（`flexGrow:1` 撑满视口，**无边框/无标题**），内容行 → 状态栏 → **灰色块**（可选）→ **路径/token 行**；灰色块用 `marginTop:auto` 吸收剩余空间，**始终钉在视口最底部**（内容从顶部增长，超出尾部窗口后自动裁剪）；内容行用 `insertBefore` 插到状态栏之前；灰色块为**淡灰色背景**（`#3f3f46`，与对话流区分），**整块行布局**（`flexDirection:'row'` + `alignItems:'stretch'`，**无 paddingX**）：左侧**蓝色细线 `▍`**（3/8 块 ≈3px，`TextRenderable` fg 蓝，bg 与灰块同色）**紧贴灰色块左缘**，内容按 `inputLines+4` 行动态增高（= contentCol paddingY 2 + 输入 inputLines + 间距 1 + 模型 1）——**竖跨整个灰色块、与灰块等高**（含上下边距）；右侧内容列（`paddingX:1/paddingY:1` 撑出边距：输入文字从细线右侧让 1 列）内：多行 Textarea + 模型行（`模型 X`），**输入行与模型行之间 `gap:1` 留 1 行间距**（细线连续穿过间距）；**路径/token 行在灰色块下方**（不在灰色背景里，`justifyContent:'space-between'`：左当前目录 `cwd` 中段省略、右 `⚡ 12.3k tok` 会话累计用量，来自流末 chunk 的 usage，`stream_options.include_usage` 请求、网关不支持时自动回退无用量请求）；**用户消息**（对话流）同为 `▍` 蓝色细线 + **文本 + 灰色背景**（`MdChunk.bg` 支持，折行后每行都保留竖线与灰底，对标 opencode 用户气泡）；**主题自适应**：`TuiThemeMode`（`state.themeMode`，默认 `system` = 跟随系统）由 OpenTUI 按终端背景亮度自动检测（OSC 10/11 查询，`startTui` 里 `renderer.waitForThemeMode(400)` 等待 + `theme_mode` 事件订阅晚到切换，结果存 `state.detectedTheme`，system 模式按它取色；`/theme` 命令可手动强制 light/dark），`repaintTree` 每帧按主题重刷灰色块/输入框/细线/模型行/路径行的底色与文字色——深色：白字深灰底（`#e2e8f0`/`#3f3f46`）；**亮色：深字淡灰底**（`#27272a`/`#e4e4e7`，蓝线用更深的 `#2563eb` 保证浅底对比度），用户消息底色随主题同变；**内容区文字也主题化**（`applyRowToCell(cell, row, theme)` + `themeColor` 映射）：亮色下内容默认色（AI 回答/meta/工具卡片正文）为深灰 `#27272a`（否则浅底白字看不见——用户报告的 bug），dim 行（思考/meta/状态栏/提示行）显式取深灰 `#52525b`，markdown 浅色常量（代码块 `#8fa3bf`→`#475569`、行内代码 `#e6b450`→`#a16207`、引用 `#9aa4b2`→`#52525b`、标题 cyan→`#0e7490`）与工具卡片/面板的 cyan/yellow 标题映射为深色变体；
> - **Commands（/ 命令框架，`src/tui/commands.ts`）**：交互模式输入 `/xxx` 提交 → `runCommand` 按注册表（`TUI_COMMANDS`：`/theme` `/thinking` `/exit`(别名 `/quit`) `/clear` `/help`）分发，返回 `'exit'` 结束循环；未知命令提示不打断对话。**/thinking**：全局切换思考过程展开/折叠（`state.thinkingExpanded`，默认 true=全文展开、false=每个思考段落压成一行摘要 `💭 思考已折叠 · 共 N 行 · 点击展开`，N 按折行后实际行数计；buildBody 渲染时读取，会话级 /clear 不清除）。折叠态下**点击某条摘要可单独展开该条思考**（再点击收起，与工具卡片同交互）：`state.expandedThinking: Set<number>`（state.lines 下标，流式只追加下标稳定；/thinking 切换或 /clear 清空），折叠摘要行/单独展开行带 `Row.thinkingIdx`，`repaintTree` 每帧刷新 `tree.thinkingRects`（可见行 y → 思考行下标，与 cardRects 同坐标系），鼠标 handler 调纯函数 `hitTestThinking(state, rects, y)` 切换。**命令面板 = alert 浮层**（`/theme`，`state.menu: TuiMenu`）：`render.ts` 挂 **`menuOverlay`**（绝对定位 `position:'absolute'` + `zIndex:10`，每帧按视口**水平垂直居中**重算 top/left，`menuCells` 细胞池复用），`menuPanelRows` 画圆角方框面板（`╭─ 主题 ─╮` + `› 高亮项` + `✓ 当前值` + 操作提示行，面板宽 min(内容宽,44)）——**独立于会话流**：不占内容行、不参与滚动、鼠标事件在面板打开时整体忽略（`startTui` mouse handler 首行 `if (state.menu) return`，点击不穿透到下层工具卡片）；`handleMenuKey` 消费按键（↑/↓ 循环移动、数字 1-9 直接选中确认、Enter 确认、Esc 取消），`openThemeMenu` 打开、`closeMenu` 关闭（导出）；**命令联想列表**（`state.cmdSuggest: CmdSuggestion`，非模态，**独立浮层**）：输入框内容以 `/` 开头时，`repaintTree` 在 paint 时按输入框**最新**文本（`state.inputText` 同步）调 `commandSuggestions(query)` 过滤注册表（name 与 aliases 前缀匹配），渲染成 `suggestBox`——**绝对定位浮层**（`position:'absolute'` + `zIndex:9` + 主题面板底色 `theme.suggestBg`，亮色白底深字/深色深底浅字），每帧按输入框（灰色块）位置重算 top/left：**悬停在输入框上方 1 行**（灰色块顶 = 视口 - 2 - (inputLines+4)），left=2 与输入框文字列对齐；**不占内容流、`computeRows` 不再减它的行数**——对话不因联想出现而跳动（用户要求独立界面、非当前对话流）；`tree.suggestRect` 记录浮层 y 区间，**鼠标点击某项 = 填入该命令**（等同 Tab，尾空格自动隐藏），浮层内点击不穿透下层工具卡片；**互不影响输入**——只有 ↑/↓（移动高亮）、Tab（填入 `/cmd ` 带尾空格让联想自动隐藏）、Enter（填入并 `submit()` 走主循环分发，/exit 也能正常退出）、Esc（关闭）被消费，其余按键照常输入，无匹配自动隐藏；**关键时序**：全局 keypress 先于输入框执行（buffer 未更新），联想必须在 paint 时读最新文本，`interactive.ts` 按键处理末尾加 `setTimeout(0)` 延迟一帧重绘；
> - **会话标题**（`agent/title.ts` + `state.sessionTitle`）：首轮对话（用户问 + AI 答）结束后，**异步**发起一次独立的轻量 LLM 请求（`generateSessionTitle`，`max_tokens:50` + `stream:true`，内容 = 首条用户消息 + 首条助手回答摘录，`TITLE_SYSTEM_PROMPT` 要求 ≤15 字只输出标题本身）概括会话主题——**不阻塞主流程**（fire-and-forget，标题稍后到达；失败静默返回 null，不打扰对话）；`cleanTitle` 清洗（去引号/书名号/结尾标点、空白折叠、按显示列宽 24 截断不切代理对）；**渲染**：**不显示在信息流**——`ui.ts` 的 `setTerminalTitle`（OSC 0 序列 `\x1b]0;标题\x07`，清洗控制字符防注入）在标题到达时设为**终端窗口/标签页标题**（`buildBody` 不渲染标题行，对话流保持纯净）；会话级状态 `/clear` 不清除。mock server 用 `max_tokens ≤ 60` 识别标题请求并返回固定标题；
> - `computeRows` 尾部窗口裁剪 + **滚动**：内容区预算 = 高度 - 根框固定(2) - 状态栏(1) - 底部区（灰色块 paddingY 2 + inputLines + 间距 1 + 模型 1 + 路径/token 行 1）= 高度 - 8 - inputLines（inputLines=1 即高度 - 9）；超出的部分默认自动跟随最新；`scrollTop` 非 null 时回看历史（内容窗 cap-1 行 + 底部 dim 提示行「↑ 已上滚 N 行 · 共 M 行」）；`scrollIntent`（按键发出的一次性指令）在 computeRows 内消费，滚动数学集中一处；**长行自动折行**（`wrapChunks`：CJK 全角算 2 列、优先空格断行（词边界）、其次标点后断行（中文散文友好，标点留行尾）、否则硬断、不切代理对）后设置 `wrapMode:'none'`——折行后每行恰好 1 个终端行，行数预算精确成立（否则 TextBuffer 默认 word 换行会把实际渲染行数撑过预算，yoga 把状态栏/输入框挤出视口）；视口 <9 行时隐藏状态栏保证底部完整；
> - `TuiOutput.schedulePaint` 30ms 节流合并突发 chunk；**退出前必须 `flush()`**（清掉节流计时器并强制画最后一帧），否则“任务完成”等最终状态会丢；
> - **工具调用显示**（`output/format.ts`，console/TUI 共用）：`formatToolCall` 把裸 JSON 参数预览改成人类可读摘要——`run_command` → `$ 命令`（shell 风格）、`read_file`/`write_file` → `📄/✏️ 路径`、`list_directory` → `📁 路径`、`search_code` → `🔍 关键词`；`previewOutput` 只取工具输出前 5 行（单行 90 列截断、总量 400 字符封顶），完整结果仍回传模型；
> - **工具调用卡片**（对标 opencode 风格）：工具调用画成**圆角方框卡片**（`╭─ 执行命令 ✓ ─╮`——标题用**中文标签**（`toolLabel`：run_command→执行命令、read_file→读取文件等，用户要求去掉裸工具名），完成后**默认收起**（只显示标题+摘要+「▸ 点击展开（N 行输出）」），**鼠标点击卡片任意位置可展开/收起**输出预览（`退出码: 0` / `mock-ok`、`▾ 点击收起`）。**宽度约定**：卡片每行总宽恰为 contentWidth（`cardInnerWidth` = contentWidth-2，标题/内容/分隔/底边均为 inner+2；内容文本区 = inner-1，`wrapText` 按 inner-1 折行）——早期各行宽度不一致（标题 inner+1、内容 inner+3），内容行超宽 1 列被 TUI 折行把右侧 `│` 挤到下一行（用户报告的「右侧没框住」根因）。MouseEvent 坐标 0-based（实测 SGR y 减 1），无边框布局下内容行 i 对应事件坐标 y = i（mock-mouse 实测：卡片行在屏幕第 2..5 行时点击 y=1..4 触发切换）。console 端用**增量方框**（步骤开框 `╭─ 执行命令 … ─╮` + 摘要 + `⏳ 执行中…`，结果填输出收框，成功底边绿/失败红）。收起态输出预览隐藏，展开后可见——点击交互在真实终端（支持 DECRQM 能力查询）正常工作，`script` 伪终端因不响应查询导致 OpenTUI 禁用鼠标模式，python pty wrapper 响应查询后 SGR 点击完整验证通过；
> - `renderer.loop()` 在 d.ts 中是 private，但运行时存在（test-renderer 内部也调它），用类型断言调用；
> - **交互模式（交互式 TUI）**：`dev:tui` 无任务参数时进入——底部**多行 `TextareaRenderable` 输入框**（对标 opencode）+ 消息滚动区，多轮对话；自定义 keyBindings（与默认合并）：return/kpenter/linefeed → **submit（Enter 发送）**、shift+return 等 → **newline（Shift+Enter 换行）**；**自动增高**（不设 height、只给 minHeight 1/maxHeight 5 → yoga 按内容行数增高，超 5 行内部滚动），多行粘贴保留换行；**高度预算动态同步**——`repaintTree` 每次从 `lineCount` 刷新 `state.inputLines`（1-5），`computeRows` 按它收缩内容区，输入框变高也不挤坏布局；提交走 `submit()` 触发 **onSubmit 回调**（Textarea 不 emit 'enter'；且 `value` setter 不提交到 buffer，清空必须 `setText('')`，读取用 `plainText`）；状态栏显示“等待输入…”；/exit /clear /help 内联处理；按键时通过 `session.onKeyPress` 兜底重绘；
> - **Markdown 行式渲染**（`tui/markdown.ts`）：最终回答按行解析成带样式片段（加粗/行内代码/斜体/**删除线 ~~**/标题/引用/水平线/围栏代码块/**无序列表 • / 有序列表 / 任务清单 ☑☐**/**GFM 表格**），语法标记（`**`、` `、```` ``` ````、`#`、`~~`、`- [x]`）隐藏（conceal），代码块行统一着色；**表格渲染成 box-drawing 方框**（`┌──┬──┐` 表头加粗青色、`:---:` 居中/`:--` 左/`--:` 右对齐、列宽按内容自然宽度（CJK 全角 2 列）、超内容宽时收缩最宽列并截断单元格——每行总宽 = Σ列 + 3n + 1 ≤ 内容宽，折行不会打破对齐；`markdownToRows(text, contentWidth?)` 传宽度时表格才收缩，缓存 key 带宽度前缀、终端 resize 自动重解析）；流式友好（每次重绘对完整文本重解析，未闭合标记按纯文本处理）。**用户消息后自动插 1 行空白间距**（用户输入与 AI 思考不紧贴，buildBody 的 user 分支）。刻意不用 MarkdownRenderable——它是动态高度块，无法参与尾部窗口裁剪；行式方案每行高度固定为 1；
> - 快照验证（`tui:snapshot`）用 `createTestRenderer` 内存渲染，与 CLI 共用 mountTree/repaintTree 同一渲染路径，5 个场景断言（布局/溢出跟随/增量重绘/TuiOutput+flush/Markdown 渲染与 conceal，含输入框与用户消息）。

### 工具列表（src/tools/）

静态注册表 5 个基础工具；`delegate`（子代理）与 MCP 外部工具由入口 `attachRuntime` 按配置**运行时注入**（MCP 工具名带 server 前缀，如 `demo_ping`）。

| 工具 | 作用 |
|---|---|
| `read_file` | 按行号读取文件，支持 offset/limit 分段 |
| `write_file` | 创建或整体覆盖写入文件 |
| `list_directory` | 列出目录内容 |
| `search_code` | 代码搜索（优先 ripgrep，兜底内置扫描） |
| `run_command` | 执行 shell 命令（带超时 + 危险命令拦截 + 输出截断） |
| `delegate` | **子代理**：把独立子任务委托给隔离上下文的小循环（可选，`allowSubagents`） |
| `mcp_*` | **MCP 外部工具**：经 stdio JSON-RPC 调用外部服务器（可选，`mcpServers`） |

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
- [x] 上下文管理：工具结果截断 → 消息摘要压缩 → 相关文件选择性加载
- [x] 安全护栏：危险命令确认、权限分级、审计日志
- [x] 评估体系：自建任务集 + 完成率统计（mock 离线可进 CI）
- [x] CLI 体验：ANSI 着色、TUI 状态展示（对标 opencode）
- [x] MCP 接入（外部工具生态）
- [x] 子代理（subagent）与并行工具执行
- [ ] 进阶：SWE-bench 评测、上下文摘要的跨会话持久化、MCP 资源/提示（prompts）协议

## 演进日志

- **2026-08-11（第四十七次）**：**路线图全量推进：安全护栏 + 上下文管理 + 并行工具 + 子代理 + MCP + 评估体系 + 工程结构整理**——用户要求「完善所有未完成功能，注意业务划分，构建完美工程结构」（五条路线图全部勾选、功能+结构并行）。**① 结构整理**：`render.ts`（1268 行）拆为 `theme.ts`（主题色板与取色）/`layout.ts`（布局常量 + 折行截断数学，不依赖 OpenTUI）/`rows.ts`（buildBody/computeRows/卡片/点击命中，纯函数）/`render.ts`（仅编排 mountTree/repaintTree/startTui + 兼容 re-export）；新增业务域目录 `safety/`（policy/audit/index）与 `agent/context.ts`。**② 安全护栏**（`src/safety/`）：权限分级 `permission: full/safe/ask/read`（policy.ts：危险命令正则库 + 分级白名单；safe=危险命令询问、ask=所有命令询问、read=只读工具白名单、full=不拦截）；`Output.onApprovalRequest` + 审批队列（TUI 卡片 `⚠ 需要确认` + `[y/n]` 按键审批、console TTY readline、**非 TTY 自动拒绝**）；`audit.ts` 审计日志落盘 `~/.config/omni/audit.log`（JSONL：时间/工具/参数/级别/决策）；loop 工具执行前过 `Safety.gate()`，子代理共用同一闸门。**③ 上下文管理**（`agent/context.ts`）：`selectRelevantFiles`（按任务关键词扫描 cwd 命中文件，预载进首轮 system 附注，preloadMaxFiles 默认 5）+ `summarizeContext`（历史消息超 summarizeAt 阈值（默认 40 条）时用一次轻量 LLM 请求把早期对话压成摘要，保持首条 user 与最近轮次完整，摘要以 system 注入、原消息从历史移除）。**④ 并行工具执行**：loop 支持一次多 `tool_calls` 并发 `Promise.all` 执行、结果按序回传（防模型靠响应顺序推断）。**⑤ 子代理**（`agent/subagent.ts` + `tools/delegate.ts`）：隔离上下文嵌套循环（独立消息历史、无 UI、maxSubagentSteps 默认 10、深度限制 2、共用 Safety 闸门），入口按配置注入 `delegate` 工具。**⑥ MCP 接入**（`tools/mcp.ts`）：`mcpServers` 配置（command/args），stdio JSON-RPC 客户端 `McpClient`（initialize/notifications/initialized/tools/list + 阻塞调用序列化），`discoverMcpTools` 启动时连接各服务器 → `tools/list` → 包装成 Tool 注册进运行时工具表，请求处理 `tools/call` 透传结果。**⑦ 评估体系**（`scripts/eval/`）：`tasks.ts` 任务集（mock 离线 10 条 / 真实 API 8 条）+ `run-eval.ts` 运行器（串行跑任务 → 判定完成（回答含关键词）→ 输出 JSON 报告 + 完成率，`npm run eval` / `npm run eval:mock`）。**⑧ config/示例/入口**：新增 `permission/auditLog/summarizeAt/preloadLimit/mcpServers/maxSubagentSteps` 字段；`main.ts` 新增 `attachRuntime`（Safety + MCP 工具发现 + delegate 注入 + 上下文准备），cli/tui 两入口共用；banner 显示权限档位。验证：typecheck + 快照 **24 场景**全绿（新增场景 22 审批卡/场景 23 权限分级/场景 24 上下文摘要）+ `eval:mock` 100% + console 端到端（banner 权限 + 卡片）+ 审批/审计端到端（ask 管道自动拒绝、audit.log 记录 rejected）+ MCP 端到端（demo_ping 工具发现注册）+ 子代理探针 + 并行工具探针 + `npm run build`（0.79MB）+ TUI PTY 冒烟（退出码 0、零崩溃）+ 代码审查。
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
- **2026-08-10（第二十一次）**：**TUI 闪退排查：崩溃日志 + 重绘串行化**——用户反馈交互一段时间后闪退且无任何错误输出。新增 `tui/crashlog.ts`（落盘 `~/.config/omni/tui-crash.log`：uncaughtException/unhandledRejection/paint 错误全记录 + start/exit-clean/process-exit 生命周期标记，崩溃时 stderr 提示日志位置）；**重绘串行化+合并**（render.ts startTui）：OpenTUI 渲染器不允许并发 `loop()`（原生侧非线程安全，流式节流/按键/flush 的 paint 重叠是闪退高危候选），改为 promise 链串行 + in-flight 合并（一帧排队期间新调用只等排空，每次重绘读最新 state 中间帧冗余；flush 等队列排空避免与 stop 竞争；单次失败 logCrash 后继续不拖崩 TUI）。mock 新增 `MOCK_STREAM=1`（逐字分块延迟流式，制造成百上千次重绘）。验证：typecheck + 快照 8 场景 + 三轮压力测试（8 轮交互/打字/滚动键连按/长思考/逐字流式全部 EXIT=0、日志无 paint 错误）。
- **2026-08-10（第二十二次）**：**鼠标滚轮滚动 + 顶部溢出提示**——用户反馈"超过 1 屏就无法显示更多内容"（键盘滚动此前已实现，但终端聊天用户天然用滚轮）。排查：OpenTUI 已启用 SGR 鼠标上报（`\e[?1000h...`），滚轮事件（`\e[<64/65;x;yM` → `type:'scroll'` + `scroll:{direction,delta}`）沿渲染树冒泡到根 Box——在 `startTui` 给根 Box 挂 `onMouseEvent`（实例属性遮蔽原型方法，注释注明属刻意为之）：滚轮上/下 → `scrollIntent { action:'line-up'/'line-down', lines: 每格 3 行 }`（ScrollIntent 新增 lines 步长，computeRows 消费），**同方向连续滚轮累加步长**（帧执行期间到达的多格并入同一意图，由尾沿补帧一次性消费，快速连滚不丢格）；点击/移动不拦截（不干扰输入框聚焦）；滚轮任意位置均可滚动内容区。**跟随模式顶部提示**：内容溢出时窗口顶部显示 dim 提示行「↑ 上方还有 N 行 · 滚轮/PgUp 上滚」（此前用户不知道上面还有内容）。/help 补充滚轮说明。**配套修复**：合并式重绘改为**尾沿合并**（一帧执行期间收到请求置 paintQueued，当前帧结束后 do-while 补跑一帧）——审查发现原合并版会把 in-flight 期间的 scrollIntent 滞留丢弃（滚轮/连按丢格），补帧保证「先写意图再 paint」一定被消费；flush 等批次排空避免与 stop 竞争。验证：typecheck + 快照 9 场景（场景 2 断言顶部提示、新增场景 9 滚轮步长 lines=3 + 顶部提示单元断言）+ 真实 PTY（SGR 滚轮连滚 6 格上滚出现「已上滚」、滚轮下滚 + End 回底出现「上方还有」、PgUp 键盘滚动回归、EXIT=0、崩溃日志干净）。
- **2026-08-10（第二十三次）**：**多行输入框 + 快捷键扩展（对标 opencode TUI）**——用户要求"直接抄 opencode tui、不只是滚动"。**① 多行输入框**：底部 `InputRenderable`（单行）换成 `TextareaRenderable`（多行）——自定义 keyBindings 与默认**合并**（运行时验证 mergeKeyBindings 语义）：return/kpenter/linefeed → **submit（Enter 发送）**、shift+return/shift+kpenter/shift+linefeed → **newline（Shift+Enter 换行，kitty 协议终端可用）**、meta+return → newline，其余编辑键（↑↓/Home/End/Ctrl+U 删除等）不变；**自动增高**：不设固定 height、只给 `minHeight:1/maxHeight:5`，yoga 按内容行数增高（probe 验证：`insertChar` 逐字输入实时增高、超过 5 行内部滚动 scrollY）；多行粘贴保留换行。**关键坑**（probe 逐一验证）：Textarea 的 `value` setter **不提交到 buffer**（渲染不变），清空必须 `setText('')`、读取用 `plainText`；submit() 触发 **onSubmit 回调**（非 InputRenderable 的 'enter' 事件），不自动清空；**高度预算动态同步**——`state.inputLines`（1-5）由 `repaintTree` 每次用 `estimateInputLines`（逻辑行数 + 长行按内宽折行估算，`visualWidth` 计 CJK 全角）实时刷新，`computeRows` 内容区预算 = 高度 - 7 - inputLines（输入框变高内容区同步收缩，状态栏/输入框永不被挤出）；审查修复：`lineCount` 是逻辑行数不含折行，粘贴长行会低估预算，改按文本宽度估算折行（宁可多估不重叠）；占位符必须单行内放下（过长折行会让输入框实际高度超预算、内容区溢出重叠——场景 2 实测抓到该 bug）；meta+return 保持默认 submit（Cmd/Ctrl+Enter 仍发送）。**② 快捷键**：Ctrl+U/Ctrl+D 翻页滚动（输入框为空时；有内容时保留 Ctrl+U 删除到行首的编辑语义）。/help 与状态栏补充 Shift+Enter 换行说明。验证：typecheck + 快照 10 场景（新增场景 10：真实 Textarea setText 三行自动增高渲染 + 清空复位 + inputLines=3 内容区预算收缩 2 行单元断言）+ 真实 PTY 端到端（bracketed paste 三行 → Enter 提交 → 三行用户消息完整入会话、Ctrl+U 上滚出现「已上滚」、End 回底出现「上方还有」、MOCK_STREAM 流式三轮回归、EXIT=0、崩溃日志干净）。
- **2026-08-10（第二十四次）**：**修复「内容超过 1 屏后全部被清空」（原生 TextBuffer 耗尽）**——用户报告超一屏后内容全空、无法显示。**根因实锤**（崩溃日志 6295 行）：`Error: Failed to create TextBuffer` 堆栈直指 `repaintTree` 里 `new TextRenderable`（经 `processMouseEvent` 滚轮触发）。早期实现每帧 **remove 全部旧 cells + 新建 TextRenderable**——每个 TextRenderable 持有**原生 TextBuffer**，流式逐字/滚轮/按键的反复重建会耗尽 OpenTUI 原生对象池：probe 实测无释放时约 **1365 次重绘**后 `createTextBuffer` 抛「Failed to create native renderable」（12 cells/帧 ≈ 1.6 万次原生分配），且异常发生在「旧 cells 已 remove、新的没建完」之间 → 内容区永久清空、每次重试都失败——测试会话短未触发，用户长会话必现。**修复（细胞池复用）**：`repaintTree` 改为池**只增不减**——行数增加才新建（一次原生分配），减少只 `visible=false` 隐藏（不销毁、零原生抖动）；行内容**原位更新** `content/attributes/fg`（setter 运行时验证可用，StyledText 与纯文本路径均覆盖，chunk 行复位单元格级样式防残留）；单行应用 try/catch（失败保留旧内容 + logCrash，整帧永不挂）。probe 验证：12 细胞原位更新 **5000 次零失败**（对比重建方案 1365 次崩溃）。验证：typecheck + 快照 10 场景全绿 + 长会话压力 PTY（MOCK_STREAM 6 轮流式 ~2400+ 次重绘 + 30 格滚轮 + PgUp/PgDn 连按：EXIT=0、6 轮内容与滚动提示完整、**崩溃日志新增 0 条错误**）。
- **2026-08-10（第二十五次）**：**工具调用显示美化 + 轮次上限放宽**——用户反馈「调用 tool 的打印要更好看，不要直接输出字符（如 `freebuff --continue ...`）」「命令输出不要单纯字符堆砌」「20 次轮次上限是不是太少」。**① 显示美化**：新增 `output/format.ts` 共享格式化——`formatToolCall(name, args)` 把裸 JSON 参数预览换成人类可读摘要：`run_command` → `$ 命令`（shell 提示符风格）、`read_file`/`write_file` → `📄/✏️ 路径`、`list_directory` → `📁 路径`、`search_code` → `🔍 关键词`、未知工具 k=v 兜底；`previewOutput(result)` 只取输出前 5 行（单行 90 列截断、总量 400 字符封顶，空行过滤）；Output 接口 `onToolResult` 新增 `preview?: string[]`，loop.ts 传预览、完整结果仍回传模型。console 渲染 `→ [n/max] 工具名  $ 命令` + `✓ 返回 N 字符` + dim `│` 缩进预览块；TUI 同构（步骤行 + dim meta 预览行）。**② maxSteps 默认 20 → 50**（config DEFAULTS + loop 兜底 + 示例配置 + 用户全局配置同步）：回答「大家会设轮次上限吗」——会，主流 coding agent 默认 20-50 之间，20 对复杂任务（探索+修改+验证+修复迭代）偏紧，50 只作防死循环兜底、典型任务 15 次内完成。验证：typecheck + 快照 10 场景（场景 4 改为断言 `$ echo mock-ok` 摘要与 `│ 退出码: 0`/`│ mock-ok` 预览块）+ TUI PTY 与 console 管道双端实测（`→ [1/20] run_command  $ echo mock-ok` / `✓ 返回 14 字符` / `│ mock-ok` 全部正确渲染）。
- **2026-08-10（第二十六次）**：**工具调用卡片化（opencode 风格）**——用户要求「不要文本输出和 [n/max] 标记，用框框起来，输出完成后可收起按键点击展开」。**① 圆角方框卡片**：新增 `output/format.ts` 的 `toolCardLines`——`╭─ 工具名 状态 ─╮ 标题 + │ 摘要 │ + 收起/展开提示。收起态：`▸ 点击展开（N 行输出）`（输出隐藏）；展开态：分隔线 + 输出预览行 + `▾ 点击收起`；running 态：`⏳ 执行中…`。新增 `cardTitleLine`/`cardContentLine`/`cardSepLine`/`cardBottomLine`/`cardInnerWidth` 导出供 console 复用。**② TUI 集成**：`state.ts` 加 `TuiLineKind.tool` + `ToolCard` 接口（id/name/summary/status/output/expanded）；`TuiOutput.onToolStep` 建收起态卡片，`onToolResult` 填状态与输出；`render.ts` 的 `buildBody` 展开卡片（`toolRowStyle` 着色：标题青色、提示行/分隔线浅色、正文默认），`repaintTree` 每帧刷新 `cardRects`（内容行 i → 0-based 事件坐标 y = 1+i），`startTui` 点击 handler 调 `hitTestCard` 纯函数 toggle 展开/收起。**③ Console 增量方框**：`ConsoleOutput.onToolStep` 增量打印开框（标题 `name …` + 摘要 + `⏳ 执行中…`），`onToolResult` 补分隔线 + 输出预览 + 收框（成功底边绿/失败红）。**④ 坐标映射排障**：MouseEvent 0-based 坐标（SGR `\x1b[<0;30;5M` 解析为 `{x:29,y:4}`，`_hasPointer=true` 验证解析+派发链路正常）；内容行 i 的事件坐标 = 1 + i（屏幕行 2+i 减 1）。旧实现用 `2+i`（1-based 屏幕）比对 0-based 事件恒差 1 → 点击偏上 1 行不命中，修复后 .pty-mouse.py 完整展开/收起端到端通过。**⑤ 死代码清理**：`TuiLineKind` 移除 `step`/`result-ok`/`result-err`（现仅有 `tool` 卡片），`rowStyle` 同步精简。**⑥ 排障记录**：`script` 伪终端不响应 DECRQM 能力查询 → OpenTUI 不启用鼠标模式 → SGR 点击被静默丢弃；python pty wrapper 响应 `;1$y` 后 `_useMouse=true`（默认已 true）、`_hasPointer` 从 false 变 true，鼠标事件完整到达 root.onMouseEvent。验证：typecheck + 快照 **12 场景**全绿（场景 1/3/4 卡片断言，场景 4 收起→展开双向断言，场景 11 hitTestCard 单测）+ 真实 PTY python pty SGR 点击展开/收起端到端（`退出码: 0`/`mock-ok` 展开可见、`▸ 点击展开` 收起恢复）+ console 管道增量方框渲染（`╭─ run_command … ─╮` + `│ $ echo mock-ok │` + `│ ⏳ 执行中… │` + `│ 退出码: 0 │` + `╰──╯`）全部正确。
- **2026-08-11（第二十七次）**：**修复「运行指令乱码」（多行命令打破卡片边框）**——用户反馈运行含多行脚本的命令（`curl … | python3 -c "\nimport json,sys\n…"`）时卡片显示乱码。**根因**：`formatToolCall` 把整段多行命令原样放入摘要，卡片内容行经 `wrapText` 折行后 `\n` 仍内嵌在 `│ … │` 行里，渲染时断行打破边框对齐（`│` 错位、内容溢出框外）。**修复（双保险）**：① `formatToolCall` 对 `run_command` 把 `\n` 折叠为空格，并对所有工具统一按显示列数截断（`SUMMARY_MAX_COLS=120`，`truncateToWidth` 兜底）——摘要恒为单行且卡内最多折 1-2 行；② `wrapText` 防御性先按 `\n` 拆段再逐段折行——即使未来有调用方传入含换行文本，卡片边框也永不被打断。TUI 与 console 共用 `formatToolCall`/`wrapText`，两端口一次修复。验证：typecheck + 快照 **13 场景**全绿（新增场景 12：多行命令摘要断言无 `\n` + 截断 + `toolCardLines` 边框完整性 + 真实 TUI 渲染展开态输出）+ console 卡片渲染冒烟（`╭─ run_command … ─╮` 下摘要折行边框完整、`…` 截断结尾）。
- **2026-08-11（第二十八次）**：**TUI 输入区改版：灰色 footer 整块（对标 opencode）**——按用户要求重构底部输入区：① **左侧蓝色竖向粗线**：输入行改为 flex row，左侧 `width:2` 蓝色背景 Box（`#3b82f6`，随多行输入自动增高拉伸）；② **淡灰色背景**：原「带边框的输入框」换成 **footer 整块**（`BoxRenderable`，`backgroundColor:#3f3f46`，无边框），内部三行——输入行（蓝色粗线 + Textarea，textarea 背景色与 footer 同色融为一体）+ **模型行**（`模型 X`，输入框下方灰色区域内）+ **路径/token 行**（`justifyContent:'space-between'`：左侧当前目录 `state.cwd` 超长中段省略 `truncateMiddle`，右侧 `⚡ 12.3k tok`）；footer 用 `marginTop:'auto'` 钉在视口底部。**③ token 用量链路**：`Output` 新增 `onUsage(TokenUsage)` 事件（console 空实现），`loop.ts` 请求带 `stream_options:{include_usage:true}` 捕获流末 chunk 的 usage（网关不认该字段时报错时**自动回退**为无用量请求，不破坏主链路），`TuiOutput.onUsage` 累计进 `state.tokens`（会话总量）；`stream_options` 被 `prepareRun` 客户端透传，mock server 新增 usage 支持（请求带 include_usage 时末 chunk 返回 usage）。**布局预算**：footer = paddingY 2 + inputLines + 模型 1 + 路径/token 1，内容区 = 高度 - 9 - inputLines（原 - 7 - inputLines，内容区少 2 行）；状态栏隐藏阈值 8 → 10 行；`estimateInputLines` 输入框内宽改为减去蓝色粗线(2) + footer padding(2)。**排障记录**：PTY 端到端初测 token 恒 0——① 测试断言期望值错误（每轮 168 但会话累计 336）；② 旧 mock 进程占用端口导致新 mock 未生效（EADDRINUSE 静默失败），统一用独立端口 + pkill 清理；③ 全屏 TUI 下进程 stderr 输出不可见（OpenTUI 备用屏，与 crashlog.ts 既有认知一致），调试只能靠无头链路（真实 runAgent + TuiOutput 假 session）或重建终屏。验证：typecheck + 快照 **14 场景**全绿（场景 1 增加 footer 断言、新增场景 13：模型/路径中段省略/token 格式 + onUsage 累计单元断言）+ 真实 PTY 端到端（python pty + CJK 感知终端模拟器重建终屏：灰底 `48;2;63;63;70m`、蓝线 `48;2;59;130;246m`、占位符、`模型 mock-model`、路径、`⚡ 336 tok`（两轮×168 累计）、用户回显、工具卡片、最终回答全部命中）+ console 全回归。
- **2026-08-11（第二十九次）**：**对话流用户消息左侧蓝色竖粗线**——按用户要求「对话流中用户输入左侧也显示一个蓝色竖粗线」（与 footer 输入框同款配色 `#3b82f6`）：`MdChunk` 新增 `bg?` 字段，`applyRowToCell` 的 StyledText 映射补 `bg: parseColor(c.bg)`；`render.ts` 新增 `wrapUserLine`——用户消息（kind='user'）折行时**每一行**行首都注入 2 列蓝色背景 chunk（折行后竖线连续，整段消息被蓝色竖线框住，对标 opencode），文本宽度预算减 2 列（竖线 + 折行后每行仍恰好 1 终端行，布局预算不变）；`wrapChunks` 的 `{...c}` 展开天然保留 bg 字段。验证：typecheck + 快照 **15 场景**全绿（新增场景 14：用户消息折行 ≥2 行且每行首 chunk 为 `bg:'#3b82f6'` 竖线 + 行尾内容不丢 + 输入框布局未破坏）+ 真实 PTY 端到端（CJK 感知终端模拟器扩展为**跟踪每格背景色**：解析 `48;2;r;g;bm` SGR 重建终屏，断言用户消息行 `❯` 前 2 列 bg=(59,130,246)；排障记录：初版测试把根框边框 `│` 当首字符导致定位错误、`\x1b[0m` 重置未处理——模拟器补 `0|49` 重置分支后 10 项断言全绿）。
- **2026-08-11（第三十次）**：**竖线改 3px 细线 + 用户消息白字灰底 + 底部结构微调**——按用户反馈 4 项调整：① **蓝色竖线改细**（对话流 + 输入框都嫌 2 列色块太宽）：整列背景色块（`width:2` 蓝底 Box / 2 列 bg chunk）改为 **`▍`（U+258D，3/8 块 ≈3px）单列字符**，fg 蓝（`TextRenderable` 或 chunk 的 `fg`），宽度预算减 1 列；② **用户消息白字 + 灰底**：`wrapUserLine` 文本 chunk 改 `fg:'#e2e8f0'`（白）+ `bg:FOOTER_BG`（灰），竖线 chunk 同带灰底（`▍` 蓝字灰底），折行每行保留——对标 opencode 用户气泡；③ **输入框蓝色细线竖跨输入 field + 模型行**：mountTree 重构——灰色块内 `mainRow`（`alignItems:'stretch'`）= 蓝色细线 `TextRenderable`（内容按 `inputLines+1` 行动态生成 `▍\n▍…`，repaintTree 每次同步）+ 右侧 `contentCol`（输入框 + 模型行），细线随输入增高同步拉长；④ **路径/token 行移到灰色块下方**：灰色块只含输入+模型两行，路径/token 行独立 `infoRow` 挂在根 Box 上（灰色块之后、marginTop:auto 仍钉底），bg 为终端默认色。布局预算不变（灰色块 4 行 + 路径行 1 + 状态栏 1 = 原 footer 5 行结构等价，cap 仍 = 高度 - 9 - inputLines）；`estimateInputLines` 内宽改减 3（根 4 + 灰块 padding 2 + 细线 1）。验证：typecheck + 快照 **16 场景**全绿（场景 14 改为断言 `▍` fg 蓝 + 文本白字灰底；新增场景 15：`tree.blueBar.content` 初始 `▍\n▍`（输入 1 行 + 模型 1 行）、setText 三行后 `▍\n▍\n▍\n▍`——content getter 返回 StyledText 需取 chunks 文本）+ 真实 PTY 端到端 **14 项断言**全绿（模拟器扩展为**同时跟踪 fg/bg**：解析 `38;2;r;g;bm`；断言用户消息 `❯` 前 `▍` fg=(59,130,246)、消息文本白字(fg 226,232,240)+灰底(63,63,70)、placeholder 行与模型行行首都 `▍` fg 蓝（竖跨两行）、路径行 bg 非灰（在灰色块下方））。
- **2026-08-11（第三十一次）**：**用户消息去掉 ❯ 前缀**——按用户要求「对话流中用户输入，不要显示 > 这个」：`TuiOutput.onUserMessage` 不再拼 `❯ ` 前缀（用户消息由蓝色细线 + 白字灰底气泡本身标识），console 交互回显同步去掉 `❯`；注释与快照用例同步清理。验证：typecheck + 快照 **16 场景**全绿 + 真实 PTY 端到端 **14 项断言**全绿（新增「用户回显(无❯)」：`▍hi` 在帧中且全屏无 `❯` 字符；细线/白字灰底/竖跨两行/路径行位置断言保持全绿）。
- **2026-08-11（第三十二次）**：**输入框与模型行之间加间距**——按用户要求「输入框。用户输入消息和模型行，需要增加一点间距」：灰色块内 `contentCol`（输入框 + 模型行）加 `gap:1`（yoga gap 支持，输入行与模型行之间留 1 行间距）；**蓝色细线同步拉长跨过间距**（`repaintTree` 中 blueBar 行数 = `inputLines + 2`，细线连续穿过空白行）。布局预算：灰色块 = paddingY 2 + inputLines + 间距 1 + 模型 1，底部区共 inputLines + 6 → 内容区 = 高度 - 10 - inputLines（原 - 9）；状态栏隐藏阈值 10 → 11 行。快照场景 8 测试数据随预算收缩调整（repeat 5→4 / 15→12，仍完整折行显示）。验证：typecheck + 快照 **16 场景**全绿（场景 15 改为断言细线初始 `▍\n▍\n▍`（输入+间距+模型）、三行输入后 `▍\n▍\n▍\n▍\n▍`）+ 真实 PTY 端到端 **14 项断言**全绿（重建终屏确认：placeholder 行与模型行之间出现带 `▍` 细线的空行，细线连续穿过间距，其余断言不变）。
- **2026-08-11（第三十三次）**：**去掉 TUI 外侧边框与 Omni 标题**——按用户要求「去掉tui外侧边框及 Omni v0.1.0 grok4.5 这些字」：`mountTree` 根 Box 移除 `border/borderStyle/borderColor/title/titleColor/titleAlignment`，`repaintTree` 删除 `tree.root.title` 赋值——界面改为无边框无标题的纯净对话流。**布局预算同步调整**：内容区宽度 `CONTENT_PAD` 4 → 2（不再减边框 2）；`computeRows` cap 高度 - 10 - inputLines → **高度 - 8 - inputLines**（根框固定 4 → 2）；状态栏隐藏阈值 11 → 9 行（单任务 5 → 3）；`estimateInputLines` 内宽注释同步（根边框 4 → 内边距 2）。**卡片点击坐标重测**（mock-mouse 实测：新布局下卡片行在屏幕第 2..5 行时点击 y=1..4 触发切换）→ `cardRects` 映射由 `y = 1 + i` 改为 **`y = i`**（无边框后内容上移 1 行，事件坐标恒减 1 的偏移不变），快照场景 11 同步。验证：typecheck + 快照 **16 场景**全绿（场景 1 新增负向断言：帧内无 `┌`/`Omni v` 字符）+ mock-mouse 坐标实测（去边框前后各测一轮：边框版 y=2..5 → 无边框版 y=1..4，映射一致）。
- **2026-08-11（第三十七次）**：**工具卡片改版：去掉工具名 + 修复右侧边框缺失**——用户反馈「run_command 还是太丑：① 去掉 run_command 这种词语；② 整体框住，现在右侧没框住」。**① 宽度 bug 实锤**（probe 实测）：卡片各行宽度不一致——标题 inner+1、内容行 inner+3、底边 inner+2，内容行比内容宽度多 1 列，TUI 折行（wrapChunks）把右侧边框 `│` 挤到下一行 →「右侧没框住」。修复 `format.ts`：**所有卡片行总宽统一为 contentWidth = inner+2**（`cardTitleLine` fill 去掉 -1、`cardContentLine`/`cardSepLine` 文本区改 inner-1、`wrapText` 调用点按 inner-1 折行），TUI/console/菜单面板一次修复。**② 标题去工具名**：新增 `toolLabel(name)` 中文标签（run_command→执行命令、read_file→读取文件、write_file→写入文件、list_directory→查看目录、search_code→搜索代码、未知→工具），`toolCardLines` 与 console `onToolStep` 的标题改用它（`╭─ 执行命令 ✓ ─╮`），裸英文标识不再出现。**③ 附带优化**：标题截断分支同步修正（inner-4）；markdown 颜色常量 QUOTE_FG 导出沿用。验证：typecheck + 快照 **17 场景**全绿（场景 1 新增卡片每行宽度 == contentWidth 且右边框 `╮│╯` 完整断言，场景 1/3/4/7 断言改中文标签）+ 真实 PTY 端到端（mock 单任务：重建终屏断言「执行命令」标题出现、全屏无 run_command 字样、卡片每行右侧边框完整）。
- **2026-08-11（第三十九次）**：**/ 命令联想列表（非模态）+ 命令面板改为 alert 浮层**——用户反馈「输入 / 时应在输入框上方有个命令列表供选择，但用户也可以继续输入（互不影响）；theme 现在在会话流里显示，我要额外显示一个 alert 来进行操作选择」。**① 联想列表**（`state.ts` 加 `CmdSuggestion` + `cmdSuggest`/`inputText`；`commands.ts` 加 `commandSuggestions(query)` 前缀过滤（name+aliases）；`render.ts` 挂 `suggestBox` + `suggestCells` 池）：输入以 `/` 开头时 paint 时按输入框最新文本刷新列表，渲染成**独立浮层**（`position:'absolute'` + `zIndex:9` + 主题面板底色），悬停在**输入框上方 1 行**（`› /theme 描述`，选中行青色加粗），`computeRows` 不再减它的行数（不占内容流、对话不跳动）；鼠标点击某项 = 填入命令（等同 Tab）；`interactive.ts` 按键：↑/↓ 移动高亮、Tab 填入 `/cmd `（尾空格让联想自动消失）、Enter 填入并 `submit()`（走主循环分发，`/exit` 也能正确退出）、Esc 关闭——**其余按键照常输入**（非模态，无匹配自动隐藏）。**关键排障**：全局 keypress 先于输入框执行（输入框 buffer 未更新），初版联想不出现（repaintTree 读到旧文本）——按键处理末尾加 `setTimeout(0)` 延迟一帧重绘，让输入框先插入字符再刷新列表。**② alert 浮层**：`render.ts` 移除 `buildBody` 里的菜单内联渲染，新增 `menuOverlay`（`position:'absolute'` + `zIndex:10`，每帧按视口水平垂直居中重算 `top/left`，`menuCells` 池复用）——菜单不再占用会话流/不参与滚动；鼠标 handler 首行 `if (state.menu) return`（浮层打开时点击不穿透到下层工具卡片）；面板宽 min(内容宽,44) 居中弹窗。**review 修复**：① Esc 关闭联想后 repaintTree 每次按 inputText 重新生成列表导致**列表复活**——新增 `state.cmdSuggestDismissedText`（Esc 时记录文本，文本未变保持隐藏、变了才恢复）；② Tab 尾空格不生效——`commandSuggestions` 里的 `.trim()` 把 `theme ` 又 trim 回 `theme` 导致列表不隐藏，去掉 trim（尾空格即不匹配 → 自动隐藏）；③ 延迟重绘的 setTimeout 合并为单 pending 标志（连发按键只挂一个定时器）；④ `openThemeMenu` 移除过时的 scrollTop 重置（浮层不依赖滚动）。验证：typecheck + 快照 **19 场景**全绿（场景 17 改为浮层断言：`menuOverlay.visible`、内容流无菜单行、top/left 居中、closeMenu 后隐藏；新增场景 19：输入 `/` 列全部命令、`/th` 过滤剩 theme、`/xyz` 与普通文本隐藏、**Esc 关闭后不复活 + 文本变化恢复 + Tab 尾空格隐藏**、面板渲染含描述、内容区预算收缩 4 行）+ 真实 PTY 端到端（输 `/` 联想列表出现在输入框上方、Tab 填入 `/theme`、`/`+Enter 直接执行高亮命令 → 主题 alert 浮层居中弹出（屏幕中部、内容流无菜单行）、**Esc 关闭联想不复活/继续输入恢复**、Esc 关浮层、/exit 退出）+ 回归（MOCK_MARKDOWN 对话 + 联想共存不破坏会话）。
- **2026-08-11（第三十九次）**：**会话标题：首轮对话后自动生成 + 对话区顶部居中显示**——用户问「对话的标题如何设置？目前终端显示的标题看起来是 npm（其实是底部左侧的当前目录路径）」。**① 生成**：新增 `agent/title.ts`——`generateSessionTitle(client, model, messages)` 在**首轮对话结束后**用首条用户消息 + 首条助手回答发起一次独立轻量 LLM 请求（`max_tokens:50`、`stream:true` 与主循环一致兼容各家网关、`TITLE_SYSTEM_PROMPT`：≤15 字中文标题、只输出标题本身）；`cleanTitle` 清洗去引号/书名号/结尾标点、折叠空白、按显示列宽 24 截断（不切代理对，留省略号）；**fire-and-forget 不阻塞主流程**（用户已在输入第二轮时标题悄悄出现）、失败静默返回 null（无 Key/网络错误不打扰对话）、不进入 messages 历史（标题是 UI 元数据）。**② 触发**：`runTuiInteractive` 每轮 `turn++`，首轮 `runAgent` 返回后且 `state.sessionTitle === null` 时异步触发一次（会话仅一次）。**③ 显示**：`state.sessionTitle`（会话级，`/clear` 不清除）；`buildBody` 内容区顶部插入居中浅色 `— 标题 —` 行 + 1 空行间距（居中偏移按 `visualWidth` 计算；随内容滚动，`↑ 上方还有 N 行` 提示行在其上方）；footer 路径行不受影响（用户误以为路径是标题，实际标题独立显示在顶部）。**④ mock**：`max_tokens ≤ 60` 识别标题请求返回固定标题（放在 `usageChunk` 定义之后避免 TDZ）。验证：typecheck + 快照 **20 场景**全绿（新增场景 20：cleanTitle 去引号/标点/截断断言 + 居中偏移 ±1 + 标题后空行 + footer 路径保留 + 无标题不渲染）+ 真实 PTY 端到端 **7 项断言**全绿（python pty + 终端查询响应器（窗口大小/光标/DECRQM/OSC10-11/DA1/kitty）+ CJK 感知模拟器：终屏 `— mock 端到端验证 —` 居中在顶部第 1 行、下方空行、`▍你好`/工具卡片/回答/占位符/模型行/路径行全部就位；排障：模拟器 CJK 续列用 `·` 导致子串匹配失败，改 `\x00` 哨兵丢弃）。审查修复：① 首条 assistant 消息可能是工具调用轮（content 为 null），`JSON.stringify(null)` 会生成 `助手：null` 垃圾喂给标题模型——改为只取非空字符串正文（`typeof content === 'string'`，绝不字符串化 null）；② 标题行直接 push 不折行，极窄视口（<标题宽）会溢出破坏「每行恰好 1 个终端行」预算——放不下时改走 `wrapRow` 折行（居中仅当放得下时）。
- **2026-08-11（第三十八次）**：**Markdown 表格 + 删除线 + 任务清单 + 用户消息间距**——用户反馈「输出的消息表格没有表格形式展示？其它的 markdown 格式也要支持；用户输入和思考内容距离太近了」。**① GFM 表格**（`markdown.ts`）：检测 `| 表头 |` + `| --- | :---: |` 分隔行 → 渲染 box-drawing 表格（`┌──┬──┐` / `│ │` / `└──┴──┘`，表头加粗青色、边框 dim，`:---`/`---:`/`:---:` 三种对齐，单元格走 scanInline 行内样式）；列宽按内容自然宽度（CJK 全角 2 列），超内容宽度时收缩最宽列 + 截断单元格（`truncCell` 留省略号、不切代理对）——**每行总宽恒 = Σ列 + 3n + 1**。排障两个 bug：① 补齐 padding 按「scanInline 前的原始文本」算，`~~x~~`/`**x**` 等标记被剥离后渲染更窄 → 行宽不一致（pad 改按渲染后 chunk 宽算）；② 右边缘 `│` 少 1 空格（应为 ` │`，与左 `│ ` 对称），行宽比边框少 1 列。**② 其它格式**：删除线 `~~x~~`（MdChunk 新增 `strike`，`TextAttributes.STRIKETHROUGH` 渲染）、任务清单 `- [x]`→`☑` / `- [ ]`→`☐`、无序列表 `-`/`*`/`+`→`•`（• 青色）、有序列表保留序号、嵌套引用 `>>` 展开、标题/引用内部行内样式（`## **加粗**`）。**③ 用户消息间距**：`buildBody` 的 user 分支末尾插 1 行空白 Row（`{ text: '', style: {} }`）——用户输入与 AI 思考/回答/工具卡片之间留 1 行，不再紧贴。**④ 宽度传递**：`markdownToRows(text, contentWidth?)` 新增宽度参数（buildBody 传入内容宽），mdCache key 带宽度前缀（resize 自动重解析）。mock MOCK_MARKDOWN 增加表格/删除线/任务清单样例。验证：typecheck + 快照 **18 场景**全绿（新增场景 18：表格边框/表头样式/各行等宽断言 + 删除线 chunk + ☑☐ + 用户消息后空行断言）+ 真实 PTY 端到端 **10 项断言**全绿（MOCK_MARKDOWN 交互模式：顶部屏 `▍你好` 后 1 空行再接思考；底部屏 `┌──┬──┐` 表格完整（含居中 ✅ 列）、`☑/☐`、`~~` 与 `| --- |` 零泄漏）。
- **2026-08-11（第三十六次）**：**修复「亮色模式下 AI 输出白字」（内容区文字主题化）**——用户报告「亮色模式下，AI 吐出的数据除思考部分，文字会显示为白色」：根因是此前主题适配只覆盖灰色块/用户消息/蓝色细线，**内容行文字色仍硬编码 `parseColor('white')`**（`applyRowToCell` 两处默认 fg），markdown 常量（代码块 `#8fa3bf`/行内代码 `#e6b450`/引用 `#9aa4b2`/标题 cyan）在浅底上也看不清。修复：① `TuiTheme` 新增 `contentText`/`contentDim`（dark：`#e2e8f0`/`#9ca3af`；light：`#27272a`/`#52525b`）；② `applyRowToCell` 增加 theme 参数——chunk 行与普通行默认 fg 改取 `theme.contentText`，亮色下 dim 行（思考/meta/状态栏/提示行）显式设 `contentDim`（dim 白字在浅底同样看不见），深色维持原样（dim 属性白字）；③ 新增 `themeColor(color, theme)` 亮色映射表（white/cyan/yellow + markdown 三个十六进制常量 → 深色变体，标题 cyan→`#0e7490`、warn yellow→`#a16207`、代码块→`#475569`、行内代码→`#a16207`、引用→`#52525b`），`buildBody` 对 answer 的 markdown chunks 逐段映射、`applyRowToCell` 对行级颜色映射；④ 状态栏 light 下显式深灰。验证：typecheck + 快照 **17 场景**全绿（场景 16 扩展：亮色下回答/思考/meta 细胞 fg 断言（[39,39,42] 与 [82,82,91]）、markdown 代码块 chunk 映射 `#475569`、切回深色恢复 [226,232,240]）+ 真实 PTY 端到端（浅色背景 + MOCK_MARKDOWN 单任务：重建终屏断言内容区 **0 个白字细胞**、回答文字 fg=(39,39,42) 深灰）。
- **2026-08-11（第四十三次）**：**/thinking 折叠态支持点击单独展开某条思考**——用户要求「思考的过程支持 /thinking 收起状态下点击展开某条思考内容」。① `state.ts` 新增 `expandedThinking: Set<number>`（state.lines 下标集合；流式 appendLine 只追加不插入、下标稳定；`/clear` 与 `/thinking` 切换时清空）；② `render.ts`：`Row` 新增 `thinkingIdx?`，`wrapRow` 折行传播附带字段（cardId/thinkingIdx，每折行都可命中）；`buildBody` 折叠态下——集合内行渲染**完整文本**（每折行带 thinkingIdx 可点击收起）、集合外行渲染折叠摘要 `💭 思考已折叠 · 共 N 行 · 点击展开`（带 thinkingIdx 可点击展开）；③ 命中机制：`repaintTree` 每帧刷新 `tree.thinkingRects`（可见行 y → 思考行下标，与 cardRects 同坐标系），新增纯函数 `hitTestThinking`（点击折叠摘要→加入集合展开、点击展开行→移除收起），`startTui` 鼠标 handler 在建议浮层之后、卡片之前消费；④ `/thinking` 命令切换时清空 `expandedThinking`（避免折叠态残留单条展开）。验证：typecheck + 快照 **21 场景**全绿（场景 21 扩展：折叠摘要带 thinkingIdx / 点击 li=1 摘要单独展开（只展开该条、另一条仍折叠）/ 展开行带 thinkingIdx 再点击收起恢复两条摘要 / 空白行不误命中 / `/thinking` 切换清空集合）+ 真实 PTY 端到端（python pty + SGR 点击：折叠态点击第一条摘要 → 该条全文上屏、其余仍折叠；再点击收起）。
- **2026-08-11（第四十四次）**：**工具卡片改版：去标题、普通边框、收起态三行（命令/执行/结果缩略）**——用户要求「执行的命令显示在一个方框里：不需要执行命令的文字、不需要特殊颜色，普通白色边框（暗色）/灰色（亮色）；第一行显示调用了哪个命令（与执行和结果有区分）；支持展开收起，默认收起，收起显示第一行命令、第二行执行缩略、第三行结果缩略」。**① 卡片结构**（`format.ts`）：`toolCardLines` 重写——去掉 `╭─ 执行命令 ✓ ─╮` 标题行与彩色，每行带**角色**（`ToolCardRole`：top/cmd/exec/result/sep/out/hint/bottom）；收起态 = 命令（`cmd`，加粗区分）+ 执行缩略（`✓ 执行成功 · N 字符` / `✗ 执行失败`，dim）+ 结果缩略（输出首行截断，dim）；展开态 = 命令 + 分隔线 + 完整输出 + `▾ 点击收起`；running = 命令 + `⏳ 执行中…`；边框行 `top`/`bottom` 普通无标记。删除死代码 `toolLabel`（无引用）。**② 主题边框色**（`render.ts`）：`TuiTheme` 新增 `cardBorder`（dark `#e2e8f0` 白 / light `#71717a` 灰），`toolRowStyle` 按角色着色——边框/分隔统一 `cardBorder`（亮色下自动变灰）、cmd 加粗默认色、exec/result/sep/out/hint dim。**③ 字符数链路**：`state.ts` ToolCard + `output.ts` `onToolResult` 新增 `chars`（工具返回字符数，执行缩略行显示）。**④ console 同步**：`onToolStep`/`onToolResult` 去掉标题与 cyan/green/red 彩色（清理未用导入），成功/失败用状态字符区分；**TTY 下结果到达时光标上移 1 行+清行，把「⏳ 执行中…」行原位替换为结果块**（框原地长高，不叠放矛盾状态），**管道下暂存命令、结果到达时一次成框**（无光标控制，避免 ⏳ 与结果叠在一起）。验证：typecheck + 快照 **21 场景**全绿（场景 1/3/4/7 断言改新结构：`📁 .` / `✓ 执行成功 · 42 字符` / 结果首行 / 无「查看目录」/ 无「点击展开」旧文案；场景 12 toolCardLines 返回类型适配）+ 帧级渲染确认（`╭─…╮ / │ 📁 . │ / │ ✓ 执行成功 · 42 字符 │ / │ 55 个文件/目录… │ / ╰─…╯` 逐行对齐）。
- **2026-08-11（第四十五次）**：**修复「emoji 摘要行右侧边框缺失」（charWidth 与 OpenTUI 判宽不一致）**——卡片改版后帧级检查发现 `│ 📁 .` 行右边界 `│` 缺失。**根因实锤**：`width.ts` 的 `charWidth` 只认 CJK 区间，把 emoji（📁 U+1F4C1）按 1 列算，但 OpenTUI 内部渲染判宽（打包的 string-width@7 + emoji-regex@10.6.0）按 **2 列**——卡行实际宽 1 列，`│` 被挤出（旧断言用同一 `visualWidth` 校验因此自洽通过、帧级才暴露）。**修复**：`charWidth` 与 OpenTUI 判宽对齐——① **emoji 2 列**：增补平面（≥U+1F000）按 2 列，BMP emoji 区间逐条转录 emoji-regex@10.6.0 主正则（`⏳`U+23F3/`⚡`U+26A1/`✏`U+270F 2 列；**`✓`U+2713/`✗`U+2717 不在其列保持 1 列**——旧标题含 ✓ 时边框断言通过即为佐证）；② **零宽 0 列**：组合附加符号/变体选择符（VS16）/ZWJ 等（与 string-width 跳过集合一致，`✏️`=2+0 与 OpenTUI 的 grapheme 判定一致）；③ 键帽组合符 `20E3` 按 2 列防欠计。所有宽度消费点（wrapChunks/fitCount/wrapText/truncateToWidth/markdown 表格/truncateMiddle/会话标题）共用 `charWidth`，一次修复全局一致。验证：typecheck + 快照 **21 场景**全绿（场景 1 新增**帧级回归断言**：含 `📁 .` 的帧行 `trimEnd` 必须以 `│` 结尾——帧级断言才能真正抓到此类宽度错位）+ 场景 1 帧确认 `│ 📁 .` 右侧边框完整 + **BMP 全码点核对探针**（从 @opentui/core 打包产物提取 emoji-regex@10.6.0 原文，遍历全部 170 个命中码点比对 `charWidth`：review 发现 ⛓U+26D3/⛹U+26F9/❤U+2764 三处漏转录，探针追加揪出 ⛎U+26CE（无条件组漏写）——共修 4 处后**欠计 0**，且确认 ✓U+2713/✗U+2717 保持 1 列无误）+ console 管道实测（`╭…╮ / │ $ echo mock-ok… │ / │ ✓ 执行成功 · 14 字符 │ / 分隔线 / │ 退出码: 0 │ / │ mock-ok │ / ╰…╯` 单框完整、无 ⏳ 残留）。
- **2026-08-11（第四十六次）**：**会话标题改为终端窗口标题（不再显示在信息流）**——用户要求「这个对话的标题能不显示在信息流吗？显示为 cmd 窗口/会话的标题」。① `render.ts` 的 `buildBody` **移除标题行**（`— 标题 —` 居中 + 空行间距全删，对话流纯净，首行直接是用户消息）；② `ui.ts` 新增 `terminalTitleSequence`（纯函数：OSC 0 序列 `\x1b]0;标题\x07`，清洗 `[\x00-\x1f\x7f]` 控制字符——防标题里注入任意转义序列）+ `setTerminalTitle`（仅 TTY 下写 stdout，非 TTY 无窗口可设置）；③ `interactive.ts` 标题生成回调改为 `state.sessionTitle = title; setTerminalTitle(title)`（原 `session.paint()` 移除——无视觉变化不再重绘）。验证：typecheck + 快照 **21 场景**全绿（场景 20 重写：有标题时 computeRows/渲染帧**零标题泄漏**（帧内不得含 `— 测试会话标题 —`）、首行为用户消息、footer 路径保留、`terminalTitleSequence` 单元断言（`\x1b]0;测试 标题\x07` 与控制字符清洗——断言只查标题内容段，OSC 分隔符本身含 ESC/BEL 合法））+ 真实 PTY 端到端（bun TUI + mock：首轮对话后字节流出现 `\x1b]0;mock 端到端验证\x07` OSC 序列、em-dash `—` 全流零出现（标题专属字符，证明未渲染进信息流）、`▍` 用户回显正常、进程存活）。
- **2026-08-11（第四十二次）**：**蓝色细线贴灰色块左缘 + 与灰块等高**——用户要求「输入框左侧的蓝色线，紧靠整体灰色背景的左边，且高度和灰色背景等高」。此前 footerBox 是 `paddingX:1/paddingY:1` 的 column，细线在主行内只有 `inputLines+2` 行（输入 field + 间距 + 模型行）——左缘缩进 1 列、上下留 1 行 paddingY 与灰块不同高。修复：① footerBox 改为 `flexDirection:'row'` + `alignItems:'stretch'` 且**无 paddingX**——细线成为第一个子节点，**紧贴灰色块左缘**；② paddingX/paddingY 移到右侧 contentCol——输入文字与细线间距不变（仍从 x=3 开始：根 paddingX 1 + 细线 1 + contentCol paddingX 1），上下边距由 contentCol paddingY 撑出；③ 细线行数 `inputLines+2` → **`inputLines+4`**（contentCol paddingY 2 + 输入 + 间距 + 模型）——**竖跨整块、与灰块等高**；④ `estimateInputLines` 输入框内宽公式不变（仍 = 视口 - 5），注释同步更新。验证：typecheck + 快照 **21 场景**全绿（场景 15 断言细线行数 1→5、3→7，即 inputLines+4）+ 真实 PTY 端到端（重建终屏断言：灰块顶/底行左侧均有 `▍` 蓝字灰底、细线紧贴灰块左缘 x=1、输入文字仍从 x=3 起）。
- **2026-08-11（第四十一次）**：**/thinking 命令：全局展开/折叠全部思考过程**——用户要求「增加 /thinking 命令，可以让所有思考过程展开、折叠」。① `state.ts` 新增 `thinkingExpanded`（默认 `true` = 当前行为：思考实时完整保留在屏幕；会话级，/clear 不清除）；② `commands.ts` 注册 `/thinking`：切换开关（后来按用户要求去掉「已折叠/已展开」meta 提示文字，见第四十三次）；③ `render.ts` 的 `buildBody` 对 `kind==='thinking'` 且折叠态时**每个思考段落压成一行摘要** `💭 思考已折叠 · 共 N 行（/thinking 展开）`（N = 折行后的实际可见行数，按 wrapChunks 计；全局开关，折叠/展开即时生效，流式写入的思考同样折叠）；④ `/help` 命令清单补充 /thinking。验证：typecheck + 快照 **21 场景**全绿（场景 19 命令数 4→5、frame 断言补 /thinking；新增场景 21：默认展开全文/折叠成摘要行（行数+提示）/渲染帧无全文/`runCommand('/thinking')` 分发切换/再执行恢复展开/再展开全文恢复）。
- **2026-08-11（第四十三次）**：**去掉 /thinking 的 meta 提示文字**——用户要求「不需要提示文字：已折叠、已展开这种」：`commands.ts` 的 `/thinking` 移除 `pushLine` 的「已展开全部思考过程 / 已折叠全部思考过程（点击某条或 /thinking 展开）」meta 行（切换只改 `thinkingExpanded` + 清 `expandedThinking`，不污染对话流）；快照场景 21 断言反转为「`/thinking` 后 lines 中不得出现含『已折叠/已展开』的行」。验证：typecheck + 快照 **21 场景**全绿。
- **2026-08-11（第四十次）**：**命令联想列表改为独立浮层（悬停在输入框上方，不占内容流）**——用户要求「command 命令命中的时候，应该在底下输入框上方展示命中的菜单，而且需要是独立界面；不是在当前对话流中」。此前联想列表（suggestBox）是**流式布局子节点**（插在内容行与状态栏之间），`computeRows` 按 items.length 收缩内容区预算——联想出现时对话整体跳动，视觉上像「长在对话流里」。修复：① **改绝对定位浮层**（`position:'absolute'` + `zIndex:9` + 主题面板底色）：`TuiTheme` 新增 `suggestBg`/`suggestText`（dark 深底浅字 `#27272a`/`#e2e8f0`，light 白底深字 `#ffffff`/`#27272a`），mountTree 的 suggestBox 不再 insertBefore 状态栏，每帧按灰色块位置重算 `top/left`——**底部悬停在输入框上方 1 行**（灰色块顶 = 视口 - 2 - (inputLines+4)，left=2 与输入文字列对齐，含 paddingX 1）；② **`computeRows` 不再减联想行数**（内容区预算恢复为 高度 - 8 - inputLines，对话不因联想出现而跳动）；内容行 anchor 从 suggestBox 改回 status；③ **鼠标点击联想项 = 填入命令**（等同 Tab，尾空格自动隐藏；`tree.suggestRect` 记录浮层 y 区间，浮层内点击不穿透下层工具卡片），与 ↑/↓/Tab/Enter/Esc 键盘操作并行；④ 联想细胞文字统一按主题上色（普通项 suggestText、选中项 accentBlue 加粗，亮色下不再白字看不见）。验证：typecheck + 快照 **20 场景**全绿（场景 19 改为断言：suggestRect 已记录、浮层定位 left=2/top≥1、浮层底在灰色块顶（13）之上、**联想打开时内容区行数不变**）+ 真实 PTY 端到端（输入 `/` 浮层悬停在输入框上方、对话不跳动、鼠标点击某命令填入输入框、/exit 退出正常）。
- **2026-08-11（第三十五次）**：**Commands 框架 + /theme 命令面板（system/light/dark）**——按用户要求「实现 Commands 功能，先做 theme 变更命令：/theme 弹面板切换 light/dark/follow system」：① `commands.ts` 新增**斜杠命令注册表**（`TUI_COMMANDS`：`/theme` `/exit`(别名 `/quit`) `/clear` `/help` + `runCommand` 分发，返回 `'exit'` 信号结束交互循环，未知命令 warn 提示），`interactive.ts` 提交 `/xxx` 改走注册表（原内联 /exit /clear /help 逻辑移除）；② **命令面板**：`state.ts` 加 `TuiMenu`（id/title/options/selectedIndex/currentValue），`render.ts` 的 `menuPanelRows` 复用工具卡片边框画圆角面板（`╭─ 主题 ─╮` + `› 高亮项` + `✓ 当前值` + 操作提示行），`handleMenuKey` 消费面板按键（↑/↓ 循环移动、数字 1-9 直接选中确认、Enter 确认、Esc 取消），面板打开期间全局 keypress 先拦截 `preventDefault`（输入框不参与、Enter 不误提交），确认后 `state.themeMode` 切换 + meta 行提示「已切换主题 → X」；③ **TuiThemeMode 扩为 `'system' | 'light' | 'dark'`**（默认 system）：`state.detectedTheme` 存终端实测（OSC 检测，`startTui` 的 `waitForThemeMode` + `theme_mode` 事件），`themeFor` 在 system 模式按 detectedTheme 取色、light/dark 手动强制，`/theme` 面板里 system 项即「跟随系统」。验证：typecheck + 快照 **17 场景**全绿（新增场景 17：面板打开/高亮/↑↓/数字 2 选中确认 → themeMode 变 light/Enter 确认 dark/Esc 取消、面板渲染（`主题`/`跟随系统 ✓`/`›`/`Enter 确认`/`Esc 取消`）、未确认无切换提示、system 跟随 detectedTheme 亮暗切换 footer 底色）。
- **2026-08-11（第三十四次）**：**亮色模式主题适配（淡灰底）**——按用户要求「亮色模式下，输入框所在区域和对话流中我发送消息显示的区域，显示淡灰色」：`state.ts` 新增 `TuiThemeMode`（'dark' | 'light'，默认 dark）+ `state.themeMode`；`render.ts` 抽出**主题色板**（`TuiTheme`：footerBg/userText/accentBlue/footerText/footerDim/inputText/placeholder，深色版维持原色，**亮色版灰块与用户消息改淡灰底 `#e4e4e7` + 深字 `#27272a`，蓝线改深蓝 `#2563eb` 保浅底对比度**），`wrapUserLine`/`mountTree`/`repaintTree` 全部按 `themeFor(state.themeMode)` 取色，`repaintTree` 每帧重刷 footer 底色/输入框/细线/模型行/路径行（主题检测异步完成晚于首帧时自动换色）；`startTui` 用 `renderer.waitForThemeMode(400)` 等待 OpenTUI 的 OSC 10/11 背景色查询结果（超时/不支持保持深色），并订阅 `theme_mode` 事件处理晚到的切换。验证：typecheck + 快照 **17 场景**全绿（新增场景 16：亮色主题用户消息 chunk 深字淡灰底 + footer/输入框/细线真实渲染树底色 (228,228,231) + 切回深色恢复 (63,63,70)）+ 真实 PTY 双端验证（python pty 收到 OSC 查询后回亮色背景 → 字节流出现淡灰底 `48;2;228;228;231` 且无深灰残留；不回主题 → 保持深灰底 `48;2;63;63;70`）。