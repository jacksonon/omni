# TODO — Omni 可做事项清单（1.0 调研规划 + 持续演进 backlog）

> **合并说明**（2026-09-01）：本文档由原 `Doc/TODO.md`（持续演进 backlog，2026-08-17 调研）与
> `Doc/TODO-1.0.md`（1.0 全市场调研与版本规划，2026-08-22 调研）合并而来；两部分信息全部保留，
> 勾选状态已按当前落地情况统一回填（✅ = 已完成基线，不再重复做）。
>
> 文档结构：
> - **第一部分 当前待办**：全部未完成项汇总（优先看这里）；
> - **第二部分 1.0 调研与规划**：调研范围、市场全景、差距矩阵、1.0 TODO（P0/P1/P2）、发布工程、不做清单、领先项、信息来源；
> - **第三部分 持续演进 backlog**：十二节已完成基线 + 少量待办（1.0 完成项已回填）。
>
> 优先级：P0 = 高价值低成本（短期可做）/ 1.0 定义项；P1 = 高价值中成本；P2 = 低优先/重投入。
> 完成一项 → 同步更新 AGENTS.md 路线图摘要与 `Doc/evolution-log.md`。

---

## 第一部分 当前待办（未完成项汇总）

| 待办项 | 内容 | 详见 |
|---|---|---|
| **/rewind 三模式**（P0-1） | 恢复选项 code-only / conversation-only / both 三选；基础版（纯文件快照，工作区文件回滚）已落地 | 二·D.1 P0-1 · 三·第五节 |
| **Terminal-Bench / SWE-bench 接入**（P2） | 社区基准套件（重投入，容器化环境，OpenHands Docker 沙箱参考） | 三·第十一节 |
| **agent teams 完整版**（P2） | 共享任务列表 + SendMessage 互发消息 + 并发预算治理 + 树形协调可视化；轻量版（web `/send` 排队为后台任务）已落地 | 二·D.3 · 三·第六节 |
| **云端远程任务执行**（P2） | 需托管面与容器编排，慎重评估投入产出 | 二·D.3 |
| **移动审批流**（P2） | Web PWA 化 + approval push 通知 | 二·D.3 |
| **语音输入/听写**（P2） | 通知流才是刚需，语音属边缘 | 二·D.3 |

---

## 第二部分 1.0 调研与规划（原 TODO-1.0.md）

> 调研时间：2026-08-22 · 方法：六路并行在线调研（websearch/webfetch，官方文档与 release notes 优先）
> 覆盖 **30+ 款工具**：终端 CLI / 开源终端 harness / 商业 IDE / VS Code 插件 / 云端自主平台
> 详细原始报告（开源终端 harness 专篇）：`research-terminal-agents-2026.md`
> **定位结论：1.0 不是功能堆料，而是「补齐行业标配 + 放大已有领先项 + 发布工程化承诺」。**

### A. 调研范围与方法

| 线 | 对象 |
|---|---|
| A 终端 CLI | Claude Code、OpenAI Codex CLI、Gemini CLI / Antigravity、Qwen Code、Amazon Q + Kiro CLI、Warp、Aider |
| B 开源终端 harness | opencode V2、Goose（Block→Linux Foundation）、Crush（Charm）、Amp（Sourcegraph）、Factory Droid、Plandex、gptme / Mentat |
| C 商业 IDE | Cursor、Windsurf（→Devin Desktop）、GitHub Copilot 全家桶、Zed、JetBrains Junie、Trae、AWS Kiro |
| C' VS Code 插件 | Cline、Roo Code、Kilo Code、Continue.dev |
| D 云端自主平台 | Devin、OpenHands、Google Jules、Codex Cloud、Claude Code on the web、Copilot coding agent、Cursor Cloud、SWE-agent 家族 |
| E 横向趋势 | 标配能力收敛清单、前沿差异化方向、1.0 版本发布惯例 |

每个工具按统一维度采集：核心循环与工具集、上下文管理、子代理/编排、hooks/skills/plugins、
MCP、记忆、会话管理（checkpoint/rewind/fork/share）、权限与沙箱、headless/CI/server、
模型配置（多 provider/variants/fallback）、评测成绩、UI/UX 差异化、近半年新特性。

### B. 市场全景

#### B.1 半年洗牌大事记（2026 上半年）——可持续性警示

