# TODO — Omni 可做事项清单

> 检索自业界主流 coding agent（Claude Code / Codex CLI / opencode / Cursor / Aider）能力
> 与本仓库现状的差距。优先级：P0 = 高价值低成本，P1 = 高价值中成本，P2 = 低优先/重投入。
> 完成一项 → 同步更新 AGENTS.md 路线图与演进日志。

## 一、记忆系统增强（当前：全局+项目级联加载、/init 生成、全局自动写入、偏好去重/矛盾合并）

- [x] **P0 偏好去重与合并**（`src/agent/memory.ts`，第五十二次）：自动写入前规范化比对新条目与已有
      `## 会话记忆` 段落（规范化哈希/互相包含判定），重复不追加；同主题矛盾条目以最新为准
      原位替换——防止全局记忆冗余膨胀。
- [ ] **P0 项目级会话自动写入**：现在只有全局记忆会「会话结束自动追加」，项目记忆
      （AGENTS.md 是 git 跟踪文件）也可在退出时提示/写入新学到的构建命令与架构决定
      （需与「项目文件不轻易被自动改」的直觉平衡——可先做「生成待提交片段供用户确认」）。
- [ ] **P1 记忆渐进披露**：记忆文件只载头部索引（前 N 行），详细条目通过工具按需读取
      ——对标 Claude Code「MEMORY.md 只载 200 行/25KB，主题文件按需读」。
- [ ] **P1 记忆 TTL 与过期**：`## 会话记忆（日期）` 段落超过 N 天未再命中时移入归档
      段或裁剪（当前只有体积裁剪，没有时间维度）。
- [ ] **P2 语义检索记忆**：记忆条目向量化 + `memory_search` 工具按需检索（重投入，
      依赖嵌入模型；可先用关键词检索替代）。

## 二、会话管理（当前：JSONL 落盘 + `--continue`/`-r <id>`/`-l` 恢复 + `/rename` 标题 + `/resume` 交互内恢复 + `/session` 同目录管理 + `/compact` 手动压缩）

- [x] **P1 会话持久化**（第五十二次）：交互模式把消息流以 append-only JSONL 落盘
      （`~/.config/omni/sessions/`，脚手架 system 消息不落盘），崩溃/关闭后可恢复。
- [x] **P1 `--continue` / `-r <id>` / `-l` 恢复**（第五十二次）：自动恢复最近会话（`--continue`，
      `-c` 已被 --config 占用）或列出历史会话（`-l`）按 id 恢复（`-r <id>`，显示消息数/时间）；
      恢复按「可落盘消息数」计数，防脚手架注入导致重复写盘。
- [x] **P1 会话命名 `/rename <标题>`**（第六十次）：改标题 → 终端窗口标题（OSC 0）+ 会话 meta 落盘
      （SessionMeta.title，`/resume` 恢复时还原）。
- [x] **P1 `/session` 会话管理**（第六十六次）：无参列出**当前目录**（同目录）历史会话——TUI 选择面板 /
      CLI 文本列出；`/session <id>` 直接继续（支持 id 前缀匹配，多个命中列出候选不静默选）；
      `/session all` 列出全部；恢复后持久化路由到新文件 + 清理空占位会话（/resume 同步受益）。
- [ ] **P1 会话 fork**：从历史某点 fork 出新会话（安全探索替代路径；当前 /resume 只能整段恢复，
      不能从中间分支）。
- [x] **P1 `/compact` 手动压缩**（第五十八次）：复用 summarizeContext 强制压缩旧消息为摘要
      （保留最近 8 条原文），消息太少/无可压缩时提示不打断。

## 三、计划模式与变更撤销（当前：/plan 只读 + /undo//redo 快照回滚 + /permission 分级切换 + /diff//review）

- [x] **P0 `/plan` 只读计划模式**（第五十二次）：命令切换，只暴露只读工具（read_file/list_directory/
      search_code）+ 系统提示只读说明，footer 常驻「· 计划模式」指示，输出实施计划。
- [x] **P1 文件变更检查点 `/undo` + `/redo`**（第五十三/六十次）：write_file 执行前自动快照原内容
      （UndoStack，1MB 上限，子代理共用），`/undo` 回滚最近一次、`/undo all` 全部回滚（新建文件删除）；
      第六十次补 redo 栈——`/undo` 时捕获「撤销前」状态进 redo，`/redo` 恢复，新写入清空 redo 历史。
- [x] **P1 `/permission` 运行时权限切换**（第五十四次）：TUI 面板（低=read 只读 / 中=safe 危险询问默认 /
      高=ask 全询问 / 全量=full 直通）+ CLI 参数即时切换，共用闸门 setTier 同步子代理；
      第五十五次打通审批链路（bind 修复 + 单任务 TUI 审批按键 + full 直通任意命令）。
