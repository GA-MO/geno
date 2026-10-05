# Plan: U19 onward (approved 2026-10-06)

The user approved this order:
1. After U18a merges: U34, the boundary lint.
2. U21: effort per turn kind.
3. U36 (composer v2), then U18b (the working dino). Both touch the composer and the turn's current step, so they run one after the other.
4. U35: every provider, plus a settings page. It can run beside the others.

Every unit follows "Shared rules for every unit" in `docs/plan-u11-u14.md`. That includes its Verification rule: run the `unit` project, plus only the VS Code integration files your unit adds or touches. The coordinator runs the full suite before each merge.

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
- **Compact.** There is no compact action yet, so the context ring offers only the numbers (U36).
