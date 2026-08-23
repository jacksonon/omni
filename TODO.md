# TODO — Omni 可做事项清单

> **1.0 版本规划**：见 [`TODO-1.0.md`](TODO-1.0.md)（2026-08-22 全市场调研 → P0 定义项 / P1 / P2 / 发布工程）。
> 本文件维持为持续演进的 backlog；1.0 完成项会同步回填到这里。
>
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

## 五、恢复与撤销（✅ 基线：/undo /redo 快照栈、**/rewind 会话检查点**、/permission 分级、/diff --stat/--full /review、write_file diff 预览与确认审批）

- [x] **P0 会话检查点 /rewind**（第一百六十四次，Claude Code / Cursor checkpoints 同款）：
      每轮用户消息提交后把工作区「已跟踪且已修改」文件快照进 `.omni/checkpoints/<会话id>/<N>.json`
      （纯文件方案——不依赖 shadow git，无 git 目录也可用；排除 node_modules/dist/.env 等，
      单文件 1MB 上限）；`/rewind` 无参列出（用户消息摘要 + 时间 + 文件数）、`/rewind <N>` 回滚
      工作区文件到该回合状态（对话历史保留，注入 system 提示告知模型）；快照持久化——
      **会话恢复后仍可 /rewind**。CLI/TUI/Web 三端。
- [x] **P1 检查点可视化**（第一百六十四次）：TUI/Web `/rewind` 列表每条附与当前工作区的
      差异统计（Δ +A −B 行，checkpointDiffStats 行级 LCS），一致时显示「与当前一致」。
- [x] **P2 diff 确认审批**（第一百六十四次）：write_file 需要审批的场景（safe 危险档/ask 全询问）
      在审批 reason 附变更统计（新增 N 行 / 修改 +A −B 行，数据源 = UndoStack 执行前快照，
      与工具卡片 diff 同源）；read 档位硬拒绝不变。
- [x] **P2 git 集成深化**（第一百六十四次）：config `autoCommit` 开启后每轮对话结束自动
      `git add -A && git commit`（消息 = 本轮用户消息摘要；非 git/无改动静默跳过）；
      `/diff --stat`（只看统计摘要）/ `--full`（不截断）三端支持。

## 六、子代理与编排（✅ 基线：delegate 隔离上下文小循环、共用安全闸、计划模式只读、web 排队跨会话消息）

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
- [ ] **P2 agent teams / 多会话并行协调**（Claude Code）→ **轻量版已落地**（第一百六十四次）：
      web 端 `/send <会话id> <消息>` 排队为后台任务（全局单运行闸门下当前任务结束后
      串行执行，结果落盘目标会话）；完整树形协调（多会话并发 + 父子关系可视化）
      待 per-session runOpts 克隆后评估。
- [x] **P2 Watch 模式** → 见第十二节（`omni watch` 已落地）。
- [x] **P2 /loop 循环任务 + /goal 硬性完成要求**（第一百三十五次）：`/loop` 命令循环执行任务直至
      验收标准满足（内置目标循环模块：执行 → 校验满足 → 不满足带反馈继续），含迭代日志输出。

## 七、模型与多端点（✅ 基线：models 多端点、/model 切换与添加、/variants 思考级别、持久化、**fallback 回退链**）

> 2026-08-22 需求修订（参考 opencode V2 providers / models.dev 目录设计）：
> 支持一个 baseURL 挂多个模型、每个模型带自己的 variants 与元数据
> （上下文/输出上限、输入输出类型数组等）；并按现状盘点出待优化项。

### 7.1 配置模型重构（provider 分组 + 模型元数据）

- [ ] **P0 Provider 分组：一个 baseURL 挂多个模型**（对标 opencode `providers`）：
      现状 `models` 是以「模型名」为 key 的扁平表
      （`{ 模型名: { baseURL?, apiKey?, userAgent?, reasoningEffort?… } }`）——同一网关下挂 N 个
      模型要么重复写 N 遍端点字段，要么全部挤在顶层唯一 baseURL 回退上，
      **无法表达「一个网关 + 一组模型」**。新增 `providers` 分组（扁平 `models` 向后兼容，
      迁移期两种形态并存）：

      ```jsonc
      {
        "providers": {
          "bigmodel": {
            "baseURL": "https://open.bigmodel.cn/api/paas/v4",
            "apiKey": "{env:GLM_KEY}",   // provider 级共享凭据；支持 {env:VAR} 引用
            "userAgent": "...",
            "headers": {},               // 可选：provider 级请求头
            "models": {
              "glm-4-flash": {},         // 只写差异字段（缺省继承 provider 级）
              "glm-4-plus": {}
            }
          }
        }
      }
      ```

      解析顺序 = provider 级 → model 级逐字段覆盖；`/model` 面板按 `provider/model`
      展示与切换（`providerID` 不含 `/`，`modelID` 可含 `/`，opencode 同规则）；
      createClient 按 provider 复用缓存（同组多模型共享一个客户端实例）。
