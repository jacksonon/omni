# 贡献指南

感谢你考虑为 Omni 做贡献！以下指南帮助大家高效协作。

## 开发环境

- **Node.js** ≥ 18（运行 console 版 `npm run dev`）
- **Bun** ≥ 1.3（运行 TUI 版 `npm run dev:tui`、打包 `npm run compile`）
- **TypeScript** strict 模式

## 快速开始

```bash
git clone git@github.com:jacksonon/omni.git
cd omni
npm install
npm run dev -- "show me the structure of this directory"
```

## 项目结构

完整架构说明见 [AGENTS.md](AGENTS.md)（给 AI 协作 Agent 看的精简开发指南）+ [Doc/agents-reference.md](Doc/agents-reference.md)（逐文件详细参考 / 工具与命令全表）。

## 开发规范

- **TypeScript strict** + **ESM（NodeNext）** + 无框架依赖
- 中文注释 + 英文命名（变量/函数/类型用英文，解释用中文）
- **保持 MVP 简洁**：能不加抽象就不加；新功能先写直白代码，出现明显重复再考虑提炼
- **修改工具时**：必须同步更新 `tools.ts` 中的 JSON Schema 与 `description`
- **架构或命令有变化时**：同步更新 `AGENTS.md` 并在 `Doc/evolution-log.md` 追加一行

## 提交规范

提交信息格式：`<type>(<scope>): <中文描述>`

- `type`: `feat`（新功能）/ `fix`（修复）/ `refactor`（重构）/ `docs`（文档）/ `chore`（构建/工具链）
- `scope`: 受影响模块（tui / web / agent / config / tools / hooks / cli / electron / safety 等）
- 描述用中文，简洁

示例：`feat(web): 设置界面改版（左侧分类导航 + 右侧详情面板）`

## PR 流程

1. Fork 仓库，创建功能分支
2. 完成开发后运行完整回归测试：

```bash
npm run typecheck          # 类型检查（必须通过）
npm run build               # 构建（console bundle）
npm run tui:snapshot       # TUI 渲染快照（bun 渲染器，全部 45 场景通过）
npm run eval:mock          # Agent 核心评估（mock 离线，确定性 100%）
npm run probe:web          # Web 协议端到端探针（mock 离线）
```

3. 提交 PR，描述改动内容与验证结果

## 测试要求

| 测试 | 说明 | 需要 |
|---|---|---|
| typecheck | `tsc --noEmit` | 全部 PR |
| eval:mock | Agent 核心循环 mock 离线评估 | 影响 loop/工具链的 PR |
| tui:snapshot | TUI 渲染 45 场景断言 | 影响 TUI 渲染的 PR |
| probe:web | Web 后端协议探针 | 影响 Web 服务的 PR |
| probe-web 全绿 | 同上 | Web 端改动 |

## 报告问题

请使用 GitHub Issues，包含：
- omni 版本（`omni --version`）
- 终端类型、Node/Bun 版本
- 复现步骤、预期行为与实际行为
- 相关日志（`~/.config/omni/tui-crash.log` 等）

## Acknowledgements / Prior art（致谢与来源）

Omni 是一个独立项目，但其设计与实现在不同程度上参考、对标了以下开源项目。感谢它们的作者与社区：

- **[sst/opencode](https://github.com/sst/opencode)** —— 「技能」目录约定（项目内 `.opencode/skills`，并兼容 Claude Code 的 `.claude/skills`，Omni 另加 `.agents/skills`）、配置分层 + JSONC 体系，以及 TUI 命令面板、Ctrl+X 前缀绑定等交互的灵感来源。
- **[OpenAI Codex CLI](https://github.com/openai/codex)** —— `omni mini` 纯终端模式的版面与交互对标 Codex CLI（`• Ran` 状态行、审批三选项、`exec`/`resume` 子命令族、Ctrl+T 轨迹账本等）。
- **[Anthropic Claude Code](https://github.com/anthropics/claude-code)** —— Hooks 生命周期协议（`PreToolUse`/`PostToolUse` 等事件与 JSON 决策）、工具卡片的 Edit 风格统一 diff、技能（SKILL.md）渐进披露等机制的对标对象。
- **[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)**（MIT）—— Web UI 部分派生自该项目，版权声明保留在相关文件头（另见 [SECURITY.md](SECURITY.md)）。

以上多为设计灵感与功能对标；涉及直接派生的情况会在相应文件头保留原始版权声明。若你有未列出的来源需要致谢，欢迎提 issue 补充。