# Omni

**从零手写的全功能 Coding Agent（终端型 AI 编程助手）** — 对标 opencode / codex / Claude Code。

当前处于 **MVP 阶段**：单 Agent 循环 + 5 个基础工具，无框架依赖（裸 OpenAI SDK + 手写循环），并带一个全屏 TUI 界面。

## 特性

- **Agent 主循环**：流式调用 LLM → 工具调用 → 执行 → 结果回传，支持自我纠错（工具失败信息回传由模型自行修正）
- **5 个基础工具**：`read_file` / `write_file` / `list_directory` / `search_code`（优先 ripgrep）/ `run_command`（危险命令拦截）
- **思考过程展示**：流式实时显示（浅色保留在屏幕），完整思考落盘 `.omni/last-thinking.md`
- **TUI 全屏界面**：内容区滚动、底部输入框交互模式（多轮对话）、Markdown 行式渲染
- **可替换后端**：`OMNI_BASE_URL` 兼容所有 OpenAI 协议服务（OpenAI / DeepSeek / 智谱 / Moonshot / Grok 等）
- **分层配置**：默认值 → 全局配置 → 项目配置 → 自定义配置 → 环境变量 → CLI 参数（JSONC 支持注释）
- **三种产物**：单文件 JS 包（`dist/omni.cjs`）、原生二进制（`release/omni`）、npm 安装包

## 快速开始

### 方式一：npm 全局安装

```bash
npm install -g omni-0.1.0.tgz   # 或发布后 npm install -g omni
omni "帮我看看这个目录的结构"
```

### 方式二：开发运行（需 Node ≥ 18）

```bash
npm install
npm run dev -- "列出当前目录的文件"
```

### 方式三：TUI 全屏模式（需 bun）

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
| 环境变量 | `OMNI_API_KEY` / `OMNI_BASE_URL` / `OMNI_MODEL` / `OMNI_MAX_STEPS` / `OMNI_SHOW_THINKING` / `OMNI_DEBUG` | 覆盖配置文件 |
| CLI 参数 | `-m, --model <名称>` | 最高优先级 |

常用环境变量：`OMNI_DEBUG=1` 打印发往 LLM 的完整请求体；`OMNI_SHOW_THINKING=0` 关闭终端思考显示（仍落盘）。

## 架构

```
src/
  index.ts              # CLI 入口：参数 → 配置 → 客户端 → 单次/交互
  ui.ts                 # 终端 UI：ANSI 颜色、TTY 检测、spinner
  cli/                  # 参数解析 / banner / 交互模式
  agent/
    loop.ts             # Agent 主循环：流式调 LLM → 工具调用 → 执行 → 回传
    thinking.ts         # 思考过程：流式显示 / 落盘
    messages.ts         # 消息组装：assistant 消息构造、工具参数解析
  tools/                # 工具注册表 + 5 个工具实现
  config/               # 分层合并 / JSONC 解析 / 配置发现
  tui/                  # 命令式渲染的全屏 TUI（state / render / output / interactive / markdown）
scripts/
  mock-server.mjs       # 本地 mock OpenAI API（无 Key 端到端测试）
  tui-snapshot.ts       # TUI 快照验证（内存渲染断言）
```

核心循环：

```
for step in 1..maxSteps:
  1. 流式调用 LLM（携带全部历史消息）
  2. 无工具调用 → 输出最终回答，结束
  3. 有工具调用 → 解析 JSON 参数 → 执行工具
  4. 结果以 role=tool 回传 → 回到 1
```

关键机制：自我纠错、工具结果 8000 字符截断（提示模型定向读取）、`maxSteps` 防死循环。

## 开发

```bash
npm run dev -- "<任务>"       # 开发运行（tsx）
npm run typecheck             # TypeScript 类型检查
npm run build                 # typecheck + tsc 编译 + bun 打包单文件
npm run mock                  # 本地 mock API 服务器（端口 8787，无 Key 验证）
npm run dev:tui -- "<任务>"    # TUI 全屏模式
npm run tui:snapshot          # TUI 快照验证
```

打包需 bun：`npm run bundle`（单文件 JS）、`npm run compile`（原生二进制）、`npm pack`（npm 安装包）。

## 路线图

- [x] MVP：Agent 循环 + 5 基础工具 + mock 端到端测试
- [ ] 上下文管理：消息摘要压缩 → 相关文件选择性加载
- [ ] 安全护栏：危险命令确认、权限分级、审计日志
- [ ] 评估体系：自建任务集 + 完成率统计；进阶 SWE-bench
- [ ] MCP 接入（外部工具生态）
- [ ] 子代理（subagent）与并行工具执行

## 技术栈

TypeScript strict · ESM（NodeNext）· 裸 openai SDK · @opentui/core（命令式渲染）· 无框架依赖
