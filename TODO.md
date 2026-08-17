# TODO — Omni 可做事项清单

> 调研时间：2026-08-17。覆盖主流 agent harness：Claude Code / OpenAI Codex CLI / opencode /
> Gemini CLI（现 Antigravity CLI）/ Qwen Code / Cursor / Aider / Cline / Roo Code / Kilo Code /
> Goose / OpenHands / GitHub Copilot CLI。
> 优先级：P0 = 高价值低成本（短期可做），P1 = 高价值中成本，P2 = 低优先/重投入。
> 完成一项 → 同步更新 AGENTS.md 路线图与演进日志。
> ✅ = 已完成基线（当前能力，不再重复做）。

## 一、生命周期自动化（Hooks）✅ 基线：9 事件 + JSON 协议 + matcher + 配置分层合并 + stderr 捕获 + 超时/失败降级放行（第一百三十二/三十三次）

- [x] **P0 Hooks 框架**（`src/hooks/index.ts`，第一百三十二次）：在生命周期事件上挂 shell 命令——
      `UserPromptSubmit`（返回 `updatedPrompt` 可改写 prompt）/ `PreToolUse`（工具调用前，
      **JSON 返回 `decision: block` 可硬拦截** + `updatedInput` 改写参数）/ `PostToolUse`（工具后，
      `hookSpecificOutput` 回传上下文字段，如 lint 结果）/ `Stop`（agent 准备结束，block 可要求继续修，
      `stop_hook_active` 只续一次防死循环）/ `Notification`（fire-and-forget 通知）。
      实现：loop 内工具调用点与回合结束点插入 hook 调度（PreToolUse 在安全闸门前、PostToolUse 在 execute 后、
      Stop 在正常结束点）；config `hooks` 字段（`{ "PreToolUse": [{ "matcher": "write_file", "command": "sh lint.sh" }] }`，
      matcher 通配 `*`/`read_*`/`*_file`）；终端回显 hook 输出（TUI 对话流 / console dim 行）；
      JSON 协议（stdin 喂入事件上下文、stdout 返回决策），超时（默认 60s）/命令失败/非 JSON → 降级放行。
      **场景**：编辑后自动 lint 回传模型自修复、拦截 `rm -rf`/`.env` 写入、会话结束通知。
- [x] **P1 hooks 事件补全 + 分层配置**（第一百三十三次）：新增 `SessionStart`（`sessionStartOutput` 注入首轮
      system 提示上下文）/ `SubagentStart` / `SubagentStop`（delegate 子代理生命周期，子代理内部工具调用也过
      Pre/PostToolUse）/ `PreCompact`（block 可跳过本次摘要压缩）；`hooks` 配置改**分层合并**（全局
      `~/.config/omni` + 项目 + 自定义逐层累加，同 matcher 后层优先）；hook `stderr` 捕获并与 stdout 一起回显。
- [x] **P1 内置安全护栏 enforcement 语义**（第一百三十三次）：官方 hook 示例集——`guard-env`（防 .env/密钥
      写入）/ `guard-dangerous`（防 `rm -rf /` 等破坏性命令）/ `guard-git-push`（防 git push），与内置
      permission 分级互补（规则强制、不依赖模型自觉）；`examples/hooks/README.md` 完整目录。

## 二、Headless 与 CI 集成（对标 `codex exec` / `claude -p`，把 omni 变成可组合 Unix 命令）✅ 基线：`omni exec` 非交互 + `--output-schema` 结构化校验 + `exec resume` 续跑 + CI 工作流模板 + `mcp-server` 子代理模式（第一百三十四次）

- [x] **P0 `omni exec "任务"` 非交互模式**（`src/exec.ts`，第一百三十四次）：现有单任务模式升级——stdout 只输出最终结果、
      stderr 流式进度；`--output-format text|json|stream-json`（json = 单对象含
      `result/cost_usd/duration_ms/num_turns/session_id`，stream-json = 每行一个事件 JSON，
      复用现有轨迹事件记录器 `events.ts` 的 ev 序列）；stdin 管道两种形态（裸 `-` = 全 prompt /
      prompt+stdin = 注入上下文，对标 codex）；`--max-turns` 上限（超出非零退出）；工具上限
      `--allowed-tools` 前置声明（不对应安全审批语义，纯工具过滤，复用 /plan 只读过滤）；
      exit code 语义（0 成功 / 非零失败，管道可 `&&`/`||` 分支）。
