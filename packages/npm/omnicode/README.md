# @rightai/omni

**Omni — Agent 工程**（终端型 AI 编程助手）。

`npm install -g @rightai/omni` 一条命令安装，自带**全屏 TUI**（原生二进制，npm 按平台自动选择）。

## 安装

```bash
npm install -g @rightai/omni
```

支持的平台：macOS（arm64/x64）、Linux（x64/arm64）、Windows（x64）。

## 使用

```bash
omni "<任务>"      # 单次任务（流式思考 + 工具调用）
omni               # 交互模式（全屏 TUI，多轮对话）
omni --help        # 帮助
```

## 特性

- **Agent 主循环**：流式调用 LLM → 并行工具调用 → 结果回传，自我纠错
- **8 个工具（6 基础 + 2 注入）**：read_file / write_file / list_directory / search_code / run_command / skill + delegate（子代理）+ mcp_*（MCP 外部工具）
- **安全护栏**：权限分级（full / safe / ask / read）+ 危险命令确认 + 审计日志
- **上下文管理**：工具结果截断、相关文件预载、长对话摘要压缩
- **记忆系统（AGENTS.md）**：项目记忆 + 全局记忆级联加载，`/init` 一键生成
- **会话持久化**：JSONL 落盘，`--continue` / `-r <id>` / `/resume` 跨进程恢复
- **技能系统（Agent Skill）**：自动发现 SKILL.md，`/skill find` 网络检索安装
- **全屏 TUI**：Markdown 渲染（表格/列表/代码块）、工具卡片点击展开、`@` 提及文件、`/` 命令联想、多主题
- **可替换后端**：`OMNI_BASE_URL` 兼容所有 OpenAI 协议服务

## 配置

参考 `~/.config/omni/omni.json`（全局）/ 项目内 `omni.json`（JSONC 支持注释），环境变量 `OMNI_API_KEY` / `OMNI_BASE_URL` / `OMNI_MODEL` 等。
