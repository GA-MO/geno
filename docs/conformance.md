# Conformance with Claude Code

The suite in `packages/engine/test/conformance/` checks Geno against the conformance tests in `research/claude-code-harness/spec/05-conformance-tests.md`. Each test title starts with its ID, such as `T-TOOL-12`. A test asserts `is_error` and meaning, never Claude Code's exact bytes. A test of what the model sees runs on the Anthropic wire and on the OpenAI-compatible wire.

The study behind the IDs, and the plan unit that owns each one, are in [claude-code-parity.md](claude-code-parity.md).

Run the suite with `pnpm vitest run --project unit packages/engine/test/conformance`.

## Tools (P2)

| ID | Claude Code | Geno | Status | Test |
|---|---|---|---|---|
| T-TOOL-12 | Bash exit 1 is `is_error`, with `Exit code 1` before the output. | `bash` with a non-zero exit, or killed at its timeout, returns an error result. It starts with `Exit code N` and keeps the trailing `[exit code N]` line. On the OpenAI-compatible wire the tool message starts with `[error]`. | pass (was fail) | `tools.conformance.test.ts`, both wires |

P2 also fixed rows that have no Claude Code conformance test. Their checks are unit and e2e tests:

| ID | Check |
|---|---|
| B/B-19, B/B-04 | T-TOOL-12 above. `plugins.e2e.test.ts` expects a sandbox-refused command as an error result. |
| N-01 | `tools.test.ts`: `grep` with `path: 'packages/core/src'` finds `pendingToolUses` in this repository. A `path` that names a directory or a file searches it, `glob` narrows it, and a search that looked at no file is an error. |
| B/B-25, C/C-77 | `plugins.test.ts` renders geno-tools text with and without the `agent` tool. `plugins.e2e.test.ts` checks that a run with `agentTool` points the model at the text that maps `Agent` to `agent`. |
| A/B-12 (text) | `context.test.ts` pins the skill listing, which tells the model to call the `skill` tool. |
