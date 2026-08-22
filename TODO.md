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

## 三、记忆与上下文增强（✅ 基线：全局+项目级联、**嵌套 AGENTS.md**、/init 生成、autoMemory 去重合并、预载文件、摘要压缩、渐进披露、override、TTL、repo map、新工具）

- [x] **P0 记忆渐进披露**（第一百六十三次，Claude Code MEMORY.md 方案）：记忆/AGENTS.md 常驻
      索引，新增 `memory_search`（多关键词 AND + 按命中数排序）/ `memory_read`（按路径读完整记忆）
      工具按需读取详细条目（工具注入 trusted 环境）。
- [x] **P0 项目级会话自动写入**（第一百六十三次）：退出时提取本项目持久事实（构建命令/架构约定，
      `extractProjectMemory` 独立 LLM 请求）→ 生成**待提交片段** `.omni/memory-pending.md`
      （不直接改 git 跟踪的 AGENTS.md）；`/memory-apply` 命令确认后应用（追加项目根 AGENTS.md + 清片段）。
- [x] **P1 嵌套 AGENTS.md 与分层合并（核心）**（第一百五十八次）：从 cwd 向上**收集所有层级**
      的 AGENTS.md（git 根/home 边界、每目录一层），各生成一条 system 消息（独立 40KB 字节截断），
      注入顺序 `[外层 → … → 内层]`——内层贴近用户消息、权重最高（内层可覆盖/细化外层）。
- [x] **P1 AGENTS.override.md 覆盖层 + fallback 文件名**（第一百六十三次，Codex 方案）：
      每目录优先选 `AGENTS.override.md`（同目录覆盖 AGENTS.md）> `AGENTS.md` > fallback
      （`TEAM_GUIDE.md` / `GUIDE.md` 兜底）。
- [x] **P1 嵌套合计上限**（第一百六十三次）：`loadProjectMemory` 合计超 32KB
      （PROJECT_MEMORY_TOTAL_MAX_BYTES）时从最外层（权重最低）开始裁，保内层。
- [x] **P2 `/init` 支持子目录层级生成**（第一百六十三次）：`/init <子目录>` 生成局部层级
      AGENTS.md（复用快照/LLM 生成链路，写入目标子目录，嵌套记忆覆盖外层）。
- [x] **P2 `/status` 展示已加载的 AGENTS.md 清单**（第一百六十三次）：statusReport 新增
      memoryFiles（从 `[项目记忆` 前缀消息解析路径）逐层展示 + 全局记忆标记。
- [x] **P1 记忆 TTL 与过期**（第一百六十三次）：`## 会话记忆（日期）` 段落超 MEMORY_TTL_DAYS（90）
      天移入 `## 记忆归档（过期）` 段（`applyMemoryTTL` 纯函数；条目仍参与去重防重复学习）。
- [x] **P1 TodoWrite 任务清单工具**（第一百六十三次）：`todo_write` 工具——模型维护结构化 todo
      （in_progress/completed/pending），存 `runOpts.todoList`（会话级，/status 可查），
      执行返回进度摘要（共 N 项：完成/进行中/待办）。
- [x] **P1 WebFetch 内置工具**（第一百六十三次）：`web_fetch` 工具——Node 内置 fetch 抓取 URL →
      `htmlToText` 转纯文本（剥 script/style/标签、保留链接与代码块）→ 截断；域名允许列表可配
      （config `webFetchDomains`，缺省全部）。
- [x] **P1 代码库结构感知（repo map）**（第一百六十三次，Aider 轻量版）：`agent/repomap.ts` 正则
      提取函数/类/常量定义行生成紧凑符号地图（文件: 符号列表）注入首轮（config `repoMap` /
      `repoMapMaxSymbols`）；不引入 tree-sitter。
- [x] **P1 LSP 诊断反馈闭环**（第一百六十三次，opencode/Cline 轻量版）：`diagnose` 工具——探测
      项目 typecheck→lint→test 脚本并运行返回诊断摘要回传模型自修复（与 run_command 静默 typecheck
      互补；`detectCheckCommand` 纯函数）。
- [x] **P2 语义检索记忆**（第一百六十三次）：用关键词检索替代向量化——`memory_search` 多关键词
      AND + 命中数排序近似相关度（向量嵌入重投入后置）。

## 四、会话管理（✅ 基线：JSONL 落盘、--continue/-r/-l、/rename、/session、/compact、/resume、/trace、/export、/fork、/send）

