# Phase 1 brief: model gateway and turn log

Read `research/synthesis.md` sections 5 (Session, Turn event) and 6 (Phase 1) first. This brief builds Phase 1 only and settles E1: does caching work, and what does a turn cost.

## Decision: Anthropic SDK through OpenRouter

The user has an OpenRouter key and no Anthropic key. OpenRouter serves an Anthropic Messages API compatible endpoint at `https://openrouter.ai/api`, documented as passing through thinking blocks, native tool use and prompt caching. So the gateway uses `@anthropic-ai/sdk` (`new Anthropic({ baseURL: 'https://openrouter.ai/api', authToken: <key>, apiKey: null })`, check the SDK's constructor types for the exact null/empty handling), not the Vercel AI SDK the synthesis named. Why: native tool types such as `text_editor_20250728` and exact `cache_read_input_tokens` / `cache_creation_input_tokens` usage, which synthesis assumption 2 and E3 depend on. Keep the gateway behind a small engine interface so another wire format can be added later without touching callers.

- Key from `OPENROUTER_API_KEY`. Missing key is a clear error naming the variable. Never log the key.
- Model ids are OpenRouter slugs. Default `anthropic/claude-opus-5.5`, override with `--model` or `GCODE_MODEL`.
- Opus 5.5 thinking is always on; control depth with `output_config.effort`, default `medium`, flag `--effort`. Do not send `thinking: {type: "disabled"}` or `budget_tokens` (400). No assistant prefill.
- Stream every request. `max_tokens` 64000.
- Check `stop_reason` before reading content. A `refusal` is logged as its own outcome and printed, not thrown.

## Caching

- System prompt is a stable constant in `packages/core` and must exceed 512 tokens, the minimum cacheable prefix on Opus 5.5 and Sonnet 5.5. Write it as the real base prompt for a coding agent working in a user's repo (tone, how to read before editing, how to report), since later phases build on it. No timestamps, ids or other volatile content in it.
- Breakpoints: `cache_control: {type: 'ephemeral'}` on the system block and on the last content block of the newest user message. That makes turn N+1 read the prefix turn N wrote.
- Pass the session id as `x-session-id` header (OpenRouter sticky routing, so follow-up turns hit the same provider's cache). Verify the SDK lets you set per-request headers; it does via request options.

## Data shapes (packages/core)

- `SessionId` brand. `Session` header: id, createdAt, workspace root (cwd), model, effort.
- `TurnEvent`, one JSON line each, discriminated by `kind`:
  - `session-start` carries the `Session` header. Always line 1.
  - `user` carries `seq`, `content` (text for now).
  - `assistant` carries `seq`, `content` (the SDK content blocks as returned, including thinking blocks, which must be replayed unchanged on later turns), `stopReason`, `usage` (`input`, `cacheRead`, `cacheWrite`, `output`), `costUsd`, `latencyMs`, `model`.
  - `error` carries `seq`, `message`, and whether it was a refusal, a transport error or an abort.
- `replayMessages(events)`: pure function from events to the `MessageParam[]` for the next request. A trailing `user` with no `assistant` (crash mid-stream) is kept, so the next run answers it rather than duplicating it.
- `costOf(model, usage)`: pure, from a price table keyed by OpenRouter slug. Seed it with the per-million rates from `https://openrouter.ai/api/v1/models` for `anthropic/claude-opus-5.5` (in 4.00, out 20.00, cache read 0.20, cache write 5.00) and `anthropic/claude-sonnet-5.5` (2.00, 10.00, 0.20, 2.50). Unknown model gives `null`, not 0.

## Storage

`$GCODE_HOME/sessions/<id>.jsonl`. Append-only. Write each event as one line with a single `appendFile` call. The reader skips a trailing line that fails to parse (torn write) and reports it, and fails on any earlier bad line, naming file and line number. Parse with zod at the boundary like `store.ts` does.

## CLI

- `gcode chat [--session <id>] [--model <slug>] [--effort <level>] <message...>`. New session when `--session` is absent; prints `session: <id>` first. Streams assistant text to stdout as it arrives. After the turn, prints one line: `usage: in=<n> cache_read=<n> cache_write=<n> out=<n> cost=$<x> latency=<ms>ms`.
- `gcode session show <id>` prints each turn with its usage line and the session totals.
- SIGINT during a stream aborts the request, appends an `error` event of kind abort, and exits 130.

## Tests that must exist (no network)

Use the SDK's `fetch` option to inject a fake transport that replays recorded SSE responses. Build the fixtures by hand from the Messages streaming format, including a `message_start` usage with cache fields.

- Turn log round trip: two turns produce `session-start`, `user`, `assistant`, `user`, `assistant`, and `replayMessages` rebuilds the right request, with the thinking block intact.
- The second request sent to the fake transport carries `cache_control` on the system block and on the newest user block, and the `x-session-id` header.
- A torn trailing line is skipped and reported; a torn middle line fails with file and line.
- A stream aborted mid-message leaves a log whose last events are `user` then `error`, and resuming sends that user message once.
- `costOf` on the seeded models and on an unknown model.
- Missing `OPENROUTER_API_KEY` produces the clear error.

## Done-check

1. `pnpm typecheck && pnpm test && pnpm build` pass.
2. Live, only if `OPENROUTER_API_KEY` is set in the environment (the shell loads the user's profile): `pnpm gcode chat "Say hi in five words."`, then `pnpm gcode chat --session <id> "Now in three words."`. The second usage line shows `cache_read` above zero. Report both usage lines literally. Spend stays under $0.10.
3. Live: start a chat with a prompt that produces a long answer, send SIGINT mid-stream, then `gcode session show <id>` parses the log and shows the abort.

If the key is not set, finish 1, say 2 and 3 are pending on the key, and stop. Do not ask for the key and do not look for it in files.

## Rules

- Dependencies allowed beyond Phase 0: `@anthropic-ai/sdk`.
- Comments only for a non-obvious why.
- Small ordered commits: core types and replay, cost table, session store, gateway, chat command, session show. Each ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Report the branch, worktree path, `git log --oneline`, literal done-check output, and anything you interpreted. Report specifically whether OpenRouter's Anthropic endpoint returned cache fields, thinking blocks and the effort setting as documented.
