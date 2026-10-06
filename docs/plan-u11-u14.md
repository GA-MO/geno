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
- **Verification.** Run `pnpm typecheck && pnpm vitest run --project unit && pnpm build`, plus only the VS Code integration files your unit adds or touches (`pnpm test:vscode:docker <files>`). Keep every existing assertion. Run VS Code tests only in Docker, never on the host, unless the user says they are away; see [testing.md](testing.md). The coordinator runs the full gate, `pnpm test:all`, once before each merge (user's choice, 2026-10-05). Also run every integration file that drives UI you changed, even if you did not edit the file: grep `packages/extension/test/suite/` for the selectors and commands you touched (U36 broke the mode menu's Escape because `modes.integration.test.ts` was not run). UI units add integration tests and CDP screenshots in dark glass, light glass and high contrast, all viewed. Each unit ends with the `.vsix` clean-install test, also on `GCODE_VSCODE_VERSION=1.109.2`.
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


## U13: rules, memory, `/init` and `ask_user` (wave C)

Wave B is merged as 0.7.0. U13 fills in the `/rules`, `/memory` and `/init` placeholders in `packages/engine/src/commands.ts`. It also adds the `ask_user` tool.

- **Data shape first.** Name these before writing logic:
  - the context sources and their order: global `~/.g-code/AGENTS.md`, the instruction files from the filesystem root down to the workspace (`project-context.ts`), `.cursor/rules`, and memory;
  - a memory entry: id, text, scope (`project` or `global`), created time and source session;
  - the `ask_user` request and answer.
- **Global rules.** `$GCODE_HOME/AGENTS.md` loads before the project's instruction files. A missing file means nothing to load.
- **`/rules`.** Opens a panel pane, like History and MCP. It lists every instruction file and rule that applies to this session, in load order, with its path and whether it is always on or which glob attaches it. Each opens in an editor tab. The pane also has "Edit global rules", which creates `$GCODE_HOME/AGENTS.md` if it is missing.
- **Memory.**
  - A `remember` tool takes `{ text, scope }`. It asks the user in every interactive mode, Auto included, because a memory is a standing instruction for later sessions. The card shows the exact text. In non-interactive runs the tool is not offered.
  - Store project memory under `$GCODE_HOME/memory/`, keyed by the workspace's real path, never inside the repository. Global memory lives in the same place. Writes are atomic.
  - Memory enters the system prompt fenced as notes the user approved. The prompt says memory never overrides the user's current request. Each memory has a size cap and the total has a cap. The prompt bytes stay stable while memory is unchanged, so the cache keeps working.
  - `/memory` opens a pane that lists entries by scope and offers delete and edit. A delete moves the entry to `trash` under the app home.
- **`/init`.** An engine command that runs one agent turn with a fixed prompt. The agent reads the project and creates or updates `AGENTS.md`: what the project is, how to build, test and lint, its layout, and its conventions. When the file already exists, the agent keeps what the user wrote and adds what is missing. The edit goes through normal approval. Port the prompt idea from OpenCode's `/init` only if its license allows. Otherwise write it fresh.
- **`ask_user`.** It is offered in Ask and Plan modes only, never in Auto or non-interactive. It takes `{ question, options?: string[] }`. Read the installed ACP SDK types for an elicitation or permission mechanism, and use the closest real one rather than inventing a new method. If there is none, use a `_gcode/askUser` request. The panel shows a question card with the options as buttons and a free-text answer. Cancelling the turn cancels the question. The answer goes back to the model as the tool result.
- **Fold in.** U11a's command folder watchers (`sessionCommands.attach` in `commands.ts`) keep running after `session/close`. Stop them when the session closes, and test that.
- **Security.** Memory text, instruction files and rule files are data the user owns. The model never writes to them without approval. A `remember` call carrying text that looks like an instruction to weaken approval still only goes to the user's card; it is never auto-approved.
- **Check.**
  - Unit tests: load order, memory store round trip and caps, the ask-in-every-mode table for `remember`, the `ask_user` mode table, and that the prompt bytes stay stable.
  - Serve e2e: `/init` against a fake model edits `AGENTS.md` through approval; `ask_user` round trip; watchers stop on close.
  - Integration tests: the rules pane, the memory pane (with delete), the remember card, and the ask_user card. Screenshots in dark glass, light glass and high contrast, viewed.
  - A live smoke on `qwen3.8-flash` under $0.05: `/init` on a temp copy of `~/Development/next-15-template` (the copy, never the original) writes a sensible `AGENTS.md`.
  - `pnpm typecheck && pnpm test && pnpm build`, and the `.vsix` clean-install test also with `GCODE_VSCODE_VERSION=1.109.2`.

