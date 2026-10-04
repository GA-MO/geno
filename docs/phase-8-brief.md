# Phase 8 brief: Tab v2, next-edit prediction

Read `research/synthesis.md` sections 5 (Edit-history entry, Completion request, Tab flow) and 6 (Phase 8, exit rule), E9, E10 and E11 in section 8, then the Phase 7 code and `docs/tab-model.md`. The machine is an Apple M4 with 16 GB RAM; llama.cpp is installed from Phase 7.

## Outcome

The extension predicts the next edit from recent edit history, possibly away from the cursor, using Zeta 2.1 locally, shown through VS Code's proposed inline-edit API in VS Code Insiders. A replay harness grades predictions offline. If the model misses the latency bar locally, the phase ends with FIM only, per the synthesis exit rule, and says so.

## Model

- Zeta 2.1 (`zed-industries/zeta-2.1`, Apache-2.0, 8B, finetuned from Seed-Coder-8B-Base). Download one llama.cpp-compatible quantization (Q4_K_M or similar, about 5 GB) from the model's own Hugging Face page or a GGUF repo it links to, into `$GCODE_HOME/models/`. Record source and sha256 in `docs/tab-model.md`.
- Read the model card in full for the exact prompt template: suffix-prefix-middle layout with `<[fim-suffix]>`, `<[fim-prefix]>`, `<[fim-middle]>`, numbered `<|marker_N|>` editable-region markers, `<|user_cursor|>`, and how edit history and related context go in. Implement it exactly; test the builder against the card's example if it has one.

## Data shapes (packages/core/src/tab/)

- `EditHistoryEntry`: file path, time, old text of the changed range, new text. A rolling buffer of the last N per workspace; N is a parameter, swept in E10.
- `buildNextEditPrompt(history, document, cursor, related, budget)` and `parseNextEdit(output, region)` returning a structured edit (range and replacement) or `none`.
- `CompletionRequest` with kind `next-edit`, reusing the Phase 7 record and log.

## Replay harness (E10)

- No recorded human sessions exist yet, so build edit moments from git history as a proxy and say so in the results: for a mined multi-hunk commit, replay its first k hunks as the edit history on the parent file, and the target is hunk k+1. Use the triples in `$GCODE_HOME/evals/apply/` and their repos (read-only).
- Grade each prediction: exact match of the target hunk, the target region touched (location right, text wrong), wrong location, or `none`.
- `gcode tab replay [--history N] [--limit 100]` prints the grade counts and latency percentiles. Run it for N of 1, 3 and 6.

## Extension (E11)

- Track edit history from `onDidChangeTextDocument`.
- Show predictions through the proposed `inlineCompletionsAdditions` API (`isInlineEdit`, `displayLocation`) for off-cursor edits. Add the proposal name to `enabledApiProposals` in the extension manifest and the `.d.ts` from the VS Code repo for that proposal into the extension's types.
- Integration test under `@vscode/test-electron` with VS Code Insiders (`version: 'insiders'`) and `--enable-proposed-api` for the extension, using a fake completion server: make two edits, assert an off-cursor inline edit is offered at the predicted location.
- Stable VS Code (no proposed API) keeps Phase 7 FIM behavior unchanged.

## Done-check

1. `pnpm typecheck && pnpm test && pnpm build` pass, including the Insiders integration test.
2. E9 latency, per the benchmark checklist: p50 and p90 of time to first token and total latency for next-edit prompts on the local server, warmup excluded, sequential, with prompt token sizes. Compare to the 200 ms p50 and 500 ms p90 bar.
3. E10: replay grades for N of 1, 3 and 6 on up to 100 moments.
4. Exit rule: if E9 misses the bar, write that next-edit is off by default (`gcode.tab.nextEdit` false), FIM stays the shipped Tab, and what hardware or hosting would be needed. Keep the code and harness.
5. `docs/e9-e10-e11.md` with every number traced to a results file.

## Rules

- The live two-week trial is the user's; write what to log and how to read `gcode tab report` for it in the doc.
- No new dependencies without a reason in the report.
- Small ordered commits. Each ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Report the branch, worktree path, `git log --oneline`, the literal done-check output, the downloads with sources, and anything you interpreted.