- [ ] **P0 模型元数据：limit + modalities + capabilities**（每个模型自己的参数画像，
      对标 opencode model 条目的 limit/modalities/capabilities）：
      - `limit: { context, output }`——输入上限（上下文窗口）/ 输出 max（token 数）；
      - `modalities: { input: [...], output: [...] }`——**输入/输出类型数组**
        （text / image / pdf / audio；vision 模型标 image，纯文本模型只 text）；
      - `capabilities`：tools（工具调用）/ reasoning（思考输出）/ temperature 等能力标记；
      - `modelID` 别名（目录友好名 ≠ 发给 API 的真实模型名）、`disabled` 隐藏不出现在
        /model 列表；
      - **未声明时的兜底假设**（opencode 方案）：tools ✓ · input ["text","image"] ·
        output ["text"] · context 200K / output 32K——显式声明覆盖兜底。
      下游消费点：① 请求带 `max_tokens ≤ limit.output`（当前从不设置，长回答可能被网关默认值截断）；
      ② summarizeContext 从「消息数阈值」升级为按 context 窗口占比触发；
      ③ 工具结果 8000 字符固定截断可按模型预算缩放；
      ④ 多模态前置校验（用户消息含图片而该模型 input 无 image → 明确提示而非网关侧报错）。
- [ ] **P1 variants 升级为命名请求叠加层**（对标 opencode custom variants）：
      现状 variants 只有 reasoning_effort 一个维度（`reasoningEffortOptions` 字符串数组 +
      `reasoningEffort` 当前值）；升级为 `{ id, settings?, body?, headers? }` 命名叠加层——
      deep-merge 到该模型的请求配置上（例：`fast` = effort low；`deep` = effort high +
      summary auto + 更大 token budget），/variants 面板列命名 variant、选中即叠加生效；
      **未知 variant 报错而非静默回落基础模型**（opencode 语义）；现有字符串形式保留为简写。

### 7.2 现状盘点：模型与多端点待优化项

- [x] **P0 fallback 模型回退链**（第一百六十四次，Claude Code fallbackModel 同款）：
      config `fallbackModels: []`（最多 3 级按序回退；条目为 models 表模型名）——主模型
      可重试失败（429 限流 / 超时 / 5xx 网关 / 网络错误；401/400 配置问题不浪费回退）
      自动切换备用端点重试本轮，提示「已回退到 X」（meta 行）；本轮内后续请求继续用
      备用端点（activeClient），下一回合从主模型重新开始。三端 Output 均有回退提示。
- [ ] **P1 architect/editor 跨端点路由**：现状 loop 只在同一 client 上换模型名
      （`routedModel`；config 注释明说「不同端点的 architect/editor 需配 models 表，
      MVP 不做跨端点路由」）——architect 与 editor 配在不同网关时不生效。
      基于 provider 分组解析出 per-model 端点，路由时同步切换/复用对应 client
      （ModelRuntime 已支持重建，缺的是按模型名反查端点的解析层）。
- [ ] **P1 模型发现与列表增强**：a) `/model add` 与启动时可选拉取网关 `GET /v1/models`
      自动补全可用模型（OpenAI 兼容协议通用能力；对标 opencode 对 Ollama/LM Studio/vLLM
      的后台自动发现）；b) /model 面板与 Web 设置面板的模型下拉展示显示名 + 上下文窗口/
      输出上限（来自元数据，当前只有裸模型名）；c) `{env:VAR}` 引用统一替换——密钥不进
      配置文件（现状只有顶层 OMNI_API_KEY 环境变量一条路，models 表里只能明文）。
- [ ] **P2 能力驱动的请求构建**：`reasoning_effort` / `stream_options` 等参数目前靠
      「请求失败静默重试不带」探测（每次换不兼容网关都白付一轮失败往返）；有了
      capabilities 元数据后事前决定是否携带。兼容性字段 `compatibility.reasoningField`
      （DeepSeek 系 `reasoning_content` 已内置识别，其余字段名可配置扩展，对标 opencode）。
