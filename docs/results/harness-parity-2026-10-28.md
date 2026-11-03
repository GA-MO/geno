# Geno vs Claude Code on the user's own prompts (2026-10-28)

Same model on both sides, 13 tasks replayed from Geno checkpoints of the user's trip-site sessions where Geno handed work back (scripts/harness-parity). Claude Code 2.1.311 ran `claude -p --permission-mode auto` with the same headless browser server. Geno ran `gcode agent --mode auto --browser`. Each ran in a fresh HOME. A run that ended by asking or offering got one "go on" reply from a simulated user, up to two. A hand-back is needless when a default could have settled it, as a Sonnet 5.5 reader judged it. The judge is Opus 5.5, blind, in both orders, and a split counts as a tie. Each table pairs two Claude Code runs with Geno's final round.

Opus 5.5 was judged through the Claude Code CLI after the API key ran out of credit, and its phases-all task did not finish for the same reason. The tables below are the first rounds. The run on the shipped prompt is under [Final run on the shipped prompt](#final-run-on-the-shipped-prompt-2026-11-03).

## claude-sonnet-5-5

### Claude Code r0,r2 vs Geno r4

| task | Claude Code | Geno | judge |
|---|---|---|---|
| skill-copy | pass 0/0hb · 3c 14s 53k $0.03 | pass 0/0hb · 4c 20s 41k $0.03 | claude |
| outside-tokens | pass 1/1hb chk 14c 98s 568k $0.44 | pass 0/0hb · 19c 84s 595k $0.31 | geno |
| icon-buttons | pass 3/3hb chk 13c 60s 292k $0.30 | pass 0/0hb nochk 5c 22s 99k $0.13 | geno |
| mobile-375 | pass 2/2hb chk 30c 217s 1584k $1.10 | pass 0/0hb chk 23c 140s 913k $0.46 | tie |
| agent-review | pass 1/1hb chk 28c 193s 1400k $0.58 | pass 0/0hb chk 30c 136s 1164k $0.50 | geno |
| review-fix | pass 2/2hb chk 27c 305s 1581k $1.44 | pass 0/0hb chk 6c 46s 145k $0.18 | claude |
| animation | pass 1/1hb · 9c 57s 234k $0.17 | pass 1/1hb chk 15c 73s 350k $0.20 | geno |
| redesign | pass 1/1hb chk 24c 288s 1556k $1.15 | pass 0/0hb chk 21c 112s 806k $0.43 | tie |
| icon-labels-en | pass 1/2hb chk 9c 54s 206k $0.19 | pass 0/0hb chk 12c 41s 319k $0.19 | geno |
| edit-page | pass 1/1hb chk 18c 163s 822k $0.65 | pass 0/0hb chk 28c 123s 998k $0.46 | geno |
| plan-image | pass 0/1hb nochk 7c 56s 250k $0.26 | pass 0/1hb chk 25c 77s 747k $0.31 | geno |
| deploy | pass 0/0hb · 5c 34s 95k $0.07 | pass 0/0hb · 5c 24s 56k $0.04 | claude |
| phases-all | FAIL 0/3hb nochk 22c 221s 1258k $1.54 | pass 0/1hb chk 32c 245s 1658k $0.79 | geno |

### Claude Code r0b vs Geno r4

| task | Claude Code | Geno | judge |
|---|---|---|---|
| skill-copy | pass 0/0hb · 3c 11s 53k $0.03 | pass 0/0hb · 4c 20s 41k $0.03 | claude |
| outside-tokens | pass 1/1hb chk 21c 132s 937k $0.57 | pass 0/0hb · 19c 84s 595k $0.31 | geno |
| icon-buttons | pass 1/1hb · 13c 55s 346k $0.24 | pass 0/0hb nochk 5c 22s 99k $0.13 | tie |
| mobile-375 | pass 1/1hb chk 40c 296s 2249k $0.86 | pass 0/0hb chk 23c 140s 913k $0.46 | tie |
| agent-review | pass 2/3hb chk 26c 363s 1558k $1.99 | pass 0/0hb chk 30c 136s 1164k $0.50 | claude |
| review-fix | pass 3/3hb chk 19c 387s 1021k $0.92 | pass 0/0hb chk 6c 46s 145k $0.18 | claude |
| animation | pass 1/1hb · 10c 69s 269k $0.18 | pass 1/1hb chk 15c 73s 350k $0.20 | geno |
| redesign | pass 1/1hb · 18c 181s 975k $0.78 | pass 0/0hb chk 21c 112s 806k $0.43 | geno |
| icon-labels-en | pass 2/2hb nochk 11c 110s 429k $0.55 | pass 0/0hb chk 12c 41s 319k $0.19 | tie |
| edit-page | pass 3/3hb chk 25c 198s 1331k $1.15 | pass 0/0hb chk 28c 123s 998k $0.46 | geno |
| plan-image | pass 1/1hb nochk 7c 42s 250k $0.26 | pass 0/1hb chk 25c 77s 747k $0.31 | geno |
| deploy | pass 3/3hb · 12c 63s 246k $0.21 | pass 0/0hb · 5c 24s 56k $0.04 | geno |
| phases-all | FAIL 0/3hb chk 18c 190s 945k $1.31 | pass 0/1hb chk 32c 245s 1658k $0.79 | geno |

Over 2 pair(s): hidden checks Claude Code 24/26, Geno 26/26. Needless hand-backs (of all): Claude Code 32 (41), Geno 2 (6). Checked its own result: Claude Code 14, Geno 18. Judge: Geno 17.5/26 (ties count half). Criteria MET.

## claude-opus-5-5

### Claude Code o1,o2 vs Geno o3

| task | Claude Code | Geno | judge |
|---|---|---|---|
| skill-copy | pass 1/1hb · 4c 28s 72k $0.23 | pass 0/0hb nochk 8c 35s 86k $0.14 | geno |
| outside-tokens | pass 0/0hb chk 20c 258s 1004k $0.97 | pass 0/0hb chk 32c 335s 1629k $1.43 | geno |
| icon-buttons | pass 1/1hb · 15c 127s 453k $0.61 | pass 0/0hb chk 21c 129s 727k $0.67 | geno |
| mobile-375 | pass 1/1hb chk 58c 372s 3580k $2.67 | pass 0/0hb chk 55c 388s 2743k $1.52 | geno |
| agent-review | pass 1/1hb chk 33c 912s 2833k $13.18 | pass 0/0hb chk 46c 418s 2454k $1.86 | geno |
| review-fix | pass 0/1hb chk 39c 434s 2569k $2.52 | pass 0/0hb chk 29c 220s 1329k $1.05 | tie |
| animation | pass 1/1hb chk 22c 223s 918k $0.84 | pass 0/0hb chk 21c 140s 886k $0.69 | geno |
| redesign | pass 0/0hb chk 20c 377s 1278k $1.43 | pass 0/0hb chk 33c 411s 2114k $1.84 | geno |
| icon-labels-en | pass 1/1hb chk 9c 92s 318k $0.67 | pass 0/0hb chk 16c 91s 510k $0.48 | claude |
| edit-page | pass 1/1hb chk 39c 435s 2501k $2.27 | pass 0/0hb chk 25c 286s 1244k $1.19 | geno |
| plan-image | pass 1/1hb chk 11c 92s 449k $0.61 | pass 2/2hb chk 38c 415s 1642k $0.98 | claude |
| deploy | pass 0/0hb · 5c 38s 93k $0.14 | pass 0/0hb · 8c 49s 103k $0.11 | geno |

### Claude Code o1,o2,o1b vs Geno o3

| task | Claude Code | Geno | judge |
|---|---|---|---|
| skill-copy | pass 1/1hb · 5c 40s 91k $0.26 | pass 0/0hb nochk 8c 35s 86k $0.14 | geno |
| outside-tokens | pass 0/0hb · 17c 238s 858k $0.90 | pass 0/0hb chk 32c 335s 1629k $1.43 | geno |
| icon-buttons | pass 1/1hb nochk 22c 156s 718k $0.90 | pass 0/0hb chk 21c 129s 727k $0.67 | geno |
| mobile-375 | pass 0/0hb chk 41c 388s 2324k $1.18 | pass 0/0hb chk 55c 388s 2743k $1.52 | tie |
| agent-review | pass 1/1hb chk 28c 1004s 2092k $9.27 | pass 0/0hb chk 46c 418s 2454k $1.86 | geno |
| review-fix | pass 1/1hb chk 43c 478s 2822k $4.37 | pass 0/0hb chk 29c 220s 1329k $1.05 | tie |
| animation | pass 1/1hb chk 23c 183s 942k $0.82 | pass 0/0hb chk 21c 140s 886k $0.69 | geno |
| redesign | pass 0/0hb chk 25c 438s 1850k $1.60 | pass 0/0hb chk 33c 411s 2114k $1.84 | geno |
| icon-labels-en | pass 1/1hb chk 13c 121s 486k $0.80 | pass 0/0hb chk 16c 91s 510k $0.48 | tie |
| edit-page | pass 1/1hb chk 29c 302s 1645k $1.89 | pass 0/0hb chk 25c 286s 1244k $1.19 | geno |
| plan-image | pass 1/1hb chk 11c 92s 449k $0.61 | pass 2/2hb chk 38c 415s 1642k $0.98 | claude |
| deploy | pass 0/0hb · 7c 51s 137k $0.11 | pass 0/0hb · 8c 49s 103k $0.11 | geno |

Over 2 pair(s): hidden checks Claude Code 24/24, Geno 24/24. Needless hand-backs (of all): Claude Code 16 (17), Geno 4 (4). Checked its own result: Claude Code 17, Geno 20. Judge: Geno 19/24 (ties count half). Criteria MET.

## Final run on the shipped prompt (2026-11-03)

Commit 59d88b65, the extension's 0.18.13 code with the Claude prompt that ships: Claude Code's text, plus five Geno rules that Layer A shows Sonnet needs (a todo list for several-part work, edit rather than sed -i and rename with replace_all, never print secrets, a short recommendation for an options question, and the language line). The Claude Code runs are the first rounds' runs, not run again. Geno ran one new Sonnet round (r5) and Opus phases-all (o4), with the other Opus tasks kept from o3.

### Layer A on Sonnet 5.5

36 of 39 pass (`node scripts/real-usecases/run.mjs --model claude-sonnet-5-5 --cost-scale 4.91`, $2.60). A07 and A28, which the first Claude prompt broke, pass. A09 (repeats a secret it read) and A26 also fail on main. A17 passes 1 of 6 on the shipped prompt, 3 of 3 with the short restored rules and 1 of 2 on main. The shipped prompt's pass did the job as intended, with 36 edit calls, and got the budget notice. Its failures did the job with one bulk script: the reported run used `perl -i`, which the edit check rightly flags, and four reruns finished in 4 calls, so the notice, which goes out after the 4th of 5, never fired. The short rules' passes go through two holes in the case: one run changed no file, because Geno refused its bulk edit for also reading a file with `sed -n`, and two wrote all 18 files with a `node` script, which the edit check does not see.

| case | main | short restored rules | shipped prompt |
|---|---|---|---|
| A07-multi-step-todo | 3/3 | 0/5 | 4/4 |
| A35-show-before-after | 2/2 | - | 4/4 |
| A17-budget-reminder | 1/2 | 3/3 | 1/6 |

The first restored rules said "make a todo list" and "edit rather than sed -i" in fewer words than main. With them A07 still used no todo list in 4 of 5 runs and edited files from bash in 4 of 5. Main's own wording for the two rules fixed it. Run logs: ~/Development/hp-runs/layer-a-sonnet-final-*.log and a07-*, a17-*, a35-*.

### Layer B in VS Code

9 of 9 steps on Sonnet 5.5, $0.22 (`GCODE_REAL_MODEL=1 pnpm test:vscode packages/extension/test/real-model.integration.test.ts`). The screenshots are in [shots/rhp-final](real-usecases/shots/rhp-final/).

### claude-sonnet-5-5

### Claude Code r0,r2 vs Geno r5

| task | Claude Code | Geno | judge |
|---|---|---|---|
| skill-copy | pass 0/0hb · 3c 14s 53k $0.03 | pass 1/1hb nochk 10c 55s 169k $0.11 | claude |
| outside-tokens | pass 1/1hb chk 14c 98s 568k $0.44 | pass 0/0hb chk 13c 79s 362k $0.26 | geno |
| icon-buttons | pass 3/3hb chk 13c 60s 292k $0.30 | pass 0/0hb chk 15c 55s 380k $0.21 | geno |
| mobile-375 | pass 2/2hb chk 30c 217s 1584k $1.10 | pass 0/0hb chk 28c 167s 1243k $0.57 | claude |
| agent-review | pass 1/1hb chk 28c 193s 1400k $0.58 | pass 0/0hb · 14c 73s 389k $0.25 | geno |
| review-fix | pass 2/2hb chk 27c 305s 1581k $1.44 | pass 0/0hb chk 6c 53s 148k $0.19 | claude |
| animation | pass 1/1hb · 9c 57s 234k $0.17 | pass 3/3hb chk 17c 95s 494k $0.26 | claude |
| redesign | pass 1/1hb chk 24c 288s 1556k $1.15 | pass 0/0hb chk 19c 138s 781k $0.51 | claude |
| icon-labels-en | pass 1/2hb chk 9c 54s 206k $0.19 | pass 0/0hb chk 19c 54s 570k $0.27 | geno |
| edit-page | pass 1/1hb chk 18c 163s 822k $0.65 | pass 0/0hb chk 29c 123s 1056k $0.48 | geno |
| plan-image | pass 0/1hb nochk 7c 56s 250k $0.26 | pass 3/3hb chk 25c 124s 797k $0.36 | geno |
| deploy | pass 0/0hb · 5c 34s 95k $0.07 | pass 1/3hb · 20c 114s 309k $0.16 | geno |
| phases-all | FAIL 0/3hb nochk 22c 221s 1258k $1.54 | FAIL 0/3hb chk 32c 245s 1700k $0.82 | tie |

### Claude Code r0b vs Geno r5

| task | Claude Code | Geno | judge |
|---|---|---|---|
| skill-copy | pass 0/0hb · 3c 11s 53k $0.03 | pass 1/1hb nochk 10c 55s 169k $0.11 | claude |
| outside-tokens | pass 1/1hb chk 21c 132s 937k $0.57 | pass 0/0hb chk 13c 79s 362k $0.26 | geno |
| icon-buttons | pass 1/1hb · 13c 55s 346k $0.24 | pass 0/0hb chk 15c 55s 380k $0.21 | geno |
| mobile-375 | pass 1/1hb chk 40c 296s 2249k $0.86 | pass 0/0hb chk 28c 167s 1243k $0.57 | claude |
| agent-review | pass 2/3hb chk 26c 363s 1558k $1.99 | pass 0/0hb · 14c 73s 389k $0.25 | claude |
| review-fix | pass 3/3hb chk 19c 387s 1021k $0.92 | pass 0/0hb chk 6c 53s 148k $0.19 | claude |
| animation | pass 1/1hb · 10c 69s 269k $0.18 | pass 3/3hb chk 17c 95s 494k $0.26 | geno |
| redesign | pass 1/1hb · 18c 181s 975k $0.78 | pass 0/0hb chk 19c 138s 781k $0.51 | geno |
| icon-labels-en | pass 2/2hb nochk 11c 110s 429k $0.55 | pass 0/0hb chk 19c 54s 570k $0.27 | geno |
| edit-page | pass 3/3hb chk 25c 198s 1331k $1.15 | pass 0/0hb chk 29c 123s 1056k $0.48 | geno |
| plan-image | pass 1/1hb nochk 7c 42s 250k $0.26 | pass 3/3hb chk 25c 124s 797k $0.36 | tie |
| deploy | pass 3/3hb · 12c 63s 246k $0.21 | pass 1/3hb · 20c 114s 309k $0.16 | geno |
| phases-all | FAIL 0/3hb chk 18c 190s 945k $1.31 | FAIL 0/3hb chk 32c 245s 1700k $0.82 | geno |

Over 2 pair(s): hidden checks Claude Code 24/26, Geno 24/26. Needless hand-backs (of all): Claude Code 32 (41), Geno 16 (26). Checked its own result: Claude Code 14, Geno 20. Judge: Geno 16/26 (ties count half). Criteria MET.

Geno r5 has more needless hand-backs than r4 (16 against 2), most of them a closing offer. Four of those tasks ran once more on each prompt. On the shipped prompt (r5b) skill-copy, animation and plan-image had 0, 1 and 0. On r4's prompt (r4p) they had 0, 1 and 0. Deploy had 3 against 1. After its first offer, deploy opened the published page in the headless browser, which the eval's gh and curl shims do not reach, got GitHub's 404 and handed back. phases-all failed the same way as Claude Code's runs. Geno's sandboxed gh reported no login, and the model asked the user to run `gh auth login`.

### claude-opus-5-5

### Claude Code o1,o2 vs Geno o3,o4

| task | Claude Code | Geno | judge |
|---|---|---|---|
| skill-copy | pass 1/1hb · 4c 28s 72k $0.23 | pass 0/0hb nochk 8c 35s 86k $0.14 | geno |
| outside-tokens | pass 0/0hb chk 20c 258s 1004k $0.97 | pass 0/0hb chk 32c 335s 1629k $1.43 | geno |
| icon-buttons | pass 1/1hb · 15c 127s 453k $0.61 | pass 0/0hb chk 21c 129s 727k $0.67 | geno |
| mobile-375 | pass 1/1hb chk 58c 372s 3580k $2.67 | pass 0/0hb chk 55c 388s 2743k $1.52 | geno |
| agent-review | pass 1/1hb chk 33c 912s 2833k $13.18 | pass 0/0hb chk 46c 418s 2454k $1.86 | geno |
| review-fix | pass 0/1hb chk 39c 434s 2569k $2.52 | pass 0/0hb chk 29c 220s 1329k $1.05 | tie |
| animation | pass 1/1hb chk 22c 223s 918k $0.84 | pass 0/0hb chk 21c 140s 886k $0.69 | geno |
| redesign | pass 0/0hb chk 20c 377s 1278k $1.43 | pass 0/0hb chk 33c 411s 2114k $1.84 | geno |
| icon-labels-en | pass 1/1hb chk 9c 92s 318k $0.67 | pass 0/0hb chk 16c 91s 510k $0.48 | claude |
| edit-page | pass 1/1hb chk 39c 435s 2501k $2.27 | pass 0/0hb chk 25c 286s 1244k $1.19 | geno |
| plan-image | pass 1/1hb chk 11c 92s 449k $0.61 | pass 2/2hb chk 38c 415s 1642k $0.98 | claude |
| deploy | pass 0/0hb · 5c 38s 93k $0.14 | pass 0/0hb · 8c 49s 103k $0.11 | geno |
| phases-all | FAIL 0/3hb nochk 32c 387s 2204k $4.04 | FAIL 1/3hb nochk 42c 553s 3213k $2.36 | tie |

### Claude Code o1,o2,o1b vs Geno o3,o4

| task | Claude Code | Geno | judge |
|---|---|---|---|
| skill-copy | pass 1/1hb · 5c 40s 91k $0.26 | pass 0/0hb nochk 8c 35s 86k $0.14 | geno |
| outside-tokens | pass 0/0hb · 17c 238s 858k $0.90 | pass 0/0hb chk 32c 335s 1629k $1.43 | geno |
| icon-buttons | pass 1/1hb nochk 22c 156s 718k $0.90 | pass 0/0hb chk 21c 129s 727k $0.67 | geno |
| mobile-375 | pass 0/0hb chk 41c 388s 2324k $1.18 | pass 0/0hb chk 55c 388s 2743k $1.52 | tie |
| agent-review | pass 1/1hb chk 28c 1004s 2092k $9.27 | pass 0/0hb chk 46c 418s 2454k $1.86 | geno |
| review-fix | pass 1/1hb chk 43c 478s 2822k $4.37 | pass 0/0hb chk 29c 220s 1329k $1.05 | tie |
| animation | pass 1/1hb chk 23c 183s 942k $0.82 | pass 0/0hb chk 21c 140s 886k $0.69 | geno |
| redesign | pass 0/0hb chk 25c 438s 1850k $1.60 | pass 0/0hb chk 33c 411s 2114k $1.84 | geno |
| icon-labels-en | pass 1/1hb chk 13c 121s 486k $0.80 | pass 0/0hb chk 16c 91s 510k $0.48 | tie |
| edit-page | pass 1/1hb chk 29c 302s 1645k $1.89 | pass 0/0hb chk 25c 286s 1244k $1.19 | geno |
| plan-image | pass 1/1hb chk 11c 92s 449k $0.61 | pass 2/2hb chk 38c 415s 1642k $0.98 | claude |
| deploy | pass 0/0hb · 7c 51s 137k $0.11 | pass 0/0hb · 8c 49s 103k $0.11 | geno |
| phases-all | FAIL 0/3hb nochk 32c 387s 2204k $4.04 | FAIL 1/3hb nochk 42c 553s 3213k $2.36 | tie |

Over 2 pair(s): hidden checks Claude Code 24/26, Geno 24/26. Needless hand-backs (of all): Claude Code 16 (23), Geno 6 (10). Checked its own result: Claude Code 17, Geno 20. Judge: Geno 20/26 (ties count half). Criteria MET.

On phases-all both harnesses finished phases 1 to 3 and stopped at the public deploy. In Geno, the Auto classifier refused `gh repo create --public` twice, and "decide yourself" was not taken as consent to publish the trip publicly. In Claude Code, its own permission check blocked the same step.

