# Suspected defects found while writing the docs site (2026-10-12)

Agents that traced the harness for `packages/docs` read the code behind each scenario. These are the behaviors that looked wrong. "Read" means the code was read and the claim follows from it. "Reviewed" means a second agent, reviewing every page against the code, traced it again and it held. "Called" means a function was called directly and showed the behavior. No row was reproduced in a live Geno session. Each scenario page that shows the behavior describes it in its prose. A dash in Evidence means the file is named on that page, not here.

## Turn loop and model wire

| # | Behavior | Evidence | Status |
| --- | --- | --- | --- |
| 1 | A stream that ends before `message_stop` throws `EngineError`, not `AnthropicError`, so the gateway does not retry it, although the transient patterns list that case. | `engine/src/wire.ts:141`, `engine/src/gateway.ts:311` | Read; reviewed |
| 2 | An exception that escapes `drive` ends the turn with no `error` event, and the panel shows only "Internal error". The message stays in the SDK's `data.details` and nothing writes it to stderr. | `engine/src/serve.ts` `runTurn` | Read |
| 3 | A text `max_tokens` stop ends the task `failed` with no error event, so the panel shows Failed with no reason. | `engine/src/drive.ts` `finish` | Read; reviewed |
| 4 | Retry after a Stop that came before any answer sends the prompt twice in one user message. | `core/src/session.ts`, `extension/src/chat/render.ts` | Read |
| 5 | Retry sends only the text. Attachments and mentions are dropped. | `extension/src/chat/render.ts` (`{type:'send', text}`) | Read |
| 6 | An effort change during a turn applies from the next run, not the next model call, and the panel does not say so. | `engine/src/drive.ts` `withTurnEffort` | Read; may be by design |
| 7 | Text streamed before Stop or a failure is never logged, so a reload shows none of it. | `engine/src/serve.ts` live text | Read |
| 8 | After an engine crash mid-tool, an unanswered `tool_use` in the main session runs again on the next prompt. | `core/src/loop.ts` `pendingToolUses`; `engine/src/interrupted.ts` answers only children | Read; reviewed |
| 9 | After a successful `/compact` or any `@agent`, the panel shows "Geno stopped without a reply". | `extension/src/chat/rail.ts:185-195` | Called; reviewed |
| 10 | A denied call followed by calls answered "rejected" shows "Its last reply had no text." instead of saying the turn stopped at the denied call. | `extension/src/chat/rail.ts:193` | Read; reviewed |
| 11 | A steer that misses a failed turn still runs as the next turn, while a queued follow-up returns to the composer. A refused chat steer shows no message. | — | Read |
| 12 | Stop while a permission card waits may tell the model the command "may have partly run", depending on whether `session/cancel` or the card answer reaches the engine first. | `extension/src/chat/chat.ts:860-862` answers open cards, then sends `session/cancel` | Read; reviewed; order not confirmed |
| 13 | The UserPromptSubmit hook is not raced against Stop, so Stop waits for a slow hook. | `engine/src/drive.ts` `submitted()` | Read |

## Tools, permissions and hooks

| # | Behavior | Evidence | Status |
| --- | --- | --- | --- |
| 14 | `read` shows a line that starts with `[Geno` as `‹Geno`, so an `edit` that copies the line does not match the file. | `numberedPage` | Called |
| 15 | Web-search and Edit path-rule cards are titled "Run this command?". | `extension/src/chat/render.ts` card faces | Read |
| 16 | A PreToolUse hook's "ask" card joins two sentences: "Geno asks because it uses A PreToolUse hook [settings] asks first: … ..". | `extension/src/chat/render.ts:602` | Read; reviewed |
| 17 | A Stop hook that only prints `additionalContext` keeps the turn going as if it had blocked. | `engine/src/drive.ts` `stopKeepsGoing` | Read |
| 18 | Plan mode refuses `edit` with a tool error, so the step shows failed, not denied. | `engine/src/tools/agent.ts` | Read |
| 19 | With no TTY, the CLI records a refusal as the user's, and the exit code is 0 after any refusal. | — | Read |

