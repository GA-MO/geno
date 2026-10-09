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

- P-03 and P-04: the description helps, but cat, ls and find still appear in about half the runs, and a server with `&` still appears (A19 fix-a2). A harness note on a bash call that only reads files, as ISSUES.md suggests, is the next step to measure.
- P-11: no todo call in A07 after the change. The rows say it is a model limit at this task size; a reminder notice when a prompt names three or more actions is untested.
- P-12: no measurable change; answers stay near the 1,500-character line.
- G-01's cost: every command off the safe list now asks in Ask, as in Claude Code. In a terminal-less CLI run that refuses it, so a benign first command such as A08's grep ends the turn. The safe list could grow (for example `git check-ignore`, `git clean -n`) where users find the cards noisy.
- G-02, G-10 in the panel, and P-10 were not run on the real model; they need the Layer B suite.
- G-03 and the non-JSON recovery did not recur live, so their live paths are unverified.
- M-01 (the classifier judges a plain project script by a risky request) and M-02 (ignores "run no commands", claims scrambled reads): no prompt or classifier change here. M-01 needs a hand-written benign case in the classifier eval, which today draws benign cases from eval logs only; M-02 needs a regression eval.
