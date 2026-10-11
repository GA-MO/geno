# Suspected defects found while writing the docs site (2026-10-12)

Agents that traced the harness for `packages/docs` read the code behind each scenario. These are the behaviors that looked wrong. "Read" means the code was read and the claim follows from it. "Called" means a function was called directly and showed the behavior. No row was reproduced in a live Geno session. Each scenario page that shows the behavior describes it in its prose. A dash in Evidence means the file is named on that page, not here.

## Turn loop and model wire

| # | Behavior | Evidence | Status |
| --- | --- | --- | --- |
| 1 | A stream that ends before `message_stop` throws `EngineError`, not `AnthropicError`, so the gateway does not retry it, although the transient patterns list that case. | `engine/src/wire.ts`, `engine/src/gateway.ts` | Read |
| 2 | An exception that escapes `drive` ends the turn with no `error` event, and the panel shows only "Internal error". The message stays in the SDK's `data.details` and nothing writes it to stderr. | `engine/src/serve.ts` `runTurn` | Read |
| 3 | A text `max_tokens` stop ends the task `failed` with no error event, so the panel shows Failed with no reason. | `engine/src/drive.ts` `finish` | Read |
| 4 | Retry after a Stop that came before any answer sends the prompt twice in one user message. | `core/src/session.ts`, `extension/src/chat/render.ts` | Read |
| 5 | Retry sends only the text. Attachments and mentions are dropped. | `extension/src/chat/render.ts` (`{type:'send', text}`) | Read |
| 6 | An effort change during a turn applies from the next run, not the next model call, and the panel does not say so. | `engine/src/drive.ts` `withTurnEffort` | Read; may be by design |
| 7 | Text streamed before Stop or a failure is never logged, so a reload shows none of it. | `engine/src/serve.ts` live text | Read |
| 8 | After an engine crash mid-tool, an unanswered `tool_use` in the main session runs again on the next prompt. | `core/src/loop.ts` `loopStep` | Read |
| 9 | After a successful `/compact` or any `@agent`, the panel shows "Geno stopped without a reply". | `missingReply` | Called |
| 10 | A denied call followed by calls answered "rejected" shows "Its last reply had no text." instead of saying the turn stopped at the denied call. | `missingReply` | Read |
| 11 | A steer that misses a failed turn still runs as the next turn, while a queued follow-up returns to the composer. A refused chat steer shows no message. | — | Read |
| 12 | Stop while a permission card waits may tell the model the command "may have partly run", depending on whether `session/cancel` or the card answer reaches the engine first. | — | Read; order not confirmed |
| 13 | The UserPromptSubmit hook is not raced against Stop, so Stop waits for a slow hook. | `engine/src/drive.ts` `submitted()` | Read |

## Tools, permissions and hooks

| # | Behavior | Evidence | Status |
| --- | --- | --- | --- |
| 14 | `read` shows a line that starts with `[Geno` as `‹Geno`, so an `edit` that copies the line does not match the file. | `numberedPage` | Called |
| 15 | Web-search and Edit path-rule cards are titled "Run this command?". | `extension/src/chat/render.ts` card faces | Read |
| 16 | A PreToolUse hook's "ask" card joins two sentences: "Geno asks because it uses A PreToolUse hook [settings] asks first: … ..". | `render.ts` `commandBody` | Read |
| 17 | A Stop hook that only prints `additionalContext` keeps the turn going as if it had blocked. | `engine/src/drive.ts` `stopKeepsGoing` | Read |
| 18 | Plan mode refuses `edit` with a tool error, so the step shows failed, not denied. | `engine/src/tools/agent.ts` | Read |
| 19 | With no TTY, the CLI records a refusal as the user's, and the exit code is 0 after any refusal. | — | Read |

## Agents and background work

| # | Behavior | Evidence | Status |
| --- | --- | --- | --- |
| 20 | Denying a child's card shows the no-text notice, not "Denied by you", and the card drops the child's `[worker]` title prefix. | — | Read |
| 21 | At the parent turn's end a background child's row shows Cancelled while it still runs, and stays so if the user sends a new prompt first. | — | Read |
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
| 34 | `session/close` from another window stops a running turn; the owning panel shows "Stopped by you". | — | Read |
| 35 | "Fork from here" says "up to this message", but the fork also copies that message's answer. | — | Read |
| 36 | A mention error shows the user "Invalid params: …". | — | Read |
