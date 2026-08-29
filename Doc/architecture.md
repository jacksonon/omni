# Omni Architecture

> Developer documentation. For user-facing docs see
> [`Usage-Guide.md`](Usage-Guide.md) (English) · [`使用指导.md`](使用指导.md) (中文) ·
> Chinese version of this file: [`架构.md`](架构.md).

This is the **authoritative source for architecture**. `README.md` and `AGENTS.md` both point
here instead of carrying their own copies of the source tree.

---

## 1. Positioning

Omni is an **agent engineering project** — a terminal-based AI coding assistant. Stack is
TypeScript strict · ESM (NodeNext) · bare `openai` SDK · `@opentui/core` (imperative rendering) ·
zero framework dependencies.

Design principles:

- **Cognition first** — code is the implementation of a reasoning dialogue; keep it minimal and
  readable, don't introduce abstractions for architectural aesthetics.
- **Swappable backends** — `OMNI_BASE_URL` works with any OpenAI-protocol service
  (OpenAI / DeepSeek / Zhipu / Moonshot / Grok …).

The agent requires **no framework**: a bare OpenAI SDK plus a main loop.

---

## 2. Layered overview

```
   入口层   index.ts (CLI)  ──  exec.ts (headless)  ──  web/index.ts  ──  tui-entry.ts
              │                     │                        │                  │
   运行时层 main.ts attachRuntime（安全闸门 + MCP 发现 + delegate 注入 + 上下文准备）
              │                     client.ts（按模型端点建客户端，/model 切换时重建）
              ▼
   Agent 层   agent/loop.ts ──  context.ts（记忆/预载/压缩） ──  subagent.ts（隔离嵌套）
              │                     │
   工具层     tools/*（静态 7 个 + 运行时注入 delegate / mcp_*）
              │
   安全层     safety/（权限分级 · 审批 · 审计 · 工作区信任 · OS 沙箱）   hooks/（生命周期）
              │
   输出层     output/console.ts  │  tui/output.ts  │  web/output.ts  │  exec（机器可读）
```

The four output backends are interchangeable implementations of the same `Output` interface,
which is why the CLI, TUI, web UI and headless mode share one agent core.

---

## 3. Source tree

Generated from the working tree (94 `.ts` files under `src/`).

