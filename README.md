# baton

[English](README.md) | [简体中文](README.zh-CN.md)

> Pass context between coding agents like a baton.

baton is a terminal-native shared workspace for multiple coding agents. It runs Claude Code and Codex in the same TUI and lets one agent reference another agent's session context with `@`, eliminating the need to copy conversations, write handoff documents, or repeatedly explain background information.

baton is not about opening more agents at once. It is about helping them truly share context.

## Features

- Use Claude Code and Codex from the same terminal interface
- Switch between Claude Code and Codex with `/provider`, and configure the active provider with `/model`
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
@bs_...               Reference another baton session
Tab                   Complete a command or reference
Esc                   Interrupt the current turn
/exit                 Exit
```

Common CLI commands:

```bash
baton                              # Start the TUI
baton --cwd /path/to/project       # Start in a specific project directory
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

On first run, baton creates `~/.baton/settings.json`:

```json
{
  "defaultAgent": "codex",
  "codexCommand": ["codex", "app-server"],
  "mentionBudgetChars": 4096,
  "showThoughts": true
}
```

If Claude Code uses a custom executable, set `claudeExecutable` in the configuration or override it temporarily with an environment variable:

```bash
BATON_CLAUDE_BIN=/path/to/claude baton
```

Configuration precedence: environment variables > `settings.json` > defaults.

## Data storage

baton stores its data in `~/.baton/` by default:

```text
~/.baton/
├── settings.json
└── sessions/<session-id>/
    ├── meta.json
    └── session.jsonl
```

`session.jsonl` is the event projection used for rendering, recovery, and cross-agent references. Claude Code and Codex continue to manage their native sessions, and baton never modifies the providers' native session files.

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
