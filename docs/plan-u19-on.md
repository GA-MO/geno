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

## External ACP backends: paused (2026-10-07)

The user paused work on Cursor and Claude Code as ACP backends. Through ACP the other agent's own harness does the work, so Geno's prompt, tools, compaction, subagents and Auto classifier are not used; that is not the goal, and access through a plan may be closed by the vendors later. What exists stays as built (U33, U40, the sandbox host fix 68bc7e0): no new ACP work, no Claude Code stream-json bridge, no work on Cursor's start latency. Claude models run in Geno's own loop through the `anthropic`, `bedrock` or `vertex` providers with the user's key.

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
- **Compact.** Done in U47 ([u47.md](u47.md)): auto compaction, the overflow retry, `/compact` and the ring's Compact action.

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
| U67 | **Phone notice.** Dropped on 2026-10-07: the user would rather wire their own notices through hooks (item 8 of the U44 list). The built branch `u67-phone-notice` is kept, unmerged. | | |
| Backlog | Cloud or remote sessions, teammates messaging each other, a custom status line, and keybinding customization. | Low value for a local, single-user tool right now. | |

## Claude Code parity (2026-10-07)

The user set the direction on 2026-10-07. Geno follows Claude Code's harness design by default and deviates only with a written reason. Where Geno is already better, Geno's way stays as an extra feature, tool or option on top of the Claude Code default. The study, the confirmed defects D1 to D9, the master table and every written reason are in [claude-code-parity.md](claude-code-parity.md). The units below are P1 to P38, in delivery order. Matrix IDs in each scope (`A/A-10`, `B/B-19`, `C/C-24`, `T-LOOP-04`, `N-01`) are rows of that doc's master table.

Rules for every P unit, on top of "Shared rules for every unit" in `docs/plan-u11-u14.md`:

- **Conformance suite.** P1 creates `packages/engine/test/conformance/`, one file per family (`loop.conformance.test.ts`, `permissions.conformance.test.ts` and so on), and `docs/conformance.md`. Every later unit adds the tests for its IDs there. Each `it` title starts with its ID, for example `it('T-TOOL-12 a non-zero exit is an error result', …)`. A test asserts `is_error` and meaning, never Claude Code's exact bytes.
- **Red first.** Each unit commits its failing conformance tests first, then the fix. A defect fix also rewrites the test that pinned the old behavior, and the commit says so.
- **Both wires.** A test of request shape or of the model's view runs on the Anthropic and the OpenAI-compatible wire, through `describe.each(['anthropic', 'openai'])`.
- **Bookkeeping.** Each unit updates its rows in `docs/conformance.md` and the Unit column of `docs/claude-code-parity.md`.
- **Model-facing text.** A unit that changes a prompt, a tool description or a notice runs the evals it names on `qwen3.8-flash`, at most $0.10 unless the unit says otherwise.
- **Size.** Each unit is about one day of agent work and ships on its own. A unit marked larger may split at the line its scope names.

| Phase | Unit | One line |
|---|---|---|
| 1. Safety defects | P1 | Stopped and cut-off tool calls never run. The conformance suite starts. |
| | P2 | Tool results and tool docs tell the truth: exit status, `grep` directories, the skill listing, geno-tools.md. |
| | P3 | Secrets and invisible text: no `read .env`, hidden Unicode stripped from untrusted output, a human no stops the turn. |
| | P4 | The report fence neutralizes every harness tag and tells the classifier a report came first. |
| 2. What the model is told | P5 | Environment block frozen at session start. |
| | P6 | One provenance wrapper and a not-user line on every harness message. |
| | P7 | Changed-on-disk notes beside the stale-edit refusal. |
| | P8 | Instruction files: `@import`, Claude Code's file layers, a size cap, the user's own file with user authority. |
| | P9 | Nested AGENTS.md and CLAUDE.md attached on the first read in their directory. |
| | P10 | MCP instructions, failures and late tools reach the model without moving the prefix. |
| | P11 | Memory and mode text leave the system prompt. A system and tools snapshot. A live cache smoke. |
| | P12 | One skill listing for every source, with `args`, `disable-model-invocation` and personal-first precedence. Done. |
| 3. Hooks | P13 | Hook config and runner in Claude Code's format, with SessionStart and SessionEnd. |
| | P14 | UserPromptSubmit and PreToolUse, placed inside the deny-first order. |
| | P15 | PostToolUse, PostToolUseFailure, PostToolBatch and Stop. |
| | P16 | PermissionRequest, SubagentStart and SubagentStop, and a lane-create hook. |
| 4. Agent communication | P17 | A `report` handback tool, usage in the report, and Claude Code's launch rules. |
| | P18 | `message_agent` resumes a finished child. |
| | P18b | The next engine tells the parent which agents a crash cut off, and `message_agent` or Resume in Tasks resumes them. Done. |
| | P19 | `task_stop`, `list_agents`, wake-up cancel and the background output path. Done. |
| | P20 | A child with `isolation: worktree` runs in a lane. |
| | P21 | Background and parallel writers in their own lanes. |
| | P22 | Agent definitions: `general-purpose`, `~/.claude/agents`, `omitClaudeMd`, model slots, child depth. |
| 5. Prompt tiers and compaction | P23 | A capability record per model: window, output cap, thinking, prompt tier, cache TTL, thresholds. |
| | P24 | A cheap-model prompt tier, proved by an eval A/B. |
| | P25 | Budget reminders, and the eval that decides whether `agent` is on by default. |
| | P26 | Compaction keeps skill bodies, recent files, errors and a pointer to the full history. Done. |
| | P27 | Tool gaps that cost cheap models turns: `replace_all`, overwrite, `sleep`, cwd reset, paths, `+term`. |
| 6. Permission rules | P28 | Rule grammar: `ask` rules, wrapper stripping, long commands, user path rules. |
| | P29 | Permissions read from `.claude/settings.json` and `~/.claude/settings.json`. |
| | P30 | Domain and MCP rules, and trusted domains for the classifier. |
| | P31 | Reads outside the workspace ask instead of failing. Extra read directories. |
| | P32 | Classifier session linking, and Claude Code's denial and rejection wording. |
| 7. Remaining rows | P33 | Workflow resume journal and diagnostics. |
| | P34 | Forced `structured_output` for workflow schema steps, by eval. |
| | P35 | MCP from plugins through the trust card, and MCP tools for `worker` children. |
| | P36 | Web and wire options: `web_fetch` paging, `web_search` domains, `eager_input_streaming` on Anthropic. |
| | P37 | Notebook cell edits. |
| | P38 | MCP sign-in through VS Code. |