- **Roo Code 关停**（2026-05 归档）：团队认为「IDE 不是编码的未来」转向 Slack-first 云 agent；
  其 shadow-git checkpoint 设计被 Cline v4 吸收——**好设计可以比项目活得久**。
- **Continue.dev 被 Cursor acqui-hire 后关停**（2026-06）：BYOLLM 先驱终章。
- **Windsurf → Devin Desktop**（Cognition 2026-06 更名）：Cascade 被 Devin Local 重写取代。
- **Goose 移交 Linux Foundation**：vendor-neutral 治理先例；「不卖模型只做宿主」定位。
- **opencode 公司化**（Anomaly Innovations）：160K+ stars 开源第一，配套 Zen 模型网关与企业版。
- **Amp 激进做减法**：去广告改订阅、删 custom commands（用 skills 取代）、杀编辑器扩展。
- **Aider 停滞**：无 MCP/subagents 导致掉队，社区转向 fork——git-native 与 repo map 仍被称道。
- **Plandex 实质死亡**：创始人离职、Cloud 停服、13 个月无发版——单维护者脆弱性标本。
- **资本侧**：Factory $150M Series C @$1.5B；SpaceX 收购 Cursor（所有权链 Continue→Cursor→xAI）。
- **Claude Code v2.x**：Remote Tasks / Routines、Code Review GA、sandbox runtime 独立开源包。
- **Copilot CLI GA + Agent HQ**：第三方 agents（Claude/Codex/Gemini/Cognition）平台化接入。

> **教训**：单维护者 + 托管云依赖 = 脆弱。可持续正解 = 开放治理 + client/server 多前端架构 + 本地优先。

#### B.2 形态收敛共识

| 阵营 | 已收敛的范式 |
|---|---|
| 终端 CLI | hooks 生命周期 + SKILL.md 技能 + subagents + checkpoint/rewind + OS 沙箱 + headless exec + AGENTS.md 记忆 |
| 商业 IDE | rules 文件体系 + 代码库索引 + checkpoints + 后台云 agent + MCP 市场 + Memories |
| VS Code 插件 | BYOK + Plan/Act 分离 + checkpoints + MCP 市场（赛道剧烈洗牌，只剩 Cline/Kilo 两强且都在多端化） |
| 云端平台 | 异步容器任务 + setup 快照 + diff→PR + GitHub/Slack 分派 + 移动审批 + 本地↔云端接力 |
| 共通底座 | MCP 全面普及（OAuth/registry）；SKILL.md 成为跨家通用语；ACP 编辑器互操作协议兴起 |

#### B.3 评测水位与信任危机

- SWE-bench Verified 自报普遍 **75–80%**（GPT-5.2 / GLM-5.2 80%、Sonnet 4.6 79.6%），
  但真实任务（SWE-bench Live / 长时程研究）掉到 **20–40%**——厂商转向私有评测与合同承诺。
- Terminal-Bench 2.0：GPT-5.5 82.2%、Fable 83.8%（TB2.1）领跑。
- 关键研究结论：同一模型在不同 harness 下通过率只差 0–8pp，但 **token 成本差 40 倍**——
  评测单元应是 harness-model pair，需同时报告完成率、token 成本、失败类别。

#### B.4 对 omni 的八条收敛判断

1. **客户端-服务端多前端是必答题**：opencode 五前端同核、Crush workspace、Droid Sessions API——
   「全局单运行」假设会被淘汰。
2. **SKILL.md 已是通用语**：六家支持，omni 渐进披露方向正确。
3. **子代理从「能派」到「能管」**：并发上限/超时/白名单是及格线；差异化在角色级模型路由、
   worktree 隔离、防递归约束。
4. **权限光谱两极分化**：Amp 默认零审批 vs opencode/Droid 细粒度默认问；中间态（omni safe 分级 +
   工作区信任）是多数用户甜点；值得抄 bash glob 规则与 fail-fast 只读默认。
5. **MCP 进入深水区**：OAuth 全面落地；Goose 把 Apps/Elicitation/Sampling 做成护城河。
6. **记忆仍是洼地**：除 Amp 条件注入与 gptme lessons 外无人做出学习闭环——omni 反而领先。
7. **沙箱标准 = OS 原语 + 网络 allowlist + 凭证 masking**，Windows fail-closed 是短板高发区。
8. **后台/远程任务三模式收敛**：云端跑批 / 本地常驻编排 / issue→PR 事件驱动。

### C. 行业标配 vs omni 现状（差距矩阵）

