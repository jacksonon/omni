# 修复规格：设置 → 模型配置支持 providers 分组（一个 baseURL+key 对应多个模型）

> 来源：用户需求 —— 「设置 - 模型配置，需要支持 omni.json 那种 providers 的配置，也就是一个 baseURL key 可以对应多个模型」。
>
> 本规格基于代码调查 + 三轮用户访谈确认。状态：**待实现**（本文件只做设计，不含代码改动）。

---

## 1. 现状调查

- **config 已支持 `providers`**（`src/config/index.ts` 73-77 行类型定义、501-550 行解析、826-840 行加载期展开合并进扁平 `cfg.models` 表；`client.ts` `ModelEndpoint` 带 `provider?: string` 标记；`/model` 切换、`/model add`、TUI 面板都基于扁平 `runOpts.models`）。
- **Web 设置面板「模型配置」tab 只编辑扁平 `models`**（`web/app.js` `renderSavedModelList`/`fillModelConfigForm`/保存按钮）：chips + 下拉逐模型编辑 baseURL/apiKey/思考级别/上下文，**一个模型重复填一遍 baseURL+apiKey**，且**无「新增模型名」入口**（只能编辑已存在模型）。
- **保存路径**：`POST /api/settings` 的 `modelConfig`（`src/web/server.ts` ~1585 行）→ `persistModelConfigToGlobal`（`src/config/write.ts`）**只写扁平 `models.<名>`**，从不写 `providers`。
- **`buildStatus`**（`server.ts` ~340 行）返回 `models: runOpts.models`（扁平展开表），**不含 providers 分组结构**。
- 结论：providers 只支持手写配置文件；Web 面板（用户日常入口）无法用它配置多模型。

---

## 2. 已确认的设计决策（三轮访谈结论）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | UI 形态 | **完整分组 CRUD**：左侧 provider 列表（未分组 + 各 provider），provider 级编辑共享 baseURL/apiKey，组内管理模型（添加/移除/编辑） |
| D2 | 持久化格式 | 分组编辑**写 `providers` 字段**（真 provider 结构）——**providers 为配置文件端点/密钥的唯一格式**（第一百六十九次起扁平 `models` 解析已移除，不再有「未分组模型」） |
| D3 | 旧扁平 models | ~~自动合并展示 + 编辑时提示迁移~~ —— **已随扁平 models 解析移除**（旧配置中的扁平条目不再被读取，用户需手动迁移到 providers 分组） |
| D4 | 前端范围 | **Web + TUI 都分组** |
| D5 | 字段划分 | **provider 级：baseURL / apiKey（可选 userAgent）**；**模型级：apiModel / displayName / reasoningEffortOptions / reasoningEffort / limit.context / variants 等其余全部**（与 omni.json providers 结构一致） |
| D6 | 新增能力 | 组内**支持输入新模型名**（+ 可选 apiModel）；支持**「+ 新建 provider」** |
| D7 | 默认模型 | 每个模型旁**「设为默认」按钮** → 写顶层 `model` 字段，当前默认高亮 |
| D8 | 覆盖能力 | 组内模型默认继承 provider 的 baseURL/apiKey，提供**「继承 / 覆盖」开关**（覆盖时显示额外输入框） |
| D9 | 写入目标 | **保持只写全局配置**（`~/.config/omni/omni.json`，XDG-aware），跨项目生效 |
| D10 | JSONC | **保持拒绝自动改**：纯 JSON 才自动写，JSONC 提示手动编辑（与 `persistModelConfigToGlobal` 现状一致） |
| D11 | 删除能力 | 支持**删除 provider / 删除组内模型**（确认后移除配置条目；删除当前默认模型时提示先改默认） |
| D12 | TUI 粒度 | **分组展示 + 切换**：/model 面板按 provider 分组展示（组头），切换/添加保持现有能力，**不做删除/默认** |

---

## 3. 详细设计

### A. 配置读写（`src/config/write.ts`）

新增四个纯函数（全部沿用现有「纯 JSON 才自动改、JSONC 拒绝」与「合并已有字段」的模式，写入**全局配置** `globalConfigFile()`）：

1. `persistProviderConfigToGlobal(patch: { provider: string; baseURL?: string; apiKey?: string; userAgent?: string }, cfg): PersistModelResult`
   - 合并写 `obj.providers[provider] = { ...旧, baseURL?, apiKey?, userAgent?, models: 旧.models ?? {} }`（provider 名即 key，不改名；`baseURL` 缺失时保留旧值）。
