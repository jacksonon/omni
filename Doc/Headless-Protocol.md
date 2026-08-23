# Headless 协议冻结（P0-5）

`omni exec` 与 `omni mcp-server` 是 Omni 的**程序化接口**——CI、脚本、外部 harness
把它当可组合 Unix 命令用。为保证下游稳定性，以下协议面 **v1 冻结**：

- **破坏性变更**（删除/改名/改类型/改语义）必须升 minor+ 版本并保留一个弃用窗口；
- **additive 追加**（新字段/新事件）不视为破坏性变更，随时可加（新字段语义默认缺省兼容）；
- 冻结范围以 `schemas/*.v1.json` 为权威。

## 冻结面

| 协议 | Schema | 说明 |
|---|---|---|
| `omni exec --output-format json` | `schemas/exec-result.v1.json` | 单对象 `{ result, cost_usd, duration_ms, num_turns, session_id, exit_code, tokens, idle_turns, error_type }` |
| `omni exec --output-format stream-json` | `schemas/stream-json.v1.json` | 每行 `{"t":"ev",...}`（轨迹事件），末行 `{"t":"result",...}` 同 exec-result |
| 会话 JSONL | `schemas/session-jsonl.v1.json` | `{"t":"meta"}` 首行 + `{"t":"m","m":msg}` 消息行 + `{"t":"ev","e":ev}` 轨迹行；恢复/续写必须按此协议 |
| `omni mcp-server` | `schemas/mcp-server.v1.json` | stdio JSON-RPC（2024-11-05）：`omni_exec` / `omni_reply`；请求串行、isError 透传退出码 |
| Hooks JSON 协议 | `schemas/hook-protocol.v1.json` | stdin 事件上下文 / stdout JSON 决策 |

## 配置 schema

`config.schema.json`（仓库根）是全部配置字段的 JSON Schema（含默认值与说明），
编辑器可自动补全/校验；`omni.example.jsonc` 顶部 `$schema` 引用同一文件。
字段级变更遵循同一冻结规则（废弃字段保留一个周期别名）。