## Agents and background work

| # | Behavior | Evidence | Status |
| --- | --- | --- | --- |
| 20 | Denying a child's card shows the no-text notice, not "Denied by you", and the card drops the child's `[worker]` title prefix. | — | Read; reviewed |
| 21 | At the parent turn's end a background child's row shows Cancelled while it still runs, and stays so if the user sends a new prompt first. | `extension/src/chat/transcript.ts:204` | Read; reviewed |
| 22 | The extension's `subagent_update` schema has no `interrupted` end, so the "Cut off when Geno stopped" look never shows from live updates. | `extension/src/chat/subagent-host.ts` | Read |
| 23 | The cancelled-child report reads "The subagent cancelled by the user…" (missing "was"). | — | Read |
| 24 | The budget refusal prints `$0.4`, and its "spent" includes money running children only reserved. | — | Read |
| 25 | After a Stop or error, wakes are paused; if the last awaited item then arrives, the Tasks pane shows nothing until the next prompt. | — | Read |
| 26 | `monitor` and `watch_pr` waits are not re-armed after an engine restart; only `schedule_wakeup` is. | `engine/src/wake-hooks.ts` | Read |
| 27 | The `/workflow --resume` card looks like a new run, and its cost counts steps that replay for free. | — | Read |

## Panel, sessions and settings

| # | Behavior | Evidence | Status |
| --- | --- | --- | --- |
| 28 | Opening the panel with no key shows the "no API key" toast before anything is sent. | — | Read |
| 29 | Model Studio needs a key and an endpoint, so a new user gets a second toast after setting the key. | — | Read |
| 30 | Changing a key or setting mid-turn resets the engine; the panel shows Failed while the old engine keeps running the turn. | `extension/src/chat/engine.ts` `resetEngine` | Read |
| 31 | After a model switch the composer shows the new model, but the open chat keeps the old one; a provider switch may leave it without its key. | `engine/src/chat.ts`, `settings-host.ts` | Read |
| 32 | A queued follow-up survives a chat switch and is sent into the new chat after that chat's next turn. | — | Read |
| 33 | Undo restores the whole workspace, including the user's own edits since the turn began; the confirm dialog appears only when later Geno turns changed files. | — | Read |
| 34 | `session/close` from another window stops a running turn; the owning panel shows "Stopped by you". | `engine/src/serve.ts:2060-2069` | Read; reviewed |
| 35 | "Fork from here" says "up to this message", but the fork also copies that message's answer. | `engine/src/rewind.ts:89` | Read; reviewed |
| 36 | A mention error shows the user "Invalid params: …". | — | Read |
| 37 | A queued follow-up whose text holds an `@` mention but no attachment can be sent mid-turn with Send now, so the mention goes as plain steer text and is never resolved. | `extension/src/chat/steer-model.ts:82` checks attachments only | Read |
| 38 | After an offline or retry wait ends and the call goes out again, the panel keeps the turn in its waiting state while the re-sent answer streams. | — | Read |
| 39 | Geno never checks whether the chosen model accepts images. A pasted or attached image goes to a text-only model as base64 and the provider's error reaches the user. | — | Read |
| 40 | A subagent's last allowed call carries the note "Do not call a tool" while the same request forces the `report` tool call. | `core/src/notice.ts` `LAST_CALL_NOTE`, `engine/src/drive.ts` | Read |
| 41 | The real-usecase archiver's Authorization-header redaction also matches "authorization:" inside the classifier prompt and breaks the JSON of that wire line (A09 fix-a1 and fix-b2). | `docs/results/real-usecases/runs/A09-auto-classifier/*/wire.jsonl` | Read |
| 42 | Real run B04 refuses an edit to a `/var/...` path that is inside the workspace (on macOS `/var` is a symlink to `/private/var`, so a realpath and a plain path may not compare equal). | `docs/results/real-usecases/runs/B04*` | Read; cause is a guess |
