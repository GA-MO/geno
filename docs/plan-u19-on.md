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
