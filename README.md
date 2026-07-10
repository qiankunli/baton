# baton

[English](README.md) | [简体中文](README.zh-CN.md)

> Pass context between coding agents like a baton.

baton is a terminal-native coding-agent session. A BatonSession remains the same durable conversation while you switch providers with `/provider`, including after closing and reopening baton. Claude Code and Codex are the first bundled providers, not a closed support list.

Provider-native sessions are resume optimizations; BatonSession history remains available even when a native session cannot be resumed.

## Features

- Use Claude Code and Codex from the same terminal interface
- Switch between Claude Code and Codex with `/provider`, and configure the active provider with `/model`
- Open a previous BatonSession with `/sessions`, or start a clean one with `/new`
- Continue the latest session in a project with `baton -c`, or open one by ID with `baton -s <id>`
- Reference previous sessions with `@<session-id>` and inject a compact summary automatically
- Record messages, thoughts, tool calls, file changes, plans, and token usage in a unified format
- Append events to a local `session.jsonl` for state reconstruction and future references
- Reuse local Claude Code and Codex credentials without storing them in baton
- Use a headless REPL to debug agent integrations

## Requirements

- [Bun](https://bun.sh/)
- At least one supported agent installed and authenticated:
  - [Codex CLI](https://github.com/openai/codex)
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)

## Local installation

```bash
git clone https://github.com/qiankunli/baton.git
cd baton
bun install
bun link
```

Then start baton directly:

```bash
baton
```

You can also run it from the repository without linking:

```bash
bun run tui
```

## Usage

Start the TUI and type a prompt to send it.

```text
/provider            Open the provider picker
/provider claude     Switch to Claude Code
/provider codex      Switch to Codex
/model               Open the model picker for the active provider
/model <id>          Select the model used by subsequent turns
/sessions            Open the BatonSession picker
/new                 Start a new BatonSession in the current project
@bs_...               Reference another baton session
Tab                   Complete a command or reference
Esc                   Interrupt the current turn
/exit                 Exit
```

Common CLI commands:

```bash
baton                              # Start the TUI
baton --cwd /path/to/project       # Start in a specific project directory
baton -c                           # Continue the latest session in this directory
baton -s bs_01...                  # Open a specific BatonSession
baton repl --agent codex           # Start the headless REPL with Codex
baton repl --agent claude          # Start the headless REPL with Claude
baton sessions                     # List sessions available for reference
baton help                         # Show full help
```

Reference an ID returned by `baton sessions` in your prompt:

```text
@bs_01... Implement this feature based on Claude's earlier analysis
```

baton reads the referenced session's compact summary and passes it to the active provider as context.

## Configuration

On first run, baton creates `~/.baton/config.yaml`:

```yaml
defaultAgent: codex
codexCommand:
  - codex
  - app-server
mentionBudgetChars: 4096
showThoughts: true
```

If Claude Code uses a custom executable, set `claudeExecutable` in the configuration or override it temporarily with an environment variable:

```bash
BATON_CLAUDE_BIN=/path/to/claude baton
```

Configuration precedence: environment variables > `config.yaml` > defaults.

## Data storage

baton stores its data in `~/.baton/` by default:

```text
~/.baton/
├── config.yaml
└── sessions/<session-id>/
    ├── meta.json
    └── session.jsonl
```

`session.jsonl` is the durable logical history used for rendering, recovery, provider handoff, and cross-session references. Claude Code and Codex still manage their private native sessions; baton stores their IDs only to accelerate resume and never modifies their native session files.

## Development

```bash
bun install
bun run check        # TypeScript type checking + unit tests
bun run repl -- --agent codex
bun run tui
```

See [docs/design.md](docs/design.md) for the architecture, event model, Adapter design, and roadmap.

## License

Apache-2.0
