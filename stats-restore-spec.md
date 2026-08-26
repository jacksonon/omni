# 修复规格：恢复会话思考丢失 + token 速率统计修正 + 上下文统计

> 来源：用户 Fix Log 两条 ——
> 1. **Thinking time is lost when loading historical conversations**（加载历史会话时思考时间丢失）
> 2. **Token rate statistics are incorrect and need optimization; context statistics need to be added**（token 速率统计错误需优化；需新增上下文统计）
>
> 本规格基于代码调查 + 三轮用户访谈确认。状态：**待实现**（本文件只做设计，不含代码改动）。

---

## 1. 现状调查结论（两个问题都已确认存在）

### 1.1 问题 1：恢复历史会话时思考丢失

**根因**：思考块的展示数据（`kind:'thinking'` 的 `TuiLine`：文本 + `thinkingMs` 耗时 + `thinkingRunning`）全部是**运行时状态**：

- `src/tui/output.ts` 里 `thinkingMs = Date.now() - thinkingStart`（`thinkingStart` 在 `onRound` 预建头行时记录）——纯内存测量，**从不落盘**；
- 会话 JSONL（`src/agent/session.ts`）只持久化 `ChatCompletionMessageParam` 消息。assistant 消息会带一个非标准 `reasoning` 字段（`loop.ts` 588 行 `buildAssistantMessage(content, toolCalls, reasoning)` 写入，`stripNonStandardFields` 在发 API 前剥离），因此**思考内容其实已经随消息落盘**（web 刷新恢复正是读它），但**思考耗时没有任何存储位置**；
- TUI 恢复路径（`tui-entry.ts` ~101 行 + `interactive.ts` `restoreSession`）只回放 `user` 与 `assistant`（纯文本）消息，经 `onUserMessage` / `onAnswer` 重建——**思考块完全不被回放**（内容、耗时都没有）；
- Web 恢复（`web/app.js` `renderHistoryThinking`，1385 行由 `m.reasoning` 触发）能恢复思考**内容**与字符数，但 `finish()` 时无耗时可显示（`thinking.done` 文案里的 `{dur}` 缺失）。

**结论**：TUI 恢复后思考块整体消失；Web 恢复后思考块存在但耗时缺失。耗时从未持久化是根本缺口。

### 1.2 问题 2：token 速率统计错误 + 上下文统计缺失

**① firstTokenMs 计算 bug（已实锤，loop.ts 四处调用点）**：

```ts
output.onLlmLap?.(Date.now() - llmT0, firstTokenAt !== null ? Date.now() - firstTokenAt : null);
```

`firstTokenAt` 是首个 chunk 到达时间（`firstTokenAt ??= Date.now()`），因此 `Date.now() - firstTokenAt` 是「首 token 到流结束的时长」= **生成时长**，而注释明确写着「首 token 延迟 = firstTokenAt - llmT0」。实际传入的应是 **`firstTokenAt - llmT0`**。后果：footer「首 token 平均」（`firstTokenSum / firstTokenCount`）实际展示的是平均生成时长而非首 token 延迟，且该错误值同步进入轨迹事件（`events.ts` `assistant/message.firstTokenMs`）。

**② 速率公式偏低**（`src/tui/layout.ts` `speed` 段）：

```ts
const rate = s.llmMs > 0 ? Math.round(t.completion / (s.llmMs / 1000)) : 0;
```

`llmMs` 是**总墙钟**（含首 token 等待、思考阶段——这些阶段 0 token 产出），用它做分母低估真实生成速率。

**③ 缓存命中**（`cache` 段）：`s.cached / t.prompt` 即「缓存 token / 总 prompt token」，符合 OpenAI 系标准定义，本次不改。

**④ 上下文统计缺失**：footer 无任何「上下文窗口用量」展示；`/context` 命令只有粗糙的 `字符数/2` 估算；模型元数据 `limit.context`（如 128000）已存在于 config（`main.ts` 326 行已把 `cfg.models?.[cfg.model]?.limit?.context` 注入 `runOpts.context.contextLimit` 供压缩 2.0 使用），但没有展示入口。

**⑤ 相关缺口（访谈确认一并纳入）**：恢复历史会话后 `state.stats` / `state.tokens` 全部归零（footer 显示「0 轮 · 0 步 · 输入 0 tok」）——会话完整性缺口，需随恢复重建。

---