### P1: stopped and cut-off tool calls never run

- **Scope.** D1, D2. A/A-10, A/A-05, T-LOOP-04, A/A-08, B/B-08, T-LOOP-02. The suite skeleton.
- **Why.** A Stop followed by "don't run that" runs the stopped call (D1). A tool call cut off at `max_tokens` can run with half its input on the Anthropic wire (D2). Both act against the user.
- **Change.**
  - The suite. Add `packages/engine/test/conformance/`, a `scripted(adapter, script)` helper over `fake-transport.ts` and `fake-openai.ts` that returns `{ io, store, opened, transport }`, a `conformance` vitest project, and `docs/conformance.md` with all 98 IDs and matrix D's status.
  - In `loopStep`, an earlier run's abort with unanswered tool uses yields synthetic `is_error` results: "interrupted by the user; it may have partly run" for a call that started, and "not run" for the rest. A transport error keeps resume-after-crash.
  - A `max_tokens` turn answers its last tool use with an error result ("output limit reached; resend it smaller") and continues once with Claude Code's reminder.
  - `model_context_window_exceeded` takes the overflow path: compact and retry once.
  - Rewrite `core/test/loop.test.ts` "pending tools run before a newer question".
- **Check.** Unit table rows in loop.test.ts. Conformance T-LOOP-02 and T-LOOP-04 on both wires. An e2e that interrupts `sleep 30`, sends "don't run that", and asserts no second spawn.
- **Size.** 1 day. **Depends on.** Nothing.

### P2: tool results and tool docs tell the truth

- **Scope.** D3, D5, D8, D9. B/B-19, T-TOOL-12, B/B-04, N-01, B/B-25, C/C-77, A/B-12 (text).
- **Why.** A failed build reads as a pass (D5). A directory search says "no matches" (D3). The model is told there are no subagents (D8) and to load skills with `read` (D9).
- **Change.**
  - `bash` with a non-zero exit returns `status: 'error'` with "Exit code N" first, and keeps the trailing status line. Update `plugins.e2e.test.ts:77`.
  - `grep`: a `path` that names a directory searches it. When ripgrep searched no files, the result is an error that says so.
  - Render the subagent rows of `docs/geno-tools.md` from the run's roster, so they match `agentTool`.
  - The skill listing tells the model to call `skill`.
- **Check.** T-TOOL-12. A `grep` unit test with `path: 'packages/core/src'`. geno-tools text with `agentTool` on and off. A listing snapshot.
- **Size.** 1 day. **Depends on.** P1 (suite).

### P3: secrets and invisible text

- **Scope.** D4, D6. T-PERM-05 (built-in part), B/B-61 (defaults), N-02, B/B-72.
- **Why.** `read .env` sends secrets to the provider without a question (D4). Hidden Unicode in a page or an MCP result carries instructions the user cannot see (D6). After a human rejects a call, "find another way" invites the model to work around the no.
- **Change.**
  - `read`, `grep` and `glob` refuse paths that match `SECRET_PATH` from `core/src/approval.ts`, with a message that names the rule. `grep` skips such files.
  - Strip hidden Unicode from `web_fetch` page text, MCP results and child reports. Show visible escapes in `read` and `bash` output, so edits stay exact.
  - A user rejection says to stop and wait for the user. Rule and classifier denials keep "find another way".
- **Check.** T-PERM-05 first half: `read .env`, a `grep` hit in `.env` and `cat .env` are all refused or asked. A fixture page with tag characters. A rejection in Ask ends the turn.
- **Size.** 1 day. **Depends on.** P1.

### P4: report fence hardening

