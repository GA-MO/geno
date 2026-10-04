# Phase 2 brief: read-only tools and the agent loop

Read `research/synthesis.md` sections 5 (Tool runtime, Output spill, Turn event) and 6 (Phase 2), then the Phase 1 code. This phase settles E2: is grep enough for "where and how is X done" questions, or is a symbol outline needed.

## Outcome

`gcode ask` answers questions about a repo by looping over read-only tools until the model ends its turn. The session log records every tool call and result, so a run can be replayed and resumed.

## Provider and price

- Model Studio is the default provider now. Change `DEFAULT_PROVIDER` in `packages/engine/src/chat.ts` to `modelstudio`; the `.env` already sets `GCODE_PROVIDER=modelstudio`.
- Add `qwen3.8-flash` to `PRICES` in `packages/core/src/cost.ts` at input 0.15, output 0.47 per million (Alibaba Model Studio Singapore list price). The price page does not list cache rates, so bill `cacheRead` at 0.15 and `cacheWrite` at 0.1875 and say in the comment that these overstate the cost on purpose.
- Qwen tool use through the Anthropic-format endpoint works (a live probe returned `tool_use`, then `end_turn` after a `tool_result`). No new wire format is needed.

## Data shapes (packages/core)

- Tool registry. `Record<ToolName, ToolSpec>` where `ToolSpec` holds the Anthropic tool definition (`name`, `description`, `input_schema`) and nothing executable. Tools: `read` (path, optional `start_line`, `end_line`; returns numbered lines), `grep` (pattern, optional path glob, case flag; backed by ripgrep), `glob` (pattern), `list` (directory, depth). Definitions are a frozen, sorted array so the cached prefix is byte-stable.
- `TurnEvent` gains `tool-result`: `seq`, `at`, `toolUseId`, `name`, `status` (`ok` or `error`), and either `output` (inline text) or `spill` (`{ path, bytes, head, tail }`).
- `replayMessages` turns each assistant `tool_use` message plus the following `tool-result` events into one user message holding every `tool_result` block for that assistant turn, in tool-use order. All results for one turn go in a single user message.
- A pure `loopStep(events)` that says what happens next: `call-model`, `run-tools` with the pending tool uses, or `done` with the reason (`end_turn`, `max-turns`, `budget`, `refusal`, `error`). Encode this as a state derived from the event log, not as flags. The CLI loop asks it after every event.

## Engine

- Tool executors in `packages/engine/src/tools/`, one module per tool, looked up from a `Record<ToolName, Executor>`. Parse every tool input with zod at this boundary: the model is an external caller. A bad input becomes an `error` tool result with a precise message, never a throw.
- Workspace confinement. Resolve every path with `realpath` against the workspace root and reject anything outside it, including symlinks that escape. The spill directory is the one allowed read root outside the workspace.
- Output spill. A result over 24,000 characters is written to `$GCODE_HOME/spill/<session>/<seq>-<tool>.txt`; the model sees the first and last 2,000 characters, the byte count, and the spill path with a note that `read` with line ranges works on it.
- Run every tool use of one assistant turn concurrently, then append the results in tool-use order.
- `gcode ask [--session <id>] [--workspace <dir>] [--max-turns 25] [--max-cost 0.40] <question...>`. Workspace defaults to cwd and is recorded in the session header (already a field). Prints each tool call as one line (`> grep "SERVER_URL" src/**`), streams the final answer, then the usage line summed over the whole run and the turn count.
- Stopping. Stop at `--max-turns` model calls or when the summed estimated cost passes `--max-cost`. Both append an `error` event whose kind names the limit and exit 3. `gcode chat` keeps working and gains nothing it does not need.
- SIGINT mid-run behaves as in phase 1, including during tool execution.

## Caching

The tool definitions sit before the system prompt in the request, so the system-block breakpoint caches them too. After this change the cached prefix should exceed Qwen's minimum (somewhere between 792 and 1,664 tokens). Confirm it live: the second model call of an `ask` run reports `cache_read` above zero. Report the numbers.

## Tests that must exist (no network)

- Each tool on a fixture directory: correct output, line numbering for `read` ranges, ripgrep not installed gives a clear error, path escape via `..` and via a symlink both rejected as `error` results.
- Spill: a 100 KB grep result is spilled, the model-visible text holds head, tail and path, and `read` on the spill path works.
- Replay: an assistant turn with two tool uses produces one user message with both `tool_result` blocks in order, and a resumed session after a crash between tool execution and logging re-runs only the tools with no logged result.
- `loopStep` table test over hand-built event logs for every state.
- End to end through the fake transport: a two-step run (tool use, then answer) logs `user`, `assistant`, `tool-result`, `assistant`, and exits 0; a model that never stops hits `--max-turns` and exits 3.

## Done-check

1. `pnpm typecheck && pnpm test && pnpm build` pass.
2. Live: run `gcode ask --workspace ~/Development/payload-site-template "Where is the public site URL read, and what happens when it has a trailing slash?"`. Report the tool calls, the answer, and both the first and second call's usage lines.
3. E2: write `docs/e2-questions.md` with 10 "where and how is X done" questions about `~/Development/next-15-template` and `~/Development/payload-site-template`, each with the answer you find yourself by reading the code (file and line). Run `gcode ask` on each and save the transcripts under `$GCODE_HOME/e2/`. Do not grade the answers; the coordinator grades them. Report the total estimated cost.

## Rules

- No new dependencies. ripgrep is installed (`rg` 14.1.1).
- Never write inside the workspace; this phase is read-only.
- Small ordered commits: price and default provider, tool specs and replay, loop state, executors, spill, ask command, E2 questions. Each ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Report the branch, worktree path, `git log --oneline`, the literal done-check output, and anything you interpreted.
