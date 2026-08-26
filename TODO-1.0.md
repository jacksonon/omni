# TODO 1.0 — 全市场 Agent Harness 调研与 1.0 版本规划

> 调研时间：2026-08-22 · 方法：六路并行在线调研（websearch/webfetch，官方文档与 release notes 优先）
> 覆盖 **30+ 款工具**：终端 CLI / 开源终端 harness / 商业 IDE / VS Code 插件 / 云端自主平台
> 详细原始报告（开源终端 harness 专篇）：`research-terminal-agents-2026.md`
> **定位结论：1.0 不是功能堆料，而是「补齐行业标配 + 放大已有领先项 + 发布工程化承诺」。**

---

## 一、调研范围与方法

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

---

## 二、市场全景

### 2.1 半年洗牌大事记（2026 上半年）——可持续性警示

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

### 2.2 形态收敛共识

| 阵营 | 已收敛的范式 |
|---|---|
| 终端 CLI | hooks 生命周期 + SKILL.md 技能 + subagents + checkpoint/rewind + OS 沙箱 + headless exec + AGENTS.md 记忆 |
| 商业 IDE | rules 文件体系 + 代码库索引 + checkpoints + 后台云 agent + MCP 市场 + Memories |
| VS Code 插件 | BYOK + Plan/Act 分离 + checkpoints + MCP 市场（赛道剧烈洗牌，只剩 Cline/Kilo 两强且都在多端化） |
| 云端平台 | 异步容器任务 + setup 快照 + diff→PR + GitHub/Slack 分派 + 移动审批 + 本地↔云端接力 |
| 共通底座 | MCP 全面普及（OAuth/registry）；SKILL.md 成为跨家通用语；ACP 编辑器互操作协议兴起 |

### 2.3 评测水位与信任危机

- SWE-bench Verified 自报普遍 **75–80%**（GPT-5.2 / GLM-5.2 80%、Sonnet 4.6 79.6%），
  但真实任务（SWE-bench Live / 长时程研究）掉到 **20–40%**——厂商转向私有评测与合同承诺。
- Terminal-Bench 2.0：GPT-5.5 82.2%、Fable 83.8%（TB2.1）领跑。
- 关键研究结论：同一模型在不同 harness 下通过率只差 0–8pp，但 **token 成本差 40 倍**——
  评测单元应是 harness-model pair，需同时报告完成率、token 成本、失败类别。

### 2.4 对 omni 的八条收敛判断

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

---

## 三、行业标配 vs omni 现状（差距矩阵）

| # | 维度 | 行业标杆做法 | omni 现状 | 差距 |
|---|---|---|---|---|
| 1 | Checkpoints/Rewind | Claude /rewind（对话+代码双向、100 个/30 天）；Roo shadow git；Cline 每工具快照；Windsurf 命名快照 | 仅 /undo（write_file 快照栈） | ★★★ 最大差距 |
| 2 | 多会话并发 | opencode 五前端同核 + 会话树；Crush workspace 隔离；Droid Sessions API | Web 全局单运行 | ★★★ |
| 3 | 模型配置 | providers 分组 + limit/modalities 元数据 + 命名 variants + fallback chain（opencode/models.dev） | 扁平 models 表；per-model variants 已有；无元数据/无 fallback | ★★★（需求已在 TODO.md 七节修订） |
| 4 | 沙箱 | Seatbelt/bwrap + 网络 allowlist 代理 + 凭证 masking；Codex 三平台 fail-closed；Zed 默认开启 | sandbox-exec/bwrap 仅文件系统维度 | ★★★ |
| 5 | 子代理编排 | 角色级模型路由（Droid Mission）；worktree 扇出；团队化（共享 todo/互发消息） | delegate 定义文件 + /orchestrate 已有；缺 worktree 隔离 | ★★ |
| 6 | Hooks | Claude ~30 事件五类型；Copilot pre/postToolUse；Crush 格式兼容 | 9 事件 JSON 协议 | ★ 小步扩展 |
| 7 | Skills 生态 | 六家支持 SKILL.md 标准 + 团队仓库分发 | 已兼容 + frontmatter 扩展 | ✓ 领先 |
| 8 | MCP | OAuth 普及、tool annotations、registry 一键装、Apps/Elicitation | stdio/HTTP + OAuth + resources/prompts | ★ 小步跟进 |
| 9 | 记忆 | Claude auto memory（MEMORY.md+主题文件）；Amp globs 条件注入 | autoMemory/TTL/memory_search/嵌套 AGENTS.md | ✓✓ 领先（加大投入） |
| 10 | Headless/CI | exec --json 冻结协议 + 官方 GH Action + SDK 包 | exec + stream-json + schema 校验 + mcp-server | ★ 缺冻结承诺与官方 Action |
| 11 | 上下文管理 | cache-aware 多层压缩、clear_tool_uses、LSP 反馈进上下文（opencode/Crush 招牌） | summarizeAt + repo map + 文件预载 | ★★ |
| 12 | 后台任务 | 全行业铺开（云端跑批/本地常驻/事件驱动三模式） | 无 | ★★ 可 P2 后置 |
| 13 | 浏览器使用 | Playwright MCP + chrome-devtools-mcp 双雄已成标配 | 无（可借 MCP 预设补齐，无需自研） | ☆ 低成本 |
| 14 | Spec-driven | Kiro EARS 三件套（requirements/design/tasks）；Droid spec mode | /plan 只读规划 + /goal 目标循环 | ★ |

