# Plan: U19 onward (approved 2026-10-06)

The user approved this order:
1. After U18a merges: U34, the boundary lint.
2. U21: effort per turn kind.
3. U36 (composer v2), then U18b (the working dino). Both touch the composer and the turn's current step, so they run one after the other.
4. U35: every provider, plus a settings page. It can run beside the others.

Every unit follows "Shared rules for every unit" in `docs/plan-u11-u14.md`. That includes its Verification rule: run the `unit` project, plus only the VS Code integration files your unit adds or touches. The coordinator runs the full suite before each merge.

## สถานะ (updated 2026-10-06)
ทำแล้ว: U13–U14, U17–U26, U34–U39, U18a/b, Auto แบบ Claude Code, mode/effort ไม่หาย, กันอ่าน credential, test temp cleanup, sticky request; full suite ล่าสุด 152 files / 1664 tests ผ่าน (05bf3fc)
ค้าง: ไม่มีงานครึ่งทางใน tree (worktree เหลือแค่ vigilant-kalam-d976c6 ของ user — ห้ามลบ)
ค้าง: ยังไม่ได้พิสูจน์ด้วยมือ: คลิกปุ่มใน widget จริง (เทสแก้โดยยิง CDP เข้า frame target; เหตุผลว่ามือจริงไม่โดน = inference)
ค้าง: รอ user ยืนยัน: bahtPerUsd=33 (เดา), ความถี่ peek, ไดโนเกาะ input 2x
ค้าง: กำลังทำ U40 (sign in agent ภายนอก); ยังไม่เริ่ม: U15+U33 (Claude Code และ Cursor เป็น backend, research/cursor-backend-2026-10.md) + Backlog ท้ายไฟล์
ค้นพบ: เปลี่ยน effort กลางแชต = Model Studio cache แยกตาม effort → stepped effort แพงขึ้น 24%; default flat (docs/results/u21-effort.md)
ค้นพบ: เวลาไปที่ thinking 36% + decode 25%; read แทบ 0 → parallel reads ไม่ช่วยความเร็ว (u19/u20 results); lever ถัดไป = checker ที่รันค้าง
ค้นพบ: sandbox-runtime config+proxy เป็น global ต่อ process → fs rules ต่อ command ได้ แต่ network allowlist ต้องเหมือนกันทุก sandbox → lanes/arena ที่ต้องการ network ต่างกันใน process เดียวทำไม่ได้ (แก้ U24–U26 ให้ใช้ allowlist เดียว หรือแยก process)
ค้นพบ: กฎ "agent รันเฉพาะ integration file ตัวเอง" พลาด regression (U36 modes) → เพิ่มกฎให้รันไฟล์ที่ drive UI ที่แก้ด้วย (plan-u11-u14.md)
ค้นพบ: Arena ช่วยงานง่ายแต่ไม่ช่วยงานยาก (pass@3 1/3, pick 0/3 บน E5 ที่ fail); review child หมด 8 turn ก่อนจัดอันดับ 2/4 ครั้ง (docs/u26.md)
ถัดไป: merge U40 แล้ว U15+U33 (Cursor ต้อง login ก่อน)

## U34: boundary lint

Keep each part of Geno cheap to lift out into a library later. Add a dependency-rules check that runs with `pnpm test`, or as its own `pnpm lint:deps` called from `pnpm test`, and fails on a crossing.

- Choose the tool after reading what the repo already uses. Prefer one small dev dependency, such as dependency-cruiser, or a short script over the TypeScript import graph if that is simpler. Explain the choice.
- **Rules, as data in one file:**
  - `packages/core` imports nothing from engine or extension, and only `node:path` and `node:crypto` from Node: no fs, no child_process, no net.
  - `packages/engine` never imports `packages/extension`.
  - `packages/engine/src/mcp/` reaches the rest of the engine only through a named, small set of modules: the store, child-env, the tool context and the approval glue it uses today. List them, and fail on any new one.
  - The extension webview code (`src/chat/*` that runs in the webview) never imports `vscode` or Node built-ins.
  - No import cycles inside a package.