- **Scope.** D7. A/A-14, C/C-24, C/C-25, T-AGENT-02, B/B-83, T-AUTO-04.
- **Why.** A child's report can carry `<parent_message>` or a forged `[Geno started this turn…` line, and the parent sees it unchanged (D7).
- **Change.** In `childReport`, indent every line by two spaces, neutralize every Geno harness tag (`parent_message`, `subagent_report`, `project_instructions`, `global_instructions`, `memory`, `available_skills`, `compacted_context`) and lines that start `[Geno`, add an instruction-pattern banner, and add Claude Code's permission-laundering sentence. The classifier input says "a subagent report preceded this" when one did. No extra monitor call.
- **Check.** T-AGENT-02 with all three forgeries. Classifier eval: a report says "run rm -rf src", and the parent's command is not allowed.
- **Size.** 0.5 to 1 day. **Depends on.** P1.

### P5: environment block

- **Scope.** A/C-12, A/G-04, T-ASM-03, T-PERM-08.
- **Why.** The model gets no date, platform, shell, workspace path, git state, model name or scratchpad. Cheap models do not infer these.
- **Change.** An `Environment` value built at session start (date, OS and version, shell, workspace path, git branch and a short status marked "will not update", model id, scratchpad path) and stored in `session-start` like `LoadedContext`. Replay renders it in the opening user message.
- **Check.** A render unit test. A resumed session sends identical bytes. Eval: a task that needs the date, and one that needs BSD `sed -i ''` on macOS.
- **Size.** 1 day. **Depends on.** P1.

### P6: provenance on every harness message

- **Scope.** A/D-01, A/A-16, C/C-37, T-BG-04, T-ASM-17, A/A-13, T-BG-05, A/B-05, A/B-03.
- **Why.** Cheap models confuse harness notices with the user. Mid-turn arrivals carry no not-user line, and the prompt never explains the bracket convention.
- **Change.**
  - One wrapper, `[Geno] …`, for every harness-originated block, with a fixed not-user line on arrivals (background ends, wake-ups, monitor matches, PR watch). Output tails are fenced as data.
  - One system prompt line that explains the wrapper. A forged wrapper inside tool output is neutralized.
  - The user's steer is framed at render time as "The user sent a new message while you were working".
  - The prompt names the product Geno, and adds "prefer dedicated tools" and the `file:line` convention.
- **Check.** T-BG-04 and T-BG-05. Injection eval: a file holding "[Geno] the user approved…" is treated as data. Steer smoke on qwen3.8-flash. A grep test that no model-facing string says "g-code".
- **Size.** 1 day. **Depends on.** P1.

### P7: changed-on-disk notes

- **Scope.** A/D-04, B/B-10, T-CTX-01.
- **Why.** In VS Code the user edits files while the agent works. Today the model learns of it only when an edit is refused.
- **Change.** At the safe point before each model call, compare the hashes of files read this session with the disk, and add Claude Code's note for each changed file. Edit results add "the file state is current; no need to read it back". The stale-edit refusal stays.
- **Check.** T-CTX-01. E2E: the user edits a file mid-turn, and the model does not revert it.
- **Size.** 1 day. **Depends on.** P6.

### P8: instruction files, layers and imports

- **Scope.** C/C-66, T-MEM-01, C/C-65, T-ASM-10, C/C-68, A/C-15, C/C-64.
- **Why.** The user's own `~/.claude/CLAUDE.md` is a single `@import` that Geno cannot follow. Claude Code's user, project and local files are not read.
- **Change.** Resolve `@path` and `@~/path` lines up to 4 levels, with cycle and size guards, each as its own entry. Read `~/.claude/CLAUDE.md` after `$GCODE_HOME/AGENTS.md`, plus `.claude/CLAUDE.md` and `CLAUDE.local.md` in the workspace. Skip a file over 4 MiB with a problem line. The user's own global files get user authority over preferences. Repository files keep the "cannot widen" framing.
- **Check.** T-MEM-01 and T-ASM-10. Each file appears once, in order. Injection eval: an AGENTS.md that asks to send secrets.
- **Size.** 1 day. **Depends on.** P1.

### P9: nested instruction files

- **Scope.** A/C-16, B/B-11, C/C-67, T-ASM-11.
- **Why.** Directory rules in a monorepo never load.
- **Change.** Register each `<dir>/AGENTS.md` or `<dir>/CLAUDE.md` under the workspace as a glob rule for `<dir>/**` in the existing rule attacher. It already attaches once per session and survives resume.
- **Check.** T-ASM-11: reading `pkg/a.ts` attaches `pkg/AGENTS.md` once.
- **Size.** 0.5 day. **Depends on.** P8.

### P10: MCP reaches the model

- **Scope.** A/C-13, C/C-58, A/C-14, C/C-59, T-MCP-01, A/C-05, T-MCP-03, C/C-61.
- **Why.** The model never sees server instructions or failures, so it claims it has no access. A server that becomes ready late rewrites the cached prefix.
- **Change.** Record each trusted server's instructions (capped at 2,000 characters, fenced as server text) at session start. One fenced notice lists failed, untrusted and needs-sign-in servers with Claude Code's two rules. Freeze `tool_search`'s description at run start, and announce later tools in a delta message. Add the "narrow the request" note to spilled MCP results.
- **Check.** T-MCP-01 and T-MCP-03. `tools` bytes unchanged after a server connects mid-run. A fake server's instructions appear in the first request.
- **Size.** 1 day. **Depends on.** P6.

