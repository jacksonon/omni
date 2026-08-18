# Omni

[English](README.md) | [中文](README.zh-CN.md)

**An agent engineering project** — a terminal-based AI coding assistant.

Currently at **Beta (feature-complete)**: single-agent loop + 6 base tools (+ delegate subagents + MCP external tools) + safety guardrails + context management + memory system/session persistence/skills, with zero framework dependencies (bare OpenAI SDK + main loop), plus a full-screen TUI.

## Features

- **Agent main loop**: streams LLM calls → executes tool calls (in parallel) → feeds results back, with self-correction (tool failure messages are returned to the model so it can fix its own mistakes)
- **8 tools (6 base + 2 injected)**: base `read_file` / `write_file` / `list_directory` / `search_code` (ripgrep-first) / `run_command` (dangerous-command interception) / `skill` (on-demand SKILL.md loading) + runtime-injected `delegate` (subagent) + `mcp_*` (MCP external tools)
- **Safety guardrails**: permission tiers (full / safe / ask / read) + dangerous-command confirmation + approval UI + audit log
- **Context management**: tool-result truncation, relevant-file preloading, long-conversation summarization
- **Thinking display**: streamed live (kept on screen in dim color), full reasoning saved to `.omni/last-thinking.md`
- **Full-screen TUI**: scrollable content area, multi-line input box for interactive multi-turn conversations, line-based Markdown rendering (tables/lists/code blocks), click-to-expand tool cards, **`@` file mention in the input box** (directory drilling, Tab/Enter/click to insert), 26 `/` commands (theme/permission/plan/thinking collapse/undo/redo/model switch/reasoning level/skills/memory generation/subagent/MCP/compact/export/status/context/resume/rename/review/diff/doctor/config etc.) — both `/` command suggestions and `@` mentions are **rounded-corner overlay panels** (hovering above the input box, non-modal, you can keep typing)
- **Skills (Agent Skill)**: auto-discovers `SKILL.md` in `.opencode/skills`, `.claude/skills`, `.agents/skills` (project-upward + global), injects a skill manifest on the first turn, and the model loads full content on demand via the `skill` tool; `/skill` lists / `find <term>` searches skills.sh online / `add` installs
- **Memory system (AGENTS.md)**: project memory + global memory (`~/.config/omni/AGENTS.md`) loaded in cascade (auto-injected on the first turn of every session, truncated when too long), `/init` for project / `/init --global` for global one-shot generation, session-end auto-extraction of new preferences into global memory (with dedup/conflict merging)
- **Session persistence**: interactive conversations saved as JSONL (`~/.config/omni/sessions/`), restored across processes with `--continue` / `-r <id>` / `-l` / `/resume`, session titles (terminal window title + meta on disk)
- **Hooks (lifecycle automation)**: attach shell commands to lifecycle events — rewrite user prompts (`UserPromptSubmit`), hard-block tool calls (`PreToolUse`), feed post-tool output back to the model such as lint results (`PostToolUse`), require the agent to keep working before it stops (`Stop`), session-complete notifications (`Notification`), plus `SessionStart` context injection, subagent hooks (`SubagentStart`/`SubagentStop` + Pre/Post around subagent tool calls) and `PreCompact`; JSON protocol over stdin/stdout, wildcard tool-name matchers, config layers merged (global + project), stderr captured, timeout/failure degrade to pass-through
- **Swappable backends**: `OMNI_BASE_URL` is compatible with any OpenAI-protocol service (OpenAI / DeepSeek / Zhipu / Moonshot / Grok etc.)
- **Layered config**: defaults → global config → project config → custom config → env vars → CLI args (JSONC with comments)
- **Four build artifacts**: single-file JS bundle (`dist/omni.cjs`, console), native binary (`release/omni`, TUI), console npm package (`omni-<version>.tgz`), TUI npm package (`omni-tui-<version>.tgz`, requires bun); GitHub Actions builds and publishes automatically on tag push

## Quick Start

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

Useful env vars: `OMNI_DEBUG=1` prints the full request body sent to the LLM; `OMNI_SHOW_THINKING=0` hides thinking from the terminal (still saved to disk).

Config fields (see `omni.example.jsonc` for a full example):