```
src/
  index.ts           # CLI entry: args → config → client → one-shot / interactive / exec / mcp-server / web
  main.ts            # attachRuntime: safety gate + MCP tool discovery + delegate injection + context prep
  client.ts          # OpenAI client factory, built per model endpoint; rebuilt when /model switches endpoint
  exec.ts            # Headless `omni exec` + `omni mcp-server` (omni_exec / omni_reply)
  acp.ts             # ACP protocol adapter
  telemetry.ts       # Opt-in OTLP/HTTP JSON exporter (redacted by default, fire-and-forget)
  ui.ts              # Terminal UI: ANSI colors, TTY detection, spinner, window title (OSC 0)
  tui-entry.ts       # TUI entry (pure TS, no JSX): TTY gating + console fallback
  version.ts         # Version constant

  agent/
    loop.ts          # **Agent main loop**: stream LLM → tool calls (parallel) → safety gate → execute → feed back
    context.ts       # Context: memory cascade injection + relevant-file preload + summarization
    messages.ts      # Message assembly: assistant message construction, tool arg parsing
    thinking.ts      # Thinking: streamed display + save to disk (reasoning + reasoningMs duration fields; restored sessions replay thinking blocks with a "· duration" header)
    memory.ts        # Global/project memory cascade, nested AGENTS.md, auto-extract on exit
    memory-topics.ts # Structured memory: MEMORY.md index + topics/*.md + globs conditional injection
    session.ts       # Session persistence: JSONL on disk + list / latest / restore by id
    session-fork.ts  # /fork: branch a new session from a point in history
    rewind.ts        # /rewind: checkpoints + rollback
    events.ts        # EventRecorder: in-memory trace + `{"t":"ev"}` lines appended to session file
    trace.ts         # foldTrace → TraceRow projection (for /trace panel and console ledger)
    subagent.ts      # Subagent: isolated-context nested loop, shared safety gate, depth cap
    subagent-defs.ts # Subagent definitions: .agents/subagents/*.md frontmatter parsing
    orchestrate.ts   # /orchestrate fan-out pipeline + /goal acceptance-criteria loop
    skill.ts         # Skills: SKILL.md discovery, frontmatter, progressive disclosure, npx skills CLI
    init.ts          # /init [--global] [<subdir>]: scan project → LLM generates AGENTS.md
    repomap.ts       # Repo map: symbol map injected on the first turn
    review.ts        # /review: typecheck + git diff → LLM review
    report.ts        # Shared logic for /status /context /export /doctor /config
    spec.ts          # /spec: requirements-EARS / design / tasks trio
    preset.ts        # `omni preset browser` capability presets
    title.ts         # Session title: generated async after the first turn
    watch.ts         # File watching
    types.ts         # Shared types (RunOptions, ThinkingDisplay)

  tools/
    index.ts         # Static tool registry (register new tools here)
    types.ts         # Tool interface (separate file to avoid circular imports)
    util.ts          # Shared helpers: num / resolvePath / truncate / TOOL_OUTPUT_LIMIT
    read-file.ts     # read_file
    write-file.ts    # write_file
    edit-file.ts     # edit_file (targeted edits)
    list-directory.ts# list_directory
    search-code.ts   # search_code (ripgrep first, built-in scan fallback)
    run-command.ts   # run_command (timeout + output truncation; interception lives in safety/policy)
    diagnose.ts      # diagnose: probe typecheck → lint → test, return diagnostic summary
    todo.ts          # todo_write: structured task list the model maintains
    web-fetch.ts     # web_fetch: URL → text (domain allowlist via webFetchDomains)
    memory-tools.ts  # memory_search / memory_read — progressive memory disclosure
    skill.ts         # skill: load full SKILL.md by name
    ask.ts           # ask_user: ask the user a question (runtime-injected callback)
    delegate.ts      # delegate: hand a subtask to an isolated subagent (runtime-injected)
    mcp.ts           # MCP client: stdio + streamable HTTP, runtime tool discovery
    mcp-oauth.ts     # MCP OAuth login: RFC 8414 discovery + auth code PKCE
    undo.ts          # /undo snapshots: UndoStack + applyUndo + redo stack

  safety/
    index.ts         # Safety gate: policy decision + approval callback + audit record
    policy.ts        # Permission tiers (full/safe/ask/read) + dangerous-command detection
    audit.ts         # Audit log on disk (~/.config/omni/audit.log)
    trust.ts         # Workspace trust: trust list, untrusted = read-only + skip project config
    sandbox.ts       # OS-level sandbox: sandbox-exec (macOS) / bwrap (Linux) wrapping run_command
    netproxy.ts      # Sandbox network allowlist filtering proxy (CONNECT by hostname, TLS untouched)

  hooks/
    index.ts         # HookRunner: JSON protocol over stdin/stdout, 12 events, wildcard matchers,
                     # layered config merge, timeout/failure degrade to pass-through

  config/
    index.ts         # Config loading: layered merge (permission/audit/context/subagent/MCP fields)
    jsonc.ts         # JSONC parsing (comments / trailing commas)
    discover.ts      # Config discovery: in-directory lookup + upward from cwd
    write.ts         # Config persistence (model add, workspace, provider writes)
    model-context.ts # Model capability detection: 3-tier match, context window / effort derivation
    model-context-builder.ts  # Snapshot build logic (shared by generator script and /models refresh)
    model-context-snapshot.ts # Offline models.dev snapshot (generated, committed to repo)

  output/
    types.ts         # Output interface — implemented by console / TUI / web / headless
    console.ts       # ConsoleOutput
    format.ts        # Shared formatting (tool cards)

  cli/
    args.ts          # Arg parsing (-m/-c/-h/-v) + help text
    banner.ts        # Startup banner (version / model / tools / permission / config source)
    interactive.ts   # Console interactive mode: readline loop, keeps context across turns
    import-claude.ts # Import from Claude Code config

  tui/
    render.ts        # Render orchestration: mountTree / repaintTree / startTui
    rows.ts          # Content row construction: cards, approval cards, click hit-testing (pure)
    layout.ts        # Layout constants + wrapping/truncation math by display columns
    state.ts         # TUI state (plain object, no reactive deps)
    interactive.ts   # TUI interactive mode: input submit + command/approval keys + multi-turn
    commands.ts      # Slash-command registry + command panel interaction
    output.ts        # TuiOutput: events → state → 30ms throttled repaint + flush before exit
    markdown.ts      # Line-based Markdown rendering (tables, lists, code blocks)
    mention.ts       # `@` file-mention overlay
    shortcuts.ts     # Keyboard shortcuts help
    pending.ts       # Pending/steer message queue
    trace.ts         # Trace panel (right sidebar)
    theme.ts         # Theme palette (system/light/dark)
    i18n.ts          # UI strings (zh/en)
    width.ts         # Display-width helpers (CJK aware)
    crashlog.ts      # Crash log to disk

  web/
    index.ts         # `omni web` entry: parse args → prepareRun → attachRuntime → open browser
    server.ts        # REST + SSE backend on Node's built-in http (zero deps), multi-session concurrency
    output.ts        # WebOutput: events broadcast with sessionId; approvals/asks via pending registry
    events.ts        # Web event protocol — single source of truth for event names and payloads
    assets.ts        # Embedded page assets (copy of web/, regenerated by npm run web:sync)

electron/            # Desktop app (repo root, not src/): main.cjs + preload.cjs
                     # spawns dist/omni.cjs web via Electron's bundled Node (ELECTRON_RUN_AS_NODE)
web/                 # Browser pages (repo root): index.html + style.css + app.js + vendor.js
                     # vanilla HTML/CSS/JS, zero framework — the source for src/web/assets.ts
scripts/             # mock-server / mock-mcp / mock-hook, tui-snapshot, pack-tui, publish-npm, eval
packages/            # omni-tui (TUI npm package) · npm/omnicode (published @right-ai/omni)
```

