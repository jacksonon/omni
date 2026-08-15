# Omni

[English](README.md) | [中文](README.zh-CN.md)

**An agent engineering project** — a terminal-based AI coding assistant.

Currently at the **MVP+ stage**: single-agent loop + 8 tools + safety guardrails + context management + subagents/parallel tools + MCP external tools, with zero framework dependencies (bare OpenAI SDK + main loop), plus a full-screen TUI.

## Features

- **Agent main loop**: streams LLM calls → executes tool calls (in parallel) → feeds results back, with self-correction (tool failure messages are returned to the model so it can fix its own mistakes)
- **8 tools**: `read_file` / `write_file` / `list_directory` / `search_code` (ripgrep-first) / `run_command` (dangerous-command interception) / `skill` (on-demand SKILL.md loading) + `delegate` (subagent) + `mcp_*` (MCP external tools)
- **Safety guardrails**: permission tiers (full / safe / ask / read) + dangerous-command confirmation + approval UI + audit log
- **Context management**: tool-result truncation, relevant-file preloading, long-conversation summarization
- **Thinking display**: streamed live (kept on screen in dim color), full reasoning saved to `.omni/last-thinking.md`
- **Full-screen TUI**: scrollable content area, multi-line input box for interactive multi-turn conversations, line-based Markdown rendering (tables/lists/code blocks), click-to-expand tool cards, **`@` file mention in the input box** (directory drilling, Tab/Enter/click to insert), 25+ `/` commands (theme/permission/plan/thinking collapse/undo/redo/model switch/reasoning level/skills/memory generation/subagent/MCP/compact/export/status/context/resume/rename/review/diff/doctor/config etc.) — both `/` command suggestions and `@` mentions are **rounded-corner overlay panels** (hovering above the input box, non-modal, you can keep typing)
- **Skills (Agent Skill)**: auto-discovers `SKILL.md` in `.opencode/skills`, `.claude/skills`, `.agents/skills` (project-upward + global), injects a skill manifest on the first turn, and the model loads full content on demand via the `skill` tool; `/skill` lists / `find <term>` searches skills.sh online / `add` installs
- **Memory system (AGENTS.md)**: project memory + global memory (`~/.config/omni/AGENTS.md`) loaded in cascade (auto-injected on the first turn of every session, truncated when too long), `/init` for project / `/init --global` for global one-shot generation, session-end auto-extraction of new preferences into global memory (with dedup/conflict merging)
- **Session persistence**: interactive conversations saved as JSONL (`~/.config/omni/sessions/`), restored across processes with `--continue` / `-r <id>` / `-l` / `/resume`, session titles (terminal window title + meta on disk)
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
  "models": {                           // multi-model endpoints (/model switch/add): per-model baseURL/apiKey/userAgent; missing fields fall back to top level; /model add adds at runtime and persists
    "glm-4-flash": { "baseURL": "https://open.bigmodel.cn/api/paas/v4", "apiKey": "sk-glm" },
    "moonshot-v1-8k": { "baseURL": "https://api.moonshot.cn/v1" }
  },
  "mcpServers": {                        // MCP external tools: { name: { command, args?, env? } }
    "demo": { "command": "node", "args": ["scripts/mock-mcp.mjs"] }
  }
}
```

## Architecture

```
src/
  index.ts              # CLI entry: args → config → client → single-shot/interactive
  main.ts               # attachRuntime: Safety gate + MCP tool discovery + delegate injection + context preparation
  client.ts             # OpenAI client factory: created per "model endpoint" (/model rebuilds on endpoint switch) + shared ModelRuntime
  ui.ts                 # terminal UI: ANSI colors, TTY detection, spinner, window title
  version.ts            # version constant
  cli/                  # arg parsing / banner / interactive mode (25+ / commands)
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
- [ ] Advanced: SWE-bench eval, MCP resources/prompts protocol, memory progressive disclosure/TTL, nested AGENTS.md

## Tech Stack

TypeScript strict · ESM (NodeNext) · bare openai SDK · @opentui/core (imperative rendering) · zero framework dependencies