> 以下矩阵为 **2026-08-22 调研时点快照**；1.0 期间多数差距已补齐（见 D 节勾选状态）：
> #1 rewind 基础版 · #2 Web 多会话并发 · #3 providers/元数据/fallback · #4 沙箱 fs 维度 + 网络代理/
> masking/fail-closed · #5 子代理 worktree 隔离 · #6 hooks 事件扩展 · #8 MCP annotations/registry ·
> #9 记忆结构化升级 · #10 Headless 协议冻结 + omni-action · #11 压缩 2.0 + LSP 反馈 · #12 本地后台任务
> 队列 + Web 收件箱 · #13 浏览器一键预设 · #14 `/spec` 三件套。

| # | 维度 | 行业标杆做法 | omni 现状（调研时点） | 差距 |
|---|---|---|---|---|
| 1 | Checkpoints/Rewind | Claude /rewind（对话+代码双向、100 个/30 天）；Roo shadow git；Cline 每工具快照；Windsurf 命名快照 | 仅 /undo（write_file 快照栈）；现已有 /rewind 基础版（纯文件快照，第一百六十四次） | ★★★ 最大差距 |
| 2 | 多会话并发 | opencode 五前端同核 + 会话树；Crush workspace 隔离；Droid Sessions API | Web 全局单运行（现为 P0-2 多会话并发，已落地） | ★★★ |
| 3 | 模型配置 | providers 分组 + limit/modalities 元数据 + 命名 variants + fallback chain（opencode/models.dev） | 扁平 models 表；per-model variants 已有；无元数据/无 fallback | ★★★（需求修订见第三部分第七节） |
| 4 | 沙箱 | Seatbelt/bwrap + 网络 allowlist 代理 + 凭证 masking；Codex 三平台 fail-closed；Zed 默认开启 | sandbox-exec/bwrap 仅文件系统维度 | ★★★ |
| 5 | 子代理编排 | 角色级模型路由（Droid Mission）；worktree 扇出；团队化（共享 todo/互发消息） | delegate 定义文件 + /orchestrate 已有；缺 worktree 隔离（P0-6 已落地） | ★★ |
| 6 | Hooks | Claude ~30 事件五类型；Copilot pre/postToolUse；Crush 格式兼容 | 9 事件 JSON 协议 | ★ 小步扩展 |
| 7 | Skills 生态 | 六家支持 SKILL.md 标准 + 团队仓库分发 | 已兼容 + frontmatter 扩展 | ✓ 领先 |
| 8 | MCP | OAuth 普及、tool annotations、registry 一键装、Apps/Elicitation | stdio/HTTP + OAuth + resources/prompts | ★ 小步跟进 |
| 9 | 记忆 | Claude auto memory（MEMORY.md+主题文件）；Amp globs 条件注入 | autoMemory/TTL/memory_search/嵌套 AGENTS.md | ✓✓ 领先（加大投入） |
| 10 | Headless/CI | exec --json 冻结协议 + 官方 GH Action + SDK 包 | exec + stream-json + schema 校验 + mcp-server | ★ 缺冻结承诺与官方 Action |
| 11 | 上下文管理 | cache-aware 多层压缩、clear_tool_uses、LSP 反馈进上下文（opencode/Crush 招牌） | summarizeAt + repo map + 文件预载 | ★★ |
| 12 | 后台任务 | 全行业铺开（云端跑批/本地常驻/事件驱动三模式） | 无 | ★★ 可 P2 后置 |
| 13 | 浏览器使用 | Playwright MCP + chrome-devtools-mcp 双雄已成标配 | 无（可借 MCP 预设补齐，无需自研） | ☆ 低成本 |
| 14 | Spec-driven | Kiro EARS 三件套（requirements/design/tasks）；Droid spec mode | /plan 只读规划 + /goal 目标循环 | ★ |

### D. 1.0 版本 TODO

> 优先级：**P0 = 1.0 的定义项（不完成不叫 1.0）**；P1 = 竞争力增强；P2 = 远期/按需。
> 完成一项 → 同步更新 AGENTS.md 路线图摘要与 `Doc/evolution-log.md`。

#### D.1 P0 —— 定义项