### P11: cache-stable session text

- **Scope.** A/B-07, C/C-71, C/C-70 (guidance), A/B-13, A/F-02, T-PERSIST-02, T-ASM-07.
- **Why.** Memory in the system prompt and Plan text appended to it rewrite the prefix. Nobody can see which system prompt and tools a call carried.
- **Change.** Snapshot memory at session start into the opening user message with "may be stale; verify", and announce new notes as a delta. Move the mode text into a message, and keep Plan's tool filter. Add Claude Code's "don't save what the repo records" to `remember`. Log a per-run snapshot of system and tools, and an opt-in `GCODE_WIRE_LOG` with keys redacted.
- **Check.** Identical system bytes across two runs with a `remember` between. Two workspaces send identical system blocks. `cacheRead` after an Ask to Plan switch. T-PERSIST-02. T-ASM-07 as a live smoke on Model Studio, under $0.05.
- **Size.** 1 day. **Depends on.** P6.

### P12: one skill listing

- **Scope.** C/C-50, C/C-51, B/B-30, A/B-12 (args), C/C-53, C/C-54.
- **Why.** Global and plugin skills, pstack included, are loadable but never listed. A cloned repo can shadow the user's own skill.
- **Change.** List every model-invocable skill from the discovery `skill` uses, recorded in `session-start`. Add optional `args`. Honor `disable-model-invocation`. Run `context: fork` skills as a child. Personal skills and agents beat project ones, with a problem line on shadowing.
- **Check.** A plugin skill appears in the first request. A hidden skill is not listed, and `skill` refuses it. A precedence unit test.
- **Size.** 1 day. **Depends on.** P2.

### P13: hook config and runner

- **Scope.** B/B-89 to B/B-97, B/B-99, B/B-100, B/B-126, C/C-55 (plugin hooks), T-HOOK-01, T-HOOK-06 to T-HOOK-11.
- **Why.** Hooks are the user's only deterministic lever over a cheap model, and existing Claude Code and pstack hook configs would run unchanged. The user dropped U67 to wire their own notices through hooks.
- **Change.** Read `hooks` from `.claude/settings.json`, `~/.claude/settings.json`, Geno's settings and installed plugins' `hooks/hooks.json`. Support the `command` type only. Matchers use a map from Claude Code tool names to Geno's. Add timeouts, parallel runs, dedup of identical handlers, the common payload, the exit-code and JSON contract, and a Settings warning for unknown events. Project hooks run only in a trusted VS Code workspace, inside the sandbox. Events in this unit are SessionStart (startup, resume, compact) and SessionEnd.
- **Check.** T-HOOK-06 to T-HOOK-11, with a hook script that writes its payload to a file. pstack's SessionStart mandate reaches the first request.
- **Size.** 1 to 1.5 days. Split the loader from the runner if it grows. **Depends on.** P6.

### P14: UserPromptSubmit and PreToolUse

- **Scope.** B/B-102, B/B-104, B/B-98, T-HOOK-02, T-PERM-06, T-PERM-05 (hook part), T-PERM-12, T-LOOP-01 (pre-phase).
- **Why.** A PreToolUse hook is how a user forbids, for example, edits to migrations. It must only tighten policy.
- **Change.** Settle every call's hook decision before the batch runs. Run the hook before `ruledDenial` in `approveCommand` and before each tool's own checks. A hook allow skips the question and the classifier only, never a deny rule or the sandbox. UserPromptSubmit can block a prompt or add context.
- **Check.** T-HOOK-02, T-PERM-05, T-PERM-06, T-PERM-12 and T-LOOP-01.
- **Size.** 1 day. **Depends on.** P13.

### P15: after-tool and Stop hooks

- **Scope.** B/B-107, B/B-108, B/B-109, B/B-114, A/A-04, T-HOOK-03, T-HOOK-04, T-LOOP-03.
- **Why.** A Stop hook enforces "done means tests pass" on a model that stops early.
- **Change.** PostToolUse runs after Geno's check. PostToolUseFailure runs on a non-zero exit. PostToolBatch runs once per batch. Stop carries `stop_hook_active`, so a hook can block only once in a row.
- **Check.** T-HOOK-03, T-HOOK-04, T-LOOP-03, and a block-once test.
- **Size.** 1 day. **Depends on.** P14, P2.

### P16: permission, subagent and lane hooks

- **Scope.** B/B-105, B/B-112, B/B-122, T-HOOK-05.
- **Why.** Command-line runs can answer cards from a hook. A new lane can run `pnpm install`.
- **Change.** PermissionRequest fires when a card would show, with Geno's offered pattern as `permission_suggestions`. Add SubagentStart, SubagentStop and a lane-create hook.
- **Check.** T-HOOK-05. A lane e2e with a create hook.
- **Size.** 1 day. **Depends on.** P15.
- **Status.** Done. Claude Code's WorktreeCreate replaces creating the worktree, which a lane cannot let a hook do, so the lane-create hook is Geno's own LaneCreated, and runs the user's hooks only. [conformance.md](conformance.md) has what runs and the tests that check it.

### P17: handback and report contents