- [x] **P1 `--output-schema <json>` 结构化结果校验**（第一百三十四次）：最终回答强制符合 JSON Schema
      （无框架依赖子集校验器，支持 type/enum/properties/required/items/长度/范围/pattern +
      围栏与散文兜底提取），供下游 job 读取稳定字段（如 `{ "verdict": "safe" }`）。
- [x] **P1 headless 会话恢复**（第一百三十四次）：非交互跑一半续跑——`exec resume <id>` /
      `--resume`（复用现有会话 JSONL 恢复，session_id 不变、历史载入续写、无重复落盘）。
- [x] **P2 CI 集成示例与文档**（第一百三十四次）：GitHub Actions 工作流模板（`examples/ci/`）——
      只读 checkout + `omni exec` 修 CI 失败 → patch artifact → 独立 job 应用补丁开 PR
      （密钥不进入生成补丁的 job）。
- [x] **P1 `omni` 作为 MCP server 暴露**（`src/exec.ts` runMcpServer，第一百三十四次）：stdio JSON-RPC 暴露
      `omni_exec`/`omni_reply` 两个工具（启动会话/续会话），让 Claude Code、opencode 等外部
      harness 把 omni 当子代理用——复用 `tools/mcp.ts` 的 JSON-RPC 结构，请求串行 + isError 透传退出码。

## 三、记忆与上下文增强（✅ 基线：全局+项目级联、/init 生成、autoMemory 去重合并、预载文件、摘要压缩）

- [ ] **P0 记忆渐进披露**（Claude Code MEMORY.md 方案）：记忆/AGENTS.md 只载头部索引
      （前 N 行），提供 `memory_search` / `read_memory` 工具按需读取详细条目
      （现有 40KB 截断改为索引 + 工具读取）。
- [ ] **P0 项目级会话自动写入**：退出时把新学到的构建命令/架构决定写入项目 AGENTS.md
      （git 跟踪文件，先做「生成待提交片段供用户确认」，不直接改文件）。
- [ ] **P1 嵌套 AGENTS.md 与分层合并**（Codex：git 根 → cwd 每级一个，近者优先、合并注入、
      `AGENTS.override.md` 覆盖层、`fallback` 文件名如 TEAM_GUIDE.md、合计 32KB 上限）：
      现有发现逻辑从「向上找最近一个」改为「从项目根到 cwd 全链收集合并」。
- [ ] **P1 记忆 TTL 与过期**：`## 会话记忆（日期）` 段落超 N 天未命中移入归档/裁剪
      （现有只有体积裁剪）。
- [ ] **P1 TodoWrite 任务清单工具**（Claude Code 标配）：模型维护结构化 todo（新建/更新/完成），
      TUI 对话流展示当前进度（轻量卡片或折叠行），人机进度同步——低成本（纯工具 + 渲染）。
- [ ] **P1 WebFetch 内置工具**（Claude Code/Gemini/Qwen 标配；omni 现只能 `curl` 兜底）：
      URL 抓取 → 转 markdown → 截断回传（复用 wrapChunks/truncateToWidth），域名允许列表可配。
- [ ] **P1 代码库结构感知（repo map）**（Aider：tree-sitter 提取符号 + PageRank 排序 +
      1/8 context token 预算）：为长任务预生成紧凑符号地图注入首轮——现有 preloadFiles 是文件级，
      缺符号级。可先用轻量方案（ctags/正则提取定义行）起步，tree-sitter 后置。
- [ ] **P1 LSP 诊断反馈闭环**（opencode/Cline）：编辑完成后自动跑语言服务器取诊断
      （错误/警告）回传模型自修复——比 typecheck 更细粒度实时；先支持单一语言（TypeScript）
      验证链路，再泛化。P1 中偏重，可与「run_command 静默 typecheck 反馈」分层落地。
- [ ] **P2 语义检索记忆**：向量化 + 检索（重投入，依赖嵌入模型；可先用关键词检索替代渐进披露）。

## 四、会话管理（✅ 基线：JSONL 落盘、--continue/-r/-l、/rename、/session、/compact、/resume、/trace、/export）

- [ ] **P1 会话 fork**（Claude Code /codex `/fork`）：从历史某点 fork 新会话（原会话不丢），
      支持安全探索替代路径；与 /undo（文件级）和 checkpoint（见第五节）配合形成完整分支体系。
- [ ] **P2 跨会话消息**（Claude Code SendMessage/@ 提及会话）：主会话向指定会话发消息取结果
      （agent teams 的前置；依赖多会话运行能力，见第六节）。

