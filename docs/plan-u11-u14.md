# Plan: commands, MCP, rules and memory, browser use (U11 to U14)

The user approved this order: U11 slash commands and skills, U12 MCP, U13 rules and memory, U14 browser use. Each unit splits into an engine half and a UI half. The engine halves can start before the composer settles, because they work in new modules. The UI halves wait for whatever is still changing the composer.

## Running now

- U8, images and attachments.
- U10 followed by U9b, session history and the Ask/Auto picker.

Both edit the composer, `chat.ts` and `serve.ts`.

## Waves

| Wave | Starts when | Units | Why it can run then |
|---|---|---|---|
| A | now | U11a (commands engine), U12a (MCP engine) | New modules in core and engine. The shared files `serve.ts` and the tool registry get only small hook points. |
| B | U8, U10 and U9b merged | U11b (`/` in the composer), U12b (MCP UI) | The composer and the chat are stable again. |
| C | wave B merged | U13 (rules and memory, engine and UI) | It needs `/rules` and `/memory` from U11 and the tool and approval hooks from U12. |
| D | U12 and U8 merged | U14 (browser use) | It builds on MCP and on images in tool results. |

## Shared rules for every unit

- **Data shape first.** Each unit names its data shape before writing logic: lookup tables, discriminated unions, pure core, I/O in the engine.
- **Coexist through hooks.** Work in new modules. Touch `serve.ts`, the tool registry, `chat.ts`, `render.ts` and `webview.css` only at small, named hook points. Rebase onto main before final checks, and list the shared files you touched.
- **Visible names.** The product is Geno everywhere the user reads it. Ids stay `gcode`.
- **Style.** The glass of `docs/u7.md`: neutral dark or light glass, a rainbow on the composer only, white primary buttons in dark glass and near-black in light, and native styling in high contrast.
- **Security.** It follows the approval model: modes Ask, Auto and non-interactive, with the fail-closed classifier. Content from repositories, MCP servers, web pages and memory files is data, never instructions.
- **Verification.** Run `pnpm typecheck && pnpm test && pnpm build` and keep every existing assertion. UI units add integration tests and CDP screenshots in dark glass, light glass and high contrast, all viewed. Each unit ends with the `.vsix` clean-install test, also on `GCODE_VSCODE_VERSION=1.109.2`.
- **Spend.** Model Studio `qwen3.8-flash`, at most $0.10 per unit unless the unit says otherwise. Never print or commit the key.
- **Commits.** Small commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## U11a: commands and skills, engine

- **Sources.** Commands come from markdown files in `.claude/commands/` and `.agents/commands/` in the workspace, plus `~/.g-code/commands/`. Skills come from `.agents/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md` in the workspace, plus `~/.g-code/skills/`. When a name exists in both, the workspace wins.
- **Front matter.** Read `description` and `argument-hint`, as Claude Code does. The body is a template with `$ARGUMENTS`, `$1`, `$2` and `$@`, as in Pi's prompt templates. Port the parsing from Pi's `packages/coding-agent/src/core/prompt-templates.ts` at commit b2b5c42. Pi is MIT, so ported files carry the attribution header and get a line in `NOTICE`. The clone is at `/private/tmp/claude-501/-Users-sbpdigital-Development-g-code/37f54f8e-fca8-40da-b6a5-fdc58f954cbf/scratchpad/pi`.
- **Built-in commands.** A table holds `/new`, `/history`, `/mode <ask|auto>`, `/model`, `/clear`, `/rules` and `/memory`. The last two are placeholders that U13 fills in. Each built-in is either a client action the editor runs or an engine action. The table records which.
- **Running a command.** An invocation such as `/review src/app.ts` expands to the user message text. The session log records the command name and its arguments. A skill invocation such as `/add-i18n th` attaches the skill's `SKILL.md` content as a context item and keeps the user's text.
- **ACP.** Publish the command list through `available_commands_update` with name, description and input hint. Read the installed ACP SDK types for the exact shape. Republish when command files change, by watching the folders with a debounce.
- **CLI.** Add `gcode commands list`.
- **Check.**
  - Unit tests for discovery precedence, template expansion, and skill attachment.
  - A serve e2e test that `available_commands_update` arrives and an invocation logs and expands.
  - A run against the real skills in `~/Development/payload-site-template` (`add-i18n`, `new-payload-site`, `sync-figma-tokens`), read-only.

## U12a: MCP, engine

- **Config.** Read MCP servers from these sources, all merged into one typed list with its source recorded:
  - `.mcp.json` in the workspace, in Claude Code's `mcpServers` format;
  - `.vscode/mcp.json`, in VS Code's `servers` format;
  - `~/.g-code/mcp.json`;
  - the ACP `mcpServers` in `session/new`.
