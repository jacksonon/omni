# Omni 路线图

> 2026-08-26 从 `AGENTS.md` 迁移。全部已完成项与剩余进阶项清单。
> 来源：仓库根目录 `Agent开发认知梳理.md` 的认知地图；backlog 见 `Doc/TODO.md`、`Doc/TODO-1.0.md`。

## 路线图

> 来源：仓库根目录 `Agent开发认知梳理.md` 的认知地图（概念层 → 设计层 → 实现层 → 交付层）。
> 可做事项的完整 backlog 见 `Doc/TODO.md`（按记忆/会话/计划/撤销/MCP/评测分类，标注优先级）。

- [x] **MVP**：Agent 循环 + 5 基础工具 + mock 端到端测试
- [x] 上下文管理：工具结果截断 → 消息摘要压缩 → 相关文件选择性加载
- [x] 安全护栏：危险命令确认、权限分级、审计日志
- [x] 评估体系：自建任务集 + 完成率统计（mock 离线可进 CI）
- [x] CLI 体验：ANSI 着色、TUI 状态展示（对标 opencode）
- [x] MCP 接入（外部工具生态）
- [x] 子代理（subagent）与并行工具执行
- [x] **记忆系统**：全局记忆（~/.config/omni/AGENTS.md）+ 项目记忆（AGENTS.md）级联加载——`/init` 生成项目级、`/init --global` 生成全局级，会话结束自动写入新偏好（**去重/矛盾合并**，agentsFile / globalAgentsFile / autoMemory 开关）
- [x] **会话持久化**：交互对话 JSONL 落盘（~/.config/omni/sessions/）+ `--continue` / `-r <id>` / `-l` 恢复——跨进程恢复对话上下文
- [x] **计划模式 /plan**：只读工具过滤 + 系统提示只读说明，输出实施计划供用户确认后执行
- [x] **/undo 文件撤销**：write_file 自动快照 + `/undo` / `/undo all` 回滚本次会话修改
- [x] **/permission 运行时权限切换**：低=read 只读 / 中=safe 危险询问（默认）/ 高=ask 全询问 / 全量=full 直通——TUI 面板 + CLI 参数即时切换（共用闸门 setTier 同步，子代理一致）
- [x] **Headless 与 CI 集成（对标 codex exec / claude -p）**：`omni exec "任务"`（stdout 只出结果/stderr 进度、`--output-format text|json|stream-json`、stdin 两形态、`--max-turns`、`--allowed-tools` 工具过滤、exit code 0/1 管道分支）+ `--output-schema` 结构化校验 + `exec resume <id>` 会话续跑 + `omni mcp-server`（omni_exec / omni_reply）+ CI 工作流模板（`examples/ci/omni-fix-ci.yml`：只读 job 生成补丁 → 独立 job 开 PR，密钥不进生成补丁的 job）
- [x] **本地后端服务 + Web 界面（`omni web`）**：REST + SSE 后端（零依赖）+ 浏览器 UI——多会话/实时流式/审批与提问卡片/模型权限设置/会话持久化（复用 session JSONL）/运行统计/**工作目录可切换（设置面板，无需重启后端）**；同一 Agent 栈同时服务 CLI 与网页（multi 前端共享后端）
- [x] **Electron 桌面应用（`omni`）**：独立 mac/win/linux 应用（内置后端，Electron 自带 Node 无需系统 Node）——GitHub Actions 打 tag 自动构建（mac zip / win exe / linux AppImage）并附 GitHub Release + npm 发布（5 平台子包 + 主包）
- [x] **嵌套 AGENTS.md**：项目记忆按目录层级**嵌套加载**——从 cwd 向上收集所有 AGENTS.md 到 git 根/home 边界（每目录一层，各生成一条 system 消息、独立截断），越贴近 cwd 的层级排在越后面、权重越高（内层可覆盖/细化外层）
- [x] **MCP 增强**：Resources 协议（资源列表/读取工具）+ Prompts 协议（提示词模板/获取工具）+ server instructions（注入系统提示）+ per-tool 审批模式（enabled/disabled 白黑名单 + defaultToolsApprovalMode 对接安全闸门）+ 运行时 add/remove + streamable HTTP 传输 + OAuth 登录（RFC 8414 + PKCE）
- [x] **安全与信任**：工作区信任（未信任 = 只读 + 跳过项目级 hooks/skills/子代理/记忆；信任清单持久化）+ 危险命令正则库扩充与可配置（`dangerousPatterns`）+ OS 级沙箱（read-only / workspace-write，sandbox-exec / bwrap 包裹 run_command）
- [x] **技能系统增强**：安装即时生效（`/skill add` 后刷新注入清单）+ frontmatter 扩展（disable-model-invocation / context:fork 子代理执行 / agent / background）+ 技能市场（`--global` + 来源标记）+ 清单渐进披露（15 条截断 + 剩余提示）
- [x] **会话管理增强**：`/fork` 会话分叉（从历史某点复制独立新会话，原会话保留）+ `/send` 跨会话消息（向指定会话发消息取结果，串行执行 + 结果注入当前上下文）
- [x] **记忆与上下文增强**：渐进披露（memory_search/read 工具）+ 项目级自动写入（待提交片段 + /memory-apply）+ override/fallback 文件名 + 嵌套合计上限 + /init 子目录 + /status 记忆清单 + 记忆 TTL 归档 + TodoWrite/WebFetch/diagnose 工具 + repo map + 关键词语义检索
- [x] **恢复与撤销增强**：`/rewind` 会话检查点（每轮用户消息提交时快照工作区修改文件到 `.omni/checkpoints/<会话id>/`，持久化——会话恢复后仍可回滚；CLI/TUI/Web 三端，列表附与当前工作区差异统计）+ write_file diff 确认审批（审批 reason 附变更统计）+ `/diff --stat/--full` + config `autoCommit` 自动 git commit（Aider 原子提交）
- [x] **模型 fallback 回退链**：config `fallbackModels`（最多 3 级）——主模型可重试失败（429/超时/5xx）按序切换备用端点重试本轮并提示「已回退到 X」+ 多模型对比 eval（`npm run eval -- --compare A,B` → eval-compare.json）
- [x] **MCP 服务器通知流**：HTTP 传输 GET SSE 长连接订阅服务器主动推送（断线重连指数退避、405 安静放弃）
- [x] **沙箱细化**：Linux 无 bwrap 回退 firejail + config `sandboxWritePaths`（workspace-write 白名单路径，macOS/bwrap/firejail 三实现）
- [x] **技能清单相关性注入**：技能超 15 条截断时按任务关键词相关度排序（skillRelevance，任务文本 = 最近用户消息）
- [x] **Headless eval**：`scripts/eval/run-headless-eval.ts` 用 `omni exec --output-format json` 跑结构化评测（mock 离线 / --real 真实 API）
- [x] **杂项增强**：会话标题本地化（跟随界面语言）+ 配置 profile 档案（config profiles + `--profile <名>`）+ Claude Code 迁移工具（`omni import`，只增不改）+ Watch 模式（`omni watch`，AI!/AI? 注释标记监听触发执行）+ ACP 端点（`omni acp`，stdio JSON-RPC 编辑器生态集成）
- [x] **1.0 模型层**（providers/元数据/命名 variants/跨端点路由/{env:VAR}/max_tokens/模型发现，第一百六十五次）
- [x] **Web 多会话并发运行**（per-session runOpts 原型链克隆 + 独立 undo/events/abort + 全局并发上限，第一百六十五次）
- [x] **沙箱 2.0**（网络白名单代理 / fail-closed / 凭据 masking，第一百六十五次）
- [x] **子代理 worktree 隔离**（delegate worktree + ToolContext.cwd，第一百六十五次）
- [x] **Headless 协议冻结 + omni-action + 发布工程**（schemas/config.schema.json/action/install.sh/Homebrew/Winget，第一百六十五次）
- [x] **Hooks 扩展 / 记忆结构化 / 压缩 2.0 / LSP 反馈 / MCP annotations+install / 预设 / 规格 / 遥测 / eval 成本报告**（第一百六十五次）
- [ ] 进阶：SWE-bench 评测、/rewind 三模式（code/conversation/both）