## 2. 已确认的设计决策（用户访谈结论）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 恢复范围 | **内容 + 耗时**（回放完整思考块：文本 + `· 3.2s` 耗时头行） |
| D2 | 耗时持久化方式 | **由实现方推荐**：挂到 assistant 消息 `reasoning` 旁新增 `reasoningMs` 字段（一处存储，TUI/Web/console 三端共用，复用现有 `stripNonStandardFields` 剥离逻辑） |
| D3 | 前端范围 | **TUI + Web**；附带：**console /resume 思考显示**、**Web 恢复思考显示耗时** |
| D4 | 旧会话（已落盘、无耗时） | 显示内容，**不显示耗时**（头行无 `· 时间`，不回填） |
| D5 | firstToken bug | **修复**（改 `firstTokenAt - llmT0`，轨迹同步修正） |
| D6 | 速率语义 | **纯生成速率**：`rate = 输出 token ÷ (LLM 墙钟 − 首 token 延迟累计)` |
| D7 | 思考 token 口径 | **由实现方定（要求准确）**：completion 口径 = `completion_tokens` + 网关单独上报的 `reasoning_tokens`（如存在）；DeepSeek 系本就计入，无变化 |
| D8 | 恢复时统计 | **恢复时重建统计**（footer 显示会话真实累计，而非 0） |
| D9 | 上下文统计形态 | **新增 footer 状态行段 `context`**（`/settings statusline` 可勾选/排序，TUI/Web 通用） |
| D10 | 上下文数据源 | **真实 usage 的 prompt token**（API 返回的 `prompt_tokens` 累计）作分子 |
| D11 | `limit.context` 未知 | **由实现方定**：只显示 token 数（如「上下文 23K tok」），不显示百分比（避免误导） |

---

## 3. 详细设计

### A. 思考耗时持久化（D2 / D4）

**`src/agent/messages.ts`**
- `buildAssistantMessage(content, toolCalls, reasoning?, reasoningMs?)`：新增可选 `reasoningMs` 参数，`reasoning` 非空且 `reasoningMs > 0` 时在 assistant 消息上挂非标准字段 `reasoningMs`（毫秒整数）。
- `stripNonStandardFields`：剥离 `reasoning` 的同时剥离 `reasoningMs`（避免发给 API）。

**`src/agent/loop.ts`**（思考阶段计时，与 UI 展示口径一致）
- 每步在调用 `output.onRound` 之前记录 `thinkT0 = Date.now()`（`TuiOutput.onRound` 内部会调 `thinking.start()`，起点对齐）。
- 思考结束点（首个 content delta / 首个 tool_calls delta / 流结束仍展开时兜底 `finishThinking()`）处，若 `reasoning` 非空：`reasoningMs = Date.now() - thinkT0`。
- 组装 assistant 消息时传入：`buildAssistantMessage(content, toolCalls, reasoning, reasoningMs)`。
- 注意：subagent 分支（`subagent.ts` 157 行）不传 reasoning，保持现状。

**会话落盘**：`reasoning` / `reasoningMs` 随 assistant 消息经 `isPersistable` 自然落盘（无需改 `session.ts`）。旧文件没有 `reasoningMs` → 恢复时 `undefined` → 显示内容无耗时（D4）。

### B. TUI 恢复回放（内容 + 耗时，D1 / D3）

**新增可选 Output 方法**（`src/output/types.ts`）：
```ts
onThinkingRestored?(text: string, ms?: number): void;  // 恢复历史会话时回放已完成的思考块
```
- `TuiOutput` 实现：`pushLine(state, { kind: 'thinking', text, thinkingMs: ms, thinkingRunning: false })`（`ms` 为 `undefined` 时头行渲染为 `- thinking`，无耗时——`rows.ts` 492 行已按 `thinkingMs != null` 条件追加时间，天然兼容）。
- `ConsoleOutput` 实现：dim 打印 `💭` 思考块（文本 + `· 3.2s`，对齐 console 的思考展示惯例）。
- `WebOutput` 实现：no-op（web 恢复由前端读消息的 `reasoning` / `reasoningMs` 渲染，见 C）。