- [x] **P2 多模型对比 eval**（第一百六十四次）：`npm run eval -- --compare modelA,modelB`
      ——同一组任务各模型跑一遍（-m 覆盖配置），终端对比表（完成率 + 总耗时）+
      `eval-compare.json` 报告落盘。


## 八、MCP 增强（✅ 基线：tools 协议、stdio/streamable-HTTP 双传输、/mcp 列表/资源/提示词/增删/登录、instructions 注入、per-tool 审批、OAuth、**GET 通知流订阅**)

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
- [x] **P2 streamable HTTP 服务器通知流**（第一百六十四次）：GET 长连接（SSE）接收服务器
      主动推送的 JSON-RPC 通知（resources 变更等）——HttpTransport.subscribeNotifications：
      断线自动重连（指数退避封顶 30s）、405 安静放弃（协议允许）、close 终止；OMNI_DEBUG
      下打印通知内容（消费动作按需接入）。

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
- [x] **P2 沙箱细化**（第一百六十四次）：Linux 无 bwrap 时回退 `firejail`
      （--net=none 断网 + --private 工作目录 + --read-only=/ 只读）；config
      `sandboxWritePaths`（workspace-write 白名单：额外允许写的绝对路径——macOS 追加
      subpath allow / bwrap 追加 --bind / firejail 追加 --whitelist）。Windows 沙箱
      （AppContainer）仍不支持（降级提示不变——重投入项后置）。

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
- [x] **P2 清单按关键词/分类注入**（第一百六十四次）：技能超过 15 条截断时按**任务相关性
      排序**注入（skillRelevance：name/description 命中任务关键词数排序，同分保持原序）——
      模型先看到最相关的技能；任务文本 = 最近一条用户消息。

## 十一、评测与基准（✅ 基线：mock 离线 eval 可进 CI、**headless eval 结构化输出**、真实 API 手动 eval、多模型对比、/model 多端点）

- [x] **P1 headless eval 自动化**（第一百六十四次）：`scripts/eval/run-headless-eval.ts`
      ——用 `omni exec --output-format json` 跑任务组，直接消费结构化结果
      （result/num_turns/session_id/exit_code 断言）；mock 离线确定性（默认）/ --real
      真实 API；报告落盘 eval-report.json（headless 标记）。CI 定时评测已铺路。
- [ ] **P2 Terminal-Bench / SWE-bench 接入**：社区基准套件（重投入，容器化环境，OpenHands
      提供 Docker 沙箱参考）。
- [x] **P2 多模型对比运行**：见第七节 `--compare`。

## 十二、其他

- [x] **P2 ACP（Agent Client Protocol）支持**（第一百六十四次）：`omni acp`——stdio JSON-RPC
      端点（initialize / session/new / session/prompt / session/cancel），会话复用 JSONL
      持久化；Zed/编辑器生态可把 omni 当 agent 后端。
- [x] **P2 Watch 模式**（第一百六十四次，Aider AI!/AI? 注释监听）：`omni watch`——fs.watch
      递归监听工作区（排除 node_modules/.git/dist 等），检测到「AI! 任务」注释触发执行并删行、
      「AI? 问题」触发问答并把答案写回为下一行注释；去抖聚合 + 执行期停监听防自触发。
- [x] **P2 会话标题本地化**（第一百六十四次）：标题语言跟随界面语言（config language）——
      中文会话出中文标题、英文会话出英文标题（titleSystemPrompt 按语言选择；TUI/Web 双端接线）。
- [x] **P2 配置 profile 档案**（第一百六十四次，Codex profiles）：config `profiles` 字段
      （{ 档案名: { 部分配置字段 } }）+ `--profile <名>` / OMNI_PROFILE 环境变量——
      档案字段覆盖合并到层叠配置之上（项目/自定义之后、环境变量之前）；未知名报错列可用名单。
- [x] **P2 迁移工具**（第一百六十四次，Codex 支持导入 Claude Code 配置）：`omni import`——
      CLAUDE.md → AGENTS.md、.claude/skills/ → .agents/skills/（目录复制）、
      .claude/agents/*.md → .agents/subagents/（frontmatter 转换）、settings.json deny
      规则 → dangerousPatterns 建议（只提示）；**只增不改**（目标已存在一律跳过）。