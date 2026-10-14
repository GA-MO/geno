# Real-model campaign: fixes, round 1

This round fixes the issues in [ISSUES.md](ISSUES.md) and measures each fix on qwen3.8-flash (Alibaba Model Studio), the model the campaign used. The base is commit 13e05087, the commit the campaign ran on. Each fix is its own commit, named in the table.

## How the runs were made

- The runner is `scripts/real-usecases/run.mjs`, one case at a time. `GCODE_CAMPAIGN_SCRATCH=scratchpad/fixes-r1` keeps this round's scratch apart, and `GCODE_CAMPAIGN_ENGINE` names the exported tree whose engine runs the case. A before run uses the base commit's engine with the same runner and the same checks.
- Each run has its own HOME, CLAUDE_CONFIG_DIR and GCODE_HOME (`scripts/real-usecases/home.mjs`), so none of the user's files reach a request. A19 gets a fake pstack plugin whose poteto-mode skill is 31 KB, past the 24,000-character spill limit.
- Before counts the campaign's archived runs (same base commit, written "c1" and "c2" below) and `fix-b2`, a run on the base engine with an isolated HOME. A first before batch, `fix-b1`, ran with the user's own HOME. It is not archived and not counted.
- After counts `fix-a1` (engine 84461d3b: G-01 to G-10 and P-01 to P-04), `fix-a2` (engine 6238d339: up to P-11) and `fix-a3` (engine d646f262: the last wording of P-01 and P-04).
- The new runs are in [runs/](runs/README.md) as `runs/<case>/fix-b2/`, `fix-a1/`, `fix-a2/` and `fix-a3/`. Each index entry carries `engineCommit`, `phase` (before or after) and a note. A20 to A23, A25, A31 and the Layer B steps were not run again.
- A pass rate counts runs whose named check passed, out of the runs made. One or two runs a side is a small sample: read a change from 0 of 3 to 2 of 2 as a strong sign, and anything closer as noise.

## Per issue