- [x] **P1 git 集成 `/diff` + `/review`**（第五十八/六十次）：`/diff` 查看未提交改动（前 60 行）；
      `/review` 先跑项目自带 typecheck（无则 lint）→ 收集 git diff → 一次独立 LLM 调用输出
      问题与建议（不进 messages 历史）；git/typecheck 不可用降级不崩溃。

## 四、MCP 扩展（当前：tools 协议 + `/mcp` 列表/重连）

- [ ] **P1 MCP Resources 协议**：支持 `resources/list` / `resources/read`——外部服务器
      暴露的数据流/文件可在上下文里按需读取（不只调用工具）。
- [ ] **P1 MCP Prompts 协议**：支持 `prompts/list` / `prompts/get`——可复用的提示词模板。
- [x] **P2 `/mcp` 管理命令**（第六十次）：列出已配置服务器/已发现工具 + `/mcp reconnect` 重连
      （closeMcpClients 关旧进程 → 重新 discover → 以 baseTools 为底重建工具链）。
- [ ] **P2 运行时 add/remove MCP 服务器**：当前只能改配置文件后 `/mcp reconnect`，不能在不重启
      的情况下增删服务器。

## 五、评测与基准（当前：mock 离线可进 CI + 真实 API 手动 eval + /model 多端点铺路）

- [ ] **P1 真实 API eval 自动化**：现有 `npm run eval` 需手动跑真实 API，补一个
      CI 可跑的轻量真实评测（限速/成本控制）或定时报告。
- [ ] **P2 Terminal-Bench / SWE-bench 接入**：社区基准套件（重投入，容器化环境）。
- [ ] **P2 多模型对比运行**：同一任务在多个模型下跑 eval，输出对比报告
      （`/model` 多端点切换已铺路，见第七节）。

## 六、其他

- [ ] **P1 嵌套 AGENTS.md**：子目录 `AGENTS.md` 在进入相关目录时按需加载
      （对标 Codex 子包级约定；当前只加载最近的单一文件）。
- [ ] **P1 代码库结构感知（repo map）**：为长任务预生成紧凑的符号/结构摘要注入首轮
      （对标 Aider 的 repo-map，token 高效）——现有 preloadFiles 是文件级，缺符号级。
- [ ] **P2 diff 确认审批**：安全护栏在 write_file 前展示变更 diff 供确认
      （当前审批只覆盖 run_command 危险命令）。
- [ ] **P2 子代理进度可视化**：delegate 子任务目前无 UI 展示（独立上下文、无界面），
      可考虑在 TUI 里以卡片呈现子代理运行状态/结果。

## 七、技能系统（新增：SKILL.md 发现 + skill 工具 + /skill 管理）

- [x] **P1 技能发现与按需加载**（`src/agent/skill.ts` + `src/tools/skill.ts`，第五十七次）：
      项目 `.opencode/.claude/.agents/skills` 向上 + 全局发现，frontmatter 解析（name 须符合
      opencode 规则且与目录一致）；系统只常驻 name+description 清单，模型用 **skill 工具**
      按需加载 SKILL.md 全文（40KB 截断）——对标 opencode 双段式。
- [x] **P1 `/skill` 命令**（第五十七次）：列出已发现（name+描述+全局标记）/ `/skill find <词>`
      走 `npx skills find` 网络检索 skills.sh / `/skill add <repo> [--skill <名>]` 安装到
      `.agents/skills/` 等 / `/skill show <名>` 查看内容。
- [ ] **P2 技能安装后本会话即时生效**：当前 `/skill add` 装入 `.agents/skills/` 后要**下次会话**
      才被自动发现——可在安装后重新 discover 并刷新注入的清单。
- [ ] **P2 技能清单渐进披露**：已发现技能很多时清单占上下文，可按关键词过滤/分类注入
      （对标 opencode 的可用技能索引）。

## 八、多模型（新增：config `models` 多端点 + /model 切换与添加）

- [x] **P1 多模型端点切换**（`src/client.ts` + config `models`，第五十九次）：不同模型可配不同
      baseURL/apiKey/userAgent（缺省回退顶层），`/model` 面板/命令切换时用 createClient 重建客户端
      并更新 ModelRuntime 共享引用——主循环与子代理同步；`/variants` 切思考级别（reasoning_effort，
      网关不认自动回退）。
- [x] **P1 `/model add` 运行时添加并持久化**（第六十三次，`src/config/write.ts`）：命令行添加
      （`--base-url`/`--api-key`/`--user-agent`）→ 运行时注册 + 切换 → 只写显式字段进纯 JSON 配置
      （JSONC 提示手动加，不破坏注释）。
