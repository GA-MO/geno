# Geno

Geno is a coding agent for VS Code. You describe a task in plain language, and Geno reads files, edits them and runs commands in your workspace until the task is done. The same engine also runs from the command line and in a browser.

**Documentation: [ga-mo.github.io/geno](https://ga-mo.github.io/geno/)** — *How Geno works*, a walk through real runs step by step: what you do, what the model does, what Geno does, and what you see at each point. The documentation is written in Thai.

## Features

- **Chat agent in VS Code.** Geno works in your folder with file, search, edit and shell tools, and streams each step into the chat panel.
- **Approval modes.** Plan reads and runs only clearly safe commands, and changes nothing. Ask asks you before any command that is not on the safe list or a saved allow rule. Auto runs safe commands itself, runs in the sandbox any command that no rule flags, and has a classifier model judge the rest; it still asks before it deletes the workspace, its `.git`, or a path outside it. Ask and Auto apply edits without asking; the sandbox and checkpoints cover them.
- **Review and undo.** Keep or undo each change by hunk, by file or for the whole session, compare a file with its checkpoint, or undo a whole turn.
- **Cmd-K and Tab.** Edit a selection in place with Cmd-K Cmd-I (Ctrl-K Ctrl-I). Tab shows ghost-text completions from a local model that `llama-server` serves.
- **Claude Code compatible configuration.** Geno reads settings, slash commands, skills, agent definitions and hooks from `.claude` as well as from its own `.g-code` and the vendor-neutral `.agents`, so a setup written for Claude Code works unchanged. See [docs/config.md](docs/config.md) and [docs/hooks.md](docs/hooks.md).
- **More than one thread of work.** Subagents, MCP servers, background tasks, scheduled wake-ups, workflows, and lanes: each lane is a git worktree with its own chat.
- **Browser.** With `gcode.browser.enabled`, the agent drives Chrome through `chrome-devtools-mcp` in a fresh profile.
- **Many providers.** Anthropic-format and OpenAI-compatible APIs, including local models.

## Install

Requirements: Node.js 22.12 or later, pnpm 11 (Corepack picks the version in `package.json`), and VS Code 1.95 or later.

```sh
pnpm install
pnpm package   # writes packages/extension/g-code-<version>.vsix
code --install-extension packages/extension/g-code-<version>.vsix
```

Then open **Geno: Models and Keys** from the gear in the chat view's title bar, or run **Geno: Set API Key** from the command palette, and set your provider's key. The default provider, Model Studio, also needs its endpoint: the Anthropic-compatible base URL that holds your workspace id and region. Keys are stored in VS Code's SecretStorage, never in settings.

The settings, the providers and what runs where are in [docs/install.md](docs/install.md).

## Providers

| Format | Providers |
| --- | --- |
| Anthropic | `modelstudio` (the default), `openrouter`, `anthropic`, `bedrock`, `vertex` |
| OpenAI Chat Completions | `openai`, `gemini`, `deepseek`, `groq`, `cerebras`, `xai`, `mistral`, `azure-openai`, `ollama`, `lmstudio` |

Pick one with `gcode.provider`. From the command line:

```sh
pnpm gcode providers list         # each provider, and the variable it still needs
pnpm gcode providers test openai  # one tiny call
```

## Command line and browser

```sh
pnpm gcode agent "fix the failing test in src/date.ts"
pnpm gcode ask "where is the session log written?"
pnpm web -- --workspace <dir>     # the chat panel in a browser
```

`pnpm gcode` with no arguments prints every command and its options. The browser host is described in [packages/web/README.md](packages/web/README.md).

## Repository layout

| Package | What it holds |
| --- | --- |
| `packages/core` | The agent itself: the turn loop, tools, permissions, sessions, compaction and providers |
| `packages/engine` | The `gcode` CLI and the engine process that the editor and the web host talk to |
| `packages/extension` | The VS Code extension: chat panel, review, Cmd-K and Tab |
| `packages/web` | The chat panel served in an ordinary browser |
| `packages/docs` | The documentation site, built with Astro and Fumadocs |

## Development

| Command | What it does |
| --- | --- |
| `pnpm build` | Builds the engine, the extension and the web host |
| `pnpm typecheck` | Type-checks every package |
| `pnpm test` | Runs the Vitest suites |
| `pnpm lint:deps` | Checks the import boundaries between packages |
| `pnpm ui` | Serves the UI gallery: every state of the chat panel under each VS Code theme |
| `pnpm docs:dev` | Serves the documentation site locally |
| `pnpm docs:build` | Builds the documentation site |

Every push to `main` that changes `packages/docs` deploys the documentation site to GitHub Pages.

## Credits

Geno includes code ported from [Pi](https://github.com/earendil-works/pi) by Mario Zechner, used under the MIT License. [NOTICE](NOTICE) lists the ported files.