| Issue | Change | Commit | Before | After |
|---|---|---|---|---|
| G-01 Ask ran unlisted commands unasked | The `unlisted` rule asks in Ask, as Claude Code's default mode asks before any command that is not read-only or allowed. Edits still apply without asking. The sandbox stays. | b557ef62 | A33 (`git clean -fdx` in Ask): 0 of 1 asked, and the untracked file was deleted (fix-b1 the same). | 2 of 2 asked; the CLI refused the card and the file stayed. A08's first command, a grep, now asks too, so its `asked` check (the rm) is never reached: 0 of 1. |
| G-02 Prompt lost behind an MCP notice | A line ends Geno's notes and says the user's message follows, when one message holds both. | 3f529037 | Seen once in about 10 panel turns (B02 run 2). | Not run again on the real model (Layer B). The mcp-briefing golden pins the order. |
| G-03 Thinking-only end accepted as done | One nudge in the same run; a second empty turn ends the run as an error that says so. | 30b35c94 | c2 ended with thinking only. | A29 fix-a2 made no empty turn, so the nudge never fired live. Unit and e2e tests cover it. A29 finished: valid file, wired, Thai answer. |
| G-04 Caps end with no report | The last call a limit allows carries a note and goes with `tool_choice: none` (tools still offered); a subagent's goes forced to `report`. | 872fa770 | A17 report at the turn cap: 0 of 3 (c1, c2, fix-b2). A11 c1: the capped child returned "(no report)". | A17: 2 of 2 end with an honest partial report. Model Studio accepted `tool_choice: none`. A11 fix-a1: the child's 4th, capped call was forced to `report`, and the parent used it. |
| G-05 Resume forgets reads | An edit falls back to the log's last stamp of the file. | 98f1d92d | A27 edits refused as unread after `--session`: 3 each in c2 and fix-b2. | 0 in fix-a1 and fix-a2. |
| G-06 Long skill comes back as a spill file | The skill tool's result stays inline up to 100,000 characters. | beda37c3 | A19: the skill spilled in c1, c2 (real 25 KB skill) and fix-b2 (31 KB fake, 31,683 bytes). | fix-a2: inline, whole. |
| G-07 `skill` deferred | `skill` is a core tool. | 0ea8da49 | A refused `skill` call before a load: 8 of 46 campaign runs; fix-b2 A18 and A19. | 0 in all 36 after runs. A18 loaded the changelog skill with `skill`: 1 of 1 (before 2 of 3; c1 read the SKILL.md with `read`). |
| G-08 Compaction never happens below the fixed context | Compacts when a summary would halve the context, and says once on stderr when it cannot help. | c8a8afaf | A31 c1 at GCODE_COMPACT_AT=14000: no compaction, no message. | Not run again (A31 costs about $0.10). Unit tests cover both cases. |
| G-09 Classifier cost uncounted | The session spend, the closing cost line, the history and `--max-cost` add it. | ebfb0466 | A09 fix-b2: `gcode usage` $0.007370, classifier $0.000480 left out. | A09 fix-a1: `gcode usage` $0.021593 with `classifierCostUsd` $0.002578 counted. |
| G-10 CLI refuses cards in silence | stderr names the question and says no terminal could answer. | c94f3c7b | Nothing printed. | A08 and A33 fix-a1: "Allow `…`? … There is no terminal to answer, so it was refused." |
| P-01 Stashes the user's work | Rules after Claude Code's git safety protocol; a `git-discard` rule asks before stash, clean, checkout or restore of files and `branch -D` (denied in Plan and non-interactive). The prompt names a temp-dir worktree, only when the task turns on it. | b17425d7, 2cbf35cd, d646f262 | Runs of A04, A24 and A30 that ran `git stash`: 5 of 8 (A04 c1 and fix-b2, A24 c1 and c2, A30 c2). | 0 of 8. A04 fix-a2 spent 5 calls on a worktree comparison (few-calls failed); fix-a3 passed in 5 calls. |
| P-02 Heredoc file writes | The bash description lists edit with `create: true` for writing files, after Claude Code's Bash description. | 84461d3b | A03 `create-for-new`: 1 of 3. | 2 of 2. A29 fix-a2 still wrote a scratch script with a heredoc into `$TMPDIR`. |
| P-03 cat, ls, find instead of read, list, glob | The bash description opens with the dedicated tool for each job, as Claude Code's does. | 84461d3b | `dedicated-file-tools` on this round's cases: 13 of 30 campaign runs, 3 of 16 fix-b2. | 9 of 16 fix-a1, 8 of 16 fix-a2, 1 of 4 fix-a3. Better, still the most common failure. |
| P-04 `&` servers and sleep polling | The description says never `&`, use `run_in_background`, wait with monitor, and where monitor cannot wake a headless run, one until-loop. A background start names monitor. | 84461d3b, 9f54ef09 | A12 `waits-without-sleep`: 0 of 3 (c1, c2, fix-b2). | 0 of 2 (fix-a1, fix-a2: monitor was refused in the headless run, then a for loop); 1 of 1 fix-a3 with the until-loop wording. A19 fix-a2 still started a server with `&`. |
| P-05 `[U+XXXX]` escapes unexplained | The edit description and a mismatch whose closest text holds a hidden character say the escape matches. | b07f5264 | A30 `edit-tool`: 1 of 3. | 2 of 2; both edited with the escape on the first try. Both then spent calls on a worktree comparison (`few-calls` failed). |
| P-06 Path denial invites workarounds | A denied outside path gets no try-another-tool line; the refusal names `permissions.additionalDirectories` in `.g-code/settings.json` and the editor setting. | c560b9bc | A32: after the denied `ls`, the model tried `read` and `ls ..` (c1, fix-b2), and named the editor setting. | fix-a2: no other attempt; the answer named `.g-code/settings.json`. The case's `outside-read-outcome` check wants a `read` attempt, so it fails by design now. |
| P-07 Skill listing under the repository preamble | The preamble comes only with repository files; the listing follows them. | d7519667 | Every request. | A19 fix-a2: the game repository has no instruction file, and its requests show the listing with no preamble. A unit test covers both shapes. |
| P-08 geno-tools.md ignored | A pstack skill's result ends with the mapping rows that matter, and the file's path. | 46bb9250 | A19 `reads-geno-tools`: 0 of 3 (c1, c2, fix-b2). | fix-a2: 1 of 1 (the rows came with the skill). fix-a1 ran before the change. |
| P-09 Thai follow-up answered in English | "Answer in the language of the user's latest message" in both tiers. | 45472a11 | A27 `answers-in-thai`: 1 of 3 (c1, c2 failed; fix-b2 passed). | 2 of 2 (Thai share 0.72, 0.85). |
| P-10 Status question after Stop resumes the task | A message after a stopped turn comes with a note: answer a question first, then ask whether to go on. | cca1e9fe | B09: 0 of 2. | Not run again (Layer B). Unit tests cover where the note goes. |
| P-11 No todo list | The todo description says to call it first when the user lists several things. | 6238d339 | A07 `keeps-todo`: 0 of 3. | 0 of 2 (fix-a1 ran before the change; fix-a2 still made no todo call). Not fixed. |
| P-12 Long survey for "what could we do" | The rule moved into Text output, next to "Match the answer to the request". | 45472a11 | A28: 1,632 and 2,237 characters (c1, c2); fix-b2 1,031. | fix-a1 1,705; fix-a2 939, a two-sentence-style answer with a recommendation that the check's wording regex misses. No clear change. |
| M-01, M-02 | No change. | | | See Left open. |
| Runner (T-01 to T-06) | T-01 to T-05 were already fixed in the scripts. This round adds per-run HOMEs, a scratch and engine override, `archive.mjs --append`, the A33 case, the fake pstack plugin, a check that counts one until-loop as a wait, and a cost count that no longer adds subagents twice. G-08's change makes T-06 a logged condition rather than a silent one. | 722f9f46, 4bddc024, a1defae5, 7a0c861e | | |

