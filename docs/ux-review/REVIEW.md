# Geno chat panel: UX review (2026-10-10)

This review walks the VS Code chat panel as a user sees it, from the start page to errors and limits. It asks one question per screen: does this make sense to someone who did not build it? Each finding names where it shows, a screenshot, what the user sees, why it confuses, a severity and a concrete change. No product code changed.

Severity: **high** misleads the user or blocks them. **Medium** slows them down or confuses them. **Low** is polish.

## Top 15

| # | Finding | Severity | Where | Suggested change | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | A denied or refused call shows as a red **Failed** step, and its OUT box shows text written for the model ("STOP what you are doing…"). | high | 153-run replay: A08, A05, A09, A33; `approve-settled`, `auto-decision` | Give denial its own state: a grey "Denied by you" or "Denied by Auto" badge, and a one-line user-facing reason. Keep the model's text behind "Show details". | fixed, 2e54eede |
| 2 | While a command waits for approval, its step says "Running a command" with a spinner. The same command shows three times. | high | `approve-command`, `real-approval`, real shot B01 | Mark the step "Waiting for you" with no spinner. Show the command once, in the card. | fixed, 7717ae37 |
| 3 | A turn that ends with no answer looks like a normal finish ("worked for 2m 54s"). | high | A29 runs 1 and 2, A08 runs, A33 fix-a1/a2, B09 run 1 | When a turn ends with no text after its last step, add a notice: "Geno stopped without a reply", with Continue and Retry. | fixed, 32dcd1c9 |
| 4 | At panel widths under about 260 px, the Stop button and Retry slide past the edge while a turn waits on a rate limit or the network. | high | `rate-limited` and `offline` at 240 px; real shots r2 | Let the run status shrink and wrap first. Pin Stop to the right with a fixed width. Add 240 px to the gallery's overflow check. | fixed, eff1a11f |
| 5 | Steps show raw tool names and no target: `tool_search`, `skill`, `task_stop`, `monitor`, `web_fetch` with no URL, `ask_user`, `remember`. "Delegated to" shows no task. | medium | 46 of 153 runs; `tools-each-kind`, `question-card`, `memory-card` | Add verbs and targets for every tool: "Loaded skill poteto-mode", "Fetched example.com", "Stopped bg-1", "Asked you", "Delegated to explore: find callers of getUser". | fixed, 8c9ece35, d303b658 |
| 6 | Harness and CLI text reaches the user: `[abort] interrupted by the user`, `[max-turns] stopped after 6 model calls (--max-turns 6)`, `[exit code 0]`, `[Geno] Next time, search file contents with the grep tool`. | medium | B09 runs 1 and 2, A17, A27, 12 runs with harness text in output | Map each code to a sentence ("You stopped this turn", "Geno reached this run's limit of 6 model calls"). Show the exit code as a badge. Hide notes meant for the model. | fixed, c66b55dc |
| 7 | At 300 px the composer drops the mode word and the model name. It shows a bare shield and "medium" or "qwen3…". While a turn runs, the model chip disappears. | medium | `composer-model-menu`, `writing-tool`, real shots B01 to B10 | Keep the mode word and a short model name. Drop the effort word first. | open |
| 8 | Approval cards order and style their buttons differently per kind. "No, and tell the agent…" and the session option look like plain text. | medium | `approve-command`, `approve-path`, `approve-mcp`, `approve-rule` | One fixed order on every card: Allow, the remember option, Deny, "No, and tell the agent…". All as buttons, with number keys 1 to 4. | open |
| 9 | Task and subagent status misleads. A workflow that stopped at its cost cap shows **Done** and **New**. A capped subagent shows only a warning icon. A failed one shows no reason. Finished tasks read "0ms". | medium | `workflow-tasks`, `tasks`, `subagent-failed`, A11 run 1 | Show "Stopped at cost cap" as a warning chip. Write the reason on the row. Show the real duration or none. | open |
| 10 | Errors offer no next step. "Check the API key in Settings" has no button. A stalled model offers only Stop. A failed MCP server offers nothing. | medium | `error`, `no-response`, `gone-quiet`, `mcp` | Add "Open Settings", "Retry now" and "Restart server" buttons where the text names the fix. | open |
| 11 | The mode menu says Ask asks "before commands off the safe list". It does not say that edits apply without asking, and the safe list is not visible anywhere. | medium | `composer-mode-menu` | "Ask: edits apply right away and you can undo them. Commands not on the safe list ask first." Link "safe list" to the rules pane. | open |
| 12 | A failed command shows the first lines of its output and fades the line that explains the failure. | medium | `tool-failed`, real shot B03 | For a failed command, show the last lines. Keep "Show all N lines". | fixed, 4a4fcc7a |
| 13 | Large change sets take over the chat: 18 files of diff inline, a column of 18 file chips at 300 px, diffs that do not wrap, hunks out of order (Line 3 before Line 2). | medium | A31 run 2, A04 fix-s3-1, `edit-same-file` | Cap the diff card at about 3 files and 40 lines with "Show all". Cap chips at about 6 with "+12 more". Sort hunks by line. | open |
| 14 | Approval cards use internal syntax: `Bash(pnpm publish:*)`, `mcp__github__create_issue`, "an edit Claude Code asks about", `$ read /Users/…`, and "Auto could not decide" in Ask mode. | medium | `approve-rule`, `approve-mcp`, `approve-edit`, `approve-path`, `approve-classifier` | Plain words: "Always allow `pnpm publish` in this workspace", "github: create_issue", "Read a file outside the workspace". | open |
| 15 | The sticky prompt bubble covers the turn header and the start of the answer when the user scrolls. | medium | `workflow-started`, A19 run 1 | Collapse the sticky prompt to one line with a solid background, or drop it under the turn header. | open |

Counts: 4 high, 17 medium, 18 low (39 findings, numbered F1 to F40 with F12 folded into F31). A further 3 notes are model behavior, not UI, and are listed at the end.

## Round 1 fixes

Seven findings are fixed on branch `worktree-agent-a3822927d2adf5f8b`, one commit each. Each has a gallery state and a webview test in `packages/extension/test/webview/ux-review.webview.test.ts` that checks the new text and that nothing runs past the panel at 240 and 300 px. The gallery test now opens every state at 240 px too.

| # | Before | After | Shot (300 px Dark unless named) |
| --- | --- | --- | --- |
| 1 | A refused call is a red **Failed** step; its OUT box says "The user rejected `rm -rf build`, so it did not run. STOP what you are doing…" | A grey "Denied by you", "Denied by Auto", "Denied by a rule (`Bash(git push --force:*)`)" or "Denied by a hook", one plain reason such as "It did not run, and Geno waits for you.", and the model's text behind Show details. The panel reads the approval record the engine already sends. | [tool-denied](shots/r1-tool-denied-300.png), [A08 at 420 Light](shots/f01-denied-as-failed-A08.png), [auto-decision](shots/f01-auto-denied.png) |
| 2 | "Running a command" with a spinner, the IN box and the card: the command three times. | The step says "Waiting for you" on the amber node, with no spinner and no IN box. The command shows once, in the card, and on the step once the card is answered. | [approve-command](shots/f02-pending-shows-running.png), [real-approval in High Contrast](shots/f02-real-approval-hc.png) |
| 3 | "Geno worked for 2m 54s", then nothing. | "Geno stopped without a reply" with the reason ("Its last reply had no text.", "You stopped it before it answered.", "It reached its limit before it answered.", "It stopped at the call that was denied.") and, on the latest turn, Continue and Retry. | [no-reply](shots/r1-no-reply-300.png), [A29 run 2](shots/f03-no-answer-A29.png) |
| 4 | At 240 px, Stop is 21 px past the right edge during a rate limit and 34 px during an offline wait. | The wait text ends in an ellipsis first; Stop and Retry now keep fixed slots. The 240 px gallery check also found and fixed an edit card's head, a subagent's row and a provider key field. | [rate-limited at 240](shots/f04-stop-off-edge-240.png), [offline at 240](shots/r1-offline-240.png) |
| 5 | `tool_search`, `skill`, `task_stop`, `web_fetch` with no URL, `ask_user`, `remember`, "Delegated to" with no task. | "Loaded tools: web_fetch, monitor", "Used skill poteto-mode", "Stopped bg-1", "Fetched docs.stripe.com", "Asked you …", "Remembered", "Delegated to explore: …", "Showed 2 files". A unit test fails when the engine offers a tool the table lacks. A session load now titles every agent tool with its target, and a call whose input does not parse keeps its tool's name. | [tools-deferred](shots/r1-tools-deferred-300.png), [tools-each-kind](shots/f05-tool-kinds.png) |
| 6 | "[abort] interrupted by the user", "[max-turns] stopped after 6 model calls (--max-turns 6)", "[exit code 2]", "[Geno] Next time, search file contents with the grep tool…" | The footer says "Stopped by you"; a cap reads "Reached the turn limit (6)" as a warning; a failed exit is an "exit 2" badge; Geno's notes sit behind Show details. The engine marks a turn's error text with its kind, live and replayed. | [turn-limit](shots/r1-turn-limit-300.png), [A17 run 1](shots/f06-max-turns-A17.png), [B09 run 2](shots/f06-abort-tag-B09.png) |
| 12 | A failed command shows its first lines and fades "expected … got …". | It shows its last lines, with the fade at the top and the first lines behind "Show all N lines". | [tool-failed](shots/f12-failed-output.png) |

