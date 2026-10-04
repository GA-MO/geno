# Phase 3 brief: edit applier and the apply harness

Read `research/synthesis.md` sections 4 to 6 (Edit applier, Proposed change, chat-edit flow, Phase 3, E3, E4), then the Phase 0 replay code (`packages/core/src/replay.ts`, `packages/engine/src/replay.ts` or wherever `eval apply` lives) and the Phase 2 tool loop. This phase settles E3 (which edit format works best per model) and answers E4 (is a merge model needed) from the failure data.

## Outcome

An edit applier that turns a model's edit into hunks and a written file, with precise failure messages a model can act on, plus `gcode eval apply` measuring exact-match and failure rates per format and model over the 47 mined triples.

## Formats (a table, not a switch)

Each format is an entry in a `Record<EditFormat, FormatSpec>`: how the model is asked (tool definition or response instructions), how its output is parsed, and how it is applied.

- `str_replace`. A custom tool `edit` with `path`, `old_str`, `new_str` (and `create` for new files). Apply on an exact unique match. If zero matches, retry the match with whitespace normalized per line (trailing spaces, CRLF, indentation width) and accept only a unique normalized match. Failures: `zero-matches` names the closest candidate region with line numbers; `multiple-matches` gives the count and each start line.
- `apply_patch`. The V4A patch envelope (`*** Begin Patch`, `*** Update File:`, `@@` context anchors, `-`/`+` lines, `*** End Patch`) as a tool taking one `patch` string. Write a parser in core with tests on hand-written patches; parse errors are `parse-error` with the line.
- `whole_file`. The model returns the whole new file in a tool call. The baseline.
- `native_text_editor`. Anthropic's `text_editor_20250728` (`str_replace_based_edit_tool`). Try it once against Model Studio. If the endpoint rejects the type, record the exact error in `docs/e3-results.md` and drop it from the run; do not emulate it.

## Data shapes (packages/core)

- `ProposedChange` per synthesis section 5: producing turn (optional in the harness), path, base hash and mtime at last read, format, raw model output, hunks (range in base, old text, new text, status `pending`), apply result (`applied`, or `failed` with an `ApplyFailure` reason and detail), and a slot for the check result filled in phase 4.
- Hunks come from a line diff of base and result, so every format produces the same hunk shape.
- The stale-base check is part of applying: the caller passes the current file text; if its hash differs from the recorded base hash, the result is `stale-base` and nothing is written.

## Model-backed appliers

- The Phase 0 `appliersFor(triple)` table gains one model-backed applier per format. A model applier sends the instruction and the file (path plus numbered content) with the format's tool, applies the result, and on failure returns the precise error to the model as a `tool_result` with `is_error: true` and lets it retry, up to 2 retries.
- Record per attempt: first-try outcome, final outcome, retries used, usage and estimated cost.

## Harness

- `gcode eval apply --applier <name> [--model <id>] [--limit n] [--max-cost usd] [--out <file>]` prints exact-match rate, match-ignoring-trailing-whitespace rate, first-try failure rate, final failure rate, failure counts by reason, mean retries, total tokens and estimated cost. Results also go to `$GCODE_HOME/evals/apply-runs/<run-id>.jsonl`, one line per triple.
- Split every rate by triple `scope` (`commit` and `file-slice`), since slice instructions describe a whole commit and are harder.
- Run triples sequentially; stop at `--max-cost`.

## Done-check

1. `pnpm typecheck && pnpm test && pnpm build` pass.
2. E3: run all 47 triples for each available format on `qwen3.8-flash`, and the best two formats again on `qwen3.7-plus` ($0.40 in, $1.60 out per million). Keep the whole phase under an estimated $1.50. Write `docs/e3-results.md` with one table (format by model, every rate above, cost), the native-tool outcome, three representative failures quoted with their reason, and a one-paragraph E4 answer: given the best format's final failure rate, is a merge model worth adding. Every number in the doc comes from a results file you name.

## Tests that must exist (no network)

- `str_replace`: exact unique match, whitespace-normalized fallback, zero matches with the closest region named, multiple matches with line numbers, create a new file.
- `apply_patch` parser: update with context anchors, add file, delete file, malformed envelope.
- Stale base produces `stale-base` and writes nothing.
- Hunks from base and result for an edit with two separate changes.
- A model applier against the fake transport: first try fails with zero matches, the error reaches the model as `is_error: true`, the retry succeeds, and the record shows one retry.

## Rules

- No new dependencies.
- The `.env` with the user's key is git-ignored and missing from your worktree. Symlink it at your worktree root (`ln -s /Users/me/Development/g-code/.env .env`), never print or commit it, and delete the symlink before reporting.
- Small ordered commits. Each ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Report the branch, worktree path, `git log --oneline`, the literal done-check output, total estimated spend, and anything you interpreted.