The non-JSON tool-argument failure (the user's `{"create":}`) was tried again with two large single writes: A15 fix-a2 wrote a 15,259-character `levels.js` in one `edit`, and A29 fix-a2 wrote all of `PacmanScene.js` in one `edit`. Both sent valid JSON, so the recovery path is still unverified on the real model.

## Goldens and recordings

Every prompt or tool change re-recorded the request goldens (`pnpm test:golden -u`) and only for that change:

- G-07: every request's tools carry `skill` in full, and `tool_search`'s listing drops it.
- G-02: mcp-briefing gains the end-of-notes line before the prompt.
- P-01, P-02 to P-04, P-05, P-09 and P-12, P-11, and the P-01 and P-04 follow-ups: plain-prompt's system prompt and tool descriptions; P-02 to P-04 also background-notice's start result.

`packages/engine/test/recordings/usage-e2e.json` is keyed by the request, so each of those commits re-recorded it from the test's fallback script (`GCODE_RECORD=1`), with the same answers.

## Cost

| Batch | Runs | USD |
|---|---|---|
| fix-b1 (user's HOME, not archived) | 17 | 0.6346 |
| fix-b2 (base engine) | 16 | 0.1719 |
| fix-a1 | 16 | 0.2599 |
| fix-a2 | 16 | 0.4103 |
| fix-a3 | 4 | 0.0392 |
| **Total** | **69** | **1.5159** of the $3.00 cap |

Costs are each run's `gcode usage` plus, for a base engine, the classifier calls it leaves out. Until commit 7a0c861e the runner also added subagent costs a second time, so A11's first runs and the total are slightly high.

## Left open

- P-03 and P-04: see round 2 below.
- P-11: no todo call in A07 after the change. The rows say it is a model limit at this task size; a reminder notice when a prompt names three or more actions is untested.
- P-12: no measurable change; answers stay near the 1,500-character line.
- G-01's cost: every command off the safe list now asks in Ask, as in Claude Code. In a terminal-less CLI run that refuses it, so a benign first command such as A08's grep ends the turn. The safe list could grow (for example `git check-ignore`, `git clean -n`) where users find the cards noisy.
- G-02, G-10 in the panel, and P-10 were not run on the real model; they need the Layer B suite.
- G-03 and the non-JSON recovery did not recur live, so their live paths are unverified.
- M-01 (the classifier judges a plain project script by a risky request) and M-02 (ignores "run no commands", claims scrambled reads): no prompt or classifier change here. M-01 needs a hand-written benign case in the classifier eval, which today draws benign cases from eval logs only; M-02 needs a regression eval.

# Round 2: P-03 and P-04

Round 1 left P-03 (cat, ls and find through bash) and P-04 (servers started with `&`) half fixed. Round 2 follows Claude Code's harness design in three steps, each measured on qwen3.8-flash before the next: a note in the tool result, then a refusal and process cleanup for servers, then one line of description wording.

## How the runs were made

- Same runner, one case at a time, with `GCODE_CAMPAIGN_SCRATCH=scratchpad/fixes-p03-p04` and this checkout's engine. Each run had a fresh HOME, CLAUDE_CONFIG_DIR and GCODE_HOME: `run.mjs` calls `prepareHome` (`scripts/real-usecases/home.mjs`) for every run. Before archiving, every new file, gzipped ones included, was searched for `pstack model configuration`, `EXTREMELY_IMPORTANT` and `/Users/me`. None of the 238 files matched.
- Before counts round 1's runs of the same cases. For P-03 that is fix-a1, fix-a2 and fix-a3 of A04, A07, A12, A19, A24 and A28 (15 runs). For P-04 it is every archived run of A12, A19, A25 and A26 (campaign c1 and c2, fix-b2, fix-a1 to fix-a3: 14 runs).
- After counts `fix-s1-*` (engine ee34a245, step 1), `fix-s2-*` (1b0a2ec4, step 2) and `fix-s3-*` (87537571 for fix-s3-1; 51ec0aa6 for fix-s3-2 and fix-s3-3, step 3). The runs are in [runs/](runs/README.md) under those labels.
- `dedicated-file-tools` is the campaign check. It fails a run for any bash line that holds cat, ls, find, grep, head, tail or sed -n, including lines that need the shell, such as `ls && node --test` or `grep -l`. "Pure reads" counts what the note targets: bash lines that only read, list or search files, as `fileToolsOf` judges them. A check verdict counts every call the model made, refused ones included.

## Per step

| Step | Change | Commit | Before | After |
|---|---|---|---|---|
| 1. Note in the result (P-03) | A bash call that only reads, lists or searches files runs. The first time in a session for each tool, its result ends with one `[Geno] Next time, …` line that names read, list, glob or grep. A table in `core/src/shell-intent.ts` decides it. Pipes into other programs, writes, special files, substitutions and `&` stay unflagged. The line rides in the tool result, so no request golden changed. | ee34a245 | `dedicated-file-tools` 5 of 15. Pure reads in 7 of 15 runs (9 calls); A12 fix-a3 made 3. | fix-s1 (11 runs): `dedicated-file-tools` 8 of 11, pure reads in 2 of 11 runs. Over fix-s1 and fix-s2 the note fired in 7 runs. After it, those runs made 13 read, list, glob or grep calls and no pure shell read. |
| 2. Servers and process cleanup (P-04) | A known dev server started with `&`, `nohup` or `( … ) &`, or in the foreground, is refused unrun. The refusal gives the exact `run_in_background` call; then monitor where something wakes the session, or one until-loop where nothing does; the rest of the line; and preview_start when a launch file has an entry. A finished command whose process group still runs is named in its result, and the sandbox kills that group when the run ends. | 1b0a2ec4 | A `&` server ran in 5 of 14 runs (A19 c1, c2 and fix-a2, A25 c1, A26 c1). A19 c2's server outlived its run. | fix-s2 and fix-s3 (15 runs of these cases): no `&` server ran. Three attempts were refused (A25 fix-s2-2 `(node server.js … &)`, A12 fix-s2-3 `node server.js &>… &`, A12 fix-s3-2 `npm run dev 2>&1 \| tail -40`). Each time the next call started the server with `run_in_background`. After every batch nothing listened on 5173 or 3000. A conformance test shows a `sleep 60 &` gone when its run ends. |
| 2b. Until-loop check (runner) | The campaign's until-loop test accepts `>/dev/null 2>&1` in the condition. | cdce523f | | Rescored the fix-s2 runs that had failed on it alone. |
| 2c. Localhost curl with a redirect (found in step 2) | A localhost `curl … >/dev/null` or `… 2>&1` ran as a download and was denied in a headless run: the split kept `/dev/null` and the `1` of `2>&1` as curl operands. `>&N` now drops its descriptor, and `/dev/null` counts as no URL. A remote curl still asks. | 51ec0aa6 | In fix-s1 and fix-s2, all 8 until-loops with a redirect (A12, A19, A25, A26) were denied, and the model fell back to node fetch loops. | fix-s3-2 and fix-s3-3: both until-loops with a redirect ran (A19). |
| 3. Description wording (P-03) | The bash description adds one line: make one read, list or glob call per file or folder in the same turn, rather than one bash line that chains cat, ls and find. Steps 1 and 2 left first-turn bundles such as `cat package.json; echo "--- README"; cat README.md; …` (A28 fix-s2-3). | 87537571 | fix-s2 on the same six cases: pure reads in 5 of 9 runs, `dedicated-file-tools` 3 of 9. | fix-s3 (16 runs): pure reads in 3 of 16 runs and no first-turn bundle; `dedicated-file-tools` 11 of 16. One repeat after a note: A24 fix-s3-3 ran `ls notes` again after the list note. |

Read these as signs, not rates. Each step has 9 to 16 runs on six cases. The first pure read of a run comes before any note can fire, so step 1 can only stop repeats. Most of fix-s1's drop, from 7 of 15 runs to 2 of 11, is first calls, which the note does not touch: treat that part as noise. The step 3 drop, from 5 of 9 runs to 3 of 16 with no first-turn bundle, is the wording's likely effect.

## Goldens and recordings

- Steps 1, 2 and 2c changed no request bytes. `pnpm test:golden` passed unchanged.
- Step 3 re-recorded plain-prompt's two request goldens (the bash description) and `packages/engine/test/recordings/usage-e2e.json` from its fallback script, with the same answers. `real-runs.e2e.test.ts` and `scripts/run-to-gallery.test.ts` pass.

## Cost

| Batch | Runs | USD |
|---|---|---|
| fix-s1 | 11 | 0.1751 |
| fix-s2 | 12 | 0.3374 |
| fix-s3 | 16 | 0.2983 |
| **Total** | **39** | **0.8108** of the $1.50 cap |

## Left open

- Some waits still poll. A19 fix-s1-1 and A12 fix-s3-2 waited with a bounded `for … sleep … break` loop. A19 fix-s3-1 tried `sleep 4; …`, which the sleep refusal blocked.
- A19 fix-s2-2 stopped its background server with `pkill -f "node server.js"` instead of `task_stop`. That pattern can kill the user's own processes. No refusal or note for `pkill -f` or `killall` exists yet.
- A12 fix-s3-2 read its background job's output file with `tail`, and the read was denied as outside the workspace. The start line names that file, so either allow it or name `bash_output` there.
- The note covers only lines that do nothing but read. Mixed lines such as `ls && node --test` or `git diff && cat notes/*` still fail `dedicated-file-tools`.

# Round 3: process kills and job output reads

Round 3 closes the first two open items of round 2. Both follow Claude Code's harness design: stop background work by its id, and read the output file that the start line names.

| Change | Commit | Evidence |
|---|---|---|
| A `process-kill` rule in `core/src/approval.ts`. `pkill`, `killall`, a `kill` of a PID or name the session did not start, and a `kill` fed by `xargs` or a substitution ask in Ask, go to the classifier in Auto, and are denied in Plan and non-interactive runs. A `kill` of a running background job's process or group, of a group a command left running, or of `$!` or a job spec runs without a question. A refusal names `task_stop` with each running job's id. | 93de0094 | Unit rows in `approval.test.ts`. A conformance test on both wires: `pkill -f` asks in Ask, and a non-interactive run refuses it with ``call task_stop with its id: bg-1 (`sleep 30`)``. A `kill <pid>` of the session's own job asks nothing. |
| Bash judges the session's spill folder, where background output goes, as readable. Every other path outside the workspace still asks. A refusal of a path that looks like a job output file names `bash_output`. | 8ee9a40f | A conformance test on both wires: `tail -n 20 <job output file>` and `read` of it run without a card in Ask. Another folder's `background/bg-3.log` is refused with the `bash_output` pointer. |

The conformance runs found two facts about the macOS sandbox. Its profile allows a signal only within the same sandbox, and every bash call is its own sandbox. So on macOS a `kill` of a background job runs and then fails with "Operation not permitted". Its result now ends with one `[Geno]` line that names `task_stop` and the job id. The same profile blocks `pkill`'s process list: A19 fix-s2-2's `pkill -f "node server.js"` printed "Cannot get process list" and stopped nothing. On macOS the rule saves a wasted call and points the model at `task_stop`. Where the sandbox lets signals through, the rule keeps a kill away from the user's own processes.

The bash description is unchanged, because Claude Code's Bash description has no line about process kills to mirror. No request golden changed.

The real-model check ran qwen3.8-flash on A12 and A19 twice each, labels `fix-r3-1` and `fix-r3-2`, on engine 80cd85f4, with one fresh HOME per run. The case files record that commit. A later fixup added one row to `agent.e2e.test.ts` and left the engine source as it was, so 8ee9a40f runs the same code. All four runs started their server with `run_in_background`. Three stopped it with `task_stop`. A19 fix-r3-1 left it running, and the end of the run stopped it. No run used `pkill`, `kill` or `tail` of a job's output file, so neither change fired on the real model. Read these runs as a check for regressions, not as a measured effect. A12 passed both runs. A19 passed fix-r3-2 and failed fix-r3-1 on `dedicated-file-tools` alone (`ls src/logic src/scenes test && cat README.md`, the mixed-line gap above). After both batches nothing listened on 5173 or 3000. None of the 25 new archived files, gzipped ones included, holds `pstack model configuration`, `EXTREMELY_IMPORTANT` or `/Users/me`.

| Batch | Runs | USD |
|---|---|---|
| fix-r3-1 | 2 | 0.0626 |
| fix-r3-2 | 2 | 0.0563 |
| **Total** | **4** | **0.1189** of the $0.40 cap |

## Left open after round 3

- `PID=$(cat server.pid); kill $PID` still asks, because the engine cannot see the PID in the file. `PID=$!` in the same line runs.
- A line whose first flagged command is unlisted, such as `lsof -t -i:3000 | xargs kill`, gets a merged question led by the unlisted rule. Its reason still names the kill, and a non-interactive run still denies it as `process-kill`.
- The real model has not hit either refusal yet, so the wording of both hints is untested on qwen3.8-flash.

# Round 4: a todo list that goes stale

A user saw the same pinned card, "5 of 10 done" with step 4 spinning, on every prompt of a long session, including a bug report about something else. The panel pinned an earlier turn's unfinished list on each new turn as live progress, and nothing told the model the list had gone stale. Both changes follow Claude Code's harness design: a reminder that shows the list when it has not been touched for a while, sent as a message so the cached prefix holds.

| Change | Commit | Evidence |
|---|---|---|
| A `todo` notice at the safe point shows the unfinished list and asks the model to mark it, or to clear it with an empty list if the new request moved on. It fires after 10 model calls without a todo call, again 10 after the last reminder, and at the first call of a prompt that follows a stopped or failed turn. It never goes out on a last call or in a run without `todo`. | 7e247651 | `core/test/todo-reminder.test.ts`. A conformance test on both wires: the notice reaches the eleventh request once, every request repeats the one before it, and the session log reads back. |
| A turn capped by its limits counts as cut short. Such a turn ends with a report call with tools off, which logs no error. | b68b8d3e | Run fix-todo-1 below. A unit row and a conformance row on both wires for a capped turn that ends with a report. |
| The prompt reminder fires at each prompt the user types while the list has work left, however the turn before ended. After a normal end it opens "Your todo list from earlier still has unfinished items". The text now asks the model to mark every finished item done now, even when the rest of the list still applies, and to mark the current item in_progress. | 4b539b26 | Unit rows for a normal end, once per prompt, and quiet after the list is cleared. A third conformance row on both wires for a turn that ended on its own. |
| The panel shows an earlier turn's unfinished list as carried until this turn calls `todo`. The card is one muted, dashed line that reads "from an earlier turn", and nothing on it spins. The first todo call makes it the live card, and a cleared list shows nothing. The composer label names only the running turn's own item. | 709451e2 | `extension/test/todo.test.ts`, `webview/todo.webview.test.ts`, and gallery states `todo-carried` and `todo-carried-updated` in all 4 themes at 300px. |

Claude Code's trigger values are not in research/claude-code-harness. Ten calls is the value commonly reported for its TodoWrite reminder, and it is small enough to catch a stale list within one long turn.

Case A34-todo-stale runs a three-part task in `ts-lib` under a tight `--max-turns`, then asks an unrelated question. qwen3.8-flash ran it 10 times. fix-todo-1 ran on 709451e2, fix-todo-2 to -8 on b68b8d3e, and fix-todo-9 and -10 on 4b539b26. Each run had its own HOME. The prompt and the cap changed between the early runs, because the model often explored without writing a list. Only fix-todo-7 to -10 match the case as committed, so only those four are archived. The other six are in the scratch campaign only.

| Run | Cap | List left unfinished | Notice | What the model did |
|---|---|---|---|---|
| fix-todo-1 | 4 | yes | none | Nothing. The capped turn ended with a report and logged no error, so the reminder missed it. This led to b68b8d3e. |
| fix-todo-2, -3 | 4 | no list | n/a | Explored and never called `todo`. |
| fix-todo-4 | 5 | yes | stopped | Marked all 4 items done before answering. The suite in its workspace passes, so the marks were true. |
| fix-todo-5, -6 | 5 | no list | n/a | Explored and never called `todo`. |
| fix-todo-7 | 6 | no, all done | n/a | Marked the list done in its capped last call. Failed `dedicated-file-tools` on `find . -type f`, the round 2 gap. |
| fix-todo-8 | 6 | yes | stopped | Answered the question and left the list as it was. The task was still open, so the list still applied, but item 1 was finished and stayed in progress. |
| fix-todo-9 | 6 | yes | stopped, new wording | Cleared the list with an empty todo call, then answered. All three fixes were in place and the suite in its workspace passes, so the list was finished but never marked done. Clearing it is acceptable. |
| fix-todo-10 | 6 | yes | stopped, new wording | Marked the 2 finished items done and left the 3 open ones pending, then answered. The suite in its workspace still fails formatPrice and slugify, so the marks were true. Failed `dedicated-file-tools` on `find . -path ./.git -prune -o -type f -print`. |

With the first wording, the notice fired in two runs. One updated the list and one ignored it. With the firmer wording, both runs acted on it: one cleared the list and one marked exactly the finished items. Two runs are too few to measure a rate. In each case the panel keeps a list muted, with no spinner, until the model touches it. None of the 25 new archived files, gzipped ones included, holds `pstack model configuration`, `EXTREMELY_IMPORTANT` or `/Users/me`.

| Batch | Runs | USD |
|---|---|---|
| fix-todo-1 to fix-todo-8 | 8 | 0.0831 |
| fix-todo-9, fix-todo-10 | 2 | 0.0279 |
| **Total** | **10** | **0.1110** of the $0.40 cap |

## Left open after round 4

- The prompt reminder now goes out at every prompt while a list has work left. That includes Start building after Plan, where the list is all pending by design. A model that ignores it gets it again at each prompt. The real model has not run either case yet.
- The real model has not hit the 10-call idle reminder in any run.

## show_files (A35)

Case A35-show-before-after gives qwen3.8-flash a static sign-in page and `shot.mjs`, which paints a PNG of the page with no browser. The prompt asks it to take a screenshot, fix the button, take another, and show the two side by side. It does not name `show_files`. Each run had its own HOME, CLAUDE_CONFIG_DIR and GCODE_HOME.

| Run | Engine | Result | What the model did |
|---|---|---|---|
| 1 | e7a483e3 | FAIL | Loaded `show_files` with `tool_search` on its own, then sent `files` as the JSON text `"[\"before.png\", \"after.png\"]"` four times and was refused each time. It gave up, wrote a script that joined the PNGs, and put a markdown image in its answer. Before that it wrote its first screenshot to its scratchpad as `/var/folders/...`, the environment's `/private/var/folders/...` without `/private`, and bash refused it as a path outside the workspace. |
| 2 | e7a483e3 and the fix | PASS | Sent `files` as JSON text again; `show_files` took it and showed both screenshots. |
| 3 | e7a483e3 and the fix | PASS | The same, in 8 model calls. |

The fix: `parseShowFilesInput` takes `files` as an array, as its JSON text, or as one path. None of the 18 archived files, the gzipped one included, holds `pstack model configuration`, `EXTREMELY_IMPORTANT` or `/Users/me`. The three runs cost $0.0590 of the $0.30 cap.

# Round 5: Claude Sonnet 5.5

From 2026-10-14 the campaign runs on Claude Sonnet 5.5 through Geno's `anthropic` provider, not qwen3.8-flash. Claude is the stronger model, so the same failure on both models points at Geno's prompt or tools, not the model. On base c7be6efb, 3 of 10 cases that qwen often failed passed. The failures were the same checks qwen failed: `dedicated-file-tools`, `keeps-todo` and `short-reco`. Three rounds of prompt wording did not stop Sonnet from chaining `cat`, `ls` and `grep` after its test commands, so most of the fixes below are in the engine's structure, not the prompt.

## How the runs were made

- `node scripts/real-usecases/run.mjs --all --run sonnet-1 --cost-scale 2.5`, with `GCODE_PROVIDER=anthropic` and `GCODE_MODEL=claude-sonnet-5-5` in the main checkout's .env. `--cost-scale` multiplies each case's `--max-cost`, which is sized for qwen. Without it, the cap cut A31 off at $0.40 once its cache was written.
- Each run has its own HOME, CLAUDE_CONFIG_DIR and GCODE_HOME. The scratch campaign lives in the session's own scratchpad, outside the repository.
- The archived runs are `runs/<case>/sonnet-1/`, on engine c5102e0b. The Layer B panel run on the same engine is in `shots/r3/`. It passed 9 of 9 steps and cost $0.19. Its run folder is not archived, because `archive.mjs --append` archives Layer A only.

## Per change

| Change | Commit | Evidence |
|---|---|---|
| The principles prompt tier, which Sonnet and Opus get, now has the todo rule and the short answer to an options question that the rules tier already had. The todo rule has a concrete example, and the tier shows the one-turn way to rename across files. | 4a55a88c, 857ccd35 | A07 opened a todo list in 0 of 4 runs with the generic wording and in 3 of 3 with the example. A28 went from 1,953 characters to under 1,500. |
| The macOS environment line no longer teaches `sed -i ''`. | 4a55a88c | A07 renamed with `sed -i` straight after reading it. |
| When the model ends its turn with its todo list under way, Geno reminds it once. | 7d5667c3 | In 3 of 3 A07 runs, Sonnet left 1 item in_progress and 3 pending, and the reminder closed the list. |
| bash refuses, before running anything, a line with a step that only reads a file (cat, head, tail, less, more, sed -n) or writes literal text into a workspace file (echo, printf, cat, tee). A read after `&&` a program that changes something runs. grep, find and ls run, as in Claude Code. | f04bcdca, 1c550cf6, 0e4232aa, 6cdf8419, ad17fb5e | A01 had chained `npm test` with `grep` and `cat` in 3 of 3 runs. A15 wrote its test file with a heredoc. |
| grep lines from a file count as a view that the edit gate accepts. | c8a802ad | A30's edit, built from a grep line, had been refused once. |
| A deferred tool called before tool_search runs when its input fits its schema, and the call records the load. | d670f005 | A12 called task_stop straight away, as Geno's own background-start text suggests, and was refused. |
| Tool input that is not JSON gets an error naming the text. Unquoted tool_search names, Claude Code's `select:` habit, are repaired. | 824cbff7, fa093cc9 | Sonnet sent `{"select": show_files}` in A35 and `{"select": task_stop}` in A12, three times in all. |
| Sandboxed commands get the session's scratchpad as `$TMPDIR` instead of the shared /tmp/claude, and read, grep, glob and list reach it unasked. | b10d90ed, 575638ed | A35 saved its screenshots to `$TMPDIR`, and show_files refused them as outside the workspace. |
| New sessions get a short scratchpad, `/tmp/gcode-<uid>/<8 hex>`, and the sandbox allows unix sockets in the workspace and the scratchpad, on macOS only. | 6d07ced3, 607899c6 | This repository's cache.conformance test failed 16 of 16 inside Geno's sandbox with `listen EPERM`, and passed 16 of 16 after both changes. |
| A prompt the panel sends before it hears its turn start is queued. A failed send comes back to the composer. | 148c3666 | The web host's Undo test lost "Edit b" in about 2 of 3 runs. The host had refused it in silence. |
| `gcode agent --effort` | b7a1d2c7 | Sonnet at high against medium, 3 runs each: A07 passed every time at both levels. On a real rename in this repository, neither level kept a todo list, and high cost 11% more. Geno stays at medium. |

The checks changed with the engine. `dedicated-file-tools` and `edits-with-edit` now ask the engine's own shell rules through `scripts/real-usecases/shell-facts.ts`, and count only commands that ran. A21 passes when Geno stays in the workspace and asks where the base config is, as its system prompt says. A16's `compacted` is n/a when Geno declined to compact because the newest turn held the context. A31 asks for one read per turn, so that it still reaches compaction. A35 accepts one image at least twice a shot's width.

## Results

| Run | Engine | Passed | USD |
|---|---|---|---|
| claude1 (10 cases) | c7be6efb | 3 of 10 | 0.29 |
| first full run | 1c550cf6 | 26 of 35 | 1.84 |
| sonnet-1 | c5102e0b | 34 of 35 | 2.29 |

In sonnet-1, Sonnet averaged 4.8 model calls a case. qwen3.8-flash averaged 8.7. The one failure is A29: the Pac-Man scene is right (31 rows of 28, wired in, tests pass), but the answer to the Thai prompt came back in English. Its four earlier Claude runs answered in Thai.

None of the 211 new archived files, the gzipped ones included, holds the home path, `pstack model configuration`, `EXTREMELY_IMPORTANT`, `sk-ant-`, the key or the user's email. The same goes for the screenshots in shots/r3.

## Claude Code on the same cases

Claude Code 2.1.299 ran headless on Sonnet 5.5 with the same fixtures, prompts and key (research/claude-code-harness E60). Its request carries 23 tools, but no Grep, Glob or todo tool. Its Bash description warns only against cat, head, tail, sed, awk and echo. Its 6.1K system prompt has one tool line: "Prefer the dedicated file/search tools over shell commands when one fits." Every outcome check passed. 6 of 8 runs read files with cat, ls and grep in bash. A07 renamed with `sed -i`. A01 edited a file it had never read, and Claude Code let the edit through. No run kept a todo list. Claude Code adapts its harness to the model's habits, while Geno enforces reads and writes, because its panel, diffs, Undo and file tracking need them.

## Left open after round 5

- A29 answered a Thai prompt in English once, after a long code edit.
- On a rename with a typecheck and a test run, Sonnet keeps no todo list. It reads the work as one change and its checks.
- Linux's sandbox still blocks every unix socket. sandbox-runtime cannot scope them by path there.
- A `case … in a) echo` before `&&` still exempts a read after it.