---

## 4. Core loop (`src/agent/loop.ts`)

```
for step in 1..maxSteps:
  1. Stream the LLM (full message history + system prompt)
  2. No tool calls → emit the final answer, done
  3. Tool calls → parse JSON args → execute in parallel (Promise.all)
     · every call passes the Safety gate first (permission tier + approval + audit)
  4. Feed results back as role=tool in the original order → back to 1
```

Key mechanisms:

- **Self-correction** — tool failure/refusal messages are returned to the model as tool results, so
  it fixes its own mistakes.
- **Safety gate** — every tool call (including MCP tools and subagents) goes through `Safety.gate`.
- **Parallel tools** — multiple `tool_calls` in one response execute concurrently; results are fed
  back in call order.
- **Truncation** — tool results over 8000 chars are truncated with a hint to use `read_file` for
  targeted reads, preventing context blowup.
- **Dead-loop guard** — `maxSteps` cap (default 50; typical tasks finish within 15).

---

## 5. Lifecycle of one request

```
args → config (layered: defaults → global → project → custom → env → CLI)
     → createClient (per model endpoint)
     → prepareRun / attachRuntime
          ├─ Safety gate
          ├─ MCP tool discovery (stdio / streamable HTTP)
          ├─ delegate injection (if allowSubagents)
          └─ context prep (memory cascade, relevant-file preload, repo map, skills manifest)
     → agent loop (stream → tools → feed back)
     → Output implementation (console / TUI / web SSE / headless)
```

Hooks fire at lifecycle points around this: `UserPromptSubmit` before the prompt is seen,
`PreToolUse` before each gated call, `PostToolUse` after, `Stop` when the agent is about to finish,
`Notification` when the session completes. See `Usage-Guide.md` §13 for the full 12 events.

---

## 6. Subsystem pointers

Deep implementation details live in their own documents:

| Subsystem | Document |
|---|---|
| TUI rendering (OpenTUI pitfalls, layout math, cell pooling, overlays) | [`tui-architecture.md`](tui-architecture.md) |
| Build & release (bundle / compile / npm / Electron / CI) | [`release-guide.md`](release-guide.md) |
| Headless protocol freeze (JSON Schemas, exec result, stream-json) | [`Headless-Protocol.md`](Headless-Protocol.md) |
| User manual (install, config, commands, MCP, hooks, skills, FAQ) | [`Usage-Guide.md`](Usage-Guide.md) · [`使用指导.md`](使用指导.md) |
| Roadmap and backlog | [`roadmap.md`](roadmap.md) · [`TODO.md`](TODO.md) |
| Iteration history | [`evolution-log.md`](evolution-log.md) |

---

## 7. Common development commands

```bash
npm run dev -- "<task>"      # dev run (tsx)
npm run typecheck            # TypeScript type check
npm run build                # typecheck + tsc + bun single-file bundle → dist/omni.cjs
npm start -- "<task>"        # run the tsc output
npm run mock                 # local mock API server (port 8787, keyless end-to-end)

npm run dev:tui -- "<task>"  # full-screen TUI (bun + real TTY)
npm run tui:snapshot         # TUI snapshot tests (in-memory render assertions)
npm run bundle               # single-file JS bundle
npm run compile              # native binary → release/omni (bun compile)
npm run bundle:tui           # TUI bundle → packages/omni-tui/dist
npm run pack:tui             # version sync + bundle + npm pack → omni-tui-<version>.tgz
npm run pack:tui:compile     # package + native binary

npm run dev:web              # web service (default http://127.0.0.1:3080, no browser)
npm run web:sync             # rebuild vendor.js + sync web/ → src/web/assets.ts
npm run probe:web            # web protocol e2e probe (offline, mock API)
npm run electron:dev         # Electron desktop app (dev)
npm run electron:build       # package with electron-builder → release-electron/

npm run eval                 # evaluation: real API task suite + completion report
npm run eval:mock            # evaluation: offline mock (deterministic, CI-friendly)
npm run test:features        # feature tests
npm run models:snapshot      # rebuild the model capability snapshot from models.dev
```

Packaging requires **bun** (`bundle` / `compile` / `npm pack` all call it); dev runs do not.

Build artifacts (see `release-guide.md`): `dist/omni.cjs` (single-file JS, console) ·
`release/omni` (native binary, TUI) · `omni-<version>.tgz` (console npm package) ·
`omni-tui-<version>.tgz` (TUI npm package) · Electron desktop apps (`release-electron/`).

---

## 8. Maintenance

When you change **architecture, modules, or commands**, update this file (and `架构.md`) in the
same change — it is the authoritative source that `README.md` and `AGENTS.md` point to.
When adding a tool, also register it in `tools/index.ts` and update the tool table in the manuals.