---

## 四、1.0 版本 TODO

> 优先级：**P0 = 1.0 的定义项（不完成不叫 1.0）**；P1 = 竞争力增强；P2 = 远期/按需。
> 完成一项 → 同步更新 AGENTS.md 路线图与演进日志（沿用 TODO.md 惯例）。

### 4.1 P0 —— 定义项

- [ ] **P0-1 会话检查点 `/rewind`**（对标 Claude Code /rewind + Roo shadow-git 遗产）：
      回合粒度快照链——每轮用户提交前把工作区快照进 shadow git 仓库（排除 node_modules/dist/.env，
      尊重 .gitignore；检测嵌套 git 则禁用）；`/rewind` 列表选择恢复点，恢复选项
      **code-only / conversation-only / both** 三选；恢复前 diff 预览面板确认；
      快照随会话落盘（resume 后仍可 rewind）；滚动上限（100 个 / 30 天）。
- [x] **P0-2 Web/Electron 多会话并发运行**（已落地：per-session runOpts 原型链克隆 + 独立 undo/events/abort + 全局并发上限 + 后台收件箱 + 前端徽标/按钮全对齐）：per-session runOpts 克隆 + 独立 Safety 闸门 /
      UndoStack / events / abortSignal；全局并发上限与会话级排队治理；
      这是 client/server 架构的成人礼（opencode 教科书级参照）。
- [x] **P0-3 模型层重构落地**（providers 分组 + limit/modalities/capabilities 元数据 + 命名 variants + 跨端点路由 + `{env:VAR}` + max_tokens + 模型发现 + 配置向后兼容）（即 TODO.md 第七节修订需求）：providers 分组（一个 baseURL 挂多模型）
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

**验收线**：以上 6 项全部落地 + 探针回归全绿 + eval:mock 100% + 新增场景快照全绿。

### 4.2 P1 —— 竞争力增强

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

### 4.3 P2 —— 远期/按需

- [ ] ACP server 模式（Zed/JetBrains 编辑器生态接入，JSON-RPC over stdio 开放协议）
- [ ] agent teams（共享任务列表 + SendMessage 互发消息 + 并发预算治理，Claude Code 实验特性对标）
- [ ] 云端远程任务执行（需托管面与容器编排，慎重评估投入产出）
- [ ] 移动审批流（Web PWA 化 + approval push 通知）
- [ ] 配置 profile 档案（工作/个人多套配置一键切换，Codex profiles 对标）
- [ ] 语音输入/听写（通知流才是刚需，语音属边缘）

---

## 五、1.0 发布工程（非功能承诺）

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
7. **治理可持续**：多维护者培养 + 路线图透明（TODO.md/TODO-1.0.md 公开演进），
   避免 Plandex 式单点风险。

---

## 六、明确不做清单（防范围蔓延）

- ❌ 自研浏览器自动化栈——用 Playwright/chrome-devtools MCP 预设（双雄已足够好）
- ❌ 自建模型网关/订阅转售——Zen/Amp 路线属重资产商业行为，与开源定位冲突
- ❌ Tab 补全类 IDE 功能——Amp 都砍掉了；omni 定位是 agent harness 不是补全引擎
- ❌ 云端托管 SaaS 服务——保持本地优先；远程执行仅留 headless 接口
- ❌ 重型 embedding 索引——repo map + LSP 轻量路线够用（Cursor 式后台索引成本高且非终端场景刚需）
- ❌ 语音原生交互——移动审批通知流才是真需求

---

## 七、领先项清单（1.0 重构中不得丢失，继续放大）

| 领先项 | 调研依据 |
|---|---|
| 记忆系统完整度（嵌套 AGENTS.md / TTL / memory_search 渐进披露 / autoMemory 去重合并） | 「记忆仍是洼地」——多数竞品只有静态 rules 文件 |
| headless `--output-schema` 结构化校验 | 同类 exec 命令普遍无 schema 校验 |
| 安全纵深体系（四级权限 + 审批队列 + 审计日志 + 工作区信任 + OS 沙箱） | 权限中间态是多数用户甜点 |
| mock eval 进 CI 的确定性验证文化 | 行业评测信任危机下的差异化可信度 |
| 中文优先 i18n TUI + 细腻交互（点击展开/待发送队列/steer 打断） | TUI UX 是 Crush/opencode 验证过的护城河方向 |

---

## 附录：主要信息来源

- 官方文档与 release notes：code.claude.com、openai/codex、opencode.ai/docs(v2)、models.dev、
  agentskills.io、modelcontextprotocol.io、kiro.dev/docs、ampcode.com、docs.factory.ai、
  block/goose、charmbracelet/crush、cline/roo/kilo/continue 官方仓库与 CHANGELOG
- 评测基准：swebench.com（Verified/Live 双榜）、tbench.ai（Terminal-Bench 2.0/Harbor）、
  mini-swe-agent 统一 bash-only 榜
- 研究：arXiv 2607.22585（harness-model pair 评测方法论）、arXiv 2601.11868（agent 综述）、
  SWE-EVO、METR 时间节省研究
- 本仓库配套原始报告：`research-terminal-agents-2026.md`