- [x] **P1 会话 fork**（第一百六十二次）：`/fork` 从当前会话历史某点分叉独立新会话（原会话
      不丢）——`forkSession(sourceFile, splitIndex)` 复制前 N 条消息（脚手架过滤、新 id/时间戳、
      继承标题），TUI 列出 fork 点（`/fork` 无参展示序号摘要）· `/fork <N>` 直接分叉并自动切换；
      CLI/Web 同步支持（Web 只做文件级 fork，侧栏刷新可见）。
- [x] **P2 跨会话消息**（第一百六十二次）：`/send <会话id> <消息>` 向指定会话发消息取结果——
      `sendSessionMessage` 串行执行（保存当前上下文 → 载入目标会话 → 追加消息 → prepareContext +
      runAgent → 本轮新增落盘 → 恢复当前上下文）；结果以 `[跨会话响应：会话 <id>]` system 消息
      注入当前上下文（模型可见），对话流显示摘要；CLI/TUI 支持，Web 提示全局单运行限制。

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

- [x] **P1 子代理嵌套 + 技能预载**（第一百三十五次）：`.agents/subagents/*.md` frontmatter 定义
      （name/description/model/permission/tools/skills/maxSteps），per-agent 模型/权限/工具白名单，
      delegate `agent` 参数按名加载、`skills` 注入 SKILL.md 全文；嵌套委托（深度上限 5，父链传导）。
- [x] **P1 子代理进度可视化**（第一百三十五次）：`SubagentEvent` 轨迹事件（start/step/end + step 带
      当前动作工具名）+ foldTrace 嵌套树行（缩进 + ✓ 步数 + 耗时 + 结果摘要）；TUI delegate 卡片复用
      tool 卡片（运行中 `子代理 X · ⠋ run_command 3/10`、收起态命令行 + `✓ N 步 · 结果首行`），
      /trace 面板展示嵌套树；/agents 命令列出已发现定义 + `/agents <name>` 展开查看角色全文。
- [x] **P1 模型路由：architect/editor 双模型**（第一百三十五次）：config `architect`/`editor` 字段——
      `/plan` 计划模式自动用 architect（强模型）、执行阶段用 editor（轻模型）；缺省回退当前模型。
- [x] **P2 动态工作流轻量版**（第一百三十五次）：`/orchestrate` 固定 pipeline——fan-out 并行 delegate
      （默认 3 worker）→ 汇总器 → 对抗审查（adversarial review），暂不支持模型写 JS 脚本。
- [ ] **P2 agent teams / 多会话并行协调**（Claude Code）：跨会话树形协调，依赖第五节跨会话消息
      与第六节可视化；需多会话运行能力（opencode multi-session）。
- [x] **P2 /loop 循环任务 + /goal 硬性完成要求**（第一百三十五次）：`/loop` 命令循环执行任务直至
      验收标准满足（内置目标循环模块：执行 → 校验满足 → 不满足带反馈继续），含迭代日志输出。

## 七、模型与多端点（✅ 基线：models 多端点、/model 切换与添加、/variants 思考级别、持久化）

- [ ] **P0 fallback 模型回退链**（Claude Code fallbackModel：最多 3 级按序回退）：
      主模型 429/超时/网关错误时自动切换备用端点（现有 models 表已可配，loop 错误处理处加
      回退重试），提示「已回退到 X」。
- [ ] **P1 计划/执行模型分离预设**（见第六节 architect/editor；此处指单一 harness 层面
      `/plan` 自动用 config 指定模型）。
- [ ] **P2 多模型对比 eval**：同一任务多模型跑 eval 输出对比报告（--eval 已铺路）。

## 八、MCP 增强（✅ 基线：tools 协议、stdio/streamable-HTTP 双传输、/mcp 列表/资源/提示词/增删/登录、instructions 注入、per-tool 审批、OAuth）

- [x] **P1 MCP Resources 协议**（第一百五十九次）：`resources/list` / `resources/read`——外部数据流/文件
      按需读取进上下文（不只工具调用）；server 声明时注册 `<server>_read_resource` 辅助工具。
- [x] **P1 MCP Prompts 协议**（第一百五十九次）：`prompts/list` / `prompts/get`——可复用提示词模板；
      声明时注册 `<server>_get_prompt` 辅助工具，`/mcp prompts` / `/mcp get` 查看。
- [x] **P1 server instructions**（第一百五十九次）：MCP 初始化时读取 `instructions` 字段注入系统提示
      （跨工具约束/限流指引，2048 字符截断，多条叠放）。
- [x] **P1 per-tool 审批模式**（第一百五十九次）：server 级 `enabledTools`/`disabledTools` 白黑名单 +
      `defaultToolsApprovalMode`（auto/prompt/writes/approve）——烘焙到 Tool.approvalMode，
      对接现有 Safety 闸门分级（gateTool 重构 + applyApprovalMode 纯函数）。