- [ ] **P0-1 会话检查点 `/rewind`（三模式）**（对标 Claude Code /rewind + Roo shadow-git 遗产）：
      **基础版已落地**（第一百六十四次：每轮用户消息提交后把工作区「已跟踪且已修改」文件快照进
      `.omni/checkpoints/<会话id>/<N>.json` 纯文件方案——不依赖 shadow git，无 git 目录也可用；
      `/rewind` 无参列出 / `<N>` 回滚工作区文件，对话历史保留；CLI/TUI/Web 三端。详见第三部分第五节）。
      **未完成**：恢复选项 **code-only / conversation-only / both** 三选（当前仅工作区文件回滚 +
      对话历史保留，无 conversation-only / both）；恢复前 diff 预览面板确认；滚动上限（100 个 / 30 天）。
- [x] **P0-2 Web/Electron 多会话并发运行**（已落地：per-session runOpts 原型链克隆 + 独立 undo/events/abort + 全局并发上限 + 后台收件箱 + 前端徽标/按钮全对齐）：per-session runOpts 克隆 + 独立 Safety 闸门 /
      UndoStack / events / abortSignal；全局并发上限与会话级排队治理；
      这是 client/server 架构的成人礼（opencode 教科书级参照）。
- [x] **P0-3 模型层重构落地**（providers 分组 + limit/modalities/capabilities 元数据 + 命名 variants + 跨端点路由 + `{env:VAR}` + max_tokens + 模型发现 + 配置向后兼容）（即第三部分第七节修订需求）：providers 分组（一个 baseURL 挂多模型）
      + limit/modalities/capabilities 元数据 + 命名 variants 叠加层 + provider fallback chain
      + architect/editor 跨端点路由 + `{env:VAR}` 密钥引用 + max_tokens 按 limit.output 下发
      + /v1/models 发现与列表增强。**扁平 models 表与顶层 baseURL/apiKey 解析已移除（第一百六十九次），providers 为唯一端点格式。**
- [x] **P0-4 沙箱 2.0**（网络白名单过滤代理 + fail-closed + 凭据 masking + 策略文件写保护；Windows fail-closed 文档说明）：出站流量走内置代理按 hostname 白名单放行
      （不解密 TLS）；凭证 masking（沙箱内读到 sentinel 占位符，代理注入真实值）；
      Windows 无 bwrap/sandbox-exec 等价物时 **fail-closed 可配**（failIfUnavailable 选项，
      企业安全门）；settings 类文件自动 deny 写入防策略篡改。
- [x] **P0-5 Headless 协议冻结 + omni-action**（`schemas/*.v1.json` + `config.schema.json` + `omni-action` + `Doc/Headless-Protocol.md` + 发布工程脚本）：stream-json 事件名/payload 发布 JSON Schema
      并 semver 承诺（破坏性变更升 minor+弃用窗口）；会话 JSONL 行结构与 mcp-server 协议面明示冻结；
      发布 `omni-action`——只读 job 生成 patch → 独立 job 开 PR（密钥隔离，升级现有 examples/ci 模板）。
- [x] **P0-6 子代理 worktree 隔离**（`delegate` worktree 参数 + `ToolContext.cwd` 贯穿 + 对比统计/合并提示/清理）：delegate 增加 worktree 选项——并行子代理各自在独立 git worktree
      运行防写冲突，结束后可选合并/保留/清理（对标 Droid `--worktree`、Amp/Cursor 并行模式）。

**验收线**：以上 6 项全部落地 + 探针回归全绿 + eval:mock 100% + 新增场景快照全绿
（截至合并时点：6 项中仅 P0-1 三模式未完成）。

#### D.2 P1 —— 竞争力增强

- [x] **P1-1 hooks 事件扩展**（PermissionRequest / PostCompact / PostToolUseFailure + http handler 类型）：PermissionRequest（审批前介入）/ PostCompact / PostToolUseFailure；
      handler 类型增加 http（对标 Claude Code command/http/mcp/prompt/agent 五类型中的 http）。