The replay of the archived runs now passes all eight checks in 150 of 160 runs, up from 86 of 153. The runs the findings named pass their checks: A05, A08, A09 and A32 show every refused call as denied and none as failed, and A33 fix-a1 and fix-a2 show their refused call as denied, though the read skipped after it still reads as failed (see open items); A29 runs 1 and 2, A08 and A33 fix-a1 and fix-a2 and B09 run 1 say they ended without a reply; no run shows a raw tool name; and no run shows harness text. What still fails:

- Thai answer in A27 run 2, A29 runs 1 and 2, and B09 run 1. That is the model's answer (N1), not the panel.
- No target in six runs (A12 run 2 and fix-s3-1, A19 fix-s2-1 and fix-s3-1, A25 fix-s2-2, A26 fix-s2-2): the model called `task_stop` with `{"wait":"false"}` and no id. The step reads "Stopped" with a red Failed. A call whose input does not parse could read "Could not stop" or name its error instead.

Open after round 1:

- A call skipped because the user rejected an earlier call of its turn ("The user rejected an earlier call of this turn, so this one did not run…") still reads as a red Failed step with the model's text, as in A33 fix-a1. The engine logs it as an error; it needs its own status, as a denial has now.
- A finished step keeps its finished verb when the call failed: A29 run 1's skill call that failed reads "Used skill pstack:poteto-mode" with Failed beside it.
- A capped turn shows "Failed" in its footer under "Reached the turn limit (6)" (F31's duplicate).
- The r2 VS Code shots, cut at about 225 px, do not reproduce in the gallery. At 225 px every gallery state fits but three, each by 2 to 4 px (the slash menu, a question's text field, the browse card). The r2 shots cut the header, the MCP banner and the user's bubble at the same x, with no composer in view, so the whole document is laid out wider than the view. That points at the webview's viewport in VS Code, not at one element; finding it needs a run in VS Code at that width.

## How this review was made

- **Gallery.** I ran `pnpm ui` on port 5396 and shot all 85 states with playwright-core at 300 px and 420 px in Dark Modern and Light Modern, and at 300 px in Dark High Contrast. I read each state's visible text and its controls (labels, titles, sizes). I checked every state again at 240 px for elements past the edge. The scratch scripts and the 425 raw shots are in `scratchpad/ux-review/` and are not committed.
- **Every real run.** `scripts/replay-runs-ui.ts` (new, committed) turns each archived run in `docs/results/real-usecases/runs/` into panel actions with the pipeline `scripts/run-to-gallery.ts` uses. That is the engine's `replayUpdates` and the extension's `session-updates.ts` mapping, which `ChatProvider` uses on a session load. It plays each run into the real panel bundle that the gallery server builds, at 300 px Dark (compact detail) and 420 px Light (full detail). It records console errors, elements past the edge, text cut with no way to read it, raw tool names, steps with no target, harness text, a Thai prompt with a non-Thai answer, and a turn that ends on a tool step. 153 of the 154 run folders replayed. B07-subagent-row run 1 has no session log, because its test setup failed before the prompt (T-02 in ISSUES.md). No model was called.
- **Real VS Code shots.** I read the 29 Layer B shots in `docs/results/real-usecases/shots/`. They show the panel at its real width in a VS Code window, about 225 px.
- **Code.** I read the panel code only to confirm what a label means: `render.ts` (steps, chips, failed badge), `composer-view.ts` (context ring), `mcp-panel.ts`, and `session-replay.ts` (where step targets come from).

The replay shows a session as a load replays it, which is close to what the panel showed live. Two differences matter. A live turn shows approval cards, and a replayed one does not. A replayed error ends as text, as the panel shows a reloaded session. Findings that rest only on the replay say so.

## Findings

### Approvals

**F1. A denied call looks like a failure, and shows the model's instructions (high).**
- Where: replay of A08-ask-risky-denied run 1 ([shot](shots/f01-denied-as-failed-A08.png)), A05-deferred-web-fetch run 1 ([shot](shots/f01-denied-as-failed-A05.png)), A09, A32, A33. Gallery `approve-settled` ([shot](shots/f01-settled-cards.png)) and `auto-decision` ([shot](shots/f01-auto-denied.png)).
- What the user sees: the step "Delete build folder and run tests" gets a red **Failed** badge. Its OUT box reads "The user rejected `rm -rf build`, so it did not run. STOP what you are doing and wait for the user to tell you how to proceed." In A05, `web_fetch` shows **Failed** with no URL. In `auto-decision`, a step carries both "Auto-denied" and "Failed".
- Why it confuses: nothing failed. The user, or a rule, said no. Red Failed tells the user something broke. The OUT text speaks to the model in capitals, and in A08 the user never saw a card (the CLI refused it), so "The user rejected" is also untrue for them. Claude Code shows a refusal as a muted line under the call, not as an error (from memory of its UI, not checked in this session).
- Change: add a `denied` look for a step, with a circle-slash icon, grey text and "Denied by you", "Denied by Auto" or "Denied by a rule". Replace the OUT box with one line that says who denied it and why. Put the model-facing text behind "Show details".

**F2. A command waiting for approval looks like it is already running (high).**
- Where: `approve-command` ([shot](shots/f02-pending-shows-running.png)), `real-approval` in high contrast ([shot](shots/f02-real-approval-hc.png)), real shot `docs/results/real-usecases/shots/r1/B01-ask-card.png`.
- What the user sees: the step reads "Running a command" with a spinner and an IN box with the command. Right under it, the card asks "Run this command?" and repeats the command. In `real-approval` the description appears a third time as the card's title.
- Why it confuses: the user is asked to approve something the panel says has started. That is the moment trust matters most. The repetition also pushes the buttons down; at 300 px the card's buttons sit near the composer.
- Change: while a call waits on a card, the step reads "Waiting for you" with the attention dot and no spinner, and hides its IN box. The card shows the description once and the command once.

**F3. Approval card buttons change place and look from card to card (medium).**
- Where: `approve-rule` ([shot](shots/f08-card-rule.png)), `approve-path` ([shot](shots/f08-card-path.png)), `approve-mcp` ([shot](shots/f08-card-mcp.png)), `approve-command`.
- What the user sees: on a command card, Allow and Deny sit side by side, "Always allow in this workspace" is a full-width button below, and "No, and tell the agent…" is plain text. On the path card, "Allow this directory for the session" is plain text and Deny shares a row with "No, and tell the agent…". On the MCP card, Deny sits alone on the second row.
- Why it confuses: the user has to read every card to find Deny. Plain text does not look clickable. Claude Code numbers its choices (1 Yes, 2 Yes and don't ask again, 3 No and tell Claude), always in the same order, and takes the number key (from memory, not checked here).
- Change: one layout for every card. Allow, then the remember option, then Deny, then "No, and tell the agent…", all as buttons, with keys 1 to 4 and Esc for the last.

**F4. Approval cards speak in rule syntax and internal names (medium).**
- Where: `approve-rule` (`Bash(pnpm publish:*)`), `approve-mcp` (`mcp__github__create_issue`, [shot](shots/f08-card-mcp.png)), `approve-edit` ("Geno asks because it uses an edit Claude Code asks about", [shot](shots/f09-card-edit.png)), `approve-path` (`$ read /Users/me/notes/release-plan.md`), `approve-classifier` ("Auto could not decide" while the mode is Ask, [shot](shots/f09-card-classifier.png)).
- Why it confuses: the user writes Thai and is not a rules author. `Bash(…:*)` is Claude Code's settings syntax. A `$` prompt in front of `read` suggests a shell command that does not exist. "Auto could not decide" appears while the composer says Ask, which reads as a contradiction.
- Change: "Always allow `pnpm publish` commands in this workspace". "github: create_issue". "Read a file outside the workspace: ~/notes/release-plan.md". Show the classifier line only in Auto, or say "Auto's check also flagged it".

**F5. A settled card keeps its full size (low).**
- Where: `approve-settled` ([shot](shots/f01-settled-cards.png)).
- What the user sees: each answered card stays as tall as it was, plus a line "Allowed" or "Denied". Four answered cards fill the screen.
- Change: fold an answered card into one line on its step: "Allowed by you", "Denied: Push to my fork instead".

**F6. "Geno needs your permission" stays in VS Code after it was answered (medium).**
- Where: real shot `docs/results/real-usecases/shots/r1/B03-after-comment.png`.
- What the user sees: the turn is over and the card is answered, but the VS Code toast still says "Geno needs your permission: Delete the dist folder…".
- Change: close the toast when the card settles.

### The turn while it runs

**F7. A turn that ends without an answer looks finished (high).**
- Where: replay of A29-thai-big-create run 2 ([shot](shots/f03-no-answer-A29.png)) and run 1, A08 runs 1, fix-a1 and fix-b2, A33 fix-a1 and fix-a2, B09 run 1. Eight runs end on a tool step with no text after it.
- What the user sees: "Geno worked for 2m 54s", then "Read 4 files · searched 2 times", then nothing. No file, no answer, no error.
- Why it confuses: the header and the green rail say the work is done. In A29 the model ended with thinking only (G-03). The engine now nudges once and then ends with an error, so new runs should say so. But the panel itself never checks, so any other empty ending (a denied last call, a provider hiccup) still looks like success.
- Change: when a turn ends with no text after its last step, add a short notice under it: "Geno stopped without a reply." Offer Continue and Retry.

**F8. Harness and CLI text reaches the user (medium).**
- Where: replay of B09-stop-and-resume-thai run 2 ([shot](shots/f06-abort-tag-B09.png)), A27 run 1 ([shot](shots/f06-max-turns-A27.png)), A17 run 1 ([shot](shots/f06-max-turns-A17.png)), and the real shot `docs/results/real-usecases/shots/r2/B09-stopped.png`. In 12 runs a command's OUT box carries `[exit code N]`, and in A07 fix-s1-1 it carries "[Geno] Next time, search file contents with the grep tool, not grep".
- What the user sees: "[abort] interrupted by the user", "[max-turns] stopped after 6 model calls (--max-turns 6)", a CLI flag the panel user never set, and a note that scolds the model.
- Why it confuses: brackets and flags are log lines. The user did press Stop, so "interrupted by the user" talks about them in the third person. Claude Code shows "Interrupted by user" in plain words (from memory).
- Change: map each error code to a sentence. "You stopped this turn." "Geno reached this run's limit of 6 model calls." Strip the `[exit code N]` line and show a non-zero code as a badge on the step ("exit 1"). Do not show `[Geno] …` notes in the OUT box; they are for the model.

**F9. "Stopped" looks like an unchecked box (low).**
- Where: `stopped` ([shot](shots/f21-stopped.png)), B09 replays.
- What the user sees: an empty square, the stop icon, beside "Stopped". In a panel with todo lists, it reads as an unticked item.
- Change: use the filled stop square or circle-slash, in the muted color.

**F10. The status icons say "thinking" for things that are not thinking (low).**
- Where: `writing-tool` ("Writing edit src/game.ts" with a light bulb), `gone-quiet` and `no-response` ([shot](shots/f16-gone-quiet.png)).
- Why it confuses: a stall is a warning, and writing an edit is work. The bulb says the model is thinking.
- Change: a pencil for writing a tool call, a clock or warning icon for a stall.

**F11. Four running indicators at once (low).**
- Where: `tool-running`, `approve-command`.
- What the user sees: the header spinner, the step spinner, the dashed rail circle and the working dino all move at the same time.
- Change: keep the dino and one spinner, on the step that is running.

### Tool steps

**F13. Steps show raw tool names and no target (medium).**
- Where: in the replay of 153 runs, 46 runs show a raw tool name as the step's label and 51 show a step with no target: `tool_search` (69 steps), `skill` (33, never names the skill), `task_stop` (32), `monitor` (7), `bash_output` (3), `web_fetch` (2, no URL), `list_agents`, `recall`. "Delegated to" has no target in 5 runs (A11 runs and B07 run 2, [shot](shots/f05-capped-subagent-A11.png)). In the gallery: `web_fetch` in `tools-each-kind` ([shot](shots/f05-tool-kinds.png)), `ask_user` in `question-card` ([shot](shots/f05-question-card.png)), `remember`, `new_page`, `workflow`.
- Why it confuses: the rest of the rail speaks in verbs ("Read", "Searched for", "Edited"). `tool_search` means nothing to a user. "skill" with no name hides which skill ran. Two explore subagents in a row both read "Delegated to", so the user cannot tell the first try from the retry. Claude Code always shows the target, as in `Fetch(https://…)` or `Skill(name)` (from memory).
- Cause: the engine titles a call `<tool> <target>` (`titleOf` in `packages/engine/src/session-replay.ts`). Deferred and agent tools fall back to the bare name. The panel's `verbOf` has no verb for them. (Seen in the replay; the live path uses the same titles, inferred.)
- Change: a verb and a target for every tool the engine has. "Loaded the web_fetch tool" (or hide `tool_search` steps), "Loaded skill poteto-mode", "Stopped bg-1", "Fetched example.com", "Asked you a question", "Saved a note", "Opened dashboard.stripe.com", "Delegated to explore: find callers of getUser".

**F14. Generic command titles (low).**
- Where: 14 steps in the replay read "Ran a command" (the model gave no description).
- Change: when there is no description, title the step from the command's first word and target: "Ran git status", "Ran npm test".

**F15. A failed command hides its error (medium).**
- Where: `tool-failed` ([shot](shots/f12-failed-output.png)), real shot `docs/results/real-usecases/shots/r1/B03-after-comment.png`.
- What the user sees: "FAIL src/login.test.ts", "× trims the email", then a faded line with the actual "expected … got …", and "Show all 5 lines".
- Change: for a failed command, show the last lines of output, where errors usually are, as `from-end` already does for background jobs.

**F16. Glob and search targets cut with no way to read them (low).**
- Where: replay of A17 fix-a1, A28 fix-s2-3 and fix-s3-1: long regex targets end in an ellipsis and have no title.
- Change: add the full pattern as the target's title, as file chips already do.

**F17. "Found" names a pattern, not a result (low).**
- Where: `tools-each-kind` ("Found `src/**/*.test.ts`"), A11 replay ("Found `**/*.{js,ts,mjs,cjs}`").
- Change: "Listed files matching src/**/*.test.ts (4)".

### Edits and review

**F18. Large change sets take over the chat (medium).**
- Where: replay of A31-compaction-forced run 2 at 420 px full detail ([shot](shots/f13-18-files-full-A31.png)) and at 300 px compact ([shot](shots/f13-18-chips-A31.png)); A16 run 2 (54 chips); `edit-same-file` ([shot](shots/f13-long-diff.png)); A04 fix-s3-1 ([shot](shots/f13-hunk-order-A04.png)).
- What the user sees: in full detail, every hunk of 18 files sits inline in the chat. In compact at 300 px, 18 file chips stack into a column taller than the screen. Diff lines do not wrap, so each is cut at the right. In A04 the card lists "Line 3" before "Line 2".
- Change: cap the inline diff at about 3 files or 40 lines, with "Show all 18 files". Cap the chips at about 6 with "+12 more". Sort hunks by line number. Let diff lines wrap at 300 px, or show a scroll hint.

**F19. Two "1 file changed" lines in a row (medium).**
- Where: `edit-auto` and `finished-full` in full detail ([shot](shots/f14-two-changed-lines.png)).
- What the user sees: the diff card's header "1 file changed +1 −1", then right under it "1 file changed · Undo".
- Change: put Undo in the diff card's header and drop the second line when the card is shown.

**F20. Undo, Keep and Restore overlap (low).**
- Where: `edit-review`, `rewind-confirm`, `share-menu`.
- What the user sees: "Undo" on the changes line, "Undo all / Keep all" on the review card, and "Restore files" in the message menu. All three put files back, with different scopes.
- Change: name the scope in each label: "Undo this turn's edits", "Restore files to before this message".

### Composer and menus

**F21. At 300 px the composer hides the mode and the model (medium).**
- Where: `composer-model-menu` at 300 px ([shot](shots/f07-composer-300-model-menu.png)), `writing-tool` at 300 px ([shot](shots/f07-composer-300-running.png)), every real shot (about 225 px).
- What the user sees: a shield with no word, then "medium" or "qwen3…". In the real shots it is a shield and "Medium". While a turn runs, the model chip is gone.
- Why it confuses: the mode decides what Geno may do without asking, and the user cannot see it. "Medium" without a model reads like a setting of something unknown.
- Change: at narrow widths keep the mode word ("Ask") and a short model name ("flash"). Drop the effort word first, then the context ring.

**F22. The mode menu does not say what Ask does with edits (medium).**
- Where: `composer-mode-menu` ([shot](shots/f10-mode-menu.png)).
- What the user sees: "Ask: Ask before commands off the safe list."
- Why it confuses: since G-01, Ask asks before any command not on the safe list, but edits still apply without asking (FIXES.md). Claude Code's default mode asks before edits too, so a user coming from Claude Code will expect a card for each edit. The safe list itself is not shown anywhere.
- Change: "Ask: edits apply right away and you can undo them. Commands not on the safe list ask first." Make "safe list" open the permissions pane.

**F23. The context ring looks like a spinner (low).**
- Where: every composer (the circle left of the model name), `composer-model-menu` at 300 px.
- What the user sees: a ring partly filled, the same size and place as a loading spinner, with no number.
- Change: show it only above about 50% full, with the percent beside it, as Claude Code shows "Context left until auto-compact: N%" only when it is low (from memory).

**F24. Menus cut their descriptions at 300 px (low).**
- Where: `composer-slash` at 300 px ([shot](shots/f28-slash-300.png)), the effort note in `composer-model-menu` ("A change mid-chat rewrites Model Studio'…").
- Change: let the selected item's description wrap. Reword the effort note: "Changing effort mid-chat makes the next reply slower and costlier once."

**F25. "Run in a new lane" assumes the user knows what a lane is (low).**
- Where: `composer-send-menu` ([shot](shots/f29-send-menu.png)), the send button's title.
- Change: add a detail line: "A separate copy of the repo; you apply its changes when it is done."

**F26. An attachment error has no subject (low).**
- Where: `composer-attachments` ([shot](shots/f27-attachments.png)).
- What the user sees: "it is larger than 20 MB" in red, lowercase, under a chip strip whose last chip is cut off.
- Change: "huge.mov is larger than 20 MB, so it was not attached."

### Subagents, tasks, lanes, workflows

**F27. Task and subagent status misleads (medium).**
- Where: `workflow-tasks` ([shot](shots/f11-workflow-tasks.png)), `tasks` at 300 px ([shot](shots/f11-tasks-300.png)), `subagent-failed` ([shot](shots/f11-subagent-failed.png)), replay of A11 run 1 ([shot](shots/f05-capped-subagent-A11.png)).
- What the user sees: a workflow card says **New** and **Done**, and its line says "stopped at fix, which hit its cost cap". Finished tasks show "0ms". A capped subagent shows a warning triangle and nothing else; the parent's text has to explain "The subagent came back capped with no report". A failed subagent shows "Failed" with no reason. At 300 px task titles are cut to "Push the release …" because the status chips take the room.
- Change: a "Stopped at cost cap" warning chip instead of Done. Write the end reason on the subagent row ("hit its 4-turn cap", "error: …"). Show the elapsed time or nothing. At narrow widths put the status chip on the second line.

**F28. Cancel and Stop mean the same thing (low).**
- Where: `subagent-running` ("Cancel", [shot](shots/f31-subagent-running-300.png)), `tasks` ("Stop").
- Change: use "Stop" everywhere.

**F29. Lanes: Apply looks safest on a lane whose check failed (medium).**
- Where: `lanes` ([shot](shots/f20-lanes.png)), real shots `docs/results/real-usecases/shots/r1/B05-lanes-error.png` and `docs/results/real-usecases/shots/r2/B05-lanes-done.png`.
- What the user sees: "Check failed" in red, and **Apply** as the one filled button on that card. In the real runs, `/lane` opens the Lanes pane over the composer, so the user has to find Back before typing again (T-02).
- Change: make Apply secondary when the check failed or did not run, and say "Apply anyway". After `/lane`, stay in the chat and show a one-line notice that links to the lane.

**F30. The workflow card hides its Run button (medium).**
- Where: `workflow-card` ([shot](shots/f19-workflow-card.png)), `workflow-started`.
- What the user sees: five steps with roles, models and costs, then "About $0.02, at most $0.25. The run stops cleanly at its total cap of $0.40." The Run and Cancel buttons are below the fold at 420 px. After it starts, the whole card stays.
- Change: put the action row at the top or keep it sticky. Show one cost line ("about $0.02, never more than $0.40"). Fold the card to one line once it starts.

### Errors and limits

**F31. Errors and stalls offer no next step (medium).**
- Where: `error` ([shot](shots/f16-error-401.png)), `no-response`, `gone-quiet` ([shot](shots/f16-gone-quiet.png)), `mcp` (the failed `flaky` server, [shot](shots/f17-mcp.png)).
- What the user sees: "The model call failed: 401 Unauthorized. Check the API key in Settings." with no button, and a second red "Failed" under it. "The model went quiet 1m 37s ago · waiting up to 3m" with only Stop. A failed MCP server shows the raw error and no Retry.
- Change: "Open Settings" on a key error. "Retry now" on a stall, as rate limits already have. "Restart" on a failed server. Drop the duplicate "Failed" under an error.

**F32. At narrow widths the Stop button leaves the panel (high).**
- Where: `rate-limited` at 240 px ([shot](shots/f04-stop-off-edge-240.png)): the gallery reports "button.round-button.stop 21px past the right; the page scrolls sideways by 22px". `offline` at 240 px: Stop 34 px past the right. Real shots in `docs/results/real-usecases/shots/r2/` (for example `B07-subagent-row.png`, `B05-lanes-done.png`, `B09-stopped.png`) show the whole panel cut at the right at about 225 px: the MCP banner, the user's bubble and the lane cards run off the edge. The r1 shots at the same width do not, so this came in between the two runs; I could not reproduce that cause in the gallery.
- Why it matters: VS Code lets a side bar shrink to about 170 px. The one control that ends a stuck turn is the one that falls off.
- Change: let `.run-status` shrink and wrap before the Stop button moves. Give Stop a fixed slot. Add 240 px to the gallery's overflow test. Re-shoot B05 and B07 at 225 px to find what widened the r2 panel.

**F33. The usage pane shows ฿0.00 on every row (low).**
- Where: `usage` ([shot](shots/f25-usage.png)).
- Change: show baht with two significant digits (฿0.007), or hide the baht column under ฿0.01.

### MCP, settings and permissions

**F34. MCP switches say On for servers that are not running (medium).**
- Where: `mcp` ([shot](shots/f17-mcp.png)), real shot `docs/results/real-usecases/shots/r1/B08-trust-card.png`.
- What the user sees: the switch is on for "Needs your approval" and "Needs sign-in". The approval card under it offers "Turn off", which does the same as the switch. Each switch's accessible name is "<server> on", even for the server that is off. The switch is 28 × 16 px.
- Change: call the switch "Enabled" and show running state only in the chip. Drop "Turn off" from the card. Name the switch by the server alone and let `aria-checked` carry the state. Make the hit target at least 24 px tall.

**F35. Settings panes open with walls of syntax (medium).**
- Where: `settings-permissions` at 300 px ([shot](shots/f15-permissions-300.png)), `settings-hooks` ([shot](shots/f15-hooks.png)), `settings`.
- What the user sees: the permissions pane opens with a 20-line paragraph about `Bash(words)`, `Read(path)`, `WebFetch(domain:…)` and `mcp__server__tool`. At 300 px the rule chips wrap one or two characters per line ("Bash(gi / t push / -- / force:*)"). The hooks pane lists eleven event names in a paragraph. The provider select is cut ("Alibaba Model Studi"). The settings section scrolls sideways by 17 px at 240 px. The Agents section still offers Cursor and Claude Code installs while ACP backends are paused.
- Change: one short sentence per section, with the syntax behind "How rules match". Let rule text wrap at token boundaries and put the source file on its own line. Hide or mark the ACP agents as paused.

### Navigation and layout

**F36. The sticky prompt covers the turn (medium).**
- Where: `workflow-started` at 300 px ([shot](shots/f18-sticky-prompt.png)), replay of A19 run 1 ([shot](shots/f18-sticky-prompt-A19.png)).
- What the user sees: the user's message stays pinned at the top with a fade, and the turn header and the first lines of the answer slide under it.
- Change: pin a one-line version with a solid background, or let the turn header pin instead.

**F37. The message menu hides behind a small icon (low).**
- Where: `share-menu` ([shot](shots/ok-share-menu.png)).
- What the user sees: a 16 px history icon under the user's bubble opens Restore, Fork, Mark a chapter and Save as page. The menu itself reads well.
- Change: show the icon with a label on hover of the bubble, or add the actions to the bubble's context menu.

**F38. The wake chip shows a raw prefix (low).**
- Where: `wake` at 300 px ([shot](shots/f26-wake.png)): "woke: 2 task…".
- Change: "Started by Geno: 2 tasks finished", cut at a word, with the full text as title.

**F39. Diagrams cut off at the right (low).**
- Where: `diagram` ([shot](shots/f30-diagram.png)). The gallery also logs "CSP refused style-src-elem inline" for this state.
- Change: fit the diagram to the panel width, or show a scroll hint. Find the inline style the renderer adds and move it into the stylesheet.

**F40. The start page shows a branch icon with no branch (low).**
- Where: `start-empty`, `composer-*` states.
- Change: hide the branch icon when there is no branch.

### Thai text

Thai renders well in every state and run I checked: prompts, answers, todo items and chips, at 300 px and in high contrast ([shot](shots/ok-thai.png)). No replacement characters appeared in 153 runs. The line breaks I checked fall between words. Two issues are model output, not UI, and are in the notes below.

## Notes that are not UI

- **N1. A Thai prompt answered in English.** A27 run 2, A29 runs 1 and 2, B09 run 1 (P-09). FIXES.md reports this fixed for new runs.
- **N2. Stray Chinese and Vietnamese words in Thai answers.** B09 run 2: "操作上", "如此", "chắc", "đó" inside Thai sentences. This is qwen3.8-flash output. A Thai answer check in the eval suite would catch it.
- **N3. The todo card.** B09 run 2 shows "0 of 14 done" on a stopped turn, and A10 shows "0 of 3 done" in a Plan answer. Another delegate is fixing the todo card, so this review leaves it alone.

## What works well

Keep these when acting on the findings above.

- The start page: the dino, the project and branch, and "Continue" with the last three chats ([shot](shots/ok-start.png)).
- The compact turn summary, "Read 2 files · searched 2 times · edited 1 file", with one file chip per file and its line counts.
- Keep and Undo per file and for all files, with "Kept" feedback ([shot](shots/ok-review.png)).
- The "Sent mid-turn" label on a steering message ([shot](shots/ok-steer.png)).
- The compaction divider: "Context compacted 182,000 → about 21,000 tokens" ([shot](shots/ok-compact.png)).
- The restore confirmation, which names the files and warns about edits with no checkpoint ([shot](shots/ok-rewind.png)).
- Background jobs: "Serving http://localhost:5173/ as bg-1" with its own Stop ([shot](shots/ok-background-job.png)).
- The message menu's labels: Restore files, Restore conversation, Restore both, Fork from here.
- The memory card's explanation: "Geno will follow this note in every later chat in this project. You can change or delete it in /memory."
- The question card with numbered options and "Other: type your own answer".
- Placeholder text that changes with state: "Queue a follow-up…" while running.
- High contrast: borders, focus rings and the attention color stay clear ([shot](shots/f02-real-approval-hc.png)).
- No console errors and nothing past the edge at 300 px in any of the 153 replayed runs.

## What I could not review

- **The live panel in VS Code.** The user was working in VS Code, so I opened no VS Code window and ran no integration test. Live-only behavior (focus after a card, toasts, the editor's own diff view, sign-in in the browser) rests on the 29 archived shots.
- **Cards in the replay.** A replayed session has no approval cards, so the approval findings rest on the gallery and the B01 to B03 shots.
- **Screen readers and keyboard.** I read the accessible names and sizes from the DOM; I did not drive a screen reader or tab through every state.
- **B07-subagent-row run 1.** It has no session log; the step failed in test setup before the prompt (T-02).
- **The r2 width regression in F32.** The gallery does not reproduce the clipped r2 panel; finding its cause needs a run at about 225 px in VS Code.
- **Claude Code comparisons.** `research/claude-code-harness` covers the harness, not the VS Code UI. Where a finding compares with Claude Code's UI, it says the comparison is from memory.

## Every replayed run

`scripts/replay-runs-ui.ts` made this table; run it against a gallery to refresh it. "Steps (full)" counts steps at 420 px in full detail; "Failed steps" and "Denied steps" count the steps marked so. "Checks passed" counts the eight checks: console, edge, cut, harness text, raw label, no target, Thai answer, and ends with answer, which a turn also passes when the panel says it ended without a reply. A check fails if it fails in either look. This table is from round 1, after the fixes above. Each shot is the run's final view at 300 px Dark, compact detail.

| Run | Steps (full) | Chips | Failed steps | Denied steps | Last header | Checks passed | Failed checks | Shot |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A01-fix-failing-test/1 | 5 | 3 | 0 | 0 | worked for 26s | 8/8 | none | [300 dark](shots/runs/A01-fix-failing-test__1.png) |
| A01-fix-failing-test/fix-a2 | 6 | 3 | 0 | 0 | worked for 27s | 8/8 | none | [300 dark](shots/runs/A01-fix-failing-test__fix-a2.png) |
| A02-thai-fix/1 | 6 | 3 | 0 | 0 | worked for 34s | 8/8 | none | [300 dark](shots/runs/A02-thai-fix__1.png) |
| A03-new-file-create/1 | 6 | 4 | 0 | 0 | worked for 33s | 8/8 | none | [300 dark](shots/runs/A03-new-file-create__1.png) |
| A03-new-file-create/2 | 6 | 5 | 0 | 0 | worked for 31s | 8/8 | none | [300 dark](shots/runs/A03-new-file-create__2.png) |
| A03-new-file-create/fix-a1 | 8 | 9 | 0 | 0 | worked for 42s | 8/8 | none | [300 dark](shots/runs/A03-new-file-create__fix-a1.png) |
| A03-new-file-create/fix-a2 | 9 | 7 | 0 | 0 | worked for 45s | 8/8 | none | [300 dark](shots/runs/A03-new-file-create__fix-a2.png) |
| A03-new-file-create/fix-b2 | 12 | 9 | 2 | 0 | worked for 1m 5s | 8/8 | none | [300 dark](shots/runs/A03-new-file-create__fix-b2.png) |
| A04-blind-edit-recovery/1 | 3 | 2 | 0 | 0 | worked for 15s | 8/8 | none | [300 dark](shots/runs/A04-blind-edit-recovery__1.png) |
| A04-blind-edit-recovery/fix-a1 | 8 | 3 | 1 | 0 | worked for 33s | 8/8 | none | [300 dark](shots/runs/A04-blind-edit-recovery__fix-a1.png) |
| A04-blind-edit-recovery/fix-a2 | 9 | 3 | 0 | 2 | worked for 1m 6s | 8/8 | none | [300 dark](shots/runs/A04-blind-edit-recovery__fix-a2.png) |
| A04-blind-edit-recovery/fix-a3 | 5 | 3 | 1 | 0 | worked for 22s | 8/8 | none | [300 dark](shots/runs/A04-blind-edit-recovery__fix-a3.png) |
| A04-blind-edit-recovery/fix-b2 | 5 | 3 | 0 | 0 | worked for 19s | 8/8 | none | [300 dark](shots/runs/A04-blind-edit-recovery__fix-b2.png) |
| A04-blind-edit-recovery/fix-s1-1 | 4 | 3 | 0 | 0 | worked for 17s | 8/8 | none | [300 dark](shots/runs/A04-blind-edit-recovery__fix-s1-1.png) |
| A04-blind-edit-recovery/fix-s1-2 | 7 | 2 | 0 | 0 | worked for 3m 8s | 8/8 | none | [300 dark](shots/runs/A04-blind-edit-recovery__fix-s1-2.png) |
| A04-blind-edit-recovery/fix-s3-1 | 8 | 3 | 0 | 1 | worked for 38s | 8/8 | none | [300 dark](shots/runs/A04-blind-edit-recovery__fix-s3-1.png) |
| A04-blind-edit-recovery/fix-s3-2 | 6 | 2 | 0 | 0 | worked for 29s | 8/8 | none | [300 dark](shots/runs/A04-blind-edit-recovery__fix-s3-2.png) |
| A05-deferred-web-fetch/1 | 2 | 0 | 0 | 1 | worked for 9.5s | 8/8 | none | [300 dark](shots/runs/A05-deferred-web-fetch__1.png) |
| A06-read-not-cat/1 | 3 | 1 | 0 | 0 | worked for 6.6s | 8/8 | none | [300 dark](shots/runs/A06-read-not-cat__1.png) |
| A06-read-not-cat/fix-a1 | 4 | 1 | 0 | 0 | worked for 12s | 8/8 | none | [300 dark](shots/runs/A06-read-not-cat__fix-a1.png) |
| A07-multi-step-todo/1 | 12 | 10 | 1 | 0 | worked for 40s | 8/8 | none | [300 dark](shots/runs/A07-multi-step-todo__1.png) |
| A07-multi-step-todo/2 | 12 | 12 | 1 | 1 | worked for 1m 20s | 8/8 | none | [300 dark](shots/runs/A07-multi-step-todo__2.png) |
| A07-multi-step-todo/fix-a1 | 10 | 10 | 0 | 0 | worked for 26s | 8/8 | none | [300 dark](shots/runs/A07-multi-step-todo__fix-a1.png) |
| A07-multi-step-todo/fix-a2 | 8 | 12 | 0 | 0 | worked for 30s | 8/8 | none | [300 dark](shots/runs/A07-multi-step-todo__fix-a2.png) |
| A07-multi-step-todo/fix-b2 | 8 | 12 | 0 | 0 | worked for 25s | 8/8 | none | [300 dark](shots/runs/A07-multi-step-todo__fix-b2.png) |
| A07-multi-step-todo/fix-s1-1 | 17 | 15 | 2 | 0 | worked for 1m 4s | 8/8 | none | [300 dark](shots/runs/A07-multi-step-todo__fix-s1-1.png) |
| A07-multi-step-todo/fix-s1-2 | 11 | 12 | 0 | 0 | worked for 31s | 8/8 | none | [300 dark](shots/runs/A07-multi-step-todo__fix-s1-2.png) |
| A07-multi-step-todo/fix-s2-3 | 8 | 10 | 0 | 0 | worked for 28s | 8/8 | none | [300 dark](shots/runs/A07-multi-step-todo__fix-s2-3.png) |
| A07-multi-step-todo/fix-s3-1 | 7 | 10 | 0 | 0 | worked for 22s | 8/8 | none | [300 dark](shots/runs/A07-multi-step-todo__fix-s3-1.png) |
| A07-multi-step-todo/fix-s3-2 | 8 | 11 | 1 | 0 | worked for 28s | 8/8 | none | [300 dark](shots/runs/A07-multi-step-todo__fix-s3-2.png) |
| A08-ask-risky-denied/1 | 2 | 0 | 0 | 1 | worked for 10s | 8/8 | none | [300 dark](shots/runs/A08-ask-risky-denied__1.png) |
| A08-ask-risky-denied/fix-a1 | 2 | 0 | 0 | 1 | worked for 6.5s | 8/8 | none | [300 dark](shots/runs/A08-ask-risky-denied__fix-a1.png) |
| A08-ask-risky-denied/fix-b2 | 3 | 0 | 0 | 1 | worked for 12s | 8/8 | none | [300 dark](shots/runs/A08-ask-risky-denied__fix-b2.png) |
| A09-auto-classifier/1 | 10 | 6 | 1 | 4 | worked for 2m 0s | 8/8 | none | [300 dark](shots/runs/A09-auto-classifier__1.png) |
| A09-auto-classifier/fix-a1 | 14 | 11 | 0 | 7 | worked for 2m 14s | 8/8 | none | [300 dark](shots/runs/A09-auto-classifier__fix-a1.png) |
| A09-auto-classifier/fix-b2 | 6 | 5 | 0 | 1 | worked for 36s | 8/8 | none | [300 dark](shots/runs/A09-auto-classifier__fix-b2.png) |
| A10-plan-mode/1 | 5 | 2 | 0 | 0 | worked for 49sPlan | 8/8 | none | [300 dark](shots/runs/A10-plan-mode__1.png) |
| A11-explore-subagent/1 | 6 | 0 | 0 | 0 | worked for 1m 32s | 8/8 | none | [300 dark](shots/runs/A11-explore-subagent__1.png) |
| A11-explore-subagent/fix-a1 | 2 | 0 | 0 | 0 | worked for 40s | 8/8 | none | [300 dark](shots/runs/A11-explore-subagent__fix-a1.png) |
| A11-explore-subagent/fix-a2 | 2 | 0 | 0 | 0 | worked for 25s | 8/8 | none | [300 dark](shots/runs/A11-explore-subagent__fix-a2.png) |
| A11-explore-subagent/fix-b2 | 2 | 0 | 0 | 0 | worked for 43s | 8/8 | none | [300 dark](shots/runs/A11-explore-subagent__fix-b2.png) |
| A12-background-server/1 | 8 | 2 | 1 | 0 | worked for 26s | 8/8 | none | [300 dark](shots/runs/A12-background-server__1.png) |
| A12-background-server/2 | 8 | 1 | 1 | 0 | worked for 32s | 7/8 | no target | [300 dark](shots/runs/A12-background-server__2.png) |
| A12-background-server/fix-a1 | 7 | 0 | 1 | 0 | worked for 26s | 8/8 | none | [300 dark](shots/runs/A12-background-server__fix-a1.png) |
| A12-background-server/fix-a2 | 10 | 1 | 2 | 0 | worked for 26s | 8/8 | none | [300 dark](shots/runs/A12-background-server__fix-a2.png) |
| A12-background-server/fix-a3 | 9 | 0 | 1 | 0 | worked for 29s | 8/8 | none | [300 dark](shots/runs/A12-background-server__fix-a3.png) |
| A12-background-server/fix-b2 | 11 | 1 | 2 | 0 | worked for 1m 28s | 8/8 | none | [300 dark](shots/runs/A12-background-server__fix-b2.png) |
| A12-background-server/fix-r3-1 | 5 | 1 | 0 | 0 | worked for 15s | 8/8 | none | [300 dark](shots/runs/A12-background-server__fix-r3-1.png) |
| A12-background-server/fix-r3-2 | 7 | 2 | 0 | 0 | worked for 30s | 8/8 | none | [300 dark](shots/runs/A12-background-server__fix-r3-2.png) |
| A12-background-server/fix-s1-1 | 8 | 1 | 0 | 0 | worked for 34s | 8/8 | none | [300 dark](shots/runs/A12-background-server__fix-s1-1.png) |
| A12-background-server/fix-s1-2 | 8 | 1 | 0 | 1 | worked for 31s | 8/8 | none | [300 dark](shots/runs/A12-background-server__fix-s1-2.png) |
| A12-background-server/fix-s2-1 | 8 | 1 | 0 | 1 | worked for 36s | 8/8 | none | [300 dark](shots/runs/A12-background-server__fix-s2-1.png) |
| A12-background-server/fix-s2-2 | 10 | 1 | 1 | 1 | worked for 39s | 8/8 | none | [300 dark](shots/runs/A12-background-server__fix-s2-2.png) |
| A12-background-server/fix-s2-3 | 8 | 0 | 1 | 1 | worked for 24s | 8/8 | none | [300 dark](shots/runs/A12-background-server__fix-s2-3.png) |
| A12-background-server/fix-s3-1 | 7 | 0 | 1 | 0 | worked for 17s | 7/8 | no target | [300 dark](shots/runs/A12-background-server__fix-s3-1.png) |
| A12-background-server/fix-s3-2 | 19 | 1 | 4 | 1 | worked for 1m 52s | 8/8 | none | [300 dark](shots/runs/A12-background-server__fix-s3-2.png) |
| A12-background-server/fix-s3-3 | 4 | 0 | 0 | 0 | worked for 14s | 8/8 | none | [300 dark](shots/runs/A12-background-server__fix-s3-3.png) |
| A13-fail-then-fix/1 | 3 | 3 | 0 | 0 | worked for 36s | 8/8 | none | [300 dark](shots/runs/A13-fail-then-fix__1.png) |
| A14-deny-rules/1 | 8 | 6 | 1 | 1 | worked for 1m 6s | 8/8 | none | [300 dark](shots/runs/A14-deny-rules__1.png) |
| A15-large-file-write/1 | 14 | 3 | 0 | 1 | worked for 7m 24s | 8/8 | none | [300 dark](shots/runs/A15-large-file-write__1.png) |
| A15-large-file-write/fix-a2 | 9 | 3 | 1 | 0 | worked for 6m 50s | 8/8 | none | [300 dark](shots/runs/A15-large-file-write__fix-a2.png) |
| A16-compaction-goal/1 | 12 | 3 | 0 | 0 | worked for 1m 9s | 8/8 | none | [300 dark](shots/runs/A16-compaction-goal__1.png) |
| A16-compaction-goal/2 | 15 | 54 | 0 | 0 | worked for 3m 3s | 8/8 | none | [300 dark](shots/runs/A16-compaction-goal__2.png) |
| A17-budget-reminder/1 | 6 | 0 | 0 | 1 | failed after 58s | 8/8 | none | [300 dark](shots/runs/A17-budget-reminder__1.png) |
| A17-budget-reminder/2 | 8 | 1 | 0 | 0 | failed after 28s | 8/8 | none | [300 dark](shots/runs/A17-budget-reminder__2.png) |
| A17-budget-reminder/fix-a1 | 7 | 3 | 1 | 0 | worked for 28s | 8/8 | none | [300 dark](shots/runs/A17-budget-reminder__fix-a1.png) |
| A17-budget-reminder/fix-a2 | 6 | 2 | 0 | 0 | worked for 40s | 8/8 | none | [300 dark](shots/runs/A17-budget-reminder__fix-a2.png) |
| A17-budget-reminder/fix-b2 | 9 | 27 | 0 | 0 | failed after 1m 13s | 8/8 | none | [300 dark](shots/runs/A17-budget-reminder__fix-b2.png) |
| A18-project-skill/1 | 8 | 6 | 0 | 0 | worked for 37s | 8/8 | none | [300 dark](shots/runs/A18-project-skill__1.png) |
| A18-project-skill/2 | 15 | 6 | 1 | 0 | worked for 49s | 8/8 | none | [300 dark](shots/runs/A18-project-skill__2.png) |
| A18-project-skill/fix-a1 | 12 | 5 | 1 | 0 | worked for 43s | 8/8 | none | [300 dark](shots/runs/A18-project-skill__fix-a1.png) |
| A18-project-skill/fix-b2 | 11 | 4 | 1 | 0 | worked for 28s | 8/8 | none | [300 dark](shots/runs/A18-project-skill__fix-b2.png) |
| A19-poteto-thai/1 | 18 | 15 | 3 | 0 | worked for 5m 22s | 8/8 | none | [300 dark](shots/runs/A19-poteto-thai__1.png) |
| A19-poteto-thai/2 | 14 | 15 | 2 | 0 | worked for 2m 44s | 8/8 | none | [300 dark](shots/runs/A19-poteto-thai__2.png) |
| A19-poteto-thai/fix-a1 | 21 | 10 | 1 | 1 | worked for 1m 50s | 8/8 | none | [300 dark](shots/runs/A19-poteto-thai__fix-a1.png) |
| A19-poteto-thai/fix-a2 | 12 | 13 | 2 | 0 | worked for 1m 37s | 8/8 | none | [300 dark](shots/runs/A19-poteto-thai__fix-a2.png) |
| A19-poteto-thai/fix-b2 | 15 | 7 | 2 | 0 | worked for 1m 58s | 8/8 | none | [300 dark](shots/runs/A19-poteto-thai__fix-b2.png) |
| A19-poteto-thai/fix-r3-1 | 14 | 10 | 1 | 0 | worked for 1m 41s | 8/8 | none | [300 dark](shots/runs/A19-poteto-thai__fix-r3-1.png) |
| A19-poteto-thai/fix-r3-2 | 15 | 10 | 1 | 0 | worked for 1m 22s | 8/8 | none | [300 dark](shots/runs/A19-poteto-thai__fix-r3-2.png) |
| A19-poteto-thai/fix-s1-1 | 15 | 9 | 0 | 1 | worked for 1m 35s | 8/8 | none | [300 dark](shots/runs/A19-poteto-thai__fix-s1-1.png) |
| A19-poteto-thai/fix-s2-1 | 14 | 9 | 1 | 1 | worked for 1m 28s | 7/8 | no target | [300 dark](shots/runs/A19-poteto-thai__fix-s2-1.png) |
| A19-poteto-thai/fix-s2-2 | 20 | 12 | 0 | 0 | worked for 2m 10s | 8/8 | none | [300 dark](shots/runs/A19-poteto-thai__fix-s2-2.png) |
| A19-poteto-thai/fix-s2-3 | 9 | 7 | 0 | 1 | worked for 1m 15s | 8/8 | none | [300 dark](shots/runs/A19-poteto-thai__fix-s2-3.png) |
| A19-poteto-thai/fix-s3-1 | 18 | 11 | 2 | 1 | worked for 1m 45s | 7/8 | no target | [300 dark](shots/runs/A19-poteto-thai__fix-s3-1.png) |
| A19-poteto-thai/fix-s3-2 | 14 | 11 | 2 | 0 | worked for 1m 48s | 8/8 | none | [300 dark](shots/runs/A19-poteto-thai__fix-s3-2.png) |
| A19-poteto-thai/fix-s3-3 | 17 | 12 | 0 | 0 | worked for 1m 26s | 8/8 | none | [300 dark](shots/runs/A19-poteto-thai__fix-s3-3.png) |
| A20-thai-question/1 | 5 | 5 | 0 | 0 | worked for 15s | 8/8 | none | [300 dark](shots/runs/A20-thai-question__1.png) |
| A21-outside-workspace/1 | 7 | 1 | 0 | 0 | worked for 29s | 8/8 | none | [300 dark](shots/runs/A21-outside-workspace__1.png) |
| A21-outside-workspace/2 | 5 | 0 | 0 | 1 | worked for 19s | 8/8 | none | [300 dark](shots/runs/A21-outside-workspace__2.png) |
| A22-honest-failure/1 | 6 | 3 | 1 | 0 | worked for 56s | 8/8 | none | [300 dark](shots/runs/A22-honest-failure__1.png) |
| A23-injection/1 | 4 | 3 | 0 | 0 | worked for 22s | 8/8 | none | [300 dark](shots/runs/A23-injection__1.png) |
| A24-git-commit-safety/1 | 6 | 0 | 0 | 0 | worked for 22s | 8/8 | none | [300 dark](shots/runs/A24-git-commit-safety__1.png) |
| A24-git-commit-safety/2 | 7 | 0 | 0 | 0 | worked for 30s | 8/8 | none | [300 dark](shots/runs/A24-git-commit-safety__2.png) |
| A24-git-commit-safety/fix-a1 | 7 | 0 | 0 | 0 | worked for 52s | 8/8 | none | [300 dark](shots/runs/A24-git-commit-safety__fix-a1.png) |
| A24-git-commit-safety/fix-a2 | 8 | 0 | 0 | 1 | worked for 1m 0s | 8/8 | none | [300 dark](shots/runs/A24-git-commit-safety__fix-a2.png) |
| A24-git-commit-safety/fix-a3 | 6 | 0 | 0 | 0 | worked for 39s | 8/8 | none | [300 dark](shots/runs/A24-git-commit-safety__fix-a3.png) |
| A24-git-commit-safety/fix-b2 | 5 | 0 | 0 | 0 | worked for 28s | 8/8 | none | [300 dark](shots/runs/A24-git-commit-safety__fix-b2.png) |
| A24-git-commit-safety/fix-s1-1 | 8 | 2 | 1 | 0 | worked for 46s | 8/8 | none | [300 dark](shots/runs/A24-git-commit-safety__fix-s1-1.png) |
| A24-git-commit-safety/fix-s1-2 | 7 | 0 | 0 | 0 | worked for 33s | 8/8 | none | [300 dark](shots/runs/A24-git-commit-safety__fix-s1-2.png) |
| A24-git-commit-safety/fix-s2-3 | 8 | 1 | 0 | 0 | worked for 39s | 8/8 | none | [300 dark](shots/runs/A24-git-commit-safety__fix-s2-3.png) |
| A24-git-commit-safety/fix-s3-1 | 7 | 0 | 0 | 0 | worked for 37s | 8/8 | none | [300 dark](shots/runs/A24-git-commit-safety__fix-s3-1.png) |
| A24-git-commit-safety/fix-s3-2 | 8 | 1 | 1 | 0 | worked for 36s | 8/8 | none | [300 dark](shots/runs/A24-git-commit-safety__fix-s3-2.png) |
| A24-git-commit-safety/fix-s3-3 | 7 | 0 | 0 | 0 | worked for 28s | 8/8 | none | [300 dark](shots/runs/A24-git-commit-safety__fix-s3-3.png) |
| A25-game-feature/1 | 12 | 9 | 1 | 0 | worked for 1m 30s | 8/8 | none | [300 dark](shots/runs/A25-game-feature__1.png) |
| A25-game-feature/fix-s2-1 | 10 | 11 | 0 | 0 | worked for 1m 20s | 8/8 | none | [300 dark](shots/runs/A25-game-feature__fix-s2-1.png) |
| A25-game-feature/fix-s2-2 | 15 | 9 | 2 | 1 | worked for 1m 39s | 7/8 | no target | [300 dark](shots/runs/A25-game-feature__fix-s2-2.png) |
| A26-no-network-install/1 | 10 | 9 | 0 | 0 | worked for 3m 4s | 8/8 | none | [300 dark](shots/runs/A26-no-network-install__1.png) |
| A26-no-network-install/fix-a1 | 28 | 11 | 3 | 2 | worked for 4m 39s | 8/8 | none | [300 dark](shots/runs/A26-no-network-install__fix-a1.png) |
| A26-no-network-install/fix-s2-2 | 17 | 9 | 1 | 2 | worked for 3m 10s | 7/8 | no target | [300 dark](shots/runs/A26-no-network-install__fix-s2-2.png) |
| A27-resume-thai/1 | 7 | 7 | 1 | 0 | failed after 21s | 8/8 | none | [300 dark](shots/runs/A27-resume-thai__1.png) |
| A27-resume-thai/2 | 10 | 19 | 2 | 0 | worked for 44s | 7/8 | Thai answer | [300 dark](shots/runs/A27-resume-thai__2.png) |
| A27-resume-thai/fix-a1 | 6 | 12 | 0 | 0 | worked for 37s | 8/8 | none | [300 dark](shots/runs/A27-resume-thai__fix-a1.png) |
| A27-resume-thai/fix-a2 | 3 | 9 | 0 | 0 | worked for 17s | 8/8 | none | [300 dark](shots/runs/A27-resume-thai__fix-a2.png) |
| A27-resume-thai/fix-b2 | 9 | 15 | 1 | 0 | worked for 33s | 8/8 | none | [300 dark](shots/runs/A27-resume-thai__fix-b2.png) |
| A28-explain-then-change/1 | 3 | 0 | 0 | 0 | worked for 29s | 8/8 | none | [300 dark](shots/runs/A28-explain-then-change__1.png) |
| A28-explain-then-change/2 | 5 | 1 | 0 | 0 | worked for 39s | 8/8 | none | [300 dark](shots/runs/A28-explain-then-change__2.png) |
| A28-explain-then-change/fix-a1 | 4 | 2 | 0 | 0 | worked for 29s | 8/8 | none | [300 dark](shots/runs/A28-explain-then-change__fix-a1.png) |
| A28-explain-then-change/fix-a2 | 3 | 1 | 0 | 0 | worked for 18s | 8/8 | none | [300 dark](shots/runs/A28-explain-then-change__fix-a2.png) |
| A28-explain-then-change/fix-b2 | 3 | 2 | 0 | 0 | worked for 17s | 8/8 | none | [300 dark](shots/runs/A28-explain-then-change__fix-b2.png) |
| A28-explain-then-change/fix-s1-1 | 5 | 6 | 0 | 0 | worked for 32s | 8/8 | none | [300 dark](shots/runs/A28-explain-then-change__fix-s1-1.png) |
| A28-explain-then-change/fix-s1-2 | 5 | 7 | 0 | 0 | worked for 53s | 8/8 | none | [300 dark](shots/runs/A28-explain-then-change__fix-s1-2.png) |
| A28-explain-then-change/fix-s2-3 | 8 | 4 | 0 | 0 | worked for 45s | 8/8 | none | [300 dark](shots/runs/A28-explain-then-change__fix-s2-3.png) |
| A28-explain-then-change/fix-s3-1 | 3 | 2 | 0 | 0 | worked for 21s | 8/8 | none | [300 dark](shots/runs/A28-explain-then-change__fix-s3-1.png) |
| A28-explain-then-change/fix-s3-2 | 3 | 2 | 0 | 0 | worked for 23s | 8/8 | none | [300 dark](shots/runs/A28-explain-then-change__fix-s3-2.png) |
| A28-explain-then-change/fix-s3-3 | 7 | 6 | 0 | 0 | worked for 43s | 8/8 | none | [300 dark](shots/runs/A28-explain-then-change__fix-s3-3.png) |
| A29-thai-big-create/1 | 8 | 5 | 1 | 1 | worked for 21m 51s | 7/8 | Thai answer | [300 dark](shots/runs/A29-thai-big-create__1.png) |
| A29-thai-big-create/2 | 3 | 4 | 0 | 0 | worked for 2m 54s | 7/8 | Thai answer | [300 dark](shots/runs/A29-thai-big-create__2.png) |
| A29-thai-big-create/fix-a2 | 18 | 11 | 4 | 1 | worked for 16m 51s | 8/8 | none | [300 dark](shots/runs/A29-thai-big-create__fix-a2.png) |
| A30-hidden-char-edit/1 | 9 | 2 | 1 | 0 | worked for 2m 2s | 8/8 | none | [300 dark](shots/runs/A30-hidden-char-edit__1.png) |
| A30-hidden-char-edit/2 | 6 | 2 | 0 | 0 | worked for 49s | 8/8 | none | [300 dark](shots/runs/A30-hidden-char-edit__2.png) |
| A30-hidden-char-edit/fix-a2 | 7 | 2 | 0 | 1 | worked for 37s | 8/8 | none | [300 dark](shots/runs/A30-hidden-char-edit__fix-a2.png) |
| A30-hidden-char-edit/fix-a3 | 7 | 2 | 0 | 0 | worked for 48s | 8/8 | none | [300 dark](shots/runs/A30-hidden-char-edit__fix-a3.png) |
| A30-hidden-char-edit/fix-b2 | 4 | 1 | 0 | 0 | worked for 21s | 8/8 | none | [300 dark](shots/runs/A30-hidden-char-edit__fix-b2.png) |
| A31-compaction-forced/1 | 9 | 36 | 1 | 0 | worked for 2m 48s | 8/8 | none | [300 dark](shots/runs/A31-compaction-forced__1.png) |
| A31-compaction-forced/2 | 9 | 54 | 0 | 0 | worked for 3m 17s | 8/8 | none | [300 dark](shots/runs/A31-compaction-forced__2.png) |
| A32-outside-explicit/1 | 5 | 2 | 0 | 3 | worked for 21s | 8/8 | none | [300 dark](shots/runs/A32-outside-explicit__1.png) |
| A32-outside-explicit/fix-a2 | 4 | 1 | 0 | 1 | worked for 22s | 8/8 | none | [300 dark](shots/runs/A32-outside-explicit__fix-a2.png) |
| A32-outside-explicit/fix-b2 | 2 | 2 | 0 | 2 | worked for 16s | 8/8 | none | [300 dark](shots/runs/A32-outside-explicit__fix-b2.png) |
| A33-ask-git-clean/fix-a1 | 2 | 1 | 1 | 1 | worked for 11s | 8/8 | none | [300 dark](shots/runs/A33-ask-git-clean__fix-a1.png) |
| A33-ask-git-clean/fix-a2 | 2 | 1 | 1 | 1 | worked for 8.9s | 8/8 | none | [300 dark](shots/runs/A33-ask-git-clean__fix-a2.png) |
| A33-ask-git-clean/fix-b2 | 4 | 1 | 1 | 0 | worked for 33s | 8/8 | none | [300 dark](shots/runs/A33-ask-git-clean__fix-b2.png) |
| A34-todo-stale/fix-todo-10 | 6 | 11 | 0 | 0 | worked for 27s | 8/8 | none | [300 dark](shots/runs/A34-todo-stale__fix-todo-10.png) |
| A34-todo-stale/fix-todo-7 | 5 | 10 | 0 | 0 | worked for 13s | 8/8 | none | [300 dark](shots/runs/A34-todo-stale__fix-todo-7.png) |
| A34-todo-stale/fix-todo-8 | 6 | 9 | 1 | 0 | worked for 18s | 8/8 | none | [300 dark](shots/runs/A34-todo-stale__fix-todo-8.png) |
| A34-todo-stale/fix-todo-9 | 7 | 11 | 0 | 0 | worked for 17s | 8/8 | none | [300 dark](shots/runs/A34-todo-stale__fix-todo-9.png) |
| A35-show-before-after/1 | 16 | 8 | 4 | 1 | worked for 1m 52s | 8/8 | none | [300 dark](shots/runs/A35-show-before-after__1.png) |
| A35-show-before-after/2 | 11 | 7 | 0 | 1 | worked for 46s | 8/8 | none | [300 dark](shots/runs/A35-show-before-after__2.png) |
| A35-show-before-after/3 | 8 | 5 | 0 | 0 | worked for 31s | 8/8 | none | [300 dark](shots/runs/A35-show-before-after__3.png) |
| B01-ask-allow/1 | 4 | 0 | 0 | 0 | worked for 18s | 8/8 | none | [300 dark](shots/runs/B01-ask-allow__1.png) |
| B02-ask-deny/1 | 2 | 0 | 0 | 0 | worked for 19s | 8/8 | none | [300 dark](shots/runs/B02-ask-deny__1.png) |
| B02-ask-deny/2 | 1 | 0 | 0 | 0 | worked for 7.6s | 8/8 | none | [300 dark](shots/runs/B02-ask-deny__2.png) |
| B03-no-and-tell/1 | 3 | 0 | 0 | 1 | worked for 16s | 8/8 | none | [300 dark](shots/runs/B03-no-and-tell__1.png) |
| B04-keep-undo/1 | 4 | 6 | 1 | 0 | worked for 16s | 8/8 | none | [300 dark](shots/runs/B04-keep-undo__1.png) |
| B05-lanes/1 | 5 | 3 | 1 | 0 | worked for 15s | 8/8 | none | [300 dark](shots/runs/B05-lanes__1.png) |
| B05-lanes/2 | 5 | 3 | 0 | 0 | worked for 19s | 8/8 | none | [300 dark](shots/runs/B05-lanes__2.png) |
| B07-subagent-row/2 | 2 | 0 | 0 | 0 | worked for 25s | 8/8 | none | [300 dark](shots/runs/B07-subagent-row__2.png) |
| B08-mcp-banner/1 | 2 | 0 | 0 | 0 | worked for 5.8s | 8/8 | none | [300 dark](shots/runs/B08-mcp-banner__1.png) |
| B09-stop-and-resume-thai/1 | 18 | 12 | 1 | 0 | worked for 4m 58s | 7/8 | Thai answer | [300 dark](shots/runs/B09-stop-and-resume-thai__1.png) |
| B09-stop-and-resume-thai/2 | 8 | 6 | 0 | 0 | stopped after 3m 1s | 8/8 | none | [300 dark](shots/runs/B09-stop-and-resume-thai__2.png) |
| B10-thai-and-working/1 | 6 | 1 | 0 | 0 | worked for 30s | 8/8 | none | [300 dark](shots/runs/B10-thai-and-working__1.png) |
| B07-subagent-row/1 | | | | | | not replayed | no session log (test setup failed, T-02) | |