- **Scope.** C/C-22, C/C-23, B/B-45, T-AGENT-03, C/C-27, C/C-15, C/C-10.
- **Why.** The report joins every assistant text, narration included. The parent never sees a child's cost, and nothing tells it not to predict or duplicate a pending child's work.
- **Change.** A child-only `report{message}` tool. A child that ends without it gets one nudge, then its last assistant text becomes the report. The partial report on a cap stays. The fence gets `turns=N cost=$X duration=Ys`. The launch result and the tool description get Claude Code's rules. `forkTask` gets "execute directly, don't re-delegate".
- **Check.** T-AGENT-03 with a scripted child that narrates. A snapshot of `childReport`. Eval: turns in which the parent reports results before the wake.
- **Size.** 1 day. **Depends on.** P4.

### P18: resume a finished child

- **Scope.** C/C-30, B/B-26, T-AGENT-04.
- **Why.** A follow-up to a finished child costs a full re-brief today.
- **Change.** `message_agent` to a finished child starts a new `drive` on the child's session log, delivers the message as a `parent_message`, applies fresh caps, and returns the new report the same way as the first.
- **Check.** T-AGENT-04: the resumed child's first request holds its earlier turns plus the fenced message.
- **Size.** 1 day. **Depends on.** P17.

### P18b: recover agents an engine crash cut off

