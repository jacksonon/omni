# Omni Usage Guide

> This is the complete Omni user manual: installation, configuration, everyday usage, the full
> command reference, Headless/CI integration, MCP, Hooks, the skills system, and troubleshooting.
> Written for users (not developers); advanced developer info lives in `AGENTS.md` at the repo root
> (architecture overview and evolution log).
>
> 中文版见 [`Doc/使用指导.md`](使用指导.md)。

---

## Table of Contents

1. [What is Omni](#1-what-is-omni)
2. [Installation](#2-installation)
3. [Quick Start](#3-quick-start)
4. [Configuration](#4-configuration)
5. [Safety & Permissions](#5-safety--permissions)
6. [Models & Multi-endpoints](#6-models--multi-endpoints)
7. [Full-screen TUI Guide](#7-full-screen-tui-guide)
8. [Command Reference](#8-command-reference)
9. [Memory System (AGENTS.md)](#9-memory-system-agentsmd)
10. [Session Management](#10-session-management)
11. [Headless & CI Integration](#11-headless--ci-integration)
11.5. [Web Mode (`omni web`)](#115-web-mode-omni-web)
12. [MCP External Tools](#12-mcp-external-tools)
13. [Hooks Lifecycle Automation](#13-hooks-lifecycle-automation)
14. [Skills (SKILL.md)](#14-skills-skillmd)
15. [Subagents & Orchestration](#15-subagents--orchestration)
16. [FAQ & Troubleshooting](#16-faq--troubleshooting)
17. [Tools Overview](#17-tools-overview)

---

## 1. What is Omni

Omni is a **terminal-based AI coding assistant** (an agent engineering project): describe a task in
natural language in your terminal, and it autonomously runs the "read code → edit files → run
commands → verify" loop until it gives you a final answer. It is currently at **Beta
(feature-complete)**:

- **Single-agent main loop**: streams LLM calls → executes tool calls in parallel → feeds results
  back, with self-correction (tool failures are returned to the model so it can fix its own mistakes);
- **6 base tools + runtime-injected tools**: read file / write file / list directory / search code
  (ripgrep-first) / run command / load skill, plus the `delegate` subagent and `mcp_*` external tools;
- **Safety guardrails**: permission tiers + dangerous-command confirmation + approval UI + audit log;
- **Context management**: tool-result truncation, relevant-file preloading, automatic long-conversation
  summarization;
- **Memory system**: project-level + global-level AGENTS.md cascading load, one-shot `/init`
  generation;
- **Session persistence**: conversations persisted as JSONL, cross-process resume;
- **Full-screen TUI**: multi-line input, Markdown rendering, clickable tool cards and thinking
  modules, `/` command suggestions, `@` file mentions;
- **Hooks lifecycle automation**, **MCP external tools**, **skills system**, **Headless & CI
  integration**.

**Swappable backend**: `OMNI_BASE_URL` works with any OpenAI-protocol service (OpenAI / DeepSeek /
Zhipu / Moonshot / Grok, etc.) — switch models by config change, no code changes needed.

---

## 2. Installation

Five installation options, pick what fits:

### Option 0: curl one-liner (native binary, zero dependencies)

```bash
curl -fsSL https://raw.githubusercontent.com/jacksonon/omni/main/scripts/install.sh | sh
omni "<task>"      # full-screen TUI automatically in a real terminal
```

### Option 1: npm global install (recommended, Node >= 18)

```bash
npm install -g @right-ai/omni
omni "Show me the structure of the current directory"
```

The published main package is the scoped `@right-ai/omni` (bin name `omni`); it pulls the native
binary for your platform via `optionalDependencies`, so you get the full TUI with one command.

> ⚠️ Do **not** install the bare `omni` package — that is an unrelated third-party project on npm.

You can also install the console tarball from a GitHub Release:
`npm install -g ./omni-<version>.tgz`.

### Option 2: TUI npm package (requires bun >= 1.3)

The console package runs on Node and cannot include the TUI (OpenTUI depends on bun's native FFI).
The full-screen TUI is packaged separately by `npm run pack:tui` → `omni-tui-<version>.tgz`
(bin name also `omni`; the platform native library is installed automatically by os/cpu).
**There is no `omni-tui` package on npm** — it is built and installed locally:

```bash
npm run pack:tui                  # produces omni-tui-<version>.tgz
npm install -g ./omni-tui-<version>.tgz
omni "<task>"                     # full-screen TUI automatically in a real TTY (single task)
omni                              # interactive multi-turn conversation
```

> ⚠️ `omni-tui` and the console package share the bin name — run `npm uninstall -g omni` first.

### Option 3: Native binary (zero dependencies, no Node/bun required)

GitHub Releases attach platform artifacts such as `omni-linux-x64` / `omni-darwin-arm64` /
`omni-win32-x64.exe`. Download and run directly:

```bash
chmod +x omni-darwin-arm64 && ./omni-darwin-arm64 "<task>"
```

### Option 4: Run from source

```bash
npm install
npm run dev -- "List the files in the current directory"   # Console edition (tsx)
npm run dev:tui -- "<task>"                                # TUI edition (needs bun + real TTY)
npm run dev:tui                                             # no task = interactive multi-turn
```

### Setting the API key

```bash
export OMNI_API_KEY=sk-xxx                                    # required (or OPENAI_API_KEY)
export OMNI_BASE_URL=https://api.deepseek.com/v1              # optional, defaults to OpenAI
export OMNI_MODEL=deepseek-chat                                # optional
```

Or copy `omni.example.jsonc` to `omni.json` and edit as needed (the project config is gitignored,
so keys never enter the repository).

---

## 3. Quick Start

### Single-task mode

```bash
omni "Inspect src/main.ts and point out issues"
```

One run: thinking → tool calls → final answer, then exits.

### Interactive mode (Console)

```bash
omni
```

Enters a multi-turn loop: type after the `❯` prompt, context is kept across turns; `/exit` to quit,
`/clear` to clear the screen, `/help` for the command list (full list in the
[Command Reference](#8-command-reference)).

### Full-screen TUI mode

With a real TTY + bun (or the TUI package), starting without a task enters the full-screen TUI:

```
┌─────────────────────────────────────────────┐
│  ▍Hello, tell me about this project          │
│  - thinking · 3.2s                           │
│  (thinking content…)                         │
│  ╭───────────────────────────────────────╮   │
│  │ $ ls                                     │   │
│  ╰───────────────────────────────────────╯   │
│  (final answer…)                             │
│  ────────────────────────────────────────   │
│  ▍ Type a message…                           │
│  Build · mock-model demo · medium            │
│  ⠙ esc First token avg 6.5s · 112 tok/s| Ca… │
└─────────────────────────────────────────────┘
```

The gray block at the bottom is the input area: **Enter** sends, **Shift+Enter** inserts a newline,
**Cmd/Ctrl+Enter** interrupts and inserts a new message into the current turn (steer), **Esc** cancels
the running turn; ordinary messages submitted while running go into the "⏳ pending" list and are sent
automatically when the current turn ends.

---

## 4. Configuration

### 4.1 Layering & precedence

Config files support **JSON / JSONC** (comments allowed, trailing commas tolerated). Precedence,
low → high:

```
defaults → global config → project config → custom config → environment variables → CLI args
```

| Layer | Location | Description |
|---|---|---|
| Global config | `~/.config/omni/omni.json` | user-level defaults (respects `XDG_CONFIG_HOME`) |
| Project config | `omni.json` / `omni.jsonc` | searched upward from cwd; nearest wins; git root / home are boundaries |
| Custom config | `OMNI_CONFIG` env var or `--config <path>` | explicit |
| Environment | `OMNI_API_KEY` / `OMNI_BASE_URL` / `OMNI_MODEL` / `OMNI_MAX_STEPS` / `OMNI_SHOW_THINKING` / `OMNI_PERMISSION` / `OMNI_DEBUG` | overrides config files |
| CLI args | `-m, --model <name>` | highest precedence |

> **Windows paths**: `~` above means `%USERPROFILE%`, so the global config actually lives at `C:\Users\<you>\.config\omni\omni.json` — the conventional `%APPDATA%` is **not** used; if the `XDG_CONFIG_HOME` env var is set it becomes `%XDG_CONFIG_HOME%\omni\omni.json`. Sessions, memory, audit log and other global data live under the same `.config\omni\` directory.

### 4.2 CLI arguments

```bash
omni "<task>"                     # single run
omni                              # interactive mode (auto full-screen TUI with real TTY + bun)
omni -m glm-4-flash "<task>"       # explicit model (overrides config)
omni -C ./my-config.json "<task>" # explicit config file (-c now means continue)
omni --no-tui "<task>"             # disable full-screen TUI (fall back to console)
omni -c "<task>"                    # resume the most recent session of the current project
omni -s <session-id> "<task>"        # resume a specific session (-r is a synonym)
omni -l                           # list saved sessions
omni -h / -v                      # help / version
```

### 4.3 Full config field reference

```jsonc
{
  // ── Model & endpoint ──
  "model": "gpt-4o-mini",              // default model name; endpoints/keys live only in `providers` below
  "providers": {                        // 1.0: the only endpoint format (legacy flat `models` removed) — one gateway, many models
    "bigmodel": { "baseURL": "https://open.bigmodel.cn/api/paas/v4", "apiKey": "{env:GLM_KEY}",
      "models": { "glm-4-flash": { "limit": { "context": 128000, "output": 8192 } } } }
  },
  // Endpoint fallback comes from env vars only (OMNI_BASE_URL / OMNI_API_KEY);
  // top-level baseURL/apiKey/userAgent in config files are no longer parsed.
  // Per-model reasoning level (each model can have its own, falls back to top level; under providers.<group>.models.<model>):
  "reasoningEffort": "medium",         // reasoning level (reasoning_effort; unset = omit the param, use model default)
  "reasoningEffortOptions": ["low", "medium", "high", "xhigh", "max"], // levels supported by /variants (customizable)
  // Named variants (1.0): { id: { description?, reasoningEffort?, body?, headers? } }
  // each id is a request overlay (deep-merged into the request body); the current pick is stored
  // in the `variant` field; the /variants panel lists both reasoning levels and named variants;
  // `apiModel` = real model name sent to the API
  "architect": "gpt-5",                // model routing: strong model for /plan (falls back to the current model)
  "editor": "gpt-5-mini",              // model routing: light model for execution (falls back to the current model)

  // ── Runtime & context ──
  "maxSteps": 50,                      // max agent loop steps (infinite-loop safeguard; typical tasks finish in <15)
  "showThinking": true,                // show thinking (false hides display; still written to .omni/last-thinking.md)
  "summarizeAt": 40,                   // long-conversation summarization threshold (messages; 0 = off)
  "summarizeWindow": 8,                // how many recent messages to keep verbatim when summarizing
  "preloadFiles": true,                // preload files mentioned in the task text
  "preloadMaxFiles": 5,                // max preloaded files
  "preloadMaxBytes": 30720,            // per-file preload byte cap (30KB)
  "repoMap": true,                     // codebase structure awareness: inject a compact symbol map on the first turn
  "repoMapMaxSymbols": 200,            // repo map symbol cap (10–2000)
  "contextCompressRatio": 0.7,         // compaction 2.0: trigger by context-window ratio, not just message count
  "diagnoseAfterEdit": false,          // run a quick typecheck/lint after write_file and feed diagnostics back

  // ── Safety ──
  "permission": "safe",                // full (pass-through) / safe (ask on dangerous, default) / ask (ask all) / read (read-only)
  "dangerousPatterns": [],             // extra dangerous-command regexes (prompt on match in the safe tier and above)
  "auditLog": true,                    // audit log (~/.config/omni/audit.log)
  // OS-level sandbox (see 5.5): wraps run_command with sandbox-exec (macOS) / bwrap (Linux)
  "sandbox": "off",                    // off (default) / read-only / workspace-write / danger-full-access
  "sandboxNetworkAllow": [],           // sandbox network allowlist (hostnames); empty = keep network fully blocked
  "sandboxFailClosed": false,          // true = refuse to run when no sandbox primitive exists (fail-closed)
  "sandboxWritePaths": [],             // extra writable absolute paths for workspace-write
  "sandboxMaskEnv": true,              // mask credential env vars (*_KEY/*_TOKEN/*_SECRET/*_PASSWORD) handed to sandboxed commands

  // ── Memory & sessions ──
  "agentsFile": true,                  // project memory AGENTS.md: nested load on first turn (all levels from cwd up to git root/home boundary; inner layers override outer)
  "globalAgentsFile": true,            // global memory ~/.config/omni/AGENTS.md (cross-project)
  "autoMemory": true,                  // append newly expressed preferences to global memory on interactive exit

  // ── Subagents & skills ──
  "allowSubagents": true,              // enable the delegate subagent tool
  "maxSubagentSteps": 10,              // subagent max loop steps
  "skills": true,                      // enable SKILL.md discovery and the skill tool

  // ── TUI ──
  "language": "zh",                    // TUI language: zh (default) / en (switch & persist via /settings)
  "statusline": ["speed", "cache", "tokens", "context"], // bottom status-line segments (/settings statusline)
  "statuslineAlign": "center",              // status-line alignment: left / center (default) / right (press a in the panel)

  // ── External tools ──
  "webFetchDomains": [],               // web_fetch domain allowlist (empty = all domains allowed)
  "mcpServers": {                      // MCP external tools: { name: { command, args?, env? } | { url, headers? } }
    "demo": { "command": "node", "args": ["scripts/mock-mcp.mjs"] }
  },
  "hooks": {                           // Hooks lifecycle automation (see section 13)
    "PostToolUse": [{ "matcher": "write_file", "command": "sh scripts/lint-hook.sh", "timeoutMs": 30000 }]
  },

  // ── Web & observability (1.0) ──
  "webConcurrency": 3,                 // max concurrently running web sessions (each session runs one turn at a time)
  "telemetry": { "enabled": false, "endpoint": "http://localhost:4318" }, // opt-in OTLP/HTTP JSON, redacted by default
  "compatibility": { "reasoningField": "custom_thinking" }  // custom gateway reasoning field name
}
```

A copy-paste-ready example lives in `omni.example.jsonc`.

### 4.4 Environment variable quick reference

| Variable | Effect |
|---|---|
| `OMNI_API_KEY` | API key (also accepts `OPENAI_API_KEY`) |
| `OMNI_BASE_URL` | OpenAI-compatible endpoint URL |
| `OMNI_MODEL` | default model |
| `OMNI_MAX_STEPS` | max loop steps |
| `OMNI_SHOW_THINKING` | `0` hides thinking display (still persisted) |
| `OMNI_PERMISSION` | permission tier full/safe/ask/read |
| `OMNI_DEBUG=1` | print the full request body sent to the LLM (stderr, for debugging) |

---

## 5. Safety & Permissions

### 5.1 Permission tiers (`permission` field or `/permission` command)

| Tier | Behavior | Use case |
|---|---|---|
| `full` | any command passes through (including dangerous ones), no prompting | fully trusted throwaway container / one-off task |
| `safe` (default) | dangerous commands prompt the user before running | everyday use |
| `ask` | every command prompts | cautious scenarios |
| `read` | read-only: no file writes / command execution | read-only exploration |

The dangerous-command library covers destructive patterns such as `rm -rf /`, `mkfs`, `dd` writes,
fork bombs, `git push`, etc. `/permission` switches tiers at runtime (TUI panel / CLI arg), and
subagents stay in sync with the main loop.

### 5.2 Approval flow

- **Console interactive**: a `⚠ Need confirmation [y/n]` prompt appears for dangerous commands —
  `y` approves, `n` rejects;
- **TUI**: an approval card pops up above the input area — press `y`/`Enter` to approve,
  `n`/`Esc` to reject (or click);
- **Piped / non-interactive**: no user to ask, so it auto-rejects (in `omni exec`, the dangerous
  command simply fails and the error is returned to the model for self-correction).

### 5.3 Audit log

On by default (`auditLog: true`): every tool call (time/tool/args/tier/decision) is written as
JSONL to `~/.config/omni/audit.log` for later auditing.

### 5.4 Workspace trust

The first time you enter a directory that is not yet trusted, omni asks whether to trust it
(a TUI approval card / a console prompt). Trust decides two things:

- **Untrusted = read-only.** The permission tier is locked to read-only and cannot be raised with
  `/permission`.
- **Untrusted = skips project-level config.** Project hooks, skills, subagent definitions
  (`.agents/subagents/*.md`) and project memory are all skipped.

That second rule is the point of the mechanism: a cloned repository cannot smuggle in hooks or
skills that execute on your machine the moment you run omni inside it.

The trust list is persisted in `~/.config/omni/trusted-workspaces.json`, so you are only asked once
per directory.

### 5.5 OS-level sandbox

Beyond the permission tiers, `run_command` can be wrapped in a real OS sandbox:

| `sandbox` value | Behavior |
|---|---|
| `off` (default) | No wrapping — only the permission tiers apply |
| `read-only` | Denies writes and network access |
| `workspace-write` | Denies network; allows writes only inside the current working directory |
| `danger-full-access` | Sandbox active but permissive (escape hatch) |

On macOS the wrapper is `sandbox-exec`; on Linux it is `bwrap`. When the platform has no sandbox
primitive available, omni degrades to running the command directly and tells you — unless you set
`sandboxFailClosed: true`, which refuses to run instead (fail-closed, for locked-down environments).

Related fields:

- `sandboxNetworkAllow: ["api.openai.com"]` — allow outbound traffic to specific hostnames through a
  built-in filtering proxy (CONNECT filtered by hostname; **TLS is not decrypted**).
- `sandboxWritePaths: ["/tmp/omni-shared"]` — extra writable absolute paths for the
  `workspace-write` tier (ignored by `read-only`).
- `sandboxMaskEnv: true` (default) — replaces the values of credential-looking env vars
  (`*_KEY` / `*_TOKEN` / `*_SECRET` / `*_PASSWORD`) with a sentinel before handing them to a
  sandboxed command, so a command cannot `echo` a key back into the model's context.

---

## 6. Models & Multi-endpoints

### Switching models (`/model`)

```bash
/model              # TUI panel lists all available models (↑/↓ or digits + Enter); console shows current + list
/model glm-4-flash  # switch directly
```

### Adding a model at runtime (`/model add`)

```bash
/model add my-v1 --base-url https://api.example.com/v1 --api-key sk-xxx
```

Adds, switches to it, and **persists** it to the config file (plain-JSON configs are rewritten
automatically; JSONC configs get a hint to add it manually). It is written as a single-model
`providers` group (`providers.<name>.models.<name>`); the endpoint lives at the provider level.

### Reasoning level (`/variants`)

`/variants` panel/command switches the current model's reasoning level (low/medium/high,
levels customizable); set `reasoningEffort` in config for a default. The switch persists — the
next startup keeps your choice.

---

## 7. Full-screen TUI Guide

### Input area (bottom gray block)

| Action | Effect |
|---|---|
| **Enter** | send message |
| **Shift+Enter** | newline (kitty-protocol terminals) |
| **Cmd/Ctrl+Enter** | interrupt the current turn; the new message is inserted into the running round (steer) |
| **Esc** | cancel the current turn (when no overlay is open and something is running) |
| Auto-grow input | multi-line input grows 1–5 rows automatically; beyond 5 rows it scrolls internally |
| Submit while running | ordinary messages go to the "⏳ pending (N)" list, sent when the turn ends; steer messages get priority |

Inside the gray block the model line sits on the left (`Build/Plan · model name provider · reasoning level` —
mode prefix (`/plan` shows Plan, otherwise Build), model name with its provider group, and the level
color-coded by intensity — low green → medium amber → high orange → xhigh red → max purple);
while something is running, the loading animation and `esc interrupt` hint sit **in the model line, right of
the reasoning level** (`· ⠹ esc interrupt` — the `·` separator appears only while loading, hinting that Esc
can interrupt the current turn; both disappear on Esc or when the turn ends); below the block is the configurable
status/stats line
(`/settings statusline` toggling and ordering): `first token/rate · cache hit ·
in/out tokens · context` (context = prompt tokens of the latest LLM request — shows
`used/limit` when the model config declares a context limit). Press **`a`** inside the
panel to cycle the stats line **horizontal alignment** (left / center / right; Enter
saves and persists to `statuslineAlign`).

### `/` command suggestions

Typing `/` pops a **rounded overlay** above the input box listing matching commands: `↑/↓` to move
the highlight, `Tab` to fill in, `Enter` to run, `Esc` to close; the overlay is non-modal — keep
typing to filter, or click an item to fill it in.

### `@` file mentions

Typing `@` lists files/directories in the current directory (directories first): `↑/↓` to highlight,
`Tab`/`Enter` to insert (directory → `@path/` to keep drilling down; file → `@path ` to finish),
Esc to close, mouse click to insert.

### Conversation-flow interactions

- **Tool cards**: collapsed by default and show only the executed command (`$ command` /
  `→ Read path` / `✏️ path`); **click anywhere on the card** to expand/collapse the full output and
  diff; an animated loading spinner shows while running;
- **Thinking modules**: expanded state shows `- thinking · duration` + content; **click any thinking
  row** to collapse/expand that module individually; `/thinking` folds/unfolds all thinking globally;
- **Per-turn token stats**: after each answer a `⚡ in X · out Y · cached Z` summary is shown; click
  to expand per-LLM-request details (`/settings tokens` toggles it);
- **Scrolling**: mouse wheel / PgUp/PgDn page, `↑/↓` line-by-line, `Home` top, `End` bottom; while
  scrolled up a `↑ scrolled up N lines · M total` hint appears; when content overflows, a
  `↑ N more lines above` hint appears at the top;
- **Markdown rendering**: bold / inline code / headings / blockquotes / tables (box-drawing
  frames) / lists / task checkboxes / strikethrough / fenced code blocks all render with syntax
  markers hidden;
- **Trace ledger (console/web `/trace`)**: folded text of the per-turn LLM request / tool call /
  message event log (the TUI right sidebar panel has been removed).

### Theme & language

- `/settings theme`: light / dark / follow system (defaults to auto-detecting the terminal
  background);
- `/settings language`: 中文 / English, switches instantly and persists.
- All TUI settings (theme / permission / model / thinking level / language / status line) **take
  effect immediately with no confirmation popup**; the command panel is only used for query
  outputs (/status /context /session /undo etc.).

---

## 8. Command Reference

All commands below work in both TUI and console interactive mode (`/` prefix; command output goes to
a separate panel and never pollutes the conversation flow). Omni ships **30+ commands** — run `/help`
inside omni for the authoritative list; the registry in `src/tui/commands.ts` is the source of truth.
A few are console-only (`/doctor`) and are noted inline.

| Command | Effect |
|---|---|
| `/permission` | switch permission tier at runtime (read-only=read / ask-all=ask / auto-approve-risky=safe / full-access=full) |
| `/plan` | plan mode: read-only tools + research only, output an implementation plan for approval |
| `/thinking` | fold/unfold all thinking globally |
| `/model` | switch/add models (`/model <name>`; `/model add <name> [--base-url] [--api-key]`; `/model fetch` lists models the gateway offers that aren't registered locally) |
| `/variants` | switch the model's reasoning level (low/medium/high) |
| `/settings` | settings submenu: status line / language / theme / token stats / environment diagnostics / help / model snapshot (`/settings help` help · `/settings models [refresh]` snapshot refresh) |
| `/undo` | undo the latest file edit (`/undo all` rolls back everything; write_file snapshots automatically) |
| `/redo` | redo the last undo |
| `/rewind` | session checkpoints: roll workspace files back to any past turn (`/rewind` panel select · `/rewind <N>` restores; auto-checkpointed every turn, survives session restore, conversation kept — files only) |
| `/init` | scan the project and generate AGENTS.md (`/init --global` for global memory · `/init <subdir>` for a nested layer; never overwrites existing) |
| `/memory-apply` | apply the pending project-memory snippet (`.omni/memory-pending.md`) into the project-root AGENTS.md, then clear the snippet — see 9.4 |
| `/skill` | skill management: panel select to view / `find <word>` online search on skills.sh / `add <repo> [--skill <name>] [--global]` install (takes effect in the current session immediately) / `show <name>` view / `create <name> [desc]` create / `delete <name>` delete |
| `/compact` | manually compress context (old messages merged into a summary, last 8 kept verbatim) |
| `/agents` | view subagent config + discovered subagent definitions (`.agents/subagents/*.md`, per-agent model/permission/tool whitelist/skills) |
| `/orchestrate` | orchestration: fan-out parallel delegates (default 3 workers) → merge → adversarial review → final report |
| `/goal` (alias `/loop`) | goal mechanism: derive acceptance criteria and loop until they are met (with iteration log and verdict feedback) |
| `/review` | code review: typecheck + git diff → LLM review |
| `/spec <feature>` | spec trio: writes `requirements.md` (EARS acceptance clauses) / `design.md` / `tasks.md` under `.omni/specs/<slug>/`, and syncs the tasks into the session todo list |
| `/preset browser` | one-click install of the browser-automation pair (Playwright MCP + Chrome DevTools MCP) into the global config — no custom browser stack needed |
| `/status` | session status summary (incl. context usage: model / permission / plan mode / tokens / session file / scaffolds / budget) |
| `/context` | set context window (`/context` views · `256|400|512|750|1000` manual override in K · `default` for model auto) |
| `/session` | session management: list current-directory history and continue (`/session <id>` prefix match, `all` cross-directory) |
| `/resume` | restore a past session (no arg lists; `<id>` restores) |
| `/rename` | rename the session (terminal window title + persisted meta) |
| `/fork` | fork a new session from any point in history (lists checkpoints → choose one → new independent session; the original is untouched) |
| `/send <session-id> <message>` | send a message to another session and get its result injected into the current context (lightweight cross-session collaboration) |
| `/export` | export the session as Markdown (`.omni/export-<timestamp>.md`) |
| `/trace` | trace text ledger (console/web): folded per-turn request/tool/message event log |
| `/diff` | view uncommitted changes (git diff + untracked files, first 60 lines; `--stat` summary only · `--full` untruncated) |
| `/mcp` | MCP management: `/mcp` opens a selection panel (server list + reconnect all, select for details) · `resources` · `prompts` · `reconnect` after config edits · `add <name> <command\|--url>` (runtime, persisted) · `remove <name>` · `login <name>` (OAuth PKCE for HTTP servers) · `install <id>` (one-click from the registry) — see section 12 |
| `/doctor` (console) / `/settings doctor` (TUI) | environment diagnostics: Node/bun versions, API key, endpoint connectivity, config/MCP/permission/models |
| `/clear` | clear the current session view (memory and undo stack are untouched) |
| `/exit` (alias `/quit`) | quit (triggers autoMemory write and session finalize) |

---

## 9. Memory System (AGENTS.md)

### 9.1 Two-level cascade

Memory has two levels, **cascade-injected** (global first, project second — later wins more weight):

| Level | Location | Content |
|---|---|---|
| Global memory | `~/.config/omni/AGENTS.md` | cross-project user preferences (language/style/toolchains) |
| Project memory | `<project-root>/AGENTS.md` (+ nested `AGENTS.md` in subdirectories) | project-specific (build commands/architecture/conventions), all levels loaded from cwd up to git root / home boundary |

- **Auto-load**: every AGENTS.md from cwd upward is injected on the first turn of every session —
  **nested**: each directory layer gets its own system message, inner layers (closer to cwd) sit
  later in the context and override outer layers (if a file is > 40KB only its head is loaded,
  with a hint to read the rest on demand);
- **One-shot generation**: `/init` scans the project structure and asks the LLM to write AGENTS.md
  (never overwrites an existing file); `/init --global` generates global memory;
  `/init <subdir>` generates a nested layer for a subdirectory;
- **Auto-write**: with `autoMemory: true`, quitting interactive mode extracts preferences newly
  expressed in the session, dedups/merges conflicts, and appends them to global memory.

> Want to permanently remember "I prefer tests-first" or "don't touch package-lock.json"? Write it
> straight into AGENTS.md — or let it learn: after a few conversations, global memory accumulates
> it automatically.

### 9.2 Progressive disclosure tools

A large AGENTS.md would eat the context window, so only a compact manifest is resident. When the
model needs the full text it pulls it on demand with two read-only tools:

| Tool | Behavior |
|---|---|
| `memory_search` | multi-keyword AND search over memory; results ranked by number of hits |
| `memory_read` | read the full memory file at a given path |

This is why you can keep a detailed AGENTS.md without paying for it on every turn.

### 9.3 Structured memory (1.0)

Global memory can also use a structured layout instead of one big file:

```
~/.config/omni/memory/MEMORY.md          ← index (always injected; one line per topic: `- topic: summary · path`)
~/.config/omni/memory/topics/<slug>.md   ← topic files (frontmatter: topic / date / globs / archived + body)
```

- The **index is resident**; topic bodies are loaded on demand via `memory_search` / `memory_read`.
- **Conditional injection by `globs`** — a topic declaring `globs: "src/**"` in its frontmatter is
  inlined into the context automatically whenever the task text matches that pattern, so the model
  does not have to know to look for it.
- **TTL archival** — topics older than the TTL (default 90 days) are marked `archived: true` and
  rebuilt out of the index. Nothing is ever deleted, just archived.
- The legacy `~/.config/omni/AGENTS.md` is still loaded read-only; new writes go to the structured
  layout.

### 9.4 Pending project-memory snippet

Project-level auto-writes are deliberately **not** applied silently — editing a repository's
AGENTS.md is a change other people on the team will see. Instead, at the end of a session omni
extracts durable project facts into a pending snippet:

```
.omni/memory-pending.md
```

Review it and apply it with `/memory-apply`, which merges the snippet into the project-root
AGENTS.md and clears it. Nothing is written to the project until you run that command.

---

## 10. Session Management

Interactive conversations are automatically persisted as JSONL under `~/.config/omni/sessions/`
(XDG-aware); scaffold messages (memory/skills/preloads) are never persisted and are re-injected on
restore.

```bash
omni -l                      # list saved sessions (id + project + time + first message)
omni -c "<task>"               # resume the most recent session of the current project
omni -s <session-id> "<task>"   # resume a specific session (-r is a synonym)
# After exiting the TUI (/exit or Ctrl+C) the terminal prints: 💬 Resume this session: omni -s <id>
```

In-session commands: `/session` (history sessions of the same directory — list/continue),
`/resume`, `/rename` (rename), `/export` (Markdown export), `/trace` (trace ledger),
`/compact` (manual compression). Restored history is replayed into the conversation; the same file
is appended to with no duplicate writes.

---

## 11. Headless & CI Integration

`omni exec` turns omni into a **composable Unix command** (modeled on `codex exec` / `claude -p`)
for scripts, pipelines, and non-interactive CI use.

### Basic usage

```bash
omni exec "Fix the failing tests in src/foo.test.ts"   # stdout prints only the final answer
omni exec "Summarize" --output-format json            # single JSON object → | jq
omni exec "Analyze this diff" --output-schema '{"type":"object","properties":{"verdict":{"type":"string"}},"required":["verdict"]}'
cat test-output.txt | omni exec "Fix the failures below"  # stdin injected as context
echo "my task" | omni exec -                          # whole stdin is the task
omni exec resume <session-id> "Continue from where it stopped"  # resume a headless session
omni mcp-server                                     # act as an MCP server for external harnesses
```

### Key semantics

| Aspect | Behavior |
|---|---|
| **Clean stdout** | stdout carries only the final result; progress (thinking/tool steps/errors) all goes to **stderr** — safe to `\| jq` / redirect |
| **`--output-format`** | `text` (default, plain answer) · `json` (single object `{ result, cost_usd, duration_ms, num_turns, session_id, exit_code }`) · `stream-json` (one trace event per line `{"t":"ev",…}`, last line `{"t":"result",…}` — `tail -1` gets the structured result) |
| **stdin two forms** | task `-` = whole stdin is the prompt; task given + piped stdin = injected as `[stdin input]` context |
| **`--max-turns N`** | step cap (exceeding it → non-zero exit; pipeline `&&`/`\|\|` branching) |
| **`--allowed-tools`** | comma-separated tool whitelist (pure tool filtering, same semantics as /plan read-only filtering) |
| **`--output-schema`** | final answer must conform to a JSON Schema subset (inline JSON or file path; on mismatch → non-zero exit + error paths listed on stderr) |
| **exit code** | `0` = completed · `1` = request failure / step cap reached / schema validation failed |
| **Sessions** | every run persists a JSONL session (json output includes `session_id`); `exec resume <id>` continues it |

### CI workflow template

`examples/ci/omni-fix-ci.yml` provides a GitHub Actions template for "agent fixes CI failures":

1. **Read-only job** (`permissions: contents: read`, only `OMNI_API_KEY` exposed): reproduce the
   failure → `cat failure-output | omni exec "fix…" --output-format json` → upload the
   `git diff --binary` patch as an artifact;
2. **Write-permission job**: download the patch → `git apply --binary` → push a branch →
   create-pull-request opens a PR.

**Keys never enter the patch-generating job** — a compromised agent cannot exfiltrate keys. See
`examples/ci/README.md` for details.

### 11.4 omni-action (reusable GitHub Action)

The same split is packaged as a reusable Action, so you don't have to hand-roll the two jobs:

```yaml
jobs:
  fix:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test          # reproduce the failure
        continue-on-error: true
      - id: omni
        uses: ./.github/actions/omni     # or owner/omni/action@v1
        with:
          task: "Fix the CI failure. Output:\n${{ steps.test.outputs.stdout }}"
          api-key: ${{ secrets.OMNI_API_KEY }}
      - uses: actions/upload-artifact@v4
        with: { name: patch, path: ${{ steps.omni.outputs.patch-file }} }
  apply:
    needs: fix
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write }
    steps:
      - uses: actions/download-artifact@v4
        with: { name: patch }
      - run: git apply --binary patch.diff && git add -A && git commit -m "fix: agent fixed CI" && git push -u origin agent-fix
      - uses: actions/github-script@v7
        with:
          script: "await github.rest.pulls.create({ ...owner/repo, title:'🤖 fix CI', head:'agent-fix', base:'main' })"
```

| Input | Meaning |
|---|---|
| `task` | task description (inject the failure log here) |
| `api-key` / `base-url` / `model` | endpoint config (key should come from Secrets) |
| `max-turns` | step cap (default 30) |
| `allowed-tools` | tool allowlist (default: read + execute + write) |

| Output | Meaning |
|---|---|
| `patch-file` | path to the `git diff --binary` patch |
| `exit-code` | `omni exec` exit code (0 success / 1 failure) — gate the PR on it |

Branch on the outcome with `if: ${{ steps.omni.outputs.exit-code == '0' }}` so a failed run never
opens a PR.

---

## 11.5 Web Mode (`omni web`)

Runs omni as a **local backend service** (REST + SSE, zero new dependencies) and hosts a browser UI —
modeled on `dsh web` / `opencode serve`. The same agent stack is reachable from both the CLI
(`omni` / `omni exec`) and the web page.

```bash
omni web                   # start service + Web UI at http://127.0.0.1:3080 (opens browser)
omni web --port 4000       # custom port
omni web --no-open         # don't auto-open the browser
```

### What the UI provides

| Feature | Description |
|---|---|
| **Sessions** | left sidebar lists persisted sessions (shared JSONL files with CLI `-c` / `/resume`); create / switch / delete |
| **Live streaming** | thinking (collapsible blocks), tool calls (amber cards: command + expandable output), and the final markdown answer all stream over SSE |
| **Approvals** | when a tool needs approval under the active permission tier, a card above the composer offers **允许/拒绝** — the agent pauses until you decide |
| **ask_user** | when the agent asks a question, a card shows options with a custom-input row and a confirm button |
| **Settings** | model switching (including per-model endpoints), permission tier, reasoning effort, plan-mode toggle — applied live |
| **Cancel** | one click cancels the running turn |
| **Stats** | per-turn token usage plus a run summary line after each turn |

### Protocol (for scripted/frontend clients)

The backend exposes a small HTTP API — any client can drive it, not just the bundled UI:

| Endpoint | Purpose |
|---|---|
| `GET  /api/status` | current model / permission / tools / running state |
| `GET  /api/events` | SSE stream of all run events (thinking/tool/answer/approval/ask/usage/status…) |
| `POST /api/sessions` | create a new session (optionally resume by id) |
| `GET  /api/sessions/:id/messages` | message history for a session |
| `POST /api/sessions/:id/messages` | send a message (returns 202; the run streams via SSE) |
| `POST /api/sessions/:id/cancel` | abort the running turn |
| `POST /api/sessions/:id/approval` | answer an approval request (`{ approvalId, allow }`) |
| `POST /api/sessions/:id/ask` | answer an ask_user request (`{ askId, choices }`) |
| `POST /api/settings` | change model / permission / reasoning effort / plan mode live |
| `DELETE /api/sessions/:id/delete` | delete a session |

Implementation notes: **multiple sessions run concurrently** — each session gets its own cloned
`runOpts`, undo stack, event stream and abort signal, capped globally by `webConcurrency` (default 3;
each individual session still runs only one turn at a time). The static pages are served from the
`web/` directory in dev (hot reload) and embedded in the bundle (`npm run web:sync` regenerates
`src/web/assets.ts`). `npm run probe:web` runs an offline full-protocol e2e against the mock API.

### Local run & test (Web / Electron)

```bash
# Web — dev server (no API key needed until the agent actually runs a task)
npm run dev:web        # tsx src/index.ts web --no-open  (default http://127.0.0.1:3080)
npm run probe:web      # offline e2e probe (mock API): sessions / streaming / approvals / ask / cancel / model switch / delete

# Electron desktop app
npm run build          # dist/omni.cjs — the packaged app runs this as its backend via Electron's bundled Node
npm run electron:dev   # open the desktop window against the backend (dev mode)
npm run electron:build # electron-builder package → release-electron/ (current platform; other platforms via CI)
npm run web:sync       # regenerate src/web/assets.ts after editing web/ (before bundling)

# Standard regression before release
npm run typecheck && npm run build
npm run probe:web && npm run eval:mock && npm run tui:snapshot
```

> `electron` / `electron-builder` are devDependencies. If GitHub downloads are unreachable, the repo
> ships an `.npmrc` pointing Electron binaries at the npmmirror mirror; the CI workflow sets the same
> `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` env vars.

### Electron desktop app (end users)

`omni` is a standalone desktop app that bundles the same backend (`dist/omni.cjs`, run through
Electron's own Node — no system Node needed). GitHub Actions builds it for macOS arm64/x64 (zip),
Windows x64 (NSIS installer), and Linux x64 (AppImage) on every `v*` tag; grab the artifact for
your platform from the **GitHub Releases** page:

| Platform | Artifact | Install |
|---|---|---|
| macOS Apple Silicon | `omni-<ver>-mac-arm64.zip` | unzip, drag `omni.app` into Applications |
| macOS Intel | `omni-<ver>-mac-x64.zip` | unzip, drag `omni.app` into Applications |
| Windows | `omni-<ver>-win-x64.exe` | run the installer |
| Linux | `omni-<ver>-linux-x64.AppImage` | `chmod +x` and run |

Usage: the app starts the local backend and opens the web UI in its own window. Use
**File → 选择工作目录…** to set the workspace where the agent reads/writes files, and ⚙ Settings for
model / API key / permission / reasoning level (Settings apply for the current run; permanent config
lives in `omni.json` / env vars). The Menu's 视图 → 开发者工具 opens DevTools for debugging.
If macOS Gatekeeper blocks the app at first launch (downloaded app): right-click → Open once, or
`xattr -dr com.apple.quarantine "/Applications/omni.app"`.

---

## 12. MCP External Tools

MCP (Model Context Protocol) lets you attach external tool servers; omni connects and registers
their tools at startup.

### 12.1 Configuration (stdio or HTTP)

```jsonc
{
  "mcpServers": {
    // stdio: spawn a local process and speak JSON-RPC over stdin/stdout
    "demo": { "command": "node", "args": ["scripts/mock-mcp.mjs"] },
    // streamable HTTP: talk to a remote endpoint
    "remote": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer <token>" } }
  }
}
```

A server entry needs at least one transport: `{ command, args?, env? }` for **stdio**, or
`{ url, headers? }` for **streamable HTTP**. Any stdio JSON-RPC MCP server works (e.g. the official
`@modelcontextprotocol/server-filesystem`).

Registered tools are prefixed with the server name (e.g. `demo_ping`); the model calls them on
demand, and **every call passes through the safety gate** just like a built-in tool.

### 12.2 Tool allowlist / denylist and approval mode

```jsonc
"mcpServers": {
  "demo": {
    "command": "node", "args": ["scripts/mock-mcp.mjs"],
    "enabledTools": ["ping", "echo"],   // allowlist — expose only these (default: all)
    "disabledTools": ["dangerous"],     // denylist — hide these
    "defaultToolsApprovalMode": "writes"
  }
}
```

| Mode | Behavior |
|---|---|
| `auto` (default) | follow the global permission tier |
| `prompt` | always ask before calling |
| `writes` | ask only for write-ish tools |
| `approve` | never ask — pass through |

Tools declaring `annotations.readOnlyHint` are treated as read-only and pass through where the tier
allows it.

### 12.3 Resources & Prompts

Beyond tools, omni consumes two more MCP capabilities:

- **Resources** — `/mcp resources` lists them; a companion `read_resource` tool lets the model fetch
  a resource's contents on demand.
- **Prompts** — `/mcp prompts` lists them; a companion `get_prompt` tool lets the model load a
  prompt template.

Servers that declare `instructions` have that text **injected into the system prompt**, so a server
can explain its own conventions to the model without being asked.

### 12.4 Management commands

| Command | Effect |
|---|---|
| `/mcp` | list configured servers and discovered tools |
| `/mcp resources` | list resources offered by the servers |
| `/mcp prompts` | list prompt templates offered by the servers |
| `/mcp reconnect` | reconnect (kill old processes → rediscover → rebuild the tool chain); config edits don't need a restart |
| `/mcp add <name> <command\|--url>` | add a server at runtime and persist it to config |
| `/mcp remove <name>` | remove a server |
| `/mcp login <name>` | OAuth login for HTTP servers (RFC 8414 discovery + auth-code PKCE, token persisted) |
| `/mcp install <id>` | one-click install from an MCP registry |

### 12.5 Reverse hook: omni as an MCP server

`omni mcp-server` exposes `omni_exec` (new session) / `omni_reply` (continue by `session_id`) over
stdio JSON-RPC — external harnesses such as Claude Code / opencode can use omni as a subagent
(protocol symmetric with the built-in MCP client, serialized requests to avoid races, `isError`
propagates the exit code).

---

## 13. Hooks Lifecycle Automation

Hooks attach shell commands to lifecycle events (modeled on Claude Code): the event context is fed
to the hook via **stdin**, and the command prints a JSON decision on **stdout** — rewrite the
prompt, hard-block tool calls, feed lint results back to the model, require more fixes, or send
notifications.

### 13.1 Configuration

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [{ "command": "node scripts/rewrite-prompt.mjs" }],
    "PreToolUse": [
      { "matcher": "write_file", "command": "sh scripts/guard-env.sh", "timeoutMs": 10000 }
    ],
    "PostToolUse": [
      { "matcher": "write_file", "command": "node scripts/lint-hook.mjs", "timeoutMs": 30000 }
    ],
    "Stop": [{ "command": "node scripts/require-tests.mjs" }],
    "Notification": [{ "command": "sh scripts/notify.sh" }]
  }
}
```

| Field | Description |
|---|---|
| `command` | shell command to run (required for the `command` handler type) |
| `url` | for the `http` handler type: the event JSON is POSTed here and the response body is parsed as a decision |
| `matcher` | tool-name filter (only PreToolUse/PostToolUse): `*` = all (default), `read_*` / `*_file` wildcards |
| `timeoutMs` | timeout (default 60000ms); on timeout/failure it **degrades to pass-through** — a broken hook never blocks the agent |

Two handler types are supported: **`command`** (default — spawn a shell command) and **`http`**
(`{ url, timeoutMs? }` — POST the event JSON, parse the response body as the same protocol).

Config is **merged across layers** (global + project + custom accumulate; same matcher → later
layer wins); the hook's stderr is captured and echoed too.

### 13.2 stdin context (what the hook receives)

The event context is written to the hook's stdin (or POSTed for `http` handlers) as one JSON object:

```jsonc
{
  "cwd": "/path/to/workspace",
  "hook_event_name": "PreToolUse",
  "source": "main",                 // or "subagent"
  "session_id": "20260101-abc-def",
  "tool_name": "write_file",        // tool events only
  "tool_input": { "path": "a.ts" }, // tool events only
  "tool_response": "...",           // PostToolUse / PostToolUseFailure only
  "prompt": "...",                  // UserPromptSubmit only
  "stop_hook_active": false         // Stop only: true after one continuation, prevents loops
}
```

Fields appear depending on the event; hooks should tolerate absent keys.

### 13.3 Events at a glance (12)

The authoritative list is `HOOK_EVENTS` in `src/hooks/index.ts`.

| Event | When | Key output JSON fields |
|---|---|---|
| `UserPromptSubmit` | after the user submits a prompt | `updatedPrompt` (rewritten prompt) · `hookSpecificOutput` |
| `PreToolUse` | before a tool call (**before** the safety gate) | `decision: "approve" \| "block"` (**hard block**) · `updatedInput` (rewritten args) · `hookSpecificOutput` |
| `PostToolUse` | after a tool runs | `hookSpecificOutput` (appended to the tool result, e.g. lint output for the model) |
| `PostToolUseFailure` | after a tool **fails** | `hookSpecificOutput` (diagnostics fed back so the model self-fixes) |
| `PermissionRequest` | before the approval UI is shown | `decision: "approve" \| "deny"` (short-circuits the UI; `default` / absent → show it) |
| `Stop` | agent about to finish | `decision: "continue" \| "block"` (block → require more fixes; only once, to avoid loops) |
| `Notification` | session completed (fire-and-forget) | `hookSpecificOutput` |
| `SessionStart` | once, before the first turn | `sessionStartOutput` (injected into the first system prompt) |
| `SubagentStart` | a `delegate` subagent spawns | `hookSpecificOutput` |
| `SubagentStop` | a `delegate` subagent finishes | `hookSpecificOutput` |
| `PreCompact` | before long-conversation compression | `decision: "continue" \| "block"` (block → skip this compression) |
| `PostCompact` | after compression completes (fire-and-forget) | `hookSpecificOutput` (e.g. record the new summary length) |

### 13.4 Fail-open behavior

A broken hook must never brick the agent. These are all **ignored** (pass-through):

- unknown event names;
- empty commands;
- failed process spawn;
- non-JSON stdout;
- non-zero exit codes;
- timeouts (the process is killed).

The failure reason is echoed to the terminal so you can tell a hook is misbehaving. The only
exception is an explicit `decision: "block"` / `"deny"` — that is honored, because it is the hook's
job.

### 13.5 How output reaches you and the model

Hook output is echoed to the terminal as `⚡ hook[<Event>] …`; in the TUI it renders as dim lines in
the conversation flow, **capped at 5 lines** to avoid flooding the screen. The full
`hookSpecificOutput` is still passed to the model regardless of that truncation.

Two model-visible markers you'll see in tool results:

- `[hook output]` — appended after a successful tool call (e.g. lint results);
- `Blocked (hook)` — the reason returned when a call was hard-blocked by `PreToolUse`.

### 13.6 Typical scenarios

Runnable examples live in `examples/hooks/` (see `examples/hooks/README.md` for the catalog).

1. **Auto-lint after edits** — run the linter on the file just written and feed the result back so
   the model fixes its own mistakes:

   ```jsonc
   "hooks": { "PostToolUse": [{ "matcher": "write_file", "command": "node examples/hooks/lint-hook.mjs" }] }
   ```

2. **Guard sensitive writes** — hard-block `.env` / secrets / certs no matter what the model wants.
   The call is intercepted *before* the safety gate and never executes (no side effects):

   ```jsonc
   "hooks": { "PreToolUse": [{ "matcher": "write_file", "command": "node examples/hooks/guard-env.mjs" }] }
   ```

3. **Tests must pass before stopping** — block the agent from finishing while the suite is red
   (once; `stop_hook_active` prevents an infinite loop):

   ```jsonc
   "hooks": { "Stop": [{ "command": "node examples/hooks/require-tests.mjs" }] }
   ```

4. **Rewrite the prompt** — inject project policy or extra context into every user message. The
   rewritten prompt is what the model sees; the UI still echoes what you typed:

   ```jsonc
   "hooks": { "UserPromptSubmit": [{ "command": "node examples/hooks/rewrite-prompt.mjs" }] }
   ```

5. **Session-complete notification** — fire-and-forget, never blocks the flow:

   ```jsonc
   "hooks": { "Notification": [{ "command": "sh examples/hooks/notify.sh" }] }
   ```

6. **Guard destructive commands** — hard-block `rm -rf /`, disk wipes and friends. Complements the
   built-in `safe` tier: this is **enforced by rule**, not model discretion:

   ```jsonc
   "hooks": { "PreToolUse": [{ "matcher": "run_command", "command": "node examples/hooks/guard-dangerous.mjs" }] }
   ```

7. **Block `git push`** — stop the agent from pushing to a remote and remind the user to push:

   ```jsonc
   "hooks": { "PreToolUse": [{ "matcher": "run_command", "command": "node examples/hooks/guard-git-push.mjs" }] }
   ```

### 13.7 Testing hooks

`scripts/mock-hook.mjs` is a mock hook for exercising the pipeline without writing your own; it
accepts a mode argument covering the interesting outcomes:

`pass` · `block` · `updated` · `output` · `rewrite` · `notify` · `fail` · `slow`

Unit and end-to-end coverage for the hook system lives in `scripts/probe-tmp/probe-hooks.ts`.

---

## 14. Skills (SKILL.md)

A skill is a `SKILL.md` instruction file with frontmatter; the model loads and executes it on
demand (modeled on opencode).

### Discovery locations

- Project: search `.opencode/skills/`, `.claude/skills/`, `.agents/skills/` above cwd — `<name>/SKILL.md`;
- Global: `~/.config/opencode/skills/`, `~/.config/omni/skills/`, etc.

The system prompt only carries the skill manifest (name + description); the model loads full text by
name via the `skill` tool — a long manifest never bloats the context.

### Management commands

```bash
/skill                 # list discovered skills (name + description + global marker)
/skill find typescript # npx skills online search on skills.sh
/skill add owner/repo --skill <name>   # install into .agents/skills/ (auto-discovered next session)
/skill show <name>      # view contents
```

---

## 15. Subagents & Orchestration

The `delegate` tool hands an independent subtask to an **isolated-context mini-loop** (separate
message history, no UI, shared safety gate). Subagents support **nesting** (a subagent may delegate
again, depth cap 5), **skill preload**, and **per-agent configuration**.

### Subagent definitions (`.agents/subagents/*.md`)

Drop a Markdown file with frontmatter into the project `.agents/subagents/` (or global
`~/.config/omni/subagents/`) to define a named subagent; `delegate` loads it by name via the
`agent` parameter (see `examples/subagents/reviewer.md`):

```markdown
---
name: reviewer          # must match the filename
model: ""               # optional: per-agent model (falls back to current model)
permission: read        # optional: full / safe / ask / read (defaults to parent's permission)
tools:                  # optional: tool whitelist (default = full default tool chain)
  - read_file
  - list_directory
  - search_code
maxSteps: 15            # optional: step cap (defaults to the main loop's maxSteps)
skills: []              # optional: skill names to preload (SKILL.md full text injected into system)
---

(Body = the subagent's system prompt, i.e. its role definition)
```

`/agents` lists discovered definitions; `/agents <name>` expands a definition's full role
(frontmatter + tool whitelist + instruction body) before delegating. `delegate` without the `agent`
parameter behaves like the legacy generic subagent.

**Execution preview**: while delegating, the delegate card in the conversation stream shows the
current action live (`subagent X · ⠋ run_command 3/10` — the tool being called + step count); on
completion the collapsed card shows the result summary directly (command line + `✓ subagent X · 2
steps · first line of result`), click to expand for full output; the precise nesting tree lives in
the console/web `/trace` ledger.

### Model routing (architect / editor)

Config accepts `architect` (strong model for planning) and `editor` (cheap model for execution):
`/plan` plan mode automatically uses the architect, execution uses the editor; both fall back to
the current model when unset (no config = always the current model).

### Orchestration & loop tasks

```bash
/orchestrate <task>   # fan-out parallel delegates (default 3 workers) → merge → adversarial review → final report
/goal <goal>          # goal mechanism: derive acceptance criteria and loop until met (iteration log + verdict feedback; alias /loop)
```

### 15.4 Worktree isolation

By default a subagent writes into your working tree, which means several parallel delegates can
collide on the same files. The `delegate` tool accepts a `worktree` argument to isolate it:

- `worktree: true` — creates `git worktree add <repo-root>/.omni/worktrees/<branch> -b <branch>`
  with an auto-generated branch name (`omni-wt-<id>-<ts>`);
- `worktree: "<branch>"` — same, but uses your branch name;
- `cleanup: true` — remove the worktree when the subagent finishes (default **false**, so you can
  inspect or merge the diff yourself).

All tool calls inside that subagent run with the worktree as their cwd, so it cannot touch your
working tree. When it finishes, the result reports the changed files and how to merge them back.

If worktree creation fails (not a git repo, target already exists, …), the delegate returns an error
suggesting you drop the `worktree` argument and delegate inside the workspace instead.

> In the web UI you can also create a worktree and switch the workspace to it via
> **POST `/api/git/worktree`** (`{ "path"?, "branch"? }`).

---

## 16. FAQ & Troubleshooting

### Q1: Startup error "API key not found"?

Set the `OMNI_API_KEY` env var, or write an `apiKey` field in `omni.json`; with multi-model
endpoints, a key under `models.<model-name>.apiKey` also works.

### Q2: Gateway WAF blocking (403/timeouts)?

Many third-party gateways block the SDK's default User-Agent; set a browser UA to bypass:

```jsonc
{ "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" }
```

### Q3: The model rejects `reasoning_effort` (error)?

Omni automatically falls back to omitting the parameter (same fallback pattern as
`stream_options`); you can also remove the `reasoningEffort` field from your config.

### Q4: TUI doesn't enter full-screen / mouse clicks don't work?

- The TUI requires a **real TTY** (pipes/redirection/`script` pseudo-terminals fall back to console
  or disable mouse mode);
- Use a TUI-capable build (`npm run dev:tui` / the TUI npm package / the native binary); the console
  package has no TUI.

### Q5: Want to see exactly what the model receives?

```bash
OMNI_DEBUG=1 omni "<task>"
```

The full request body prints to stderr; `/doctor` checks Node/bun versions, key, endpoint
connectivity, and config sources in one go.

### Q6: Conversation too long — slow / blowing the context?

Automatic summarization is on by default (`summarizeAt: 40`); `/compact` compresses manually;
`/context` shows current usage and advice relative to the threshold.

### Q7: Config changes not taking effect?

Check [precedence](#41-layering--precedence) for a higher layer overriding you (env vars > config
files > CLI args); `/config` shows each layer's path and the actual source; `OMNI_DEBUG=1` shows
the loaded result.

### Q8: Crash or abnormal exit?

- Audit log: `~/.config/omni/audit.log`;
- TUI crash log: `~/.config/omni/tui-crash.log`;
- Last thinking dump: `.omni/last-thinking.md`.

### Q9: No key locally — want to try it out?

```bash
npm run mock        # start a local mock API (port 8787)
OMNI_BASE_URL=http://127.0.0.1:8787/v1 OMNI_API_KEY=sk-mock omni "<test task>"
```

### Q10: How to explore a project read-only (zero-risk)?

In interactive mode, run `/permission low` (read tier: read-only tool whitelist) first, then send
your task — zero-risk exploration; for one-off use, `--no-tui` plus self-checks: `/doctor` for the
environment, `/diff` for changes.

---

## 17. Tools Overview

Omni's tools come from four sources. The static registry is `src/tools/index.ts`; the rest are
injected at runtime by `attachRuntime`.

### 17.1 Static tools (7)

| Tool | Purpose |
|---|---|
| `read_file` | read a file by line range (`offset` / `limit`) |
| `write_file` | create or fully overwrite a file |
| `edit_file` | targeted edits to an existing file |
| `list_directory` | list directory contents |
| `search_code` | code search (ripgrep first, built-in scan fallback) |
| `run_command` | run a shell command (timeout + output truncation; interception lives in the safety gate) |
| `skill` | load a skill's full SKILL.md by name (read-only; replaced at runtime to support `context: fork` subagent execution) |

### 17.2 Context tools (always injected)

| Tool | Purpose |
|---|---|
| `ask_user` | ask the user a question — surfaces as an option panel (TUI) or a prompt (console); the answer is fed back to the model |
| `todo_write` | structured task list the model maintains (`pending` / `in_progress` / `completed`) |
| `web_fetch` | fetch a URL and convert it to text (domain allowlist via `webFetchDomains`) |
| `diagnose` | run a quick typecheck / lint / test and return the diagnostic summary so the model can self-fix |

### 17.3 Trust- and config-gated tools

| Tool | Injected when | Purpose |
|---|---|---|
| `memory_search` | workspace is **trusted** | multi-keyword AND search over memory, ranked by hits |
| `memory_read` | workspace is **trusted** | read a full memory file by path |
| `delegate` | `allowSubagents: true` **and** workspace trusted | hand a subtask to an isolated subagent (see section 15) |
| `mcp_<server>_<tool>` | a server is configured in `mcpServers` | external MCP tools (see section 12) |

The trust gate is deliberate: an untrusted repository must not be able to reach into (or pollute)
your memory through these tools.

`skill` is also removed entirely when `skills: false` or the workspace is untrusted.

### 17.4 Output limits

Tool results longer than 8000 characters are truncated with a hint to use `read_file` for targeted
reads, so a single noisy command cannot blow up the context window.

---

## Appendix: Useful resources

| Resource | Location |
|---|---|
| Config example | `omni.example.jsonc` |
| Hooks example scripts | `examples/hooks/` (guard-env / guard-dangerous / guard-git-push / lint-hook / require-tests / rewrite-prompt) |
| CI workflow template | `examples/ci/omni-fix-ci.yml` + `examples/ci/README.md` |
| Developer guide / architecture | `AGENTS.md` at the repo root |
| Mock API | `scripts/mock-server.mjs` (`npm run mock`, port 8787) |
| Backlog | `Doc/TODO.md` |

## 1.0 New Capabilities

> Model layer (providers/metadata/variants), sandbox 2.0, web multi-session concurrency,
> subagent worktree isolation, hooks extension, structured memory, compaction 2.0, LSP feedback,
> MCP annotations/registry, presets, spec trio, telemetry, protocol freeze + omni-action.
> Full reference: `README.md` · `AGENTS.md` · `Doc/Headless-Protocol.md` · `config.schema.json`.

| Area | What's new | Where |
|---|---|---|
| Model config | `providers` group (one baseURL, many models, `{env:VAR}` keys); per-model `limit`/`modalities`/`capabilities`/`apiModel`/`displayName`/`disabled`; named `variants` overlays; `limit.output` drives `max_tokens`; multimodal pre-check | `omni.example.jsonc` · `/model fetch` · `/variants` |
| Sandbox | `sandboxNetworkAllow` (hostname allowlist via built-in CONNECT proxy; TLS untouched), `sandboxFailClosed`, `sandboxMaskEnv`, policy-file write guard | `sandbox` config |
| Web | multiple sessions run concurrently (per-session undo/events/abort; global cap `webConcurrency`); buttons for fork / export / checkpoints (/rewind panel); model metadata in dropdowns | `omni web` UI |
| Subagents | `delegate` `worktree` param (auto `git worktree add`, tools run inside via `ToolContext.cwd`, diff+merge hints, `cleanup`) | prompt the model; docs |
| Hooks | `PermissionRequest` / `PostCompact` / `PostToolUseFailure`; `http` handler type (POST JSON) | `hooks` config |
| Memory | global memory = `MEMORY.md` index + `topics/*.md` (+ `globs` conditional injection, TTL archive); legacy `AGENTS.md` read-only | `~/.config/omni/memory/` |
| Context | compaction triggered by context-window ratio (`limit.context`) + tool-result folding | auto |
| MCP | tool `annotations.readOnlyHint` pass-through; `/mcp install <id>` registry one-click | `/mcp` |
| Presets / spec | `omni preset browser`; `/spec <feature>` (requirements-EARS/design/tasks under `.omni/specs/`) | CLI + TUI + Web |
| Telemetry | opt-in OTLP/HTTP JSON (`telemetry.enabled` + `endpoint`), redacted by default | config |
| Headless freeze | `schemas/*.v1.json` + `config.schema.json` + `omni-action` + `Doc/Headless-Protocol.md`; exec json adds `tokens`/`idle_turns`/`error_type` | `omni exec --output-format json` |
| Install | `scripts/install.sh` (curl one-liner, native binary) · `packaging/homebrew/omni.rb` · `scripts/make-winget-manifests.mjs` | scripts/ + packaging/ |

Quick wins worth trying:
```bash
omni preset browser                                  # browser automation pair into global config
omni exec "analyze this" --output-format json       # structured result incl. tokens / error_type
omni web                                             # then: 检查点 · 分叉 · 多会话并行
/spec "login flow"                                   # spec trio under .omni/specs/ (TUI/CLI/Web)
/model fetch                                         # discover gateway models
```