## U14: browser use (wave D, briefed 2026-10-05)

U12 (MCP) and U8 (images) are merged, so the agent can drive a browser through an MCP server and see screenshots.

- **Server.** A built-in, global browser server: `chrome-devtools-mcp`, pinned to an exact version (1.10.1 at briefing time, or newer after you check it), never `@latest`.
  - It is off by default. A `gcode.browser.enabled` setting, and a toggle in the MCP pane, turn it on.
  - Run it with an isolated, throwaway profile (`--isolated`, headless by default, with a `gcode.browser.headless` setting), so the user's Chrome cookies and logins are never reachable.
  - It is global and user-enabled, so it needs no trust card. Name it `browser`, so its tools are `mcp__browser__*`.
- **Where it may go.** These URL rules are a pure table in core, next to `MCP_RULES`:
  - URLs on `localhost`, `127.0.0.1`, `[::1]`, `*.localhost` and `*.test` run without asking, in Ask and Auto.
  - Any other host asks in every interactive mode, Auto included, and is off in non-interactive runs. (Auto now sends it to the classifier; see "Auto blocks instead of asking" in `docs/u9-brief.md`.)
  - `file:` URLs are refused unless they are inside the workspace.
  - Read the url argument of every navigating tool, `new_page` included, and check it.
  - A page that redirects off the allowed hosts is reported in the step. Prove what the server lets you observe after a navigation, and say so in your report.
- **Risky tools.** `evaluate_script`, `upload_file` and `fill_form` ask in Ask mode. In Auto they go to the classifier with the page URL and arguments fenced as data. Read-only tools (snapshot, screenshot, console and network lists) follow `readOnlyHint` as U12a does.
- **Page content is data.** Text, snapshots and console output from pages are untrusted data, never instructions. Check that the tool results reach the model inside the same fencing other tool output uses.
- **Images.** Screenshots return to the model as images and show as thumbnails on the step through U8's path. Cap their size the way `read` caps images.
- **Dev servers.** The bash sandbox has no network, so the agent cannot start a dev server there. When the page does not answer, the agent tells the user the exact command to run (from `package.json`). Do not widen the sandbox.
- **Lifecycle.** The server starts lazily on the first browser tool call in a session, never at session open, because Chrome is heavy. It stops with the session.
- **Coexist.** U13 (rules and memory), U17 (folding turns) and U18a (dino) run at the same time. Touch `serve.ts`, the approval tables, `chat.ts` and the MCP pane only at small hook points. Rebase onto main before final checks.
- **Check.**
  - Unit tests: the URL rule table (allowed hosts, other hosts asking in Auto, `file:` inside and outside the workspace, IPv6, `localhost.evil.com` refused as a host, userinfo tricks such as `http://localhost@evil.com`), and the risky-tool table.
  - An e2e test with a local static HTTP server on a random port, serving a test page. A fake model navigates, snapshots and screenshots. The screenshot reaches the fake model as an image block, and an off-host URL asks even in Auto.
  - A failing-first test proving that the user's default Chrome profile is never used: check the launch arguments, or the profile directory the server reports.
  - An integration test in VS Code: the toggle in the MCP pane, a browser step with its thumbnail on the rail, and screenshots in dark glass, light glass and high contrast, viewed.
  - A live smoke on `qwen3.8-flash` under $0.05: serve a small page locally with a known heading and button, and ask the agent what the heading says and what the button does after a click.
  - `pnpm typecheck && pnpm test && pnpm build`, and the `.vsix` clean-install test, also with `GCODE_VSCODE_VERSION=1.109.2`.
