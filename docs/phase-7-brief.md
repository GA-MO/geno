# Phase 7 brief: Tab v1, FIM ghost text on a local model

Read `research/synthesis.md` sections 5 (Tab provider, Completion request, Tab flow) and 6 (Phase 7). This phase settles E8 for the local half: can a local FIM model on this Mac meet the latency bar of 200 ms p50 and 500 ms p90. The hosted half of E8 is out of scope because the user is keeping spend low.

The machine is an Apple M4 with 16 GB RAM and Homebrew. Nothing local-model related is installed yet.

## Outcome

In VS Code, typing in a file shows ghost-text completions from a local Qwen2.5-Coder model through the stable inline completion API. Every request is logged, and `gcode tab report` turns the log into latency and acceptance numbers.

## Local model server

- Install llama.cpp with `brew install llama.cpp` (provides `llama-server`).
- Download a Qwen2.5-Coder 1.5B GGUF to `$GCODE_HOME/models/` (default `~/.g-code/models/`). FIM is trained into the base models; prefer a base GGUF, and if only instruct GGUFs are available, measure FIM quality on both before choosing. Q8_0 or Q4_K_M. Record the exact repo, file and sha256 in `docs/tab-model.md`.
- Add `scripts/tab-server.sh` that starts `llama-server` on 127.0.0.1:8012 with the model, a context size that fits the prompt budget, and flags suited to low-latency single-user completion. Document why each flag is there in `docs/tab-model.md`, not in the script.
- If a 3B model also fits and the 1.5B misses the bar, measure the 3B too.

## Data shapes (packages/core/src/tab/)

Pure code only, shared by the extension and the replay harness so both build identical prompts.

- `CompletionRequest` per synthesis section 5: kind (`fim` now, `next-edit` in phase 8), document path and version, cursor offset, prompt inputs (prefix, suffix, snippets with their source), model, prompt token estimate, time sent, time to first token, total latency, returned text, outcome. Outcome is a closed union: `cancelled`, `suppressed` (with the filter that dropped it), `shown`, `accepted`, `partial`, `rejected`, `typed-over`. Plus `persisted` (boolean or unknown) filled in later.
- `buildFimPrompt(inputs, budget)`: Qwen2.5-Coder FIM format with `<|fim_prefix|>`, `<|fim_suffix|>`, `<|fim_middle|>`, and other open files as `<|file_sep|>` context ahead of the current file. Trims prefix from the top and suffix from the bottom to fit the budget, keeping whole lines.
- Filters as a table of named predicates: empty or whitespace only, repeats the start of the suffix, exceeds a line limit, stale (cursor moved). A dropped result records the filter's name.
- Cache keyed by prefix hash, plus reuse of an in-flight or cached result when the user's typing matches the start of its text.

## Extension (packages/extension)

- `InlineCompletionItemProvider` registered for all file languages. Debounce 250 ms, cancel on the `CancellationToken`, abort the HTTP request on cancel.
- Settings: `gcode.tab.enabled`, `gcode.tab.endpoint` (default `http://127.0.0.1:8012`), `gcode.tab.debounceMs`.
- Log every request as one JSON line to `$GCODE_HOME/tab-events.jsonl` (respect `GCODE_HOME`, default `~/.g-code`). Outcomes the stable API can observe: shown is approximated by returning an item, accepted by a command attached to the item, typed-over and rejected by the next document change. Say in `docs/tab-model.md` which outcomes are exact and which are approximations.
- Persistence: when an item is accepted, check after 5 minutes whether the inserted text still exists unchanged in the document and append a `persisted` record.

## Engine CLI

- `gcode tab report [--since <iso>]` reads `tab-events.jsonl` and prints, per model: count by outcome, p50 and p90 of time to first token and of total latency over shown items, accept per shown, and persisted per accepted. Pure aggregation lives in core.

## Tests that must exist

- Prompt builder: token budget respected, whole lines kept, file_sep context ordering, FIM token order exactly as Qwen expects.
- Filters: each filter drops what it should and names itself.
- Cache and typed-ahead reuse.
- Report aggregation on a hand-built event log, including percentiles on even and odd counts.
- An extension integration test under `@vscode/test-electron` that opens a fixture file, triggers `editor.action.inlineSuggest.trigger` against a fake HTTP completion server, and asserts a ghost-text item was returned and a log line written. Keep the fake server in the test, so CI never needs the model.

## Done-check

1. `pnpm typecheck && pnpm test && pnpm build` pass, including the extension integration test.
2. E8 latency, measured per the benchmark checklist: a script `scripts/tab-bench.mjs` replays 100 cursor positions sampled from real `.ts` and `.tsx` files in `~/Development/next-15-template` (read-only) through the same `buildFimPrompt` the extension uses, against the running local server, sequentially, after a warmup of 5 requests that are not counted. Report p50 and p90 of time to first token and total latency, prompt token sizes, the model and quantization, and whether the numbers pass 200 ms p50 and 500 ms p90. Report what limits the number (prompt processing or generation) by also timing a run with half the prompt budget.
3. Eyeball check: print 5 completions from the bench with their cursor context so the coordinator can judge whether they are sensible code.
4. `gcode tab report` on the bench's event log prints the numbers above.

## Rules

- Dependencies allowed: `@vscode/test-electron`, `@types/vscode` (exists). Nothing else without a reason in the report.
- Do not touch `packages/engine/src/chat.ts`, `gateway.ts`, or `packages/core/src/session.ts`; another agent is changing the engine loop in parallel. Adding one entry to the engine's command table for `tab` is expected and will be merged by the coordinator.
- Never write inside `~/Development/next-15-template` or any other source repo.
- Small ordered commits. Each ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Report the branch, worktree path, `git log --oneline`, the literal done-check output, the installs you made, and anything you interpreted.