```jsonc
{
  "model": "deepseek-chat",              // model name (default gpt-4o-mini)
  "baseURL": "https://api.deepseek.com/v1", // OpenAI-compatible API URL
  "apiKey": "sk-xxx",                    // prefer the OMNI_API_KEY env var
  "userAgent": "Mozilla/5.0 …",          // custom UA (some gateways WAF-block the SDK default UA)
  "maxSteps": 50,                        // max agent loop steps (dead-loop guard)
  "showThinking": true,                  // show thinking (still saved to disk)
  "permission": "safe",                  // safety tier: full / safe (default) / ask / read
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
  "models": {                           // multi-model endpoints (/model switch/add): per-model baseURL/apiKey/userAgent; missing fields fall back to top level; /model add adds at runtime and persists
    "glm-4-flash": { "baseURL": "https://open.bigmodel.cn/api/paas/v4", "apiKey": "sk-glm" },
    "moonshot-v1-8k": { "baseURL": "https://api.moonshot.cn/v1" }
  },
  "mcpServers": {                        // MCP external tools: { name: { command, args?, env? } }
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
| Click a thinking row | collapse/expand that thinking module; `/thinking` folds all globally |
| Click the token summary | expand per-LLM-request details (`⚡ 输入 X · 输出 Y · 缓存 Z`) |
| Mouse wheel / PgUp/PgDn / ↑↓ / Home / End | scroll content (End = back to latest) |
| `/settings theme` · `/settings language` | light/dark/system theme · 中文/English UI (persisted) |

### Command reference (all `/` commands, TUI + console interactive)

| Command | Effect |
|---|---|
| `/permission` | switch permission tier at runtime (low=read / medium=safe / high=ask / full=pass-through) |
| `/plan` | plan mode: read-only tools, research only, output an implementation plan for approval |
| `/thinking` | fold/unfold all thinking globally |
| `/model` | switch models; `/model <name>`; `/model add <name> [--base-url] [--api-key]` (adds + persists) |
| `/variants` | switch the model's reasoning level (low/medium/high, persisted) |
| `/settings` | settings submenu: status line / language / theme / token stats / environment diagnostics |
| `/undo` · `/redo` | undo the latest file edit (`/undo all` for everything) · redo the last undo |
| `/init` | scan the project and generate AGENTS.md (`/init --global` for global memory; never overwrites) |
| `/skill` | skill management: list / `find <word>` online search / `add <repo>` install / `show <name>` |
| `/compact` | manually compress context (old messages → summary, last 8 kept verbatim) |
| `/agents` | view subagent config + discovered subagent definitions (`.agents/subagents/*.md`) |
| `/orchestrate` | orchestration: fan-out parallel delegates → merge → adversarial review → final report |
| `/loop` (alias `/goal`) | loop a task until acceptance criteria are met (with iteration log) |
| `/review` | code review: typecheck + git diff → LLM review |
| `/status` · `/context` | session status summary · context usage with compression advice |
| `/session` | list current-directory history sessions and continue (`/session <id>`, prefix match; `all` = cross-directory) |
| `/resume` · `/rename` | restore a past session · rename the session (window title + persisted meta) |
| `/export` | export the session as Markdown (`.omni/export-<timestamp>.md`) |
| `/trace` | trace panel (right sidebar): per-turn LLM request / tool / message ledger, click for detail page |
| `/diff` · `/config` | uncommitted changes · config paths & sources |
| `/mcp` | MCP management: list servers/tools, `/mcp reconnect` reconnects after config edits |
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

- **Memory**: project `AGENTS.md` (searched upward from cwd, git root/home are boundaries) + global
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
    skill.ts            # skill system: SKILL.md discovery / frontmatter parsing / load-by-name / npx skills CLI
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
- [x] Safety guardrails: dangerous-command confirmation, permission tiers, audit log
- [x] Eval system: custom task suite + completion-rate report (offline mock is CI-friendly)
- [x] MCP integration (external tool ecosystem)
- [x] Subagents and parallel tool execution
- [x] **Memory system**: global + project memory cascade (`/init` project / `/init --global` global / session-end auto-write with dedup/conflict merging)
- [x] **Session persistence**: interactive JSONL on disk + `--continue` / `-r <id>` / `-l` cross-process restore
- [x] **/plan plan mode**: read-only tool filtering + implementation plan output, execute only after confirmation
- [x] **/undo file undo**: automatic write_file snapshots + `/undo` / `/undo all` rollback for the session
- [x] **/permission runtime permission switch**: low=read-only / medium=safe ask-on-danger (default) / high=ask everything / full=pass-through — TUI panel + CLI arg instant switching, subagents stay in sync
- [x] **Skills (Agent Skill / SKILL.md)**: auto-discovery + manifest injection + `skill` tool on-demand loading + `/skill` command (list / find online / add), aligned with opencode
- [x] **More interactive commands**: `/compact` manual context compression · `/agents` subagent config · `/review` code review (typecheck + git diff → LLM) · `/variants` reasoning level (reasoning_effort) · `/model` switch/add models (config `models` supports multiple endpoints; client is rebuilt on switch, subagents stay in sync; `/model add <name> [--base-url] [--api-key]` adds at runtime and persists to the config file) · `/status` session status · `/context` context usage · `/export` export to Markdown · `/config` view config · `/mcp` MCP server management (reconnect) · `/diff` view changes · `/rename` rename session (meta persisted) · `/resume` restore history · `/redo` redo undo · `/doctor` environment diagnostics
- [x] **Hooks lifecycle automation**: `UserPromptSubmit` prompt rewrite / `PreToolUse` hard-block + arg rewrite / `PostToolUse` output feedback (lint) / `Stop` require-continue (once) / `Notification` + `SessionStart` context injection / `SubagentStart`·`SubagentStop` subagent hooks / `PreCompact` — JSON protocol with wildcard matchers, layered config (global+project merged), stderr capture, timeout/failure degrade to pass-through; enforcement examples (guard-env / guard-dangerous / guard-git-push) in `examples/hooks/`
- [x] **Headless & CI integration (modeled on codex exec / claude -p)**: `omni exec "<task>"` (stdout result-only / stderr progress, `--output-format text|json|stream-json`, stdin two forms, `--max-turns`, `--allowed-tools` filtering, exit code 0/1 pipeline branching) + `--output-schema` structured validation + `exec resume <id>` session continuation + `omni mcp-server` (omni_exec / omni_reply) + CI workflow template (`examples/ci/omni-fix-ci.yml`: read-only job generates the patch → separate job opens the PR, keys never enter the patch-generating job)
- [ ] Advanced: SWE-bench eval, MCP resources/prompts protocol, memory progressive disclosure/TTL, nested AGENTS.md

## Tech Stack

TypeScript strict · ESM (NodeNext) · bare openai SDK · @opentui/core (imperative rendering) · zero framework dependencies