## 五、恢复与撤销（✅ 基线：/undo /redo 快照栈、/permission 分级、/diff /review、write_file diff 预览）

- [ ] **P0 会话检查点 /rewind**（Claude Code / Cursor checkpoints / Roo shadow-git 同款）：
      与 /undo 的区别 = **按用户回合打点、可回滚到任意历史时刻**——每轮用户消息提交前把
      工作区文件快照进 shadow git 仓库（排除 node_modules/dist/.env，Roo 方案）或复用
      UndoStack 扩展为「回合级快照链表」；`/rewind` 打开列表（每条 = 用户消息摘要 + 时间），
      选择恢复（code-only / 全部），恢复后向消息注入提示；**会话恢复后仍可 /rewind**
      （快照存盘，Claude Code 关键特性）。
- [ ] **P1 检查点可视化**（Roo/Cursor）：TUI 面板展示快照 diff（增删行），确认后再恢复。
- [ ] **P2 diff 确认审批**：write_file 前展示变更 diff 供确认（审批扩展到写操作）。
- [ ] **P2 git 集成深化**（Aider 原子 commit）：可选「每次达成子目标自动 git commit +
      描述消息」（/undo 变 git revert）；现有 /diff 输出前 60 行可加 `--full`/`--stat`。

## 六、子代理与编排（✅ 基线：delegate 隔离上下文小循环、共用安全闸、计划模式只读）

- [ ] **P1 子代理嵌套 + 技能预载**（Claude Code：subagents 可 spawn subagents（5 层上限）、
      `skills` 字段注入全文、per-agent 模型/权限/工具白名单）：现有 delegate 单层、无配置实体——
      支持 `.agents/subagents/*.md` frontmatter 定义（Claude Code `~/.claude/agents/` JSON 方案
      亦可），`Tools/Task/Agent` 工具让子代理再委托。
- [ ] **P1 子代理进度可视化**（现 P2 上调）：delegate 无 UI；复用 /trace 面板与轨迹事件，
      TUI 呈现子代理卡片（状态/步数/结果摘要）+ 嵌套树（Claude Code /agents 视图）。
- [ ] **P1 模型路由：architect/editor 双模型**（Aider：强推理模型规划 + 便宜模型执行，成本省
      30-50%）：`/plan` 模式用强模型、执行阶段切轻模型；或 config 配置
      `{ "architect": "gpt-5", "editor": "gpt-5-mini" }`——现有 /model 多端点已铺路。
- [ ] **P2 动态工作流轻量版**（Claude Code dynamic workflows / Qwen Code）：先做固定 pipeline——
      fan-out 并行 delegate → 综合结果 → 对抗验证（adversarial review）的编排命令
      （`/orchestrate`），暂不支持模型写 JS 脚本（重投入后置）。
- [ ] **P2 agent teams / 多会话并行协调**（Claude Code）：跨会话树形协调，依赖第五节跨会话消息
      与第六节可视化；需多会话运行能力（opencode multi-session）。
- [ ] **P2 /loop 循环任务 + /goal 硬性完成要求**（Qwen Code / Claude Code）：定时/条件循环执行
      任务直至验收标准满足（可复用现有 eval 判定逻辑）。

## 七、模型与多端点（✅ 基线：models 多端点、/model 切换与添加、/variants 思考级别、持久化）

- [ ] **P0 fallback 模型回退链**（Claude Code fallbackModel：最多 3 级按序回退）：
      主模型 429/超时/网关错误时自动切换备用端点（现有 models 表已可配，loop 错误处理处加
      回退重试），提示「已回退到 X」。
- [ ] **P1 计划/执行模型分离预设**（见第六节 architect/editor；此处指单一 harness 层面
      `/plan` 自动用 config 指定模型）。
- [ ] **P2 多模型对比 eval**：同一任务多模型跑 eval 输出对比报告（--eval 已铺路）。

## 八、MCP 增强（✅ 基线：tools 协议、stdio 客户端、/mcp 列表与重连、上下文里 MCP 工具）

- [ ] **P1 MCP Resources 协议**：`resources/list` / `resources/read`——外部数据流/文件
      按需读取进上下文（不只工具调用）。
- [ ] **P1 MCP Prompts 协议**：`prompts/list` / `prompts/get`——可复用提示词模板
      （对应 /skill 面板呈现）。
- [ ] **P1 server instructions**（Codex）：MCP 初始化时读取 `instructions` 字段注入系统提示
      （跨工具约束/限流指引，首 512 字符自包含优先）——低成本高价值。