- [x] **P2 运行时 add/remove MCP 服务器**（第一百五十九次）：`/mcp add <名> <command|--url> [--approval]
      [--enabled-tools] [--disabled-tools]` / `/mcp remove <名>`——不重启增删服务器并持久化配置。
- [x] **P2 streamable HTTP + OAuth**（第一百五十九次）：McpTransport 传输抽象——stdio 与 streamable HTTP
      （POST JSON + SSE 响应 + Mcp-Session-Id + 自定义 headers）；OAuth 登录（`/mcp login`，RFC 8414
      discovery + 授权码 PKCE + token 持久化 ~/.config/omni/mcp-oauth.json）。
- [ ] **P2 streamable HTTP 服务器通知流**：GET 长连接接收服务器主动推送（resources 变更通知等）——
      当前只处理 POST 响应流，服务器→客户端单向通知未订阅。

## 九、安全与信任（✅ 基线：permission 四档分级、审批卡片/队列、审计日志、危险命令正则（内置+扩展）、工作区信任、OS 级沙箱）

- [x] **P0 hooks 化 enforcement**（见第一节：PreToolUse block 是「规则」与「保证」的分界线，
      Claude Code 明确推荐 hook 而非 prompt 指令；第一百三十三次已随第一节 P1 落地
      `guard-env` / `guard-dangerous` / `guard-git-push` 示例集）。
- [x] **P1 工作区信任（workspace trust）**（第一百六十次）：首次进入未信任目录时提示信任
      （TUI 审批卡片 / console readline；无 UI = fail-safe 只读）；信任清单持久化
      `~/.config/omni/trusted-workspaces.json`（父目录继承）；未信任 = 只读（read 档位，
      `/permission` 无法提升）+ 跳过项目级 hooks/skills/子代理定义/项目记忆（防仓库注入
      恶意配置）。
- [x] **P1 危险命令正则库扩充与可配置**（第一百六十次）：内置清单扩充（git reset --hard /
      git clean -f / chmod -R 777 / curl | sh / sudo 危险操作）+ config `dangerousPatterns`
      用户/项目级扩展列表，配合 hooks matcher。
- [x] **P2 OS 级沙箱**（第一百六十次，Codex sandbox 对标）：config `sandbox` 档位
      read-only / workspace-write / danger-full-access——macOS `sandbox-exec`（Seatbelt profile：
      deny 写/网络）、Linux `bwrap`（--ro-bind + --unshare-net）包裹 run_command；平台不支持
      降级执行 + 提示（fail-open）。
- [ ] **P2 沙箱细化**：Linux 无 bwrap 时回退 `firejail`；Windows 沙箱（AppContainer / 容器）；
      workspace-write 增加临时目录/家目录白名单配置；沙箱对 MCP HTTP 服务器请求头注入
      （透传 token 的进程外工具不在沙箱内）。

## 十、技能系统（✅ 基线：SKILL.md 发现（项目+全局）、frontmatter 扩展、skill 工具按需加载、/skill find/add/show、安装即时生效、渐进披露）

- [x] **P1 技能安装后本会话即时生效**（第一百六十一次）：`/skill add` 完成后重新 discover +
      `refreshSkillInjections(messages, skills)` 刷新注入清单（替换/追加到会话消息首部）——
      模型本会话即可用 skill 工具加载新技能。
- [x] **P1 技能 frontmatter 扩展**（第一百六十一次，Claude Code Agent Skills 标准扩展）：
      `disable-model-invocation`（仅手动触发，不进自动清单）/ `user-invocable` /
      `context: fork`（技能在子代理上下文运行，结果回传——`createSkillTool` 经 delegate 执行，
      无 delegate 降级）/ `agent` / `background`——对齐 agentskills.io 开放标准
      （跨 Claude Code/Qwen/opencode 生态）。
- [x] **P2 技能市场/分享渠道**（第一百六十一次）：`/skill add --global`（`globalSkillDir()`
      提示复制到 `~/.config/omni/skills/`）+ 列表展示来源标记（全局/仅手动/子代理/来源）。
- [x] **P2 技能清单渐进披露**（第一百六十一次）：`skillMessage` 最多列 15 条 + 「还有 N 个未列出
      （/skill 查看全部；模型可直接尝试调用未列出的技能名）」；`/skill` 列表命令展示全部不截断。
- [ ] **P2 清单按关键词/分类注入**：技能很多时按任务关键词过滤注入（对标 opencode 可用技能
      索引；现为固定 15 条截断，未做任务相关性排序）。

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