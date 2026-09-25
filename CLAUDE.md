# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Omni 是一个终端型 AI 编程助手（Agent 工程）：裸 OpenAI SDK + 主循环，无框架依赖；通过 `OMNI_BASE_URL` 兼容所有 OpenAI 协议后端。完整开发指南见 `AGENTS.md`（本文件是精简版，架构/命令变化时必须同步更新 `AGENTS.md` + `Doc/evolution-log.md` 追加一行）。

## 常用命令

```bash
npm run dev -- "<任务>"        # 开发运行（tsx，无需 bun）
npm run typecheck              # tsc --noEmit（所有 PR 必须通过）
npm run build                  # typecheck + tsc + bun 单文件打包 dist/
npm run test:features          # 功能回归（83+ 用例，改动后必跑）
npm run tui:snapshot           # TUI 内存渲染断言（改 TUI 必跑，bun）
npm run eval:mock              # Agent 循环离线评估（改 loop/工具链必跑）
npm run probe:web              # Web 后端 e2e 探针（改 web 必跑）
npm run mock                   # 本地 mock API（端口 8787，无 Key 验证）
npm run dev:tui -- "<任务>"    # 全屏 TUI（需 bun + 真实 TTY）
npm run dev:mini               # 纯终端 CLI（Codex CLI 形态）
npm run dev:web                # 本地后端 + Web 界面（3080 端口）
npm run models:snapshot        # 重建模型能力快照（改 model-context 逻辑时）
```

打包需要 bun（`bundle`/`compile`/`pack` 都会调 bun）。Node ≥ 18，Bun ≥ 1.3（仅 TUI/打包）。

## 架构（大局）

- 入口：`src/index.ts` → `src/main.ts` 参数调度 → `src/client.ts` 按模型端点建 OpenAI 客户端（`/model` 切换时重建，`ModelRuntime` 共享引用让子代理同步）。
- 核心循环 `src/agent/loop.ts`：流式调 LLM → 并行执行工具（`Promise.all`，结果按序回传）→ 错误文本回传模型自修；`maxSteps` 防死循环；工具结果超 8000 字符截断。
- 安全闸门 `src/safety/`：每个工具调用（含 MCP/子代理）过 `Safety.gate`——档位 full/safe/ask/read + 危险命令审批 + 审计；未信任目录强制只读并跳过 hooks/MCP/技能/子代理/项目记忆（`trust.ts`）。
- 工具 `src/tools/`：8 静态（read/write/edit/list/search/run_command/skill/lsp）+ 运行时注入（delegate/ask_user/task_board/send_message/web_search/web_fetch/MCP `server_tool`）。改工具必须同步更新其 JSON Schema 与 `description`（写给模型看的说明书）。
- 上下文 `src/agent/context.ts`：全局+项目记忆级联注入（嵌套 AGENTS.md，32KB 上限）+ 相关文件预载 + 长对话摘要压缩；会话落盘 `src/agent/session.ts`（JSONL，`~/.config/omni/sessions/`）；撤销 `undo.ts`；检查点 `/rewind`（code/chat/both）。
- 子代理/编排：`subagent.ts`（隔离小循环）+ `orchestrate.ts`（动态工作流：模型产计划→依赖分层并行）+ `team.ts` 看板；技能 `agent/skill.ts`（SKILL.md 渐进披露 15 条，`skill` 工具按需加载全文）；MCP `tools/mcp.ts`（stdio/streamable-HTTP，资源/提示词/instructions/审批模式/白黑名单）。
- 渲染层（同一运行时，四套 Output）：`output/console.ts`（console）/ `output/mini.ts`（mini，Codex 形态：`• Ran` + 前3行预览 + `↳` 轮内排队输入）/ `tui/`（全屏，命令式渲染 OpenTUI，无 JSX 信号；改前必读 `Doc/tui-architecture.md`）/ `web/` + `electron/`（REST+SSE 本地后端，`web/` 目录是 `src/web/assets.ts` 的源，改页面后跑 `npm run web:sync`）。
- 配置 `src/config/`：分层 默认→全局（`~/.config/omni/omni.json`，XDG-aware）→项目（向上找 `omni.json[c]`）→`OMNI_CONFIG`/`--config`→环境变量→CLI；端点/密钥只认 `providers` 分组或 `OMNI_BASE_URL`/`OMNI_API_KEY`。JSONC 带注释。

## 协作规范

- TypeScript strict + ESM（NodeNext）+ 中文注释/英文命名；保持 MVP 简洁，不为架构好看加抽象。
- 提交格式 `<type>(<scope>): <中文描述>`，type=feat/fix/refactor/docs/chore。
- 破坏性操作（删文件、全局安装、git 推送）前先确认；不提交 `release/` 产物。