- [ ] **P1 per-tool 审批模式**（Codex）：server 级 `enabled_tools`/`disabled_tools` 白黑名单 +
      `default_tools_approval_mode`（auto/prompt/writes/approve，writes = 非只读工具才问）——
      对接现有 Safety 闸门分级。
- [ ] **P2 运行时 add/remove MCP 服务器**：不重启增删服务器（现在改配置 + /mcp reconnect）。
- [ ] **P2 streamable HTTP + OAuth**（Codex）：从 stdio-only 扩展 http(s) 传输与 OAuth 登录
      （`mcp login`），覆盖远程服务器生态。

## 九、安全与信任（✅ 基线：permission 四档分级、审批卡片/队列、审计日志、危险命令正则、MCP 过滤）

- [x] **P0 hooks 化 enforcement**（见第一节：PreToolUse block 是「规则」与「保证」的分界线，
      Claude Code 明确推荐 hook 而非 prompt 指令；第一百三十三次已随第一节 P1 落地
      `guard-env` / `guard-dangerous` / `guard-git-push` 示例集）。
- [ ] **P1 工作区信任（workspace trust）**（Claude Code / Codex）：首次进入未信任目录时
      提示信任；未信任 = 只读（read 档位）+ 跳过项目级 hooks/skills/子代理定义（防仓库注入
      恶意配置）——低成本，直接复用 /permission 档位。
- [ ] **P1 危险命令正则库扩充与可配置**：现有静态正则 → 用户级/项目级扩展列表
      （config 字段 `dangerousPatterns`），配合 hooks matcher。
- [ ] **P2 OS 级沙箱**（Codex sandbox：read-only / workspace-write / danger-full-access）：
      容器/sandbox-exec 包裹 run_command 执行（重投入，macOS/Linux 两套实现）。

## 十、技能系统（✅ 基线：SKILL.md 发现（项目+全局）、frontmatter、skill 工具按需加载、/skill find/add/show）

- [ ] **P1 技能安装后本会话即时生效**：`/skill add` 完成后重新 discover + 刷新注入清单
      （现在是下次会话生效）。
- [ ] **P1 技能 frontmatter 扩展**（Claude Code Agent Skills 标准扩展）：`disable-model-invocation`
      （仅手动触发，描述不进上下文）/ `user-invocable` / `context: fork`（技能在子代理上下文
      运行，结果回传）/ `agent` / `background`——对齐 agentskills.io 开放标准（跨 Claude
      Code/Qwen/opencode 生态）。
- [ ] **P2 技能市场/分享渠道**（OpenClaw ClawHub / Claude Code plugin marketplaces）：
      `npx skills` 已能网络检索，补「一键安装到全局 + 列表页展示来源」。
- [ ] **P2 技能清单渐进披露**：技能多时清单占上下文，按关键词过滤/分类注入
      （对标 opencode 可用技能索引）。

## 十一、评测与基准（✅ 基线：mock 离线 eval 可进 CI、真实 API 手动 eval、/model 多端点）

- [ ] **P1 headless eval 自动化**：`omni exec --output-format json` 落地后（第二节），
      eval 脚本直接消费结构化输出——CI 可跑的轻量真实评测（限速/成本控制）或定时报告。
- [ ] **P2 Terminal-Bench / SWE-bench 接入**：社区基准套件（重投入，容器化环境，OpenHands
      提供 Docker 沙箱参考）。
- [ ] **P2 多模型对比运行**（见第七节）。

## 十二、其他

- [ ] **P2 ACP（Agent Client Protocol）支持**（Qwen Code / Kilo Code）：暴露 ACP 端点，
      Zed/编辑器生态集成。
- [ ] **P2 Watch 模式**（Aider AI!/AI? 注释监听）：文件系统监听，检测到 `# TODO AI!` 注释
      触发 agent 执行并清除——有趣的差异化功能，需 fs watch + 差分提交。
- [ ] **P2 会话标题本地化**（Claude Code：标题按会话语言生成）：现有标题固定中文 prompt，
      可跟随 i18n 语言配置（低成本小项）。
- [ ] **P2 配置 profile 档案**（Codex profiles）：多套配置快照（工作/个人/离线）一键切换。
- [ ] **P2 迁移工具**（Codex 支持导入 Claude Code 配置）：反向——从 Claude Code 迁移
      CLAUDE.md/skills/agents 到 omni 格式（`omni import`），降低迁移成本。