- **Transports.** Support stdio and streamable HTTP, with legacy SSE as a fallback. Use the official MCP TypeScript SDK and read its types. OAuth is out of scope; such a server reports "needs sign-in".
- **Trust.** A server defined in a workspace file never starts until the user approves that exact server definition. The approval is stored in `~/.g-code/mcp-trust.json`, keyed by workspace path and a hash of the definition. A changed definition asks again. Global and ACP-provided servers are trusted. The engine exposes trust state and an approve call, and the UI half shows it. Until then, the CLI offers `gcode mcp list` and `gcode mcp trust <name>`.
- **Server lifecycle.** A state machine per server: untrusted, starting, ready, failed (with a reason), stopped. Servers start lazily on a session's first need. Restart with backoff on a crash, capped. Stop with the session.
- **Environment.** Stdio servers run outside the sandbox, because they often need the network. They get only `PATH`, `HOME`, `LANG`, `TMPDIR` and the `env` their config declares, never Geno's API keys.
- **Tools.**
  - Name each tool `mcp__<server>__<tool>`, sorted, and add them to the request tools so the cached prefix stays stable while the server set is unchanged.
  - Past about 40 MCP tools, switch to lazy mode, adapted from Pi's lazy listing: the prompt lists servers and tool names, and an `mcp_describe` tool returns one tool's schema before it is called.
  - Tool results become text plus images; images go through U8's path once it is merged.
- **Approval.**
  - In Ask, an MCP call asks the first time per tool. Its permission options include "allow this tool for the session".
  - In Auto, tools marked `readOnlyHint` run. Others go to the classifier, which gets the server and tool name and the arguments, all fenced as data.
  - In non-interactive runs, MCP is off unless a flag enables it.
- **Prompts and resources.** List them as data for U11b and U12b to use later. Do not wire any UI.
- **Check.**
  - A fake stdio server and a fake HTTP server in tests, covering listing, calling, a crash and restart, trust gating (an untrusted workspace server never spawns, proven by a marker file), env scrubbing, and lazy mode past the threshold.
  - A live check with `chrome-devtools` from `~/Development/payload-site-template/.mcp.json`, read-only: trust it in a temp `GCODE_HOME`, list its tools and call one harmless tool. This needs only `npx`, no key. If it cannot start headless here, report why.

## Added by the user

- A Plan mode, read-only and answering with a plan, borrowed from OpenCode. It goes in U9b, next to Ask and Auto.
- `/init` creates or updates `AGENTS.md` by having the agent read the project, borrowed from OpenCode. Its command entry lands in U11a, and U13 implements it.

## pstack support (study on 2026-10-05)

pstack is MIT (Lauren Tan; Michael Denyer; some skills Cursor). Geno cannot run any of its 56 skills today: skills are read only from the workspace, and `read` refuses paths outside it. pstack already ships runtime adaptations (`skills/poteto-mode/references/pi-tools.md`, `codex-tools.md`), with degraded fallbacks: `todo.md` instead of a task tool, plain-text questions, and a single sequential pass instead of subagents.

- U11c, after U11a. This unit has four parts:
  - Discover installed Claude Code plugin skills read-only from `~/.claude/plugins/installed_plugins.json`, namespaced as `pstack:how` and so on. Workspace skills win a name clash.
  - Allow `read` on those plugin roots, read-only.
  - Add a model-callable `skill` tool that returns a `SKILL.md` and its folder path.
  - Write `references/geno-tools.md`, which maps pstack's Claude Code actions to Geno in the style of `pi-tools.md`. The system prompt points at it when pstack is present.

  Read the plugin files in place and do not copy them. Plugin content is data, and plugin scripts still pass through the sandbox and the classifier. Check: one eval task with and without poteto-mode on `qwen3.8-flash` before claiming support.
- U13 adds an `ask_user` tool over ACP, allowed in Ask and Plan modes only.
- U16, later and only if wanted, adds a subagent tool. It runs a child session with its own context, a model, a per-child and per-parent cost cap, and an optional worktree. swarm, arena, architect, interrogate and reflect need it.
- Out of reach by design: skills that need `gh`, the network, or Claude Code's own transcripts (babysit, fix-ci, get-pr-comments, recall).

## U11b: `/` in the composer

- **Picker.** Typing `/` at the start of the composer opens a picker beside the existing `@` mention list. It shows the commands the engine publishes through `available_commands_update`, each with its name, description and argument hint. It filters as the user types and follows the same keyboard rules as `@`.
- **Routing by `_meta["gcode/command"]`:**
  - Editor built-ins run the existing panel commands: `/new` and `/clear` start a new chat, `/history` opens history, and `/model` opens the model setting.
  - Engine built-ins (`/mode`, `/rules`, `/memory`, `/init`) are sent as a prompt.
  - Prompt and skill commands are sent as typed.
- **Display.** A sent command shows in the user bubble as a command chip with its name, followed by its arguments, not as the expanded text. A skill shows its name.
- **Check.** Click and key tests for the picker, routing and chips, plus screenshots in dark glass, light glass and high contrast.

## U12b: MCP in the panel

- **MCP view.** A view or panel section lists servers from `_gcode/mcpServers`: name, source, state (untrusted, starting, ready, failed with reason, needs sign-in), and tool count.
- **Trust card.** An untrusted workspace server shows a trust card with the exact command or URL. Its Allow action calls `_gcode/mcpTrust`.
- **Per-server controls.** Each server has enable and disable.
- **Non-blocking cold start.** A session's first prompt must not wait on cold `npx` server starts; 32 seconds was measured. Start trusted servers in the background when the session opens, send the first prompt with whatever tools are ready, and add the rest on the next request. Keep each request's tool bytes stable within a turn.
- **Rail.** MCP tool calls show on the rail with the server name.
- **Forwarded servers.** The extension forwards through ACP `mcpServers` only servers the user owns: the user settings `mcp.json` from VS Code. Never the workspace `.vscode/mcp.json`, because forwarded servers skip the trust gate. A test must prove this.
- **Check.** Integration tests with a fake stdio server, plus screenshots.