**提取共用回放辅助**（新 `src/agent/replay.ts`）：
```ts
export function replayMessagesIntoOutput(output: Output, messages: ChatCompletionMessageParam[]): void
```
按顺序：`user`（字符串 content）→ `onUserMessage`；`assistant`（字符串 content）→ 若带非标准 `reasoning` 字段先 `onThinkingRestored(reasoning, reasoningMs)`，再 `onAnswer(content)` + `onAnswerEnd()`。替换 `tui-entry.ts`（~101 行）与 `interactive.ts` `restoreSession` 里现有的手写回放循环（两处重复逻辑收敛）。

### C. Web 恢复思考显示耗时（D3）

- `src/web/server.ts`：`GET /api/sessions/:id/messages` 返回的 assistant 消息已含 `reasoning` / `reasoningMs`（原样透传，无需改）。
- `web/app.js`：`renderHistoryThinking(sessionId, reasoning, reasoningMs)`（1385 行调用点传 `m.reasoningMs`）——`reasoningMs` 存在时换算成 `formatDur` 风格的耗时传给 `thinkingBlock.finish(dur)`（`thinking.done` 文案已含 `{dur}` 占位）；缺失时不传（现状，显示无耗时）。`web:sync` 同步内嵌副本。

### D. console /resume 思考显示（D3）

- `src/cli/interactive.ts` 的 `/resume`、`/session` 恢复分支：打印历史消息时，对带 `reasoning` 的 assistant 消息先输出 dim `💭` 思考块（含 `· N.Ns` 耗时，缺失则无耗时），再输出正文。可直接复用 `replayMessagesIntoOutput`（ConsoleOutput 实现 `onThinkingRestored`）。

### E. firstTokenMs bug 修复（D5）

**`src/agent/loop.ts`** 全部 `onLlmLap` 调用点（约 4 处：create 取消分支、流失败分支、流式正常结束、打断分支）：
```ts
Date.now() - firstTokenAt   →   firstTokenAt - llmT0
```
同步修正后 footer「首 token 平均」与轨迹 `firstTokenMs` 均为真实延迟。

### F. 纯生成速率（D6 / D7）

**`src/agent/loop.ts`** `onUsage` 处：若 `lastUsage` 带单独上报的 `reasoning_tokens`（非标准字段，`usage as CompletionUsage & { reasoning_tokens?: number }`），并入 completion（`completion: completion_tokens + reasoning_tokens`）——保证输出统计与速率覆盖全部生成 token（D7 准确口径；DeepSeek 系本就计入，行为不变）。

**`src/tui/layout.ts`** `speed` 段：
```ts
const genMs = Math.max(0, s.llmMs - s.firstTokenSum);           // 纯生成时间（总墙钟 − 首 token 延迟累计）
const rate = genMs > 0 ? Math.round(t.completion / (genMs / 1000)) : 0;
```
`firstAvg` 公式不变（`firstTokenSum / firstTokenCount / 1000`——修复 E 后即为真实平均延迟）。

### G. 上下文统计 footer 新段（D9 / D10 / D11）

**`src/tui/layout.ts`**
- `StatuslineSegment.build/buildEn` 增加可选第三参数 `contextLimit?: number`（`buildFooterStats(state)` 透传 `state.contextLimit`）。
- 新增段：
  ```ts
  { id: 'context', label: '上下文窗口', labelEn: 'Context',
    build: (_s, t, limit) => limit ? `上下文 ${formatCompact(t.prompt)} / ${formatCompact(limit)} · ${pct}%` : `上下文 ${formatCompact(t.prompt)} tok`,
    buildEn: (_s, t, limit) => limit ? `Ctx ${formatCompact(t.prompt)} / ${formatCompact(limit)} · ${pct}%` : `Ctx ${formatCompact(t.prompt)} tok` }
  ```
  `pct = Math.round(t.prompt / limit * 100)`（`limit` 已知才显示百分比；`t.prompt === 0` 时显示 `0%`）。
- 默认顺序：`['rounds','llm','speed','cache','tokens','context']`（追加末尾；`/settings statusline` 可改）。**注意**：`STATUSLINE_DEFAULT` 变更会波及快照场景断言，需同步更新。

**`src/tui/state.ts`**：`TuiState` 新增 `contextLimit?: number`（`createTuiState` 默认 `undefined`）。

**`src/tui-entry.ts` / `src/tui/interactive.ts`**：初始化与 `/model` 切换时从 `runOpts.context?.contextLimit` 同步 `state.contextLimit`（`/model` 切换端点时随新端点元数据刷新）。