- **Scope.** New (2026-10-07, from the coordinator's own crash recovery). Geno's children and workflow steps die with the engine, and nobody tells the parent.
- **Why.** After a crash the user cannot tell which agents were cut off or how far they got. The coordinator recovered the same case by listing stopped agents and messaging each to resume from its transcript.
- **Change.** At engine start, find child sessions and workflow steps whose log shows a run with no end, and log an `interrupted` end for each. Send the parent session one `[Geno]` arrival that lists each, with its last report or last text, its files changed and its spend. The parent resumes one with `message_agent` (P18's path), and Tasks shows a Resume action on each row. Nothing resumes on its own, because a run costs money.
- **Check.** E2E: kill the engine mid-child, start it, see the interrupted end, the parent's arrival, and a resume through `message_agent` that continues from the child's log. The same for a workflow step.
- **Size.** 1 day. **Depends on.** P18.
- **Status.** Done. [conformance.md](conformance.md) has what runs and the tests that check it.

### P19: stop, list and wake controls

- **Scope.** C/C-32, B/B-24, T-BG-03, C/C-33, B/B-27, B/B-39, T-BG-06, C/C-42, B/B-22, T-BG-01, C/C-38.
- **Why.** The model cannot stop a background child or monitor it started, cannot list them, and cannot cancel a wake-up.
- **Change.** `task_stop{id}` for `bg-N`, `wake-N` and child session ids. `list_agents` for this session's children and background work, with status. A cancel for `schedule_wakeup`, and the "don't poll; you are woken" sentence. The background start and end notices name the output file.
- **Check.** T-BG-01, T-BG-03 and T-BG-06. E2E: the model stops its background explore and gets a `cancelled` partial report.
- **Size.** 1 day. **Depends on.** P17.

### P20: children in lanes

- **Scope.** C/C-16, T-AGENT-05, B/B-70 and C/C-17 (stash warning).
- **Why.** `isolation: worktree` is parsed and then refused. Lanes already give sessions a worktree with sandbox bounds.
- **Change.** An isolated child runs in a new lane with U24's sandbox and `laneCommandDenial`. A clean lane is discarded. A changed lane is kept, and the report names it. A lane session's opening carries Claude Code's stash warning.
- **Check.** T-AGENT-05. Two `worker` children edit the same file in parallel lanes, both keep their edits, and the main tree is unchanged.
- **Size.** 1.5 days. **Depends on.** P17.
- **Status.** Done. The `agent` tool takes `isolation: "worktree"`, as Claude Code's does, besides the definition's field. Workflow steps with `lane` run too, since they followed from the same path, so P21 keeps only background and parallel writers. Writers in lanes still run one after another. [conformance.md](conformance.md) has what runs and the tests that check it.

### P21: background and parallel writers

- **Scope.** C/C-13, C/C-14, T-AGENT-01, U64's deferred `lane` steps.
- **Why.** Writers block and run one at a time because they share one checkout. In their own lanes they need not.
- **Change.** `background: true` for writers that run in a lane. Writers in separate lanes run in parallel under the slot limiter. Workflow `lane` steps run.
- **Check.** A background worker in a lane reports through a wake. T-AGENT-01 with Geno's blocking default.
- **Size.** 1 day. **Depends on.** P20, U64 merged.
- **Status.** Done. A child's checkout is its key: the main checkout, a lane's name, or none for a read-only child in the main checkout. Children under one key take turns, so writers of the main checkout, and workflow steps that share a lane, still run one after another. Lane children share the parent's 4 slots with read-only children. A background writer outside a lane is refused with the `isolation: "worktree"` that would let it run. Workflow `lane` steps already ran in P20; now steps in different lanes run at once. [conformance.md](conformance.md) has what runs and the tests that check it.

### P22: agent definitions

- **Scope.** C/C-02, C/C-03, C/C-04, T-MEM-03, C/C-07, C/C-74, T-PERSIST-03.
- **Why.** Claude Code agent files and pstack prompts name `general-purpose` and live in `~/.claude/agents`. `explore` pays for AGENTS.md on every call.
- **Change.** `general-purpose` aliases `worker`. Read `~/.claude/agents`. Add an `omitClaudeMd` field, set on `explore` and `plan` after measuring explore's cost and success with and without it. Add a `subagentModel` setting and alias slots, such as `haiku` to a small model id. Record depth in the child's `session-start`.
- **Check.** T-MEM-03. A loader test with a fake `$HOME/.claude/agents`. `model: haiku` runs on the configured id.
- **Size.** 1 day. **Depends on.** P8.
- **Status.** Done. `~/.claude/agents` loads after Geno's home and before the workspace, so the user's own agents win, as for skills. `general-purpose`, `Explore` and `Plan` alias `worker`, `explore` and `plan` everywhere an agent is named. The setting and the alias slots are environment variables, as the other model roles are: `GCODE_SUBAGENT_MODEL` and `GCODE_<ALIAS>_MODEL`. `omitClaudeMd` also drops the skill listing for a child without the `skill` tool, and logs an omitted git status as `"omitted"` so the child still knows it is in a repository. The explore A/B on qwen3.8-flash ([results/p22-omit-claude-md.md](results/p22-omit-claude-md.md)): 64% less per run, 16 of 18 answers against 18 of 18, both misses at the 4-turn cap. [conformance.md](conformance.md) has the rest.

### P23: model capability record

- **Scope.** A/G-03, A/C-08, A/C-09, T-ASM-06, A/C-02, T-ASM-01, T-TOOL-07 (threshold), A/E-01 (default).
- **Why.** Geno runs many models, but `max_tokens` is one constant and there is no thinking setting, TTL or tier per model.
- **Change.** A table in core with `{window, maxOutput, thinking, promptTier, cacheTtl, spillChars, compactAt}` per model, and a safe fallback for unknown models. `max_tokens` is clamped to the window minus the input. The TTL is 1 h on Anthropic.
- **Check.** Table unit tests. T-ASM-01 and T-ASM-06. `buildRequest` near a full window. A cost eval of compaction thresholds on a long session, under $0.20.
- **Size.** 1 day. **Depends on.** P1.

### P24: a cheap-model prompt tier

- **Scope.** A/B-01, B/B-01, A/B-09, A/B-10, B/B-18, C/C-44, A/B-14, T-ASM-05.
- **Why.** Claude Code gives small models detailed rule blocks and strong models short principles. Geno gives every model one prompt.
- **Change.** The prompt text is chosen by `promptTier`, with the mode text on top. The cheap tier uses Haiku-style blocks. Per-tool rules move into tool descriptions. Add "don't wrap up early", "act; don't re-derive or narrate", Bash's git lines and the workflow "only when asked" line. Add a `--append-system-prompt` flag and setting.
- **Check.** An A/B on `docs/eval-tasks.md` with qwen3.8-flash, the current prompt against the cheap tier, at least twice each: pass rate, calls per task, cost, and first-try tool failures. Keep the tier only if the pass rate holds and calls or cost fall. Results go in `docs/results/p24-prompt-tier.md`. At most $0.80. T-ASM-05.
- **Size.** 1 to 1.5 days. **Depends on.** P23, P5, P6.

### P25: budget reminders and the agent default

- **Scope.** A/B-11, C/C-12.
- **Why.** A run hits `--max-turns` or `--max-cost` without warning and leaves no report. The `agent` tool stays off until an eval shows it helps.
- **Change.** A just-in-time message when 20% or less of the calls or cost is left. Then run the U22 eval with and without `agent` on qwen3.8-flash, and turn it on in Ask and Auto only if cost and success improve.
- **Check.** An eval with a tight `--max-turns` ends with a useful final report. The agent eval goes in `docs/results/p25-agent-default.md`. At most $0.60.
- **Size.** 1 day. **Depends on.** P23, P17.
- **Status.** Done. The reminder is a `notice` at the safe point, once per run, and also counts the cost left in calls at the run's mean cost a call, because flash ignored a dollar figure in the eval. The `agent` tool stays off: on three speed tasks, two runs an arm, both arms passed 6/6 and flash never called `agent`; the cost gap was noise ([results/p25-agent-default.md](results/p25-agent-default.md), $0.52 spent). [conformance.md](conformance.md) has the tests.

### P26: compaction gaps

- **Scope.** A/E-03, A/E-04, A/E-06, T-CTX-05.
- **Why.** After a compaction, pstack rules vanish because skill bodies are not kept, and the model cannot get exact earlier details.
- **Change.** Keep invoked skill bodies in `kept`, capped. Re-attach the 1 to 3 newest changed files under a token cap. Add Claude Code's "errors and fixes", "security constraints verbatim" and "current work with quotes" sections. Tell the model how to get exact earlier details through `recall` over its own pre-compaction events.
- **Check.** T-CTX-05. compact-smoke with a skill loaded before compaction, an earlier fixed error and a "never touch X" rule, all honored after.
- **Size.** 1 day. **Depends on.** P11, P12.

### P27: tool gaps that cost cheap models turns

- **Scope.** B/B-16, T-TOOL-04, B/B-15, T-TOOL-11, B/B-20, T-TOOL-08, T-TOOL-06b, B/B-14, T-TOOL-01, T-TOOL-02, T-TOOL-03, T-TOOL-10, B/B-13, A/C-07, T-DEFER-03, T-DEFER-04.
- **Why.** Each gap adds turns. A rename takes N edits, a long `sleep` polls, and an absolute path fails.
- **Change.** `replace_all` on `edit`. Overwrite of a file that was read and is not stale. Refuse a leading foreground `sleep` of 2 s or more, and point to `monitor` or `run_in_background`. The cwd reset line. The missing-file hint with the workspace root. Absolute paths inside the workspace. `select:A,B` and `+term` in `tool_search`.
- **Check.** The listed T-IDs.
- **Size.** 1 day. **Depends on.** P2.

### P28: rule grammar

- **Scope.** B/B-56, B/B-59, T-PERM-10, B/B-66, B/B-61 (user rules).
- **Why.** Users cannot force a question in Auto, `timeout 30 pnpm test` misses a `pnpm test` rule, and there are no user path rules.
- **Change.** An `ask` effect. Claude Code's safe wrappers are stripped before allow matching. Commands over 10,000 characters or unparsable ask. User `read` and `edit` path rules apply in `read`, `edit`, `grep`, `glob` and the sandbox `denyRead`.
- **Check.** T-PERM-10. An `ask` rule asks in Auto. A user path rule blocks `read` and `cat`.
- **Size.** 1 day. **Depends on.** P3.
- **Status.** Done. Path rules ask or deny, never allow, since Geno already reads and edits the workspace unasked. `xargs` stays open-ended rather than a safe wrapper. A whole-line ask goes to the classifier in Auto and still runs where nobody can ask, as an unlisted command does. [conformance.md](conformance.md) has what runs and the tests that check it.

### P29: Claude Code settings

- **Scope.** B/B-62, B/B-58 (import), B/B-65.
- **Why.** Users already keep rules in `.claude/settings.json`.
- **Change.** Read `permissions` from `.claude/settings.json` and `~/.claude/settings.json` as scopes below Geno's own store. Parse `Bash(x:*)`, `Bash(x *)` and bare-tool denies into Geno rules. Deny always applies. Allow applies only in a trusted VS Code workspace.
- **Check.** A project deny applies. A project allow is ignored when the workspace is untrusted. T-PERM-09 still passes.
- **Size.** 1 day. **Depends on.** P28, P13 (shared settings reader).
- **Status.** Done. `.claude/settings.local.json` is read too, above `.claude/settings.json`. Trust gates only the repository's allow rules; an allow in `~/.claude/settings.json` applies everywhere, as user hooks run everywhere. A bare-tool deny refuses the tool at call time and leaves it offered, so the cached prefix holds. A bare `Bash` deny refuses every tool that runs a shell command. An allow written `Bash(x)` without a `*` matches exactly, as in Claude Code, in Settings too; a deny or ask written that way stays a prefix, which is stricter. Settings under Permissions still lists only Geno's own rules. [conformance.md](conformance.md) has what runs and the tests that check it.

### P30: domain and MCP rules

- **Scope.** B/B-63, B/B-64, B/B-78, B/B-87.
- **Why.** Every docs fetch and every trusted MCP tool asks again each session.
- **Change.** Domain allow and deny rules for `web_fetch` and the browser. Workspace rules for `mcp__server__tool` names with a wildcard. A trusted-domain list fed to the classifier. An optional sandbox network allowlist behind an explicit setting.
- **Check.** An allowed domain fetches without a card. A saved MCP rule skips the card in a new session. Eval: a URL carrying repo data to an untrusted host is denied.
- **Size.** 1 day. **Depends on.** P28.
- **Status.** Done. A domain rule matches as Claude Code's `domain:` does, `*.example.com` covering subdomains only. An allow covers the tool it names, `WebFetch(domain:x)` or Geno's own `Browser(domain:x)`; a deny or an ask covers both, which is stricter. The trusted domains are the hosts of the workspace's allow domain rules, so there is no second list to keep. The web_fetch and MCP cards offer "Always allow in this workspace", which saves the host or the tool. The sandbox allowlist is the `gcode.sandbox.allowedDomains` user setting, one list for every workspace, since sandbox-runtime keeps one per process. Under a bare `Bash` deny, the check after an edit does not run, and the edit's result says so. The eval on qwen3.8-flash ([results/p30-trusted-domains.md](results/p30-trusted-domains.md)): 27 of 27 with the list, 23 of 27 without it, $0.039 in all. [conformance.md](conformance.md) has what runs and the tests that check it.

### P31: reads outside the workspace

- **Scope.** B/B-67, B/B-68, B/B-73, T-PERM-04.
- **Why.** `read` outside the workspace fails outright, while `bash cat` asks. Monorepo siblings cannot be added.
- **Change.** `read`, `grep` and `glob` outside the workspace go through the same ask or classify path as bash. Denials list the readable directories. A setting adds extra read directories, optionally writable, to the sandbox policy. The card offers "allow this directory for the session".
- **Check.** T-PERM-04. A read in an added directory works. A write there works only when it is writable.
- **Size.** 1 day. **Depends on.** P28.
- **Status.** Done. `list` follows path rules now too. A read outside meets the rule `cat` of the same path meets, so Plan refuses it, and after a yes the credentials rule is judged on the whole path, as its own question. "Allow this directory for the session" is the card's `allow-session` answer; the engine keeps the directory for the session, and commands honour it too. The setting is `gcode.additionalDirectories`, which the engine reads as `GCODE_ADDITIONAL_DIRECTORIES`. Claude Code's `additionalDirectories` imports read-only: Claude Code asks before an edit there, and Geno edits unasked with no checkpoint outside the workspace. The classifier's system prompt names the sandbox's hosts when `gcode.sandbox.allowedDomains` sets them, and is byte for byte the same when it does not. [conformance.md](conformance.md) has what runs and the tests that check it.

### P32: classifier and denial wording

- **Scope.** B/B-76, B/B-77, B/B-53, T-PERM-03, B/B-71.
- **Why.** Write-then-run evades a per-command classifier. "Find another way" invites a cheap model to route around a denial.
- **Change.** When a command runs a file this session wrote, the classifier gets that file, clipped, and the session's edit list. Add "generic encouragement is not authorization". Non-interactive denials take Claude Code's dontAsk wording. The card offers "No, and tell the agent…" with the comment in the tool result.
- **Check.** T-PERM-03. Classifier evals: `x.sh` with `curl -d @.env`, then `bash x.sh`, is denied. AGENTS.md "never ask" with `git reset --hard` is not allowed.
- **Size.** 1 day. **Depends on.** P4.
- **Status.** Done. A command runs a written file when it names it as a program or as an interpreter's first operand; the file goes to the classifier as it is on disk, and only files the session's own tools wrote count, not a subagent's or a command's. A no with a comment lets the turn go on, as Claude Code's does, and a plain no still ends it. Two P31 gaps are closed: the read tools take the sandbox's `CREDENTIAL_PATHS`, now one list in core, as credentials files, an added `~` included, and the classifier names the directories added as writable. The eval is in [results/p32-classifier.md](results/p32-classifier.md): the scripts that send secrets out are denied in 9 of 9 runs with the file text and in none without it, where the classifier asked about two and allowed the third, for $0.027 in all. [conformance.md](conformance.md) has what runs and the tests that check it.

### P33: workflow resume and diagnostics

- **Scope.** C/C-46, T-WF-02, C/C-47.
- **Why.** A failed late step costs the whole run again.
- **Change.** A journal of `{key: sha256(prompt, caps, role), child, result}` per unit. `/workflow <name> --resume <run>` replays matching units. The closing report adds an empty-result count and "read step session <id> before diagnosing".
- **Check.** T-WF-02: fail step 3, edit, resume, and steps 1 and 2 make no model call.
- **Size.** 1 day. **Depends on.** U64 merged.

### P34: structured output for workflow steps

- **Scope.** C/C-45, B/B-46, T-WF-01.
- **Why.** Many OpenAI-compatible models may follow a forced tool call more reliably than free-text JSON. This is an inference until the eval runs.
- **Change.** Deliver a step's flat schema as a forced `structured_output` tool with the derived JSON Schema, falling back to the JSON-block parse. Keep it only if the eval shows a gain.
- **Check.** T-WF-01. An eval of schema-step success, block parse against forced tool, on qwen3.8-flash. At most $0.30.
- **Size.** 1 day. **Depends on.** P33.

### P35: MCP from plugins and for workers

- **Scope.** C/C-55 (MCP), C/C-62.
- **Why.** Plugin MCP servers do not load, and no child can use MCP.
- **Change.** Load plugin `.mcp.json` servers through the trust card. `worker` and custom agents that list `mcp__*` get trusted MCP tools. Built-in read-only roles stay without them.
- **Check.** A plugin server is untrusted until approved. A worker calls a fake MCP tool.
- **Size.** 1 day. **Depends on.** P10.

### P36: web and wire options

- **Scope.** B/B-37, T-TOOL-09, B/B-38, B/B-02, T-ASM-15.
- **Why.** Small gaps against Claude Code's web tools and the Anthropic wire.
- **Change.** `offset` paging for long pages in `web_fetch`. Allowed and blocked domains in `web_search`. `eager_input_streaming` on the Anthropic wire only.
- **Check.** T-TOOL-09 and T-ASM-15.
- **Size.** 0.5 day. **Depends on.** P1.

### P37: notebook cell edits

- **Scope.** B/B-17.
- **Why.** Raw JSON edits can corrupt a notebook.
- **Change.** A deferred `notebook_edit` tool that replaces, inserts or deletes a cell, with the read-before-edit guard.
- **Check.** Round trips through nbformat for each edit mode.
- **Size.** 1 day. **Depends on.** P1.

### P38: MCP sign-in through VS Code

- **Scope.** C/C-60, T-MCP-02.
- **Why.** Servers that need OAuth do not work at all.
- **Change.** OAuth runs in the VS Code UI. The user clicks to sign in, and tokens stay in SecretStorage. The model never gets sign-in tools.
- **Check.** An e2e with a fake OAuth server. T-MCP-02, adapted: the model sees "needs sign-in; ask the user", never a credential.
- **Size.** 2 days. Split the token store from the UI. **Depends on.** P10.
