# Omni

[English](README.md) | [中文](README.zh-CN.md)

![Node >= 18](https://img.shields.io/badge/Node-18%2B-brightgreen?style=flat-square) [![License](https://img.shields.io/badge/license-BSD--3--Clause-blue?style=flat-square)](LICENSE)

Omni is a terminal-based AI coding assistant: it reads your codebase, edits files, runs commands, and finishes programming tasks through natural language — with safety guardrails on every step.

![Omni TUI](Doc/images/tui.png)
![Omni mini](Doc/images/mini.png)

## Quickstart

1. Install (pick one):

```bash
# Native binary, zero dependencies (includes full TUI)
curl -fsSL https://raw.githubusercontent.com/jacksonon/omni/main/scripts/install.sh | sh

# Or: npm package (console, requires Node >= 18)
npm install -g ./omni-<version>.tgz   # built via `npm pack`
```

2. Set your API key (any OpenAI-compatible endpoint works):

```bash
export OMNI_API_KEY=sk-xxx
export OMNI_BASE_URL=https://api.deepseek.com/v1   # optional, defaults to OpenAI
```

3. Run it:

```bash
omni "show me the structure of this directory"   # single task
omni                                             # interactive session
```

No key at hand? `npm run mock` starts a local mock API for keyless end-to-end runs.

## Modes

| Command | What it is |
|---|---|
| `omni` | Full-screen TUI: scrollable history, Markdown rendering, click-to-expand tool cards, `/` commands + `@` file mentions |
| `omni mini` | Pure terminal CLI (Codex CLI style): same runtime, plain scrollback lines, `Ctrl+T` for the full transcript |
| `omni exec "<task>"` | Headless mode for scripts/pipes/CI: stdout carries only the result (`--output-format text\|json\|stream-json`) |
| `omni web` | Local backend (REST + SSE) + browser UI, multi-session sidebar |
| Desktop app | Standalone Electron app (mac/win/linux) from GitHub Releases, no Node needed |

## Features

- **Agent loop**: streams the model → runs tool calls in parallel → feeds results back; failures are returned to the model so it fixes its own mistakes
- **Tools**: files (`read`/`write`/`edit`), `search_code`, `run_command`, `skill`, `lsp` navigation, plus runtime tools (`delegate` subagents, MCP, `web_fetch`/`web_search`, `ask_user`, team board)
- **Safety first**: permission tiers (`full`/`safe`/`ask`/`read`), dangerous-command confirmation, approval UI, audit log, workspace trust, OS-level sandbox
- **Memory & sessions**: `AGENTS.md` project/global memory cascade, JSONL session persistence with resume/fork/rewind
- **Multi-model**: `providers` groups (one gateway, many models), `/model` switching, Completions + Responses protocols, reasoning levels
- **Extensible**: MCP servers, lifecycle hooks, skills, plugins, headless `exec`/`mcp-server` for CI

## Configuration

JSON/JSONC, precedence: defaults → global (`~/.config/omni/omni.json`) → project (`omni.json`) → env vars → CLI args.

```jsonc
{
  "model": "deepseek-chat",
  "permission": "safe",
  "providers": {
    "bigmodel": { "baseURL": "https://open.bigmodel.cn/api/paas/v4", "apiKey": "{env:GLM_KEY}",
      "models": { "glm-4-flash": {} } }
  }
}
```

Full field reference: [`omni.example.jsonc`](omni.example.jsonc).

## Docs

| Doc | Content |
|---|---|
| [`Doc/Usage-Guide.md`](Doc/Usage-Guide.md) · [`Doc/使用指导.md`](Doc/使用指导.md) | User manual (setup, commands, MCP, hooks, skills, FAQ) |
| [`Doc/architecture.md`](Doc/architecture.md) · [`Doc/架构.md`](Doc/架构.md) | Module-by-module architecture reference |
| [`Doc/Headless-Protocol.md`](Doc/Headless-Protocol.md) | Headless `exec` / `mcp-server` protocol |
| [`Doc/roadmap.md`](Doc/roadmap.md) | Roadmap |

## Development

```bash
npm run dev -- "<task>"   # run from source (tsx)
npm run typecheck         # type checking
npm run build             # typecheck + compile + bundle
npm run eval:mock         # offline evaluation (deterministic, CI-friendly)
```

## License

[BSD-3-Clause](LICENSE).