- Fix any existing violations with the smallest change. If a fix is not small, list it as an allowed exception, with a comment giving the reason, and report it.
- **Check:** a test, or the lint's own run, proves each rule fires. Add a temporary violating import, quote the failure, then remove it. Run `pnpm typecheck && pnpm vitest run --project unit && pnpm build`.

## U21: effort per turn kind

U19 measured that hidden thinking is 36% of agent time, the visible answer 25%, tools 24% and the first token 13% (`docs/results/u19-speed.md`). Model Studio honors `output_config.effort` for `qwen3.8-flash`: low gave 81 to 131 output tokens, and high gave 267 to 330. Turning thinking off answered wrongly, so keep thinking on.

- **Data shape.** An effort policy table in core, keyed by turn kind:
  - the first turn of a prompt;
  - a follow-up after tool results;
  - a turn after a failed check or tool error;
  - the turn expected to give the final answer, if that can be known; otherwise drop this row.

  The session's effort, chosen by the user, is the ceiling or the base. Decide which, and explain why.
- **Defaults.** Pick them by measurement. Run `gcode eval speed` (the 5-task subset) with the current single effort, then with the table, at least twice each, because single runs are noisy. Keep the table only if pass rate does not drop and median turn time or total output tokens fall. Otherwise ship the table with defaults equal to today's behavior, and record why.
- **Cache.** The system prompt bytes stay identical. The effort lives in `output_config`, which is not part of the cached prefix. Verify that with a test on the request bytes.
- **Composer hook.** Expose the user's session effort over ACP if it is not exposed already: a session config option, or the existing model and effort setting. U36 will show it next to the model.
- **Spend.** At most $0.80 for this unit. Use `--from` to re-report finished runs without spending.
- **Check:**
  - unit tests for the table and for request-byte stability;
  - the speed eval results in `docs/results/u21-effort.md`, with p50 and p90 per part, before and after, the pass rate, and the cost;
  - `pnpm typecheck && pnpm vitest run --project unit && pnpm build`.

## U35: every provider, and a settings page

Today `PROVIDERS` is `['openrouter', 'modelstudio']`, and both speak Anthropic Messages.

- **Two adapters:**
  - **Anthropic format** (existing): Anthropic direct, Model Studio and OpenRouter, plus AWS Bedrock and Google Vertex through Anthropic's official SDK packages for them. Read their docs or the SDK types before writing code.
  - **OpenAI-compatible Chat Completions** (new): OpenAI, Azure OpenAI, Google Gemini through its OpenAI-compatible endpoint, DeepSeek, Groq, Cerebras, xAI, Mistral, Ollama and LM Studio.
    - It translates Geno's internal messages: text, images, tool_use and tool_result blocks, the system prompt and streaming.
    - It maps usage, including cached tokens where the provider reports them.
    - Prompt caching is automatic on these providers, so keep the prefix stable.
- **Data shape.** A provider registry table in core. Each row has an id, a display name, its adapter, a default base URL, how the key is supplied (header name and scheme, or AWS credentials), whether it can list models, and price-table hooks. A new provider is a new row.
- **Keys.**
  - Each provider's key lives in VS Code SecretStorage, never in `settings.json`, logs or the session log.
  - The engine receives keys only through the child environment or a secret channel, as the Model Studio key does today. Read how `Geno: Set API Key` works now and extend it.
  - Bedrock needs an access key id, a secret and a region, or an AWS profile name.
- **Settings page.** A Geno settings view styled like the MCP pane. Each provider has its key field (write-only, showing only "set"), an optional base URL override, a "Test connection" button that makes one tiny call, and a model list where the provider has one.
- **Roles.** A setting maps roles to a provider and model: main chat, classifier, Tab, and the future explore helper. Defaults stay as today.
- **Prices.** Extend the cost table per provider and model. An unknown price shows "unknown", never a made-up number.
- **Check:**
  - unit tests for the registry and for message translation both ways, including tool calls and images;
  - e2e tests against a fake OpenAI-compatible server (streaming, tool calls, usage) and the existing fake Anthropic one;
  - a test that no key ever appears in any written file or log;
  - a live smoke on any provider whose key is already configured (Model Studio). For the OpenAI-compatible adapter, Model Studio also offers an OpenAI-compatible endpoint; use it for a live smoke if available, under $0.02;
  - an integration test for the settings page, with screenshots in all three themes;
  - `pnpm typecheck && pnpm vitest run --project unit && pnpm build`.