2. `persistProviderModelToGlobal(patch: { provider: string; modelName: string; apiModel?: string; displayName?: string; reasoningEffortOptions?: string[]; reasoningEffort?: string; contextLimit?: number; variants?: unknown; overrideBaseURL?: string; overrideApiKey?: string }, cfg): PersistModelResult`
   - 合并写 `obj.providers[provider].models[modelName]`；`overrideBaseURL/overrideApiKey` 缺省不写（继承）；字段为空串/未定义时不落盘。
3. `removeProviderFromGlobal(provider: string, cfg): PersistModelResult` —— 删除 `providers[provider]`。
4. `removeProviderModelFromGlobal(provider: string, modelName: string, cfg): PersistModelResult` —— 删除 `providers[provider].models[modelName]`（删空后保留空 provider 壳，由 UI 提示或自动清理）。

复用既有 `persistModelDefaultToConfig`（D7「设为默认」写顶层 `model`）、`persistModelConfigToGlobal`（未分组模型编辑）。

**迁移辅助**（D3）：`migrateFlatModelToProvider({ modelName, provider }, cfg)` —— 读全局配置，把 `models[modelName]` 的 baseURL/apiKey 并入 `providers[provider]`，组内模型条目携带该模型其余字段，然后**删除扁平 `models[modelName]`**；仅当扁平条目 baseURL/apiKey 与目标 provider 一致时才执行（防止误迁移）。

### B. 服务端 API（`src/web/server.ts`）

**`buildStatus` 扩展**：新增 `providers` 字段，形态供 UI 直接渲染：

```ts
providers: [{
  name: string;                 // provider 名（未分组显示为虚拟组，见 D3）
  baseURL?: string; apiKey?: string; userAgent?: string;
  models: [{ name; apiModel?; displayName?; reasoningEffortOptions?; reasoningEffort?; limit?; variants?; overrideBaseURL?; overrideApiKey? }];
}]
```

- 数据源：`runOpts.cfg.providers`（原始结构）逐条展开 + **未分组扁平模型**（`runOpts.models` 中 `provider` 为空的）聚合为一个「未分组」组。
- **自动合并展示（D3）**：未分组扁平模型中 baseURL+apiKey 完全相同的一组，UI 层合并为「未分组 → 虚拟 provider 组」展示（服务端只下发数据，合并逻辑放前端，见 C）。
- **apiKey 安全**：沿用现状 `models` 的下发方式（`runOpts.models` 本就含 apiKey，不新增泄漏面；若现状未 mask，保持行为一致，不做本次范围外加固）。

**`POST /api/settings` 扩展**：现有 `modelConfig` 保留；新增动作字段（沿用单路由风格）：

| 动作 | payload | 行为 |
|---|---|---|
| `providerConfig` | `{ provider, baseURL?, apiKey?, userAgent? }` | 新建/更新 provider → `persistProviderConfigToGlobal` + 运行时同步 |
| `providerModel` | `{ provider, modelName, apiModel?, displayName?, reasoningEffortOptions?, reasoningEffort?, contextLimit?, variants?, overrideBaseURL?, overrideApiKey? }` | 新增/更新组内模型 → `persistProviderModelToGlobal` + 运行时同步 |
| `providerRemove` | `{ provider, modelName? }` | `modelName` 缺省删整个 provider，否则删组内模型 |
| `providerMigrate` | `{ modelName, provider }` | 扁平模型迁入 provider（D3 确认后触发） |
| `setDefaultModel` | `{ model }` | 写顶层 `model`（复用 `persistModelDefaultToConfig`）+ 运行时切换 |

**运行时同步**（保存后立即生效，与现有 `modelConfig` 的同步逻辑对齐）：
- 增/改：patch `runOpts.models`（name 匹配则合并，否则 push；`provider` 标记写入）；若保存的是当前模型且 baseURL/apiKey 变化 → `createClient` 重建 `runOpts.modelRuntime`。
- 删：`runOpts.models` 移除对应项；若删的是当前模型 → 回退到剩余首个模型并重建 client（若无 → 保持现状客户端不变，面板提示）。
- 迁移：从 `runOpts.models` 移除扁平项、加入 provider 组项。

### C. Web 面板 UI（`web/index.html` + `web/app.js`）

**布局改版（模型配置 pane，D1）**：
```
├─ 左侧：provider 列表（可折叠）
│    ├─ 未分组（自动合并展示的同端点扁平模型）
│    └─ provider 组（组头 = provider 名 + 端点摘要）
│    └─ [+ 新建 provider]
└─ 右侧编辑区：
     ├─ provider 级：name（新建时）、baseURL、apiKey（密码框）、userAgent（可选）
     └─ 组内模型列表：
          ├─ 每个模型一行：名称(apiModel 次级显示) + [设为默认]* + [删除]
          ├─ 展开编辑：apiModel / displayName / 思考级别选项 / 当前级别 / 上下文长度 /
          │           「继承」默认 + 「覆盖」开关（展开显示 overrideBaseURL/overrideApiKey）
          └─ [+ 添加模型]（输入模型名，可选 apiModel）
```