**Web 端**（D3 范围）：`web/app.js` 的 statusline 段定义（`statusbar.*` 设置项 + footer 渲染 `buildFooterStats` 等价逻辑）新增 `context` 段；`contextLimit` 取 status 里的模型元数据（`limit.context`）；无 `limit.context` 时只显示 token 数。`web:sync` 同步。

**i18n**：TUI `src/tui/i18n.ts` + Web `web/app.js` 的 `statusbar.context` 键（`上下文窗口` / `Context`）。

### H. 恢复时重建统计（D8）

**新纯函数**（放 `src/agent/trace.ts` 或新 `src/agent/stats.ts`）：
```ts
export function rebuildStatsFromTrace(events: TrajEvent[]):
  { stats: SessionStats; tokens: TokenUsage }
```
- `turns` = 计数 `turn/start`；
- `steps` = 计数 `tool/call`；
- `llmMs` = Σ `assistant/message.llmMs`；
- `firstTokenSum` = Σ 非 null 的 `firstTokenMs`；`firstTokenCount` = 非 null 计数（修复 E 后为真实延迟）；
- `cached` = Σ `usage.cached`；`tokens.prompt` = Σ `usage.input`；`tokens.completion` = Σ `usage.output`；`tokens.total` = 前两者之和；
- `toolsMs`：**轨迹无工具耗时事件，不可恢复 → 置 0**（记录为已知限制，见第 5 节）。

**接线**：`interactive.ts` `restoreSession` 与 `tui-entry.ts` 初始恢复（`--continue` / `-r`）在 `EventRecorder.open` 之后调用，把结果写入 `state.stats` / `state.tokens`（覆盖初始 0）。旧会话无 `ev` 行 → 保持 0（可接受）。

---

## 4. 验证计划

1. `npm run typecheck`
2. `npm run tui:snapshot`（45 场景）——需同步更新受影响的断言：
   - `speed` 段速率公式、`firstTokenSum` 语义（修复 E 后首 token 均值变小）；
   - `STATUSLINE_DEFAULT` 增加 `context` 段（场景 39 单段配置、场景 19 命令联想等如有引用）；
   - 新增场景：恢复回放（assistant 带 `reasoning`/`reasoningMs` → 对话流出现 `- thinking · N.Ns` + 内容）、`contextLimit` 未知只显 token 数、已知显百分比。
3. 新探针（`scripts/probe-tmp/`）：
   - `probe-reasoning-ms.ts`：mock 一轮思考 → 断言 assistant 消息 `reasoningMs` 存在且 >0、`stripNonStandardFields` 剥离两字段；构造带 `reasoningMs` 的会话文件 → `replayMessagesIntoOutput` 回放出思考块（含耗时）；
   - `probe-stats-fix.ts`：断言 `firstTokenMs === firstTokenAt - llmT0`（注入已知时序）、`speed` 段纯生成速率、`context` 段两种形态、`rebuildStatsFromTrace` 各字段；
   - `probe-restore-stats.ts`：真实会话（含 ev 行）→ 恢复 → footer 统计非 0 且与轨迹一致。
4. 回归：`npm run eval:mock`、`npm run probe:web`（web 改动后必须）。
5. web 改动后执行 `npm run web:sync`（内嵌 assets 同步）。

---

## 5. 范围外 / 已知限制 / 决策记录

- **toolsMs 恢复不可行**：轨迹事件没有工具耗时（`tool/call`/`tool/result` 无时间戳差可复用？——有 `time` 字段，`tool/result.time - tool/call.time` 可近似，但并行工具交错时不准；本次**不做**，恢复后 toolsMs=0。可选后续：轨迹新增 `tool/lap` 事件）。
- **Web 恢复统计重建**（footer 会话累计）：本次仅 TUI 重建；Web 的 `sessionStats`/`sessionUsage` 为客户端内存态，刷新即失，纳入后续。
- **对话流内的逐轮 token 模块**（`kind:'tokens'`）不随恢复重建（它是 UI 行，未持久化；本次只重建 footer 累计）。
- **旧会话不回填耗时**（D4）：`reasoningMs` 只对修复后新建的会话生效。
- **缓存命中口径不变**（`cached/prompt`，OpenAI 系标准定义）。
- 快照场景断言随上述行为变更同步更新（`STATUSLINE_DEFAULT`、速率、首 token 语义、恢复回放）。
