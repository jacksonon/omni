# TODO — Omni 可做事项清单

> 检索自业界主流 coding agent（Claude Code / Codex CLI / opencode / Cursor / Aider）能力
> 与本仓库现状的差距。优先级：P0 = 高价值低成本，P1 = 高价值中成本，P2 = 低优先/重投入。
> 完成一项 → 同步更新 AGENTS.md 路线图与演进日志。

## 一、记忆系统增强（当前：全局+项目级联加载、/init 生成、全局自动写入）

- [x] **P0 偏好去重与合并**（`src/agent/memory.ts`）：自动写入前检查新条目与已有
      `## 会话记忆` 段落是否重复（规范化哈希/近似包含），重复则不追加；同主题矛盾条目
      以最新为准并原位替换旧条目——防止全局记忆冗余膨胀。
- [ ] **P0 项目级会话自动写入**：现在只有全局记忆会「会话结束自动追加」，项目记忆
      （AGENTS.md 是 git 跟踪文件）也可在退出时提示/写入新学到的构建命令与架构决定
      （需与「项目文件不轻易被自动改」的直觉平衡——可先做「生成待提交片段供用户确认」）。
- [ ] **P1 记忆渐进披露**：记忆文件只载头部索引（前 N 行），详细条目通过工具按需读取
      ——对标 Claude Code「MEMORY.md 只载 200 行/25KB，主题文件按需读」。
- [ ] **P1 记忆 TTL 与过期**：`## 会话记忆（日期）` 段落超过 N 天未再命中时移入归档
      段或裁剪（当前只有体积裁剪，没有时间维度）。
- [ ] **P2 语义检索记忆**：记忆条目向量化 + `memory_search` 工具按需检索（重投入，
      依赖嵌入模型；可先用关键词检索替代）。

## 二、会话管理（当前：单进程内多轮，退出即丢）

- [x] **P1 会话持久化**：交互模式把消息流以 append-only JSONL 落盘
      （`~/.config/omni/sessions/`，对标 Claude Code），崩溃/关闭后可恢复。
- [x] **P1 `--continue` / `--resume`**：自动恢复最近会话（`--continue`，`-c` 已被 --config
      占用）或列出历史会话（`-l`）按 id 恢复（`-r <id>`，显示消息数/时间）。
- [ ] **P1 会话命名与 fork**：`/rename <名称>` 标记会话；从历史某点 fork 出新会话
      （安全探索替代路径）。
- [ ] **P1 `/compact` 手动压缩**：现有 summarizeAt 是自动阈值触发，补一个手动命令
      让用户主动压短上下文。

## 三、计划模式与变更撤销（当前：无）

- [x] **P0 `/plan` 只读计划模式**：命令切换，只暴露只读工具（read_file/list_directory/
      search_code）+ 系统提示只读说明，footer 常驻「· 计划模式」指示，输出实施计划。
- [x] **P1 文件变更检查点 / `/undo`**：write_file 执行前自动快照原内容（UndoStack，
      1MB 上限，子代理共用），`/undo` 回滚最近一次、`/undo all` 全部回滚（新建文件删除）
      ——长任务跑偏时可撤销（run_command 副作用不跟踪）。
- [x] **P1 `/permission` 运行时权限切换**：TUI 面板（低=read 只读 / 中=safe 危险询问默认 /
      高=ask 全询问 / 全量=full 直通）+ CLI 参数即时切换，共用闸门 setTier 同步子代理。
- [ ] **P1 git 集成 `/diff` + `/review`**：查看未提交变更摘要、按 diff 审阅
      （当前 run_command 危险拦截含 git push，但无原生 diff/review 体验）。

## 四、MCP 扩展（当前：仅 tools 协议）

- [ ] **P1 MCP Resources 协议**：支持 `resources/list` / `resources/read`——外部服务器
      暴露的数据流/文件可在上下文里按需读取（不只调用工具）。
- [ ] **P1 MCP Prompts 协议**：支持 `prompts/list` / `prompts/get`——可复用的提示词模板。
- [ ] **P2 `/mcp` 管理命令**：运行时 add/remove 服务器（当前只能改配置文件后重启）。

## 五、评测与基准（当前：mock 离线可进 CI）

- [ ] **P1 真实 API eval 自动化**：现有 `npm run eval` 需手动跑真实 API，补一个
      CI 可跑的轻量真实评测（限速/成本控制）或定时报告。
- [ ] **P2 Terminal-Bench / SWE-bench 接入**：社区基准套件（重投入，容器化环境）。

## 六、其他

- [ ] **P1 嵌套 AGENTS.md**：子目录 `AGENTS.md` 在进入相关目录时按需加载
      （对标 Codex 子包级约定；当前只加载最近的单一文件）。
- [ ] **P1 代码库结构感知（repo map）**：为长任务预生成紧凑的符号/结构摘要注入首轮
      （对标 Aider 的 repo-map，token 高效）——现有 preloadFiles 是文件级，缺符号级。
- [ ] **P2 diff 确认审批**：安全护栏在 write_file 前展示变更 diff 供确认
      （当前审批只覆盖 run_command 危险命令）。
- [ ] **P2 多模型对比运行**：同一任务在多个模型下跑 eval，输出对比报告。