## U36: composer v2

This follows the mockup the user approved on 2026-10-06.

- **Layout:**
  - **Tray above the text.** It holds attachments and connections, scrolls sideways, shows image dimensions on image chips, and shows a "Browser · <host>" chip while the U14 browser is running in the session.
  - **The text box.**
  - **Bottom left:** `+`, a `/` button that opens the existing picker, and the mode pill.
  - **Bottom right:** a context ring (fill = context tokens over the model's window; tooltip with the numbers; at 80% or more it offers "Compact"), the model with its effort (Low, Medium or High from U21, picked in the same menu), then Send or Stop.
- **While a turn runs:**
  - the placeholder is "Queue a follow-up…";
  - elapsed time and cost show, in baht with a configurable rate and USD in the tooltip;
  - a "N agents" pill shows the running sessions, 1 for now, ready for subagents.
- **Style.** Keep the rainbow edge and the white primary button (near-black on light glass). High contrast stays native. U18a's peek sits on the composer's top edge; keep it working.
- **Check:**
  - integration tests for each control, the tray, and the running state;
  - screenshots in dark glass, light glass and high contrast;
  - the `.vsix` clean-install test also on `GCODE_VSCODE_VERSION=1.109.2`.

## U18b: the working dino

This is the rest of `docs/u18-brief.md`. Start it after U36.

## U37: widgets in the chat (after U36)

The user saw Claude's `show_widget` (an HTML, CSS and JS fragment drawn inline in the chat) and asked for it in Geno.

**Probe, 2026-10-06.** `qwen3.8-flash` was asked for 5 widgets with a short system prompt: a Payload admin mockup, a Next.js and Payload flow diagram, a speed chart, three pricing layouts, and a debounce versus throttle demo.
- **What worked.**
  - All 5 rendered and their interactions worked. The filter really filtered, a node click explained, and throttle fired 4 times over about 1 s of moves while debounce fired once.
  - No rule was broken: no external resources, only the given colors, flat design.
  - Cost was $0.0065 in total. Each took 25 to 42 s and 2,200 to 3,000 output tokens.
  - The script and outputs are in the session scratchpad, `widget-probe/`.
- **Weak spots.**
  - Every widget used a fixed 680 px width.
  - One chart used near-white on the dark background.
  - Writing is slow.

**Build:**
- **A `show_widget` tool** taking `{ title, html, loading_messages? }`. The engine stores the fragment as a session attachment (U8's hash-addressed store) and logs the reference, so a loaded session shows it again.
- **Rendering.** It draws in a sandboxed iframe: `sandbox="allow-scripts"`, never `allow-same-origin`. Its CSP has no network (`default-src 'none'`, inline scripts and styles allowed), so it has no access to the webview, VS Code, files or Geno. The only channel is `postMessage` for its height. A link click becomes a request the user approves.
- **Theme.** The current glass theme's CSS variables are injected into the frame, light or dark, with a chart palette of 6 colors that read on both. The system prompt for the tool names the variables and the palette, says `width: 100%` with no fixed widths, and asks for the order style, then markup, then script.
- **While the model writes,** the step shows the loading messages and the working dino's pencil pose (U18b).
- **Actions in a ⋯ menu:**
  - Copy as image: render the frame to PNG through the extension host, not the frame.
  - Download as HTML: a standalone file with the theme variables inlined.
  - Open in a VS Code editor tab.
- **When it is offered.** The tool is offered in every interactive mode, Plan included, because it changes nothing on disk. It is not offered in non-interactive runs.
- **Check:**
  - Unit tests: the tool's input schema, the stored attachment round trip, and the frame HTML builder (the CSP and the sandbox attributes are exact).
  - A security test: a widget that tries `fetch`, `parent.document`, `top.location`, `localStorage` and a `form` post gets none of them. Prove each with a red run.
  - An integration test that a fake model's widget renders, resizes to its content, and survives a reload.
  - A live smoke on `qwen3.8-flash` under $0.03 with two of the probe prompts.
  - Screenshots in dark glass, light glass and high contrast.

## U38: ask_user v2, several questions in one card (parallel with U21 and U35)

The user showed Claude's question card on 2026-10-06. It has a tab per question, options with a title and a description, a "(Recommended)" marker on the first option, an "Other" free-text choice for each question, and one "Submit answers" for all of them, with Esc to cancel. U13's `ask_user` covers one question with label-only options, one free-text answer and Skip.

- **Data shape, in core.** `AskUserRequest` grows to `{ questions: Question[] }` with 1 to 4 questions. Each question has:
  - `{ id, header (12 chars or fewer, the tab label), question, multiSelect, options }`;
  - 2 to 4 options, each `{ label, description, recommended?, preview? }`, where `preview` is a short markdown or code block.

  The answer is per question: chosen labels, plus `other` text if given. The tool's input schema rejects anything else, and the model gets the validation message.
  - The old single-question shape keeps working. Parse it as one question, so existing sessions replay.
  - "Other" is always offered and the model never lists it.
- **ACP.** Keep U13's channel, ACP `elicitation/create` in form mode. Read the installed SDK types for what a form schema can express (several properties, enums with titles or `oneOf` with descriptions, arrays for multi-select). Map the questions onto it as far as it allows, and carry the rest (descriptions, recommended, previews) in `_meta`. Explain the mapping. A client that cannot show a form still gets a plain-text fallback: the questions and options as text, answered in the next prompt.
- **The card.**
  - A tab row of question headers, with a dot on each answered tab.
  - The question text; options as rows with a radio or checkbox, title, description, and "Recommended" as a quiet tag.
  - An "Other" row that opens a text field.
  - A focused option's preview shows beside the list (or below it in a narrow panel), as rendered markdown or code, through the existing safe markdown renderer.
  - One "Submit answers" button, enabled when every question has an answer, and Esc or Skip to cancel.
- **Keyboard:**
  - up and down move between options;
  - 1 to 4 pick an option;
  - Space toggles in multi-select;
  - Tab and Shift-Tab, or left and right, change question;
  - Enter on the last question submits;
  - Esc cancels.

  Focus lands on the first option when the card opens, keeping the focus fix from `bb922dd` (a waiting card keeps the keyboard).
- **Folded turns.** The card is still a permission-style attention item, so U17 keeps it visible while pending. Answered, it folds into one line, for example "Answered 2 questions: Button, Layout", and the full answers show when the turn is opened.
- **Modes.** Unchanged: Ask and Plan only.
- **Check:**
  - unit tests for the schema (limits, the old shape, rejecting a listed "Other") and the answer mapping;
  - serve e2e: a two-question round trip with one multi-select and one "Other", plus cancel;
  - an integration test of the card with clicks and the keyboard;
  - screenshots of a 3-question card in dark glass, light glass and high contrast, including a focused option with a preview.

## U20: parallel reads and a faster check (engine, parallel with U18b)

U19 measured tools at 24% of agent time. Almost all of it was `bash` (94.9 s over 33 calls) and the type check after edits (39.8 s over 18 edits). Reads, greps, globs and lists took 0.4 s in total. U21 showed that effort stepping does not pay on Model Studio. This unit attacks turns and tool time.

- **Parallel read-only tools.**
  - **Grouping.** In `drive.ts`, consecutive read-only calls in one model turn run concurrently, with a limit of 8: `read`, `grep`, `glob`, `list`, `skill`, and MCP tools with `readOnlyHint` that need no approval.
  - **Order.** Edits, bash, and anything that may ask the user run serially in their original order. Results go back in the original order, so the transcript and the session log stay deterministic.
  - **Same file.** An edit after a read of the same file in the same turn still sees the read's result first.
  - **Prompt.** Add one sentence to the system prompt asking for independent reads in one turn. Keep the prompt bytes stable afterwards; this is one deliberate change.
- **A faster check after edits.**
  - Find what the check costs now: `npx tsc --noEmit` in the eval, and the configured check in real use.
  - Make repeated checks cheaper without changing what they prove. Example: `tsc --incremental` with its build info kept outside the workspace, under the app home and keyed by the workspace, so the repo is never written. Another example: running the project's own typecheck script when it is already incremental.
  - Measure cold and warm times on the eval tasks.
  - The check must still fail on the same errors. Prove it with a planted type error.
- **Measure.** Run `gcode eval speed` before and after, at least twice each, interleaved. Record load averages, and wait while the load is above 15. Report turns per task, tool time and wall time, with p50 and p90, and the pass rate. Spend at most $0.60. Use `--from` to re-report without spending.
- **Check:**
  - a fake-model e2e test with 4 reads and 1 edit in one turn, showing the reads' times overlap, the edit runs after them, and the results come back in order;
  - a test that a read and an edit of the same file in one turn keep their order;
  - a test that a check with the faster mode still fails on a planted type error;
  - the speed tables in `docs/results/u20-speed.md`;
  - `pnpm typecheck && pnpm vitest run --project unit && pnpm build`.

## Backlog (2026-10-06)

- **A checker that stays running between edits** (a `tsc` watch or a language-service process per workspace). U20 measured that incremental `tsc` only saves 0.1 to 0.2 s per edit on the eval repos. A warm checker is the next real lever for check time. U20's quick probe of `tsc --watch` never rechecked after an edit, so this needs its own unit and measurement.
- **The running turn's own CSS cost.** U18b measured a running turn at 6.6 to 8.7% main-thread busy, from the rainbow, shimmer, rail flow and spinner, with or without the dino. Worth one look.
- **Budget overshoot.** The engine checks `--max-cost` only after each model call, so a run can end slightly over its cap (U13 saw $0.0509 against $0.05).
- **Approval card order.** An approval card can draw above its own step when it arrives first (U17). Counts no longer depend on it; only the display order does.
- **Flaky widget height wait.** `widget.integration` timed out waiting for a widget to take its content's height twice under load (host 2026-10-06, Docker beside another container); alone it passes.
- **Compact.** There is no compact action yet, so the context ring offers only the numbers (U36).

## U22: subagent engine (next; replaces U16)

Brief: research/competitors-2026-10.md §5 "U22". Agent definitions in Claude Code's format (workspace, global, plugin), built-ins explore/plan/review/worker, a model-callable `agent` tool off by default, children as sessions with parentId, cost caps, depth 1, up to 4 read-only children in parallel (the sandbox now allows several sessions at once, b99c95d; children share one network allowlist), `subagent_update` over ACP when advertised, else `_gcode/subagent`. Then U23 (panel), U24–U26 (lanes, arena), with the allowlist constraint above.

## U39: command steps like Claude Code (queued after the Auto fix)

The user compared one disk-cleanup prompt in Claude Code and in Geno. Claude Code titles each command step in plain words ("Show disk usage and project layout") and shows IN and OUT in one box. Geno shows "Ran" and a cut-off command. Add an optional `description` (5 to 10 words) to the `bash` tool, as Claude Code's Bash tool has, use it as the step title, and draw the step as one IN/OUT box. This is one deliberate change to the tool prefix. Check: unit and integration tests for the step, screenshots in all three themes at about 300px panel width, and a live smoke where `qwen3.8-flash` fills the description.

## U40: sign in to external agents from the settings page (running)

An Agents section in the settings page: find the Cursor CLI, show its version and sign-in status, and run `agent update`, `agent login` (browser, with the URL as a fallback link) and `agent logout` from buttons. Geno never touches the agent's tokens. The ACP backend itself stays in U33 (research/cursor-backend-2026-10.md).

## Harness ideas taken from the coordinator's own tools (2026-10-06, queued after U33 and U43)

The user asked which harness features the coordinator uses could go into Geno. Ranked for this user (cheap model, long runs, several sessions):

1. **U44: steer a running agent.** A message to a running child or lane is delivered at its next tool round, as a user turn in its log, without stopping it. The same path lets the user's own follow-up land mid-turn instead of waiting in the queue.
2. **U45: background commands.** `bash` with `background: true` returns at once with an id; the engine notifies the turn when it exits, with a tail of its output. Also stop and read-output tools. For dev servers, long tests and builds.
3. **U46: deferred tools.** Only tool names sit in the prompt; the model loads a schema with a search tool when it needs one. Keeps the cached prefix small and stable as MCP servers grow.
4. **U47: compact.** Summarize old turns into a checked summary when the context nears the window (the backlog item).
5. **U48: spin-off tasks.** The agent flags an out-of-scope issue as a chip; one click starts it in a new lane with a self-contained prompt.
6. **U49: wake-ups and loops.** The agent schedules its own next check ("check CI in 8 minutes"), and `/loop` repeats a prompt on an interval, with the engine process as the timer.
7. **Worker isolation in a worktree.** U22 deferred `isolation: worktree`; lanes now exist, so a worker child can run in its own lane.
8. **Hooks.** Run a user command at loop events (session start, before a tool, after an edit), as Claude Code and Cursor do.

## U50: rewind and fork from the panel (starts after U44 merges)

Today `gcode rewind --session <id> --to <turn>` restores files from the checkpoint taken before each model call, from the command line only, and the conversation stays. Fork is U32's, not built.

- **Rewind to here** on each of the user's messages: restore files, the conversation, or both, as Claude Code does. Restoring the conversation cuts the session at that turn (logged as an event, never deleting the log) and puts the message back in the composer to edit.
- **Fork from here**: a new session with the conversation up to that turn and its own checkpoint lineage; it opens beside the original in History and Tasks. Over ACP, use session fork when the client advertises it.
- Keep U44's steered messages in place on rewind and fork.
- Check: unit tests for the cut and fork of the log; engine e2e for rewind files only, conversation only, both, and fork; Docker integration tests for the message menu; container screenshots in three themes and 300px.

## More capabilities the coordinator's harness has and Geno lacks (2026-10-07)

The user asked for every capability the coordinator uses that Geno does not have yet. Each line names what it is, why it helps this user (a cost-conscious solo developer on Next.js and Payload, in VS Code), and the check that proves it. U44 to U51 above already cover steering, background commands, deferred tools, compact, spin-off tasks, wake-ups, rewind and fork, and edits without Keep. Order is by value to this user.

| Unit | Capability | Why | Check |
| --- | --- | --- | --- |
| U49 (widened) | **Wake on events.** A turn starts background children or commands and ends. When they finish, the engine starts a new turn whose first message is the notice. It also adds `monitor` (watch a command's output until a pattern appears) and `schedule_wakeup` ("check CI in 8 minutes"), with a cap on wakes per hour, budget and max-turns limits, no wake while the user types or a card waits, and several notices batched into one wake. | The session stays usable while long work runs. This is how the coordinator waits on delegates. | Engine e2e: a turn ends with 2 children running, one wake carries both reports. A monitor wakes on a log line. The cap holds. The panel tags a woken turn. |
| U52 | **Remembered permission rules.** "Always allow `pnpm test` in this workspace" from the approval card. Rules are stored per workspace as command patterns, listed and removable in Settings, and deny rules win. | Fewer prompts in Ask, without turning Auto on. Claude Code has `permissions.allow`. | Unit table tests for pattern matching (prefix, args, compound commands refused). E2e: a second run of the same command does not ask, and a deny blocks in Auto. |
| U53 | **`web_fetch` and `web_search`.** Fetch a URL as markdown and answer a question about it with a cheap model. Search through a provider key the user sets. Remote hosts follow U14's URL rules and the approval model, and fetched text is fenced as data. | Docs lookups (Next.js, Payload) without opening the browser tool. It is cheaper than a browser page. | E2e against a local server: the model answers from the page, an injected instruction in the page is ignored, and a disallowed host is refused. |
| U54 | **Editor actions for the model.** `open_file { path, line }`, `show_diff { path }` (against the turn's checkpoint) and `reveal`. They change only what the user sees, never files. | The agent can point at the exact line, as the coordinator does with clickable paths. | Integration test: the tool opens the editor at the line and the diff view. Plan mode allows them. |
| U55 | **Read the user's terminal.** A `read_terminal` tool reads the last lines and commands of VS Code's terminals through the shell integration API, read-only and redacted. | "The command I just ran failed": the agent sees it without a paste. | Integration test with a terminal running a failing command. Secrets in the output are redacted. |
| U56 | **A live todo list.** A `todo` tool keeps a checklist the panel pins above the running turn, updated as items finish. Plan mode's plan becomes the first list. | Long tasks show progress and what is left, at a glance. | Unit tests for the list state. Integration test for the pinned list at 300px. |
| U57 | **Search past sessions.** Full-text search over session logs in History, and a `recall` tool the model can use ("what did we decide about X"). Results are data. | Continuity across chats without re-explaining. | E2e: a fact from an old session is found and cited by session and turn. |
| U58 | **Chapters in long chats.** The agent (or the user) marks a chapter. The transcript gets a small table of contents to jump between chapters, beside the sticky request. | Long sessions stay navigable. The user already asked for the sticky request. | Integration test: marks appear and jumping scrolls to them. |
| U59 | **Dev server preview.** Start the project's dev server from a launch config, show it in the browser tool's pane, and read its console errors. It ties into U29's dev loop. | Next.js and Payload work is visual. The agent checks its change on the running app. | Integration test with a fake server: start, screenshot, console error surfaced, stop. |
| U60 | **PR and CI watch.** With `gh` available, show the branch's PR status and checks, and wake the session (U49) when CI finishes or fails, with the failing log tail. | The coordinator watches CI the same way. It saves polling by hand. | E2e with a fake `gh`: a failing check wakes the turn with its log. |
| U61 | **Where the tokens went.** A per-turn and per-session breakdown: system prompt, tools, history, files read, children and model, each as tokens and baht. | The user pays per token, so knowing the cost driver changes behavior. | Unit tests for the breakdown sum. Integration screenshot of the view. |
| U62 | **Scheduled tasks.** "Every weekday at 9:00 run /review on main" or "in one hour, check X", stored in the engine, run as background sessions, and listed in Tasks. | Recurring chores without the user present. | E2e with a fake clock: the task runs, shows in Tasks, and respects budgets. |
| U63 | **Skills and plugins from a catalog.** Search, preview and install skills and agent definitions into `~/.g-code` or the workspace, shown read-only before install. | The user already uses pstack. Adding more should not need a terminal. | Integration test with a local fake catalog. Nothing runs at install. |
| U64 | **Workflows.** A script that runs children deterministically (pipeline, parallel, verify), the general form of Arena and Plan-then-run, with a cost preview and per-step caps. | Repeatable multi-agent jobs such as review, then fix, then verify. | E2e with a fake model: a 3-step pipeline, a parallel fan-out, and a cap stop. |
| U65 | **Read PDFs and notebooks.** The `read` tool returns PDF pages as text (and images when needed) and notebook cells with outputs. Editing notebooks comes later. | Specs and reports arrive as PDFs. | Unit tests on sample files. A size cap holds. |
| U66 | **Share a page.** Turn a widget or an answer into a standalone HTML file saved in the workspace or opened in the browser, with no network and the same sandbox rules as widgets. | Results to show someone else. | Integration test: the export opens and has no remote requests. |
| U67 | **Phone notice.** Optionally send done, needs-you and failed notices to the user's phone through a push service the user configures, such as ntfy. It is off by default. | The user steps away during long runs. | Unit test for the payload, with no secrets in it. E2e against a local fake push endpoint. |
| Backlog | Cloud or remote sessions, teammates messaging each other, a custom status line, and keybinding customization. | Low value for a local, single-user tool right now. | |