- [x] **P1-2 记忆结构化升级**（MEMORY.md 索引 + topics/*.md + globs 条件注入 + TTL 归档；向后兼容遗留 AGENTS.md）：MEMORY.md 索引 + topics/*.md 主题文件渐进披露（对标 Claude Code
      auto memory）；后台整理循环（会话结束异步归并）；Amp 式 globs 条件注入
      （记忆条目声明 glob，命中任务上下文才注入）。
- [x] **P1-3 LSP 反馈进上下文**（`diagnoseAfterEdit` 配置，write_file 后跑快速检查回传诊断）（opencode/Crush 的招牌差异点）：diagnose 工具升级——至少 TS/Python
      内置语言服务器探测，编辑后把诊断实时回传模型自修复；只读、按需启动。
- [x] **P1-4 上下文压缩 2.0**（limit.context 窗口占比触发 + 工具结果折叠 clear_tool_uses 等价）：cache 友好的压缩顺序（避免打爆 prompt cache）；工具结果清理
      （clear_tool_uses 等价：保留最近 N 次工具原文、更早的折成摘要）；触发条件从消息数升级为
      context 窗口占比（依赖 P0-3 元数据）。
- [x] **P1-5 MCP 深水区**（tool annotations readOnlyHint 消费 + registry 一键安装 `/mcp install`）：tool annotations 消费（readOnlyHint → 免审批直通只读工具）；
      registry 一键安装（`/mcp install <registry-id>`）。
- [x] **P1-6 浏览器能力一键预设**（`omni preset browser` 写入全局配置）：`omni preset browser` = 安装 Playwright MCP +
      chrome-devtools-mcp 并写入配置（自动化找 Playwright、调试/性能找 DevTools）；
      不自研浏览器栈。
- [x] **P1-7 spec-driven 强化**（`/spec` 三件套：requirements-EARS/design/tasks 落盘 `.omni/specs/`，tasks 同步会话清单）：`/plan` 产物可落盘 `.omni/specs/<feature>/`三件套——
      requirements.md（EARS 格式验收条款）/ design.md / tasks.md；tasks 与 TodoWrite 打通逐项执行
      （对标 Kiro 方法论，轻量版）。
- [x] **P1-8 本地后台任务队列 + Web 收件箱**（`POST /api/tasks` + worker 自动建独立会话 + 实时状态 SSE + 前端面板）：cron/手动入队长任务，跑完 Web 通知 + diff 审查；
      云端远程执行不在本期（见不做清单）。
- [x] **P1-9 skills 生态完善**（`/skill validate` 校验 + 团队仓库分发文档 + `npx skills add` 已支持）：skills-ref validate 兼容校验（`/skill validate`）；
      团队 git 仓库分发（技能仓库独立存放、agent 可自己提交更新，对标 Amp）。
- [x] **P1-10 eval 成本效率报告**（headless eval 输出 token/成本/空转回合/失败类别；多模型对比已有）：完成率之外输出 token/解题成本、无动作轮次、失败类别向量；
      多模型对比表（harness-model pair 口径）。
- [x] **P1-11 OpenTelemetry 导出开关**（零依赖 OTLP/HTTP JSON 导出器 + loop 挂接；默认关、脱敏、fire-and-forget）：默认关、opt-in 显式、prompt 内容默认脱敏；
      指标族命名对齐 claude_code.* 惯例（session/token/cost/tool activity），Grafana 即插即用。

#### D.3 P2 —— 远期/按需

- [x] ~~ACP server 模式~~ **已落地**（`omni acp`——stdio JSON-RPC 端点 initialize / session/new /
      session/prompt / session/cancel，会话复用 JSONL 持久化；Zed/编辑器生态可把 omni 当 agent 后端。
      第一百六十四次，见第三部分第十二节）
- [ ] agent teams **完整版**（共享任务列表 + SendMessage 互发消息 + 并发预算治理，Claude Code
      实验特性对标；轻量版 web `/send` 排队已落地，见第三部分第六节）
- [ ] 云端远程任务执行（需托管面与容器编排，慎重评估投入产出）
- [ ] 移动审批流（Web PWA 化 + approval push 通知）
- [x] ~~配置 profile 档案~~ **已落地**（config `profiles` 字段 + `--profile <名>` / OMNI_PROFILE，
      Codex profiles 对标。第一百六十四次，见第三部分第十二节）
- [ ] 语音输入/听写（通知流才是刚需，语音属边缘）

### E. 1.0 发布工程（非功能承诺）

1. **稳定性契约**：严格 semver；headless 输出格式、会话文件格式、mcp-server 协议面冻结
   （见 P0-5）；配置 schema 冻结 + 废弃字段保留一个周期别名；`--help` 与退出码语义视为公共 API。
2. **配置 schema 发布**：提供 `$schema` URL（JSON Schema 全字段 + 默认值 + 说明），
   编辑器自动补全/校验——对标 opencode config.json。
3. **文档完备度门槛**：安装、配置参考（全字段）、命令/工具/hook/skill 全参考、headless/CI 指南、
   安全模型说明（权限分级 + 沙箱边界 + 审计 = threat model 一节）、troubleshooting、llms.txt 索引。
4. **分发全覆盖**：npm 平台子包 ✓（已有）+ Homebrew formula + curl 安装脚本 +
   GitHub Release 原生二进制 ✓（已有）+ Windows winget/安装器；console/TUI/Web 同通道。
5. **遥测合规**：产品遥测默认关闭、opt-in 且显式；开启也默认脱敏 prompt/工具内容；
   环境变量级一键禁用；NO_COLOR 等环境约定尊重并在文档声明收集范围。
6. **质量信号公开**：发布 eval 报告（mock 回归 + 一组真实任务集完成率 + token 成本）
   + 快照/探针测试规模，作为「稳定」主张佐证。
7. **治理可持续**：多维护者培养 + 路线图透明（本文档公开演进），避免 Plandex 式单点风险。

### F. 明确不做清单（防范围蔓延）

- ❌ 自研浏览器自动化栈——用 Playwright/chrome-devtools MCP 预设（双雄已足够好）
- ❌ 自建模型网关/订阅转售——Zen/Amp 路线属重资产商业行为，与开源定位冲突
- ❌ Tab 补全类 IDE 功能——Amp 都砍掉了；omni 定位是 agent harness 不是补全引擎
- ❌ 云端托管 SaaS 服务——保持本地优先；远程执行仅留 headless 接口
- ❌ 重型 embedding 索引——repo map + LSP 轻量路线够用（Cursor 式后台索引成本高且非终端场景刚需）
- ❌ 语音原生交互——移动审批通知流才是真需求

### G. 领先项清单（1.0 重构中不得丢失，继续放大）

| 领先项 | 调研依据 |
|---|---|
| 记忆系统完整度（嵌套 AGENTS.md / TTL / memory_search 渐进披露 / autoMemory 去重合并） | 「记忆仍是洼地」——多数竞品只有静态 rules 文件 |
| headless `--output-schema` 结构化校验 | 同类 exec 命令普遍无 schema 校验 |
| 安全纵深体系（四级权限 + 审批队列 + 审计日志 + 工作区信任 + OS 沙箱） | 权限中间态是多数用户甜点 |
| mock eval 进 CI 的确定性验证文化 | 行业评测信任危机下的差异化可信度 |
| 中文优先 i18n TUI + 细腻交互（点击展开/待发送队列/steer 打断） | TUI UX 是 Crush/opencode 验证过的护城河方向 |

### H. 附录：主要信息来源

- 官方文档与 release notes：code.claude.com、openai/codex、opencode.ai/docs(v2)、models.dev、
  agentskills.io、modelcontextprotocol.io、kiro.dev/docs、ampcode.com、docs.factory.ai、
  block/goose、charmbracelet/crush、cline/roo/kilo/continue 官方仓库与 CHANGELOG
- 评测基准：swebench.com（Verified/Live 双榜）、tbench.ai（Terminal-Bench 2.0/Harbor）、
  mini-swe-agent 统一 bash-only 榜
- 研究：arXiv 2607.22585（harness-model pair 评测方法论）、arXiv 2601.11868（agent 综述）、
  SWE-EVO、METR 时间节省研究
- 本仓库配套原始报告：`research-terminal-agents-2026.md`

---

## 第三部分 持续演进 backlog（原 TODO.md）

> 调研时间：2026-08-17（第一轮）。覆盖主流 agent harness：Claude Code / OpenAI Codex CLI / opencode /
> Gemini CLI（现 Antigravity CLI）/ Qwen Code / Cursor / Aider / Cline / Roo Code / Kilo Code /
> Goose / OpenHands / GitHub Copilot CLI。
> 本部分维持为持续演进的 backlog；1.0 完成项已回填。✅ = 已完成基线（当前能力，不再重复做）。

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
      > ⚠️ **待办**：恢复选项三模式（code-only / conversation-only / both）尚未落地，见第二部分 D.1 P0-1。
- [x] **P1 检查点可视化**（第一百六十四次）：TUI/Web `/rewind` 列表每条附与当前工作区的
      差异统计（Δ +A −B 行，checkpointDiffStats 行级 LCS），一致时显示「与当前一致」。
- [x] **P2 diff 确认审批**（第一百六十四次）：write_file 需要审批的场景（safe 危险档/ask 全询问）
      在审批 reason 附变更统计（新增 N 行 / 修改 +A −B 行，数据源 = UndoStack 执行前快照，
      与工具卡片 diff 同源）；read 档位硬拒绝不变。
- [x] **P2 git 集成深化**（第一百六十四次）：config `autoCommit` 开启后每轮对话结束自动
      `git add -A && git commit`（消息 = 本轮用户消息摘要；非 git/无改动静默跳过）；
      `/diff --stat`（只看统计摘要）/ `--full`（不截断）三端支持。

## 六、子代理与编排（✅ 基线：delegate 隔离上下文小循环、共用安全闸、计划模式只读、worktree 隔离、web 排队跨会话消息）

- [x] **P1 子代理嵌套 + 技能预载**（第一百三十五次）：`.agents/subagents/*.md` frontmatter 定义
      （name/description/model/permission/tools/skills/maxSteps），per-agent 模型/权限/工具白名单，
      delegate `agent` 参数按名加载、`skills` 注入 SKILL.md 全文；嵌套委托（深度上限 5，父链传导）。
- [x] **P1 子代理进度可视化**（第一百三十五次）：`SubagentEvent` 轨迹事件（start/step/end + step 带
      当前动作工具名）+ foldTrace 嵌套树行（缩进 + ✓ 步数 + 耗时 + 结果摘要）；TUI delegate 卡片复用
      tool 卡片（运行中 `子代理 X · ⠋ run_command 3/10`、收起态命令行 + `✓ N 步 · 结果首行`），
      /trace 账本展示嵌套树；/agents 命令列出已发现定义 + `/agents <name>` 展开查看角色全文。
- [x] **P1 模型路由：architect/editor 双模型**（第一百三十五次）：config `architect`/`editor` 字段——
      `/plan` 计划模式自动用 architect（强模型）、执行阶段用 editor（轻模型）；缺省回退当前模型。
- [x] **P2 动态工作流轻量版**（第一百三十五次）：`/orchestrate` 固定 pipeline——fan-out 并行 delegate
      （默认 3 worker）→ 汇总器 → 对抗审查（adversarial review），暂不支持模型写 JS 脚本。
- [ ] **P2 agent teams / 多会话并行协调**（Claude Code）→ **轻量版已落地**（第一百六十四次）：
      web 端 `/send <会话id> <消息>` 排队为后台任务（全局单运行闸门下当前任务结束后
      串行执行，结果落盘目标会话）；完整树形协调（多会话并发 + 父子关系可视化）
      **待做**——per-session runOpts 克隆已随 P0-2 落地（见第二部分 D.1），可在此基础上评估实现。
- [x] **P2 Watch 模式** → 见第十二节（`omni watch` 已落地）。
- [x] **P2 /loop 循环任务 + /goal 硬性完成要求**（第一百三十五次）：`/loop` 命令循环执行任务直至
      验收标准满足（内置目标循环模块：执行 → 校验满足 → 不满足带反馈继续），含迭代日志输出。

## 七、模型与多端点（✅ 基线：providers 多端点、/model 切换与添加、/variants 思考级别与命名 variants、持久化、**fallback 回退链**）

> 2026-08-22 需求修订（参考 opencode V2 providers / models.dev 目录设计）：
> 支持一个 baseURL 挂多个模型、每个模型带自己的 variants 与元数据
> （上下文/输出上限、输入输出类型数组等）；并按现状盘点出待优化项。

### 7.1 配置模型重构（provider 分组 + 模型元数据）

- [x] **P0 Provider 分组**（对标 opencode `providers`，第一百六十五次）：
      现状（修订前）`models` 是以「模型名」为 key 的扁平表
      （`{ 模型名: { baseURL?, apiKey?, userAgent?, reasoningEffort?… } }`）——同一模型下挂 N 个
      模型要么重复写 N 遍端点字段，要么全部挤在顶层唯一 baseURL 回退上，
      **无法表达「一个网关 + 一组模型」**。新增 `providers` 分组（第一百六十九次起
      **扁平 `models` 与顶层 baseURL/apiKey/userAgent 解析已移除**，providers 为唯一格式）：

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
- [x] **P0 模型元数据**（第一百六十五次）：limit·modalities·capabilities·apiModel·displayName·disabled + 兜底假设 + 消费点 max_tokens·压缩占比·多模态校验（工具结果缩放未做——可选兜底项）（每个模型自己的参数画像，
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
- [x] **P1 命名 variants 叠加层**（第一百六十五次）：{id, reasoningEffort?, body?, headers?} + /variants 面板 + 未知报错 + 字符串兼容 + 持久化（对标 opencode custom variants）：
      现状 variants 只有 reasoning_effort 一个维度（`reasoningEffortOptions` 字符串数组 +
      `reasoningEffort` 当前值）；升级为 `{ id, settings?, body?, headers? }` 命名叠加层——
      deep-merge 到该模型的请求配置上（例：`fast` = effort low；`deep` = effort high +
      summary auto + 更大 token budget），/variants 面板列命名 variant、选中即叠加生效；
      **未知 variant 报错而非静默回落基础模型**（opencode 语义）；现有字符串形式保留为简写。

### 7.2 现状盘点：模型与多端点待优化项

- [x] **P0 fallback 模型回退链**（第一百六十四次，Claude Code fallbackModel 同款）：
      config `fallbackModels: []`（最多 3 级按序回退；条目为 providers 分组模型名）——主模型
      可重试失败（429 限流 / 超时 / 5xx 网关 / 网络错误；401/400 配置问题不浪费回退）
      自动切换备用端点重试本轮，提示「已回退到 X」（meta 行）；本轮内后续请求继续用
      备用端点（activeClient），下一回合从主模型重新开始。三端 Output 均有回退提示。
- [x] **P1 architect/editor 跨端点路由**（第一百六十五次）：resolveModelRoute 按名反查 + getClient 缓存 + loop 每步重算：现状 loop 只在同一 client 上换模型名
      （`routedModel`；config 注释明说「不同端点的 architect/editor 需配 models 表，
      MVP 不做跨端点路由」）——architect 与 editor 配在不同网关时不生效。
      基于 provider 分组解析出 per-model 端点，路由时同步切换/复用对应 client
      （ModelRuntime 已支持重建，缺的是按模型名反查端点的解析层）。
- [x] **P1 模型发现与列表增强**（第一百六十五次）：/model fetch 三端 + 面板元数据标签 + {env:VAR} 引用——启动自动发现保持按需命令形态：a) `/model add` 与启动时可选拉取网关 `GET /v1/models`
      自动补全可用模型（OpenAI 兼容协议通用能力；对标 opencode 对 Ollama/LM Studio/vLLM
      的后台自动发现）；b) /model 面板与 Web 设置面板的模型下拉展示显示名 + 上下文窗口/
      输出上限（来自元数据，当前只有裸模型名）；c) `{env:VAR}` 引用统一替换——密钥不进
      配置文件（现状只有顶层 OMNI_API_KEY 环境变量一条路，models 表里只能明文）。
- [x] **P2 能力驱动的请求构建**（第一百六十五次）：capabilities.reasoning/tools 事前决定是否携带参数 + compatibility.reasoningField 自定义 reasoning 字段名：`reasoning_effort` / `stream_options` 等参数目前靠
      「请求失败静默重试不带」探测（每次换不兼容网关都白付一轮失败往返）；有了
      capabilities 元数据后事前决定是否携带。兼容性字段 `compatibility.reasoningField`
      （DeepSeek 系 `reasoning_content` 已内置识别，其余字段名可配置扩展，对标 opencode）。
- [x] **P2 多模型对比 eval**（第一百六十四次）：`npm run eval -- --compare modelA,modelB`
      ——同一组任务各模型跑一遍（-m 覆盖配置），终端对比表（完成率 + 总耗时）+
      `eval-compare.json` 报告落盘。

## 八、MCP 增强（✅ 基线：tools 协议、stdio/streamable-HTTP 双传输、/mcp 列表/资源/提示词/增删/登录、instructions 注入、per-tool 审批、OAuth、**GET 通知流订阅**、tool annotations、registry 一键装）

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

## 九、安全与信任（✅ 基线：permission 四档分级、审批卡片/队列、审计日志、危险命令正则（内置+扩展）、工作区信任、OS 级沙箱 + 网络过滤代理 + 凭据 masking + fail-closed）

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

## 十、技能系统（✅ 基线：SKILL.md 发现（项目+全局）、frontmatter 扩展、skill 工具按需加载、/skill find/add/show/validate、安装即时生效、渐进披露）

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

## 十一、评测与基准（✅ 基线：mock 离线 eval 可进 CI、**headless eval 结构化输出**、真实 API 手动 eval、多模型对比、/model 多端点、成本效率报告）

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