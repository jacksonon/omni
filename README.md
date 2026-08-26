# Omni

[English](README.md) | [中文](README.zh-CN.md)

**An agent engineering project** — a terminal-based AI coding assistant.

Currently at **Beta (feature-complete)**: single-agent loop + 6 base tools (+ delegate subagents + MCP external tools) + safety guardrails + context management + memory system/session persistence/skills, with zero framework dependencies (bare OpenAI SDK + main loop), plus a full-screen TUI.

## Screenshots

**Terminal TUI** (`omni`, full-screen interactive mode) — thinking modules, tool cards, Markdown tables/code blocks, token stats and the input area:

![Omni TUI](Doc/images/tui.png)

**Web UI** (`omni web`, browser / Electron desktop app) — session sidebar with workspace grouping, live Markdown answers, composer with model & workspace switcher:

![Omni Web](Doc/images/web.png)

## Features

- **Agent main loop**: streams LLM calls → executes tool calls (in parallel) → feeds results back, with self-correction (tool failure messages are returned to the model so it can fix its own mistakes)
- **8 tools (6 base + 2 injected)**: base `read_file` / `write_file` / `list_directory` / `search_code` (ripgrep-first) / `run_command` (dangerous-command interception) / `skill` (on-demand SKILL.md loading) + runtime-injected `delegate` (subagent) + `mcp_*` (MCP external tools); plus context tools `memory_search` / `memory_read` (progressive memory disclosure) · `todo_write` (task list) · `web_fetch` (URL→text) · `diagnose` (typecheck/lint feedback)
- **Safety guardrails**: permission tiers (full / safe / ask / read) + dangerous-command confirmation (built-in + configurable `dangerousPatterns`) + approval UI + audit log
- **Workspace trust**: first entry into an untrusted directory prompts for trust (TUI card / console); untrusted = read-only (`/permission` locked) + skips project-level hooks/skills/subagent defs/project memory (blocks repo-injected malicious config); trust list persisted in `~/.config/omni/trusted-workspaces.json`
- **OS-level sandbox**: `sandbox` config (`read-only` / `workspace-write` / `danger-full-access`) wraps `run_command` with macOS `sandbox-exec` or Linux `bwrap` (deny writes/network; workspace-write allows only cwd), degrading gracefully when unavailable
- **Context management**: tool-result truncation, relevant-file preloading, long-conversation summarization
- **Thinking display**: streamed live (kept on screen in dim color), full reasoning saved to `.omni/last-thinking.md`
- **Full-screen TUI**: scrollable content area, multi-line input box for interactive multi-turn conversations, line-based Markdown rendering (tables/lists/code blocks), click-to-expand tool cards, **`@` file mention in the input box** (directory drilling, Tab/Enter/click to insert), 26 `/` commands (theme/permission/plan/thinking collapse/undo/redo/model switch/reasoning level/skills/memory generation/subagent/MCP/compact/export/status/context/resume/rename/review/diff/doctor/config etc.) — both `/` command suggestions and `@` mentions are **rounded-corner overlay panels** (hovering above the input box, non-modal, you can keep typing)
- **Skills (Agent Skill)**: auto-discovers `SKILL.md` in `.opencode/skills`, `.claude/skills`, `.agents/skills` (project-upward + global), injects a skill manifest on the first turn (progressive disclosure: first 15 listed + "N more"), and the model loads full content on demand via the `skill` tool; frontmatter extensions (`disable-model-invocation` / `user-invocable` / `context: fork` subagent execution / `agent` / `background`); `/skill` lists (with tags) / `find <term>` searches skills.sh online / `add` installs (immediate effect in current session) / `show <name>`
- **Memory system (AGENTS.md)**: project memory + global memory (`~/.config/omni/AGENTS.md`) loaded in cascade (auto-injected on the first turn of every session, truncated when too long), `/init` for project / `/init --global` for global / `/init <subdir>` for nested-layer one-shot generation, session-end auto-extraction of new preferences into global memory (dedup/conflict merge + TTL archive); progressive disclosure tools (`memory_search` / `memory_read`); `AGENTS.override.md`/`TEAM_GUIDE.md` fallback + 32KB total budget; project-level auto-write produces a pending snippet (`.omni/memory-pending.md`) applied via `/memory-apply`
- **Session persistence**: interactive conversations saved as JSONL (`~/.config/omni/sessions/`), restored across processes with `--continue` / `-r <id>` / `-l` / `/resume`, session titles (terminal window title + meta on disk); `/fork` forks a new session from a point in history (original kept), `/send <session> <msg>` sends a message to another session and injects the reply into the current context
- **Hooks (lifecycle automation)**: attach shell commands to lifecycle events — rewrite user prompts (`UserPromptSubmit`), hard-block tool calls (`PreToolUse`), feed post-tool output back to the model such as lint results (`PostToolUse`), require the agent to keep working before it stops (`Stop`), session-complete notifications (`Notification`), plus `SessionStart` context injection, subagent hooks (`SubagentStart`/`SubagentStop` + Pre/Post around subagent tool calls) and `PreCompact`; JSON protocol over stdin/stdout, wildcard tool-name matchers, config layers merged (global + project), stderr captured, timeout/failure degrade to pass-through
- **MCP enhancements**: Resources (list + `read_resource` tool) and Prompts (list + `get_prompt` tool) protocols, server `instructions` injected into the system prompt, per-tool approval mode (`defaultToolsApprovalMode`: auto/prompt/writes/approve) + tool whitelist/blacklist, runtime `add`/`remove`/`login` (OAuth PKCE), streamable HTTP transport alongside stdio
- **Swappable backends**: `OMNI_BASE_URL` is compatible with any OpenAI-protocol service (OpenAI / DeepSeek / Zhipu / Moonshot / Grok etc.)
- **1.0 model layer (P0-3)**: `providers` groups (one baseURL, many models) · per-model metadata (`limit` context/output · `modalities` input/output types · `capabilities` tools/reasoning/temperature) · named `variants` request overlays (deep-merge body/headers/effort) · cross-endpoint architect/editor routing · `{env:VAR}` key references (no keys in config files) · `max_tokens ≤ limit.output` · multimodal pre-check · `/model fetch` gateway model discovery
- **Sandbox 2.0 (P0-4)**: network allowlist via a built-in filtering proxy (CONNECT by hostname, TLS untouched; Seatbelt tightened to only the proxy port) · `sandboxFailClosed` (deny-run when no sandbox primitive) · credential masking in sandboxed commands · policy-file write guard
- **Multi-session concurrency (P0-2)**: the web backend runs several sessions at once — per-session runOpts clones (prototype chain over the shared runtime), independent undo stacks / events / abort signals, a global concurrency cap + per-session single-run (long tasks simply run in their own session)
- **Subagent worktree isolation (P0-6)**: `delegate` gains `worktree` (auto `git worktree add` on a temp branch; tools run inside it via a threaded `ToolContext.cwd`; result reports changed files + merge instructions, `cleanup` optional)
- **Hooks extended (P1-1)**: `PermissionRequest` (approve/deny before the approval UI) · `PostCompact` · `PostToolUseFailure` (diagnostics fed back for self-fixing) · `http` handler type (POST event JSON) alongside `command`
- **Structured memory (P1-2)**: global memory upgraded to `MEMORY.md` index + `topics/*.md` (progressive disclosure), Amp-style `globs` conditional injection, topic TTL archival — legacy `AGENTS.md` still loaded read-only
- **Compaction 2.0 (P1-4)**: trigger by context-window ratio (model `limit.context`) instead of message count alone + tool-result folding (clear_tool_uses equivalent)
- **MCP + presets + spec (P1-5/6/7/9)**: tool `annotations.readOnlyHint` consumed (read-only pass-through) · `/mcp install <id>` registry one-click · `omni preset browser` (Playwright MCP + Chrome DevTools MCP into global config) · `/spec <feature>` spec trio (requirements-EARS / design / tasks under `.omni/specs/`, tasks synced to the session todo list) · `skill validate`
- **Headless protocol freeze (P0-5)**: JSON Schemas under `schemas/` (`exec-result` / `stream-json` / `session-jsonl` / `mcp-server` / `hook-protocol`) + `config.schema.json` + `omni-action` GitHub Action + `Doc/Headless-Protocol.md`; exec result extended with `tokens` / `idle_turns` / `error_type` (cost-efficiency reporting, P1-10)
- **Telemetry (P1-11)**: opt-in OTLP/HTTP JSON exporter (zero deps), prompt content redacted by default, fire-and-forget — config `telemetry`
- **LSP feedback loop (P1-3)**: `diagnoseAfterEdit` runs a quick typecheck/lint after `write_file` and appends diagnostics so the model self-fixes
- **Web mode (`omni web`)**: local backend service (REST + SSE, zero new dependencies) + browser UI — multi-session sidebar, live thinking/tool/answer streaming, approval & ask_user cards, model/permission/reasoning settings, cancel, per-turn token stats; works in both browser and the Electron desktop app
- **Electron desktop app** (macOS / Windows / Linux): a standalone app bundling the web backend via Electron's own Node runtime (no system Node needed); built automatically by GitHub Actions on tag push (mac arm64/x64 zip, win x64 exe, linux x64 AppImage) and attached to the GitHub Release
- **Layered config**: defaults → global config → project config → custom config → env vars → CLI args (JSONC with comments)
- **Build artifacts**: single-file JS bundle (`dist/omni.cjs`, console) · native binary (`release/omni`, TUI) · console npm package (`omni-<version>.tgz`) · TUI npm package (`omni-tui-<version>.tgz`, requires bun) · web assets embedded (`npm run web:sync` → `src/web/assets.ts`) · **Electron desktop apps** (`npm run electron:build` → `release-electron/`); GitHub Actions builds and publishes automatically on tag push

## Quick Start

### Option 0: curl one-liner (native binary, zero deps, includes full TUI)

```bash
curl -fsSL https://raw.githubusercontent.com/omni/omni/main/scripts/install.sh | sh
omni "show me the structure of this directory"   # full-screen TUI on a real TTY
```

### Option 1: npm global install (console, requires Node ≥ 18)

```bash
npm install -g omni-0.4.0.tgz   # or after publish: npm install -g omni
omni "show me the structure of this directory"
```

### Option 2: TUI npm package install (requires bun ≥ 1.3)

The official `omni` npm package runs on Node and cannot include the TUI (OpenTUI depends on bun's native FFI). The full-screen TUI ships as a separate package `omni-tui` (same `omni` bin; native libs are externalized at bundle time and auto-installed per-platform via `optionalDependencies` on the matching `@opentui/core-*` variant):

```bash
npm install -g ./omni-tui-0.4.0.tgz
omni "show me the structure of this directory"  # enters full-screen TUI automatically on a real TTY (single task)
omni                                            # interactive multi-turn conversation
```

> ⚠️ `omni-tui` and `omni` share the same bin name — run `npm uninstall -g omni` first.

### Option 3: development run (requires Node ≥ 18)

```bash
npm install
npm run dev -- "list the files in the current directory"
```

### Option 4: TUI development run (requires bun)

```bash
npm run dev:tui -- "task description"  # single task
npm run dev:tui                        # interactive multi-turn conversation
```

### Option 5: Electron desktop app (macOS / Windows / Linux, no Node needed)

`omni` is a standalone desktop app that bundles the web backend (Electron's own Node runtime) — download the artifact for your platform from the **GitHub Releases** page (every `v*` tag builds them automatically):

| Platform | Artifact |
|---|---|
| macOS (Apple Silicon) | `omni-<version>-mac-arm64.zip` — unzip, drag `omni.app` into Applications |
| macOS (Intel) | `omni-<version>-mac-x64.zip` — unzip, drag `omni.app` into Applications |
| Windows | `omni-<version>-win-x64.exe` — run the installer |
| Linux | `omni-<version>-linux-x64.AppImage` — `chmod +x` and run |

> **macOS (first launch)**: the app is signed with an ad-hoc signature but not Apple-notarized, so
> Gatekeeper may show *"omni is damaged and cannot be opened"* when you first open a downloaded copy.
> This is expected for unsigned apps — clear the download quarantine flag once and it runs normally:
> `xattr -cr "/Applications/omni.app"` (or right-click → Open → Open).

The app launches the local backend service and opens the web UI in its own window; the 菜单「文件 → 选择工作目录…」sets the workspace where the agent reads/writes files. Configure the model/API key in the app's ⚙ Settings (they persist for the current run; use `omni.json`/env vars for permanent config).

### Configure the API Key

```bash
export OMNI_API_KEY=sk-xxx
export OMNI_BASE_URL=https://api.deepseek.com/v1   # optional, defaults to OpenAI
export OMNI_MODEL=deepseek-chat                     # optional
```

Or copy `omni.example.jsonc` to `omni.json` and edit as needed (⚠️ the project config is gitignored to keep API keys out of the repo).

## Configuration

Supports JSON / JSONC (with comments). Precedence (low → high):

```
defaults → global config → project config → custom config → env vars → CLI args
```

| Layer | Location | Description |
|---|---|---|
| Global config | `~/.config/omni/omni.json` | Per-user defaults (respects `XDG_CONFIG_HOME`) |
| Project config | `omni.json` / `omni.jsonc` | Searched upward from the current directory; nearest wins |
| Custom config | `OMNI_CONFIG` or `--config <path>` | Explicitly specified |
| Env vars | `OMNI_API_KEY` / `OMNI_BASE_URL` / `OMNI_MODEL` / `OMNI_MAX_STEPS` / `OMNI_SHOW_THINKING` / `OMNI_PERMISSION` / `OMNI_DEBUG` | Override config files |
| CLI args | `-m, --model <name>` | Highest precedence |

> **Windows paths**: `~` above means `%USERPROFILE%`, so the global config actually lives at `C:\Users\<you>\.config\omni\omni.json` — the conventional `%APPDATA%` is **not** used; if the `XDG_CONFIG_HOME` env var is set it becomes `%XDG_CONFIG_HOME%\omni\omni.json`. Sessions, memory, audit log and other global data live under the same `.config\omni\` directory.

Useful env vars: `OMNI_DEBUG=1` prints the full request body sent to the LLM; `OMNI_SHOW_THINKING=0` hides thinking from the terminal (still saved to disk).

Config fields (see `omni.example.jsonc` for a full example):

```jsonc
{
  "model": "deepseek-chat",              // model name (default gpt-4o-mini); endpoints/keys live only in `providers` below
  "maxSteps": 50,                        // max agent loop steps (dead-loop guard)
  "showThinking": true,                  // show thinking (still saved to disk)
  "permission": "safe",                  // safety tier: full / safe (default) / ask / read
  "dangerousPatterns": [],               // extra dangerous-command regexes (optional; prompt on match in safe+ tiers)
  "sandbox": "off",                      // OS-level sandbox: off (default) / read-only / workspace-write / danger-full-access
  "sandboxNetworkAllow": ["api.openai.com"],  // sandbox network allowlist (hostnames; via built-in filtering proxy, TLS untouched)
  "sandboxFailClosed": false,                // true = refuse to run when no sandbox primitive exists (fail-closed, enterprise)
  "sandboxWritePaths": [],                   // extra writable paths for workspace-write (absolute)
  "providers": {                              // 1.0: one gateway, many models — the only endpoint format (legacy flat `models` removed)
    "bigmodel": { "baseURL": "https://open.bigmodel.cn/api/paas/v4", "apiKey": "{env:GLM_KEY}",
      "models": { "glm-4-flash": { "limit": { "context": 128000, "output": 8192 },
                   "variants": { "fast": { "reasoningEffort": "low" },
                                 "deep": { "reasoningEffort": "high", "body": { "temperature": 0.2 } } },
                   "variant": "deep", "apiModel": "glm-4.7-flash" } } }
  },
  "diagnoseAfterEdit": false,                // run quick typecheck/lint after write_file, feed diagnostics back
  "telemetry": { "enabled": false, "endpoint": "http://localhost:4318" }, // opt-in OTLP/HTTP JSON (redacted by default)
  "compatibility": { "reasoningField": "custom_thinking" }, // custom gateway reasoning field name (P2 capability-driven requests)
  "repoMap": true,                       // codebase structure map (symbol map in first turn)
  "repoMapMaxSymbols": 200,              // repo map symbol cap
  "webFetchDomains": [],                 // web_fetch allowed domains (empty = all)
  "auditLog": true,                      // write audit log (default true)
  "agentsFile": true,                    // project memory AGENTS.md: auto-loaded on the first turn (default true)
  "globalAgentsFile": true,              // global memory ~/.config/omni/AGENTS.md: cross-project prefs, cascaded before project memory
  "autoMemory": true,                    // append newly expressed preferences to global memory at session end
  "summarizeAt": 40,                     // long-conversation summarization threshold (0 = off)
  "preloadFiles": true,                  // preload files relevant to the task (default true)
  "allowSubagents": true,                // enable subagents (default true)
  "maxSubagentSteps": 10,                // max subagent loop steps (default 10)
  "skills": true,                        // skill (SKILL.md) discovery and the skill tool (default true)
  "reasoningEffort": "medium",            // current reasoning level (reasoning_effort; unset = not sent, model default)
  "reasoningEffortOptions": ["low", "medium", "high"], // options supported by /variants (customizable)
  "architect": "gpt-5",                  // model routing: /plan uses a strong model (falls back to current)
  "editor": "gpt-5-mini",                // model routing: execution uses a light model (falls back to current)
  // multi-model endpoints (/model switch/add) use `providers` groups only — per-model reasoning
  // level (reasoningEffortOptions/reasoningEffort) + named variants (variants table + variant field +
  // apiModel alias) live under providers.<group>.models.<model>; /model add persists at runtime (single-model group)
  "mcpServers": {                        // MCP external tools: { name: { command, args?, env? } | { url, headers? }; enabledTools?/disabledTools?; defaultToolsApprovalMode? = auto|prompt|writes|approve }
    "demo": { "command": "node", "args": ["scripts/mock-mcp.mjs"] }
  },
  "hooks": {                              // lifecycle automation (optional, Claude Code style): { event: [{ matcher?, command, timeoutMs? }] }
    "PostToolUse": [{ "matcher": "write_file", "command": "sh scripts/lint-hook.sh" }]
  }
}
```

See [Hooks (Lifecycle Automation)](#hooks-lifecycle-automation) for the full protocol and use cases.

## Hooks (Lifecycle Automation)

Hooks attach shell commands to lifecycle events (modeled on Claude Code hooks). A hook receives a JSON context on **stdin** and returns a JSON decision on **stdout** — it can rewrite the prompt, hard-block a tool call, feed extra context back to the model (e.g. lint results), require the agent to keep working before it stops, or send a notification.

### Config

```jsonc
"hooks": {
  "UserPromptSubmit": [{ "command": "node scripts/rewrite-prompt.mjs" }],
  "PreToolUse": [
    { "matcher": "write_file", "command": "sh scripts/guard-env.sh", "timeoutMs": 10000 }
  ],
  "PostToolUse": [
    { "matcher": "write_file", "command": "sh scripts/lint-hook.sh", "timeoutMs": 30000 }
  ],
  "Stop": [{ "command": "node scripts/require-tests.mjs" }],
  "Notification": [{ "command": "sh scripts/notify.sh" }]
}
```

Each hook entry:

| Field | Description |
|---|---|
| `command` | Shell command to run (required) — e.g. `sh lint.sh` / `node guard.mjs` / `python check.py` |
| `matcher` | Tool-name filter for PreToolUse / PostToolUse: `*` = all (default), `read_*` / `*_file` wildcards; hooks for other events ignore it |
| `timeoutMs` | Timeout in ms (default `60000`); on timeout the hook is killed and the event **degrades to pass-through** |

Fail-open behavior: unknown event names, empty commands, failed spawns, non-JSON output and non-zero exit codes are all ignored — a broken hook never blocks the agent (the failure reason is echoed to the terminal).

**Config layering**: the `hooks` field is merged across config layers (global `~/.config/omni/omni.json` → project `omni.json` → custom) instead of replaced — hooks accumulate, with later layers taking precedence for the same `matcher`. Hook `stderr` is captured and echoed alongside stdout output (prefix `⚡ hook[<Event>] …`).

### Events & JSON protocol

The event context is written to the hook's stdin: `{ "cwd", "hook_event_name", "source", "session_id", "tool_name", "tool_input", "tool_response", "prompt", "stop_hook_active" }` (fields present depend on the event). The hook prints one JSON object on stdout:

| Event | When | Relevant output JSON fields |
|---|---|---|
| `UserPromptSubmit` | after the user submits a prompt | `updatedPrompt` (replaces the prompt) · `hookSpecificOutput` |
| `PreToolUse` | before a tool call (after arg parsing, before the safety gate) | `decision: "approve" \| "block"` + `reason` (**hard-block**) · `updatedInput` (merged into the tool args) · `hookSpecificOutput` |
| `PostToolUse` | after a tool call | `hookSpecificOutput` (string array appended to the tool result, e.g. lint output the model can act on) |
| `Stop` | the agent is about to finish | `decision: "continue" \| "block"` + `reason` (block → the agent is told to keep working; `stop_hook_active` becomes true and only **one** continuation is allowed, preventing infinite loops) |
| `Notification` | session complete (fire-and-forget, never awaited) | `hookSpecificOutput` |
| `SessionStart` | once, before the first turn | `sessionStartOutput` (string array appended to the first system prompt as context) · `hookSpecificOutput` |
| `SubagentStart` | a `delegate` subagent spawns | `hookSpecificOutput` |
| `SubagentStop` | a `delegate` subagent finishes | `hookSpecificOutput` |
| `PreCompact` | before long-conversation summarization | `decision: "continue" \| "block"` (block → skip compaction this time) · `hookSpecificOutput` |

Hook output is echoed to the terminal (`⚡ hook[<Event>] …`; TUI shows dim lines in the conversation flow, capped at 5 lines to avoid spam) — the full `hookSpecificOutput` is still passed to the model.

### Use cases

1. **Auto-lint after edits (PostToolUse)** — run the linter on the file just written and feed the result back so the model fixes its own mistakes:
   ```jsonc
   "hooks": { "PostToolUse": [{ "matcher": "write_file", "command": "node examples/hooks/lint-hook.mjs" }] }
   ```
   `examples/hooks/lint-hook.mjs`: reads the event JSON from stdin (`.tool_input.path`), runs ESLint on the written file, and prints `{"hookSpecificOutput": ["lint output…"]}` — the output is appended to the tool result as `[hook 输出]`, the model sees it and fixes the issues.
2. **Guard sensitive writes (PreToolUse)** — hard-block writes to `.env` / secrets no matter what the model wants:
   ```jsonc
   "hooks": { "PreToolUse": [{ "matcher": "write_file", "command": "node examples/hooks/guard-env.mjs" }] }
   ```
   `examples/hooks/guard-env.mjs` inspects `.tool_input.path`; if it matches `.env*` / secrets / certs, it prints `{"decision": "block", "reason": "…"}` — the call is intercepted **before the safety gate** and never executes (no side effects), and the reason is returned to the model as `已拦截（hook）`.
3. **Require tests to pass before stopping (Stop)** — block the agent from finishing while the suite is red:
   ```jsonc
   "hooks": { "Stop": [{ "command": "node examples/hooks/require-tests.mjs" }] }
   ```
   `examples/hooks/require-tests.mjs` runs `npm test`; on failure it prints `{"decision": "block", "reason": "tests failing: …"}` — the agent is told to continue fixing (once; `stop_hook_active` prevents an infinite loop). Adjust the test command to your project.
4. **Rewrite the prompt (UserPromptSubmit)** — inject project policy or extra context into every user message:
   ```jsonc
   "hooks": { "UserPromptSubmit": [{ "command": "node examples/hooks/rewrite-prompt.mjs" }] }
   ```
   `examples/hooks/rewrite-prompt.mjs` prints `{"updatedPrompt": "<original> + policy"}` — the rewritten prompt is what the model actually sees (the UI still echoes what you typed).
5. **Session-complete notification (Notification)** — notify on every finished session (fire-and-forget, never blocks the flow).
6. **Guard dangerous commands (PreToolUse enforcement)** — hard-block `rm -rf /`, disk-wiping and other destructive patterns regardless of model intent:
   ```jsonc
   "hooks": { "PreToolUse": [{ "matcher": "run_command", "command": "node examples/hooks/guard-dangerous.mjs" }] }
   ```
   `examples/hooks/guard-dangerous.mjs` scans `.tool_input.command` against a destructive-pattern list; on a hit it prints `{"decision": "block", "reason": "…"}` — the call never executes (mirrors the built-in `safe` tier but is enforceable by rule, not model discretion).
7. **Block `git push` (PreToolUse enforcement)** — stop the agent from pushing to a remote:
   ```jsonc
   "hooks": { "PreToolUse": [{ "matcher": "run_command", "command": "node examples/hooks/guard-git-push.mjs" }] }
   ```
   `examples/hooks/guard-git-push.mjs` blocks any `git push …` invocation with a reminder to let the user push manually.

> Runnable examples live in `examples/hooks/` (guard-env / guard-dangerous / guard-git-push / lint-hook / require-tests / rewrite-prompt) — see `examples/hooks/README.md` for the full catalog. A mock hook (`scripts/mock-hook.mjs`, modes `pass/block/updated/output/rewrite/notify/fail/slow`) is included for testing — see `scripts/probe-tmp/probe-hooks.ts` for unit + end-to-end coverage.

## Headless Mode (`exec` / `mcp-server`)

Turns omni into a composable Unix command (modeled on `codex exec` / `claude -p`): run it non-interactively in scripts, pipes and CI.

```bash
omni exec "fix the failing test in src/foo.test.ts"          # stdout = final answer only
omni exec "summarize" --output-format json                   # single JSON object → | jq
omni exec "analyze this diff" --output-schema '{"type":"object","properties":{"verdict":{"type":"string"}},"required":["verdict"]}'
cat test-output.txt | omni exec "fix the failures below"     # stdin injected as context
omni exec resume <session_id> "continue from where you left off"
```

Key semantics:

| Aspect | Behavior |
|---|---|
| **stdout purity** | stdout carries only the final result; progress (thinking / tool steps / errors) goes to **stderr** — safe to `\| jq` / `> file` |
| **`--output-format`** | `text` (default, plain final answer) · `json` (one object `{ result, cost_usd, duration_ms, num_turns, session_id, exit_code }`) · `stream-json` (one JSON line per trace event `{"t":"ev",…}`, last line `{"t":"result",…}` — `tail -1` yields the structured result) |
| **stdin forms** | task `-` = the whole stdin is the prompt; task given + piped stdin = injected as `[stdin 输入]` context |
| **`--max-turns N`** | step cap (exceeding → non-zero exit; branch with `&&` / `\|\|` in pipelines) |
| **`--allowed-tools`** | comma-separated tool whitelist (pure tool filtering, same semantics as `/plan` read-only filtering) |
| **`--output-schema`** | final answer must validate against a JSON Schema subset (inline JSON or file path; mismatch → non-zero exit + error paths on stderr) |
| **exit code** | `0` = completed · `1` = request failed / hit the step cap / schema validation failed |
| **sessions** | every run persists a JSONL session (json output carries `session_id`); `exec resume <id>` continues it |

### `omni mcp-server`

Runs omni as an **MCP server** over stdio JSON-RPC, exposing `omni_exec` (new session) and `omni_reply` (continue a session by `session_id`) — an external harness (Claude Code / opencode …) can use omni as a sub-agent. Protocol is symmetric with the built-in `tools/mcp.ts` client:

```bash
omni mcp-server     # stdio JSON-RPC: initialize / tools/list / tools/call
```

### Web Mode (`omni web`)

Runs omni as a **local backend service** (REST + SSE, zero extra dependencies) and serves a browser UI — modeled on `dsh web` / `opencode serve`: the same agent stack is now reachable from both the CLI (`omni` / `omni exec`) and the web page.

```bash
omni web                     # start service + Web UI at http://127.0.0.1:3080 (opens browser)
omni web --port 4000         # custom port
omni web --no-open           # don't open the browser automatically
```

Web features (reusing the existing agent stack: props/memory, sessions, safety, tools, subagents, hooks):

| Feature | Behavior |
|---|---|
| **sessions** | left sidebar lists persisted sessions (shared with CLI `omni -c` / `/resume` JSONL files); new session / switch / delete |
| **live streaming** | thinking (collapsible blocks) / tool calls (amber cards with command & expandable output) / final markdown answer all stream over SSE in real time |
| **approvals** | when a tool needs approval under the current permission tier, a card appears above the composer with **允许/拒绝** buttons — the agent pauses until you decide |
| **ask_user** | when the agent asks a question, a card shows options (multi-selectable) with a custom-input row and a confirm button |
| **settings** | model switching (including per-model endpoints), permission tier, reasoning effort (`/variants`), plan mode toggle — all applied live without restarting |
| **cancel** | stop the running turn with the cancel button (no click-through screens) |
| **stats** | per-turn token usage and a run summary line after every turn |

Implementation notes: one running agent at a time (safe global run lock over shared `runOpts`/gate/undo-stack); static pages are served from the `web/` directory in dev (hot reload) and embedded in the bundle for `npm i -g` / compiled builds (`npm run web:sync` regenerates `src/web/assets.ts`). `npm run probe:web` runs an offline end-to-end test of the full protocol against the mock API.

### Local run & test (Web / Electron)

**Web — run & test locally** (no real API key needed for the protocol tests, only for the actual agent work):

```bash
npm run dev:web            # dev server: tsx src/index.ts web --no-open (default http://127.0.0.1:3080)
npm run probe:web          # offline e2e probe (mock API): sessions / streaming / approvals / ask_user / cancel / model switch / session delete
npm run web:sync           # regenerate src/web/assets.ts from web/ (needed after editing the UI, before bundling)
```

**Electron desktop app — run & test locally:**

```bash
npm run build              # produces dist/omni.cjs (the packaged app runs this as its backend via Electron's bundled Node)
npm run electron:dev       # launch the desktop window against the backend (dev mode, tsx source)
npm run electron:build     # package with electron-builder → release-electron/ (current platform only)
# targeting other platforms in CI: see .github/workflows/release.yml (mac arm64+x64 zip / win x64 exe / linux x64 AppImage)
```

> npm installs `electron` + `electron-builder` as devDependencies. For networks that cannot reach
> GitHub downloads, the repo ships an `.npmrc` pointing Electron binaries at the npmmirror mirror
> (`electron_mirror` / `electron_builder_binaries_mirror`); the CI workflow sets the same env vars.

**Standard regression suite** (run before pushing a release):

```bash
npm run typecheck && npm run build   # types + console bundle (includes web assets)
npm run probe:web                    # web protocol e2e (offline)
npm run eval:mock                    # core agent-loop evaluation (offline, deterministic)
npm run tui:snapshot                 # TUI rendering snapshots (bun renderer)
```

### CI integration

`examples/ci/omni-fix-ci.yml` — an "agent fixes the CI failure" workflow modeled on anthropics/claude-code-action: a **read-only job** (only `OMNI_API_KEY` exposed) reproduces the failure, pipes the output into `omni exec "修复…"`, uploads the resulting `git diff` as an artifact; a **separate job with write permissions** applies the patch, pushes a branch and opens a PR — keys never enter the job that generates the patch. See `examples/ci/README.md` for the security boundary, usage steps and variants.

## Usage Guide (使用指导)

> Full user manual (installation, configuration, Headless/CI, MCP, Hooks, skills, FAQ):
> [`Doc/Usage-Guide.md`](Doc/Usage-Guide.md) (English) · [`Doc/使用指导.md`](Doc/使用指导.md) (中文).
> This section is a condensed quick reference.

### TUI quick reference (full-screen interactive mode)

| Action | Effect |
|---|---|
| **Enter** | send message |
| **Shift+Enter** | newline (kitty-protocol terminals) |
| **Cmd/Ctrl+Enter** | steer: interrupt the current turn and insert the new message into that round |
| **Esc** | cancel the running turn (when no overlay is open) |
| Submit while running | ordinary messages go to the "⏳ pending" list and send when the turn ends; steer messages jump the queue |
| `/` + type | command-suggestion overlay above the input (↑/↓ move, Tab fill, Enter run, Esc close, click to fill) |
| `@` + type | file/directory mention overlay (Tab/Enter insert, directories drill down with `@path/`) |
| Click a tool card | expand/collapse full output & diff (collapsed by default, shows just the command) |
| Click a thinking row | collapse/expand that thinking module; `/thinking` hides all thinking entirely (off = nothing streams) |
| Click the token summary | expand per-LLM-request details (`⚡ 输入 X · 输出 Y · 缓存 Z`) |
| Mouse wheel / PgUp/PgDn / ↑↓ / Home / End | scroll content (End = back to latest) |
| `/settings theme` · `/settings language` | light/dark/system theme · 中文/English UI (persisted) |

### Command reference (all `/` commands, TUI + console interactive)

| Command | Effect |
|---|---|
| `/permission` | switch permission tier at runtime (low=read / medium=safe / high=ask / full=pass-through) |
| `/plan` | plan mode: read-only tools, research only, output an implementation plan for approval |
| `/thinking` | show/hide thinking entirely (off = no thinking blocks stream at all, reasoning still saved to disk) |
| `/model` | switch models; `/model <name>`; `/model add <name> [--base-url] [--api-key]` (adds + persists) |
| `/variants` | switch the model's reasoning level (low/medium/high, persisted) |
| `/settings` | settings submenu: status line / language / theme / token stats / environment diagnostics |
| `/undo` · `/redo` | undo the latest file edit (`/undo all` for everything) · redo the last undo |
| `/init` | scan the project and generate AGENTS.md (`/init --global` for global memory; never overwrites) |
| `/skill` | skill management: list (with tags) / `find <word>` online search / `add <repo> [--global]` install (immediate in current session) / `show <name>` |
| `/compact` | manually compress context (old messages → summary, last 8 kept verbatim) |
| `/agents` | view subagent config + discovered subagent definitions (`.agents/subagents/*.md`) |
| `/orchestrate` | orchestration: fan-out parallel delegates → merge → adversarial review → final report |
| `/goal` (alias `/loop`) | goal mechanism: derive acceptance criteria and loop a task until they are met (with iteration log and verdict feedback) |
| `/review` | code review: typecheck + git diff → LLM review |
| `/status` · `/context` | session status summary · context usage with compression advice |
| `/session` | list current-directory history sessions and continue (`/session <id>`, prefix match; `all` = cross-directory) |
| `/resume` · `/rename` · `/fork` · `/send` · `/memory-apply` | restore a past session · rename the session (window title + persisted meta) · fork a new session from history · send a message to another session and get the result · apply pending project memory |
| `/export` | export the session as Markdown (`.omni/export-<timestamp>.md`) |
| `/trace` | trace panel (right sidebar): per-turn LLM request / tool / message ledger, click for detail page |
| `/diff` · `/config` | uncommitted changes · config paths & sources |
| `/mcp` | MCP management: list servers/tools/resources/prompts, `/mcp reconnect` after config edits, `/mcp add <name> <command|--url>` add at runtime, `/mcp remove <name>`, `/mcp login <name>` OAuth for HTTP servers, `/mcp install <id>` registry one-click |
| `/model fetch` | pull `GET {baseURL}/models` and list models not yet in the local table (Ollama/LM Studio/vLLM/any OpenAI-compatible gateway) |
| `/spec <feature>` | spec trio: `requirements.md` (EARS acceptance clauses) / `design.md` / `tasks.md` under `.omni/specs/<slug>/`, tasks synced to the session todo list |
| `/preset browser` | install the browser automation pair (Playwright MCP + Chrome DevTools MCP) into the global config — no custom browser stack |
| `/doctor` (console) / `/settings doctor` (TUI) | environment diagnostics: Node/bun versions, API key, endpoint connectivity, config/MCP/permission/models |
| `/clear` · `/exit` (alias `/quit`) · `/help` | clear view · quit (autoMemory + session finalize) · help |

### Safety & permissions

| Tier | Behavior |
|---|---|
| `full` | any command passes through (including dangerous), no prompting |
| `safe` (default) | dangerous commands (rm -rf /, mkfs, dd, fork bombs, git push …) prompt the user first |
| `ask` | every command prompts |
| `read` | read-only: no file writes / command execution |

Approval: console shows `⚠ 需要确认 [y/n]`; TUI shows an approval card (`y`/Enter approve, `n`/Esc
reject, or click); piped/non-interactive auto-rejects. Every tool call is audited to
`~/.config/omni/audit.log` (`auditLog: true`).

### Memory & sessions

- **Memory**: project `AGENTS.md` (nested: all levels from cwd up to git root/home boundary, each directory
  layer has its own system message; inner layers closer to cwd override outer layers) + global
  `~/.config/omni/AGENTS.md` cascade into the first turn automatically; `/init` generates them;
  `autoMemory` appends newly expressed preferences on interactive exit (dedup + conflict merge).
- **Sessions**: interactive conversations persist as JSONL under `~/.config/omni/sessions/`;
  `omni -l` lists, `omni -c` resumes the latest of the current project, `omni -s <id>`
  resumes a specific session (`-r` synonym); exiting the TUI (/exit or Ctrl+C) prints the
  restore command
  resumes a specific session; in-session `/session` / `/resume` / `/export` / `/trace` / `/compact`.

### FAQ (condensed)

- **No API key?** Set `OMNI_API_KEY` (or `apiKey` in config; `models.<name>.apiKey` for multi-endpoint).
- **Gateway 403/timeout?** Many gateways block the SDK default UA — set `"userAgent"` to a browser UA.
- **TUI won't start / clicks dead?** Needs a **real TTY** (pipes/`script` fall back to console or
  disable mouse mode) and a TUI build (`npm run dev:tui` / TUI npm package / native binary).
- **See what the model receives?** `OMNI_DEBUG=1 omni "task"` prints the full request body to stderr.
- **Conversation too long?** Auto-summarization is on (`summarizeAt: 40`); `/compact` manually,
  `/context` shows usage.
- **Config not applied?** Check precedence (env vars > config files > CLI args); `/config` shows sources.
- **No key, want a local try?** `npm run mock` (port 8787) + `OMNI_BASE_URL=http://127.0.0.1:8787/v1 OMNI_API_KEY=sk-mock`.

## Architecture

```
src/
  index.ts              # CLI entry: args → config → client → single-shot/interactive
  main.ts               # attachRuntime: Safety gate + MCP tool discovery + delegate injection + context preparation
  client.ts             # OpenAI client factory: created per "model endpoint" (/model rebuilds on endpoint switch) + shared ModelRuntime
  exec.ts               # **Headless exec (`omni exec`) + MCP server (`omni mcp-server`)**: stdout result-only / stderr progress; --output-format text|json|stream-json (reuses events.ts ev stream, last line t=result); stdin two forms; --max-turns / --allowed-tools / --output-schema (JSON Schema subset validation); exit code 0/1; exec resume <id>; omni_exec/omni_reply MCP tools

  web/                  # **Web mode (`omni web`)**: local backend service (REST+SSE, zero deps) + browser UI — index.ts (entry: args + prepareRun + attachRuntime + open browser) · server.ts (http server: SSE event broadcast + session/message/approval/ask/settings routes + static serving with embedded-asset fallback) · output.ts (WebOutput: Output events → SSE with sessionId; approvals/asks via pending registry) · events.ts (protocol names) · assets.ts (embedded web/ copy regenerated by `npm run web:sync`)

  electron/             # **Electron desktop app (`omni`)**: main.cjs (Electron main: spawns `dist/omni.cjs web --no-open` via Electron's own Node (ELECTRON_RUN_AS_NODE), polls /api/status, opens BrowserWindow; single-instance lock, app menu (choose workspace), kills the backend on quit; dev mode uses tsx source) + electron-builder packaging config in package.json (`build` field: mac zip arm64/x64 / win nsis x64 / linux AppImage x64); GitHub Actions builds all platforms on tag push

  web/                  # browser UI pages (repo root): index.html + style.css + app.js (vanilla HTML/CSS/JS, zero framework; source of truth for src/web/assets.ts — `npm run web:sync` regenerates the embedded copy)
  ui.ts                 # terminal UI: ANSI colors, TTY detection, spinner, window title
  version.ts            # version constant
  cli/                  # arg parsing / banner / interactive mode (26 / commands)
  agent/
    loop.ts             # agent main loop: stream LLM → parallel tool calls → execute → feed back
    thinking.ts         # thinking: streaming display / save to disk
    messages.ts         # message assembly: assistant message construction, tool arg parsing
    context.ts          # context management: file preload + summarization (scaffolding preserved) + memory injection
    memory.ts           # memory system: global/project memory cascade discovery, loading, truncation + session-end auto-extraction (dedup/conflict merging)
    init.ts             # /init [--global]: scan project/global env → LLM generates AGENTS.md
    session.ts          # session persistence: JSONL + list/restore (--continue / -r / -l / /resume)
    report.ts           # shared logic for session status/context usage/export/diagnostics/config paths (/status /context /export /doctor /config)
    review.ts           # code review (/review): typecheck + git diff → LLM review
    skill.ts            # skill system: SKILL.md discovery / frontmatter parsing (extended) / load-by-name / progressive disclosure / npx skills CLI / immediate-effect install / subagent execution
    subagent.ts         # subagents: isolated-context nested loop (shared Safety gate)
    title.ts            # session title: generated async after the first turn, set as terminal window title
  safety/               # safety guardrails: permission tiers (policy) / approval / audit log (audit)
  hooks/                # lifecycle automation: HookRunner (9 events, JSON protocol over stdin/stdout, wildcard matchers, stderr capture, timeout/failure degrade to pass-through; config layering merges global+project)
  tools/                # tool registry: 5 base tools + skill static; delegate / mcp_* injected at runtime
    undo.ts             # /undo file undo: write_file snapshots + restore + redo stack
  output/               # output layer: console / TUI shared formatting (format.ts tool cards, types.ts interface)
  config/               # layered merging / JSONC parsing / config discovery
  tui/                  # imperative-rendered full-screen TUI (state / render / rows / layout / theme / width / markdown / commands / interactive / output / crashlog)
scripts/
  mock-server.mjs       # local mock OpenAI API (keyless end-to-end tests; title/summary/usage branches)
  mock-mcp.mjs          # mock MCP server (stdio JSON-RPC)
  tui-snapshot.ts       # TUI snapshot tests (in-memory render assertions)
  pack-tui.sh           # one-click TUI packaging: version sync + bundle + npm pack (--compile also builds the native binary)
  eval/                 # eval task sets + runner (mock offline / real API)
packages/
  omni-tui/             # TUI npm package: bundle output + package.json (bin: omni, @opentui/core platform libs via optionalDependencies)
```

Core loop:

```
for step in 1..maxSteps:
  1. Stream the LLM (with full message history + system prompt)
  2. No tool calls → output the final answer, done
  3. Tool calls → parse JSON args → execute in parallel (each call passes the Safety gate)
  4. Feed results back as role=tool → back to 1
```

Key mechanisms: self-correction, 8000-char tool-result truncation (model is told to read targeted ranges), safety guardrails (permission tiers + approval + audit), parallel tool execution, isolated subagent contexts, `maxSteps` dead-loop guard.

## Development

```bash
npm run dev -- "<task>"       # dev run (tsx)
npm run typecheck             # TypeScript type checking
npm run build                 # typecheck + tsc compile + bun single-file bundle
npm run mock                  # local mock API server (port 8787, keyless validation)
npm run dev:tui -- "<task>"    # full-screen TUI mode (bun + real TTY)
npm run tui:snapshot          # TUI snapshot tests (in-memory render assertions)
npm run bundle:tui            # bundle the TUI (output: packages/omni-tui/dist/)
npm run pack:tui              # one-click TUI npm package (version sync + bundle + npm pack → omni-tui-<version>.tgz)
npm run pack:tui:compile      # one-click package + native binary (release/omni, zero deps)
npm run eval                  # eval: real API task suite + completion report
npm run eval:mock             # eval: offline mock (deterministic, CI-friendly)
```

Bundling requires bun: `npm run bundle` (single-file JS), `npm run compile` (native binary), `npm pack` (console npm package), `npm run pack:tui` (TUI npm package — auto-syncs `packages/omni-tui/package.json` version to the root version, cleans old bundles, platform libs auto-installed via `optionalDependencies`). Pushing a `v*` tag triggers the GitHub Actions build & release (Linux binary + npm package attached).

## Roadmap

- [x] MVP: agent loop + 5 base tools + mock end-to-end tests
- [x] Context management: tool-result truncation → message summarization → relevant-file selective loading
- [x] Safety guardrails: dangerous-command confirmation, permission tiers, audit log, workspace trust, OS-level sandbox
- [x] Eval system: custom task suite + completion-rate report (offline mock is CI-friendly)
- [x] MCP integration (external tool ecosystem)
- [x] Subagents and parallel tool execution
- [x] **Memory system**: global + project memory cascade (`/init` project / `/init --global` global / session-end auto-write with dedup/conflict merging)
- [x] **Session persistence**: interactive JSONL on disk + `--continue` / `-r <id>` / `-l` cross-process restore + `/fork` fork + `/send` cross-session messaging
- [x] **/plan plan mode**: read-only tool filtering + implementation plan output, execute only after confirmation
- [x] **/undo file undo**: automatic write_file snapshots + `/undo` / `/undo all` rollback for the session
- [x] **/permission runtime permission switch**: low=read-only / medium=safe ask-on-danger (default) / high=ask everything / full=pass-through — TUI panel + CLI arg instant switching, subagents stay in sync
- [x] **Skills (Agent Skill / SKILL.md)**: auto-discovery + manifest injection (progressive disclosure) + `skill` tool on-demand loading + frontmatter extensions (subagent execution) + `/skill` command (list / find online / add immediate-effect / show), aligned with opencode
- [x] **More interactive commands**: `/compact` manual context compression · `/agents` subagent config · `/review` code review (typecheck + git diff → LLM) · `/variants` reasoning level (reasoning_effort) · `/model` switch/add models (config `models` supports multiple endpoints; client is rebuilt on switch, subagents stay in sync; `/model add <name> [--base-url] [--api-key]` adds at runtime and persists to the config file) · `/status` session status · `/context` context usage · `/export` export to Markdown · `/config` view config · `/mcp` MCP server management (reconnect) · `/diff` view changes · `/rename` rename session (meta persisted) · `/resume` restore history · `/redo` redo undo · `/doctor` environment diagnostics
- [x] **Hooks lifecycle automation**: `UserPromptSubmit` prompt rewrite / `PreToolUse` hard-block + arg rewrite / `PostToolUse` output feedback (lint) / `Stop` require-continue (once) / `Notification` + `SessionStart` context injection / `SubagentStart`·`SubagentStop` subagent hooks / `PreCompact` — JSON protocol with wildcard matchers, layered config (global+project merged), stderr capture, timeout/failure degrade to pass-through; enforcement examples (guard-env / guard-dangerous / guard-git-push) in `examples/hooks/`
- [x] **Headless & CI integration (modeled on codex exec / claude -p)**: `omni exec "<task>"` (stdout result-only / stderr progress, `--output-format text|json|stream-json`, stdin two forms, `--max-turns`, `--allowed-tools` filtering, exit code 0/1 pipeline branching) + `--output-schema` structured validation + `exec resume <id>` session continuation + `omni mcp-server` (omni_exec / omni_reply) + CI workflow template (`examples/ci/omni-fix-ci.yml`: read-only job generates the patch → separate job opens the PR, keys never enter the patch-generating job)
- [x] **1.0 model layer**: providers / metadata (limit·modalities·capabilities) / named variants / cross-endpoint routing / `{env:VAR}` / max_tokens / model discovery
- [x] **Sandbox 2.0**: network allowlist proxy + fail-closed + credential masking
- [x] **Web multi-session concurrency** + full web parity (buttons wired: fork/export/checkpoints)
- [x] **Subagent worktree isolation**, hooks extension (PermissionRequest etc. + http handler), structured memory (MEMORY.md+topics+globs), compaction 2.0, LSP feedback, MCP annotations/registry, presets, spec trio, telemetry, headless protocol freeze + omni-action
- [ ] Advanced: SWE-bench eval

## Tech Stack

TypeScript strict · ESM (NodeNext) · bare openai SDK · @opentui/core (imperative rendering) · zero framework dependencies