**关键实现点**：
- `renderSettingsModel`（原 `renderSavedModelList`/`fillModelConfigForm` 重构）：读 `status.providers` 分组渲染；`modelLabel(m)` 复用。
- **自动合并（D3）**：未分组扁平模型按 `baseURL+apiKey` 分组展示；编辑任一合并组内模型时，若检测到其 baseURL/apiKey 与组一致 → 显示「迁移到 provider 组」提示条（按钮 → `providerMigrate` + `providerConfig` 一次完成），迁移后该模型移入 provider 组。
- **「设为默认」（D7）**：按钮 → `setDefaultModel`；当前 `status.model` 高亮。
- **新增/删除（D6/D11）**：新建 provider、组内添加模型名（+ apiModel）、删除按钮（confirm；删除默认模型时 alert 提示先设新默认）。
- i18n：新增键（provider 相关中英：`settings.provider`/`provider.new`/`provider.models`/`model.setDefault`/`model.inherit`/`model.override`/`model.migrate` 等），`settings.apikeySub` 文案更新说明支持 providers。
- 保存后 `refreshStatus()` 刷新（现有模式）。

### D. TUI /model 面板分组（D4 / D12）

- `src/tui/commands.ts` `openModelMenu`：选项构建时按 `runOpts.models[i].provider` 分组——**组头行**（dim、不可选中：`[provider 名]` 或 `未分组`）插入对应位置；`TuiMenu.options` 保持扁平结构、组头用 `{ label, value: '__group__', group: true }` 标记，`menuPanelRows` 对 group 行渲染为 dim 且**不参与选中/滚动计数**（`menuRowMap` 记为 -1，↑/↓ 跳过——与联想/菜单既有窗口滚动机制兼容）。
- `/model <名称>` 切换、`/model add`、面板确认逻辑不变（D12：不做删除/设为默认）。
- `src/tui/state.ts`：`TuiMenu` 的 options 类型加可选 `group?: boolean`。

---

## 4. 兼容与迁移

- 旧配置零破坏：扁平 `models` 照常解析/展示（归入未分组组），`providers` 照常解析（归入各自组）；两组并存。
- 迁移是**用户确认后**的一次性动作（D3），不自动改写旧文件。
- `buildStatus.models` 保留（兼容现有前端其它读取点：composer 模型下拉等），新增 `providers` 字段不影响旧字段。
- 项目级 omni.json 的 providers 照常被加载合并（只读路径不受影响）；面板只写全局（D9）。

---

## 5. 验证计划

1. `npm run typecheck`
2. `npm run tui:snapshot`（45 场景）——若 /model 菜单选项结构变化，更新受影响断言（组头行、窗口滚动、数字键语义）。
3. 新探针（`scripts/probe-tmp/`）：
   - `probe-providers-write.ts`：`persistProviderConfigToGlobal` / `persistProviderModelToGlobal` / remove / `migrateFlatModelToProvider` 纯 JSON 往返（保留无关字段）、JSONC 拒绝、baseURL/apiKey 合并语义；
   - `probe-providers-api.ts`：`POST /api/settings` 各动作 → 全局配置落盘内容 + `runOpts.models` 运行时同步（增/改/删/迁移/默认）+ 当前模型重建 client；
   - `probe-providers-ui.ts`：`buildStatus.providers` 形态（provider 组 + 未分组聚合）。
4. 回归：`npm run eval:mock`、`npm run probe:web`。
5. Web 改动后 `npm run web:sync`（内嵌 assets 同步）。

---

## 6. 范围外 / 决策记录

- **TUI 不做**删除/设为默认/新增 provider（D12），保持展示+切换；完整管理仍走 Web 面板或配置文件。
- **apiKey 回显**：沿用现状（服务端不下发明文 key 的改动不做——现状 `runOpts.models` 已含 apiKey，属既有行为，不在本次范围加固）。
- **rename provider / rename 模型**：不做（删除后重建即可）。
- **providers 的 variants / modalities / capabilities / apiModel 等 1.0 元数据**：UI 只暴露常见项（apiModel/displayName/级别/上下文），其余保留手写配置（不做表单全字段化）。
- 自动合并只影响**展示**；落盘始终是用户明确操作（保存/迁移/删除）。
