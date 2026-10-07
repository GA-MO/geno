# P24: a cheap-model prompt tier

Run on 2026-10-08 (Bangkok time) against Model Studio `qwen3.8-flash` through the Anthropic-compatible endpoint. Verdict: **qwen3.8-flash keeps the rules tier.** Both arms passed 10 of 10 tasks. The rules tier made fewer tool calls, spent less and wrote fewer output tokens on average. The gap is smaller than the spread between two runs of the same arm, so these four runs show that the rules tier is no worse. They do not show that it is better.

## What was compared

Both arms ran the same build: this branch at `bcdf58a5`, on top of main at `11b985f3`, before P9 and P13 merged. The branch was then rebased onto `d0376565` without changing the prompts, the tool descriptions or the eval; `bcdf58a5` is now `137b212e`. The two arms share the new tool descriptions, which now carry the per-tool rules (B/B-01), the bash git lines (B/B-18) and the workflow "only when asked" line (C/C-44). Only the system prompt text differs. `gcode eval speed --prompt-tier principles|rules` chooses it.

- **principles.** Today's agent prompt, lightly aligned. The per-tool bullets moved into the tool descriptions, and it gained the "act; do not re-derive or narrate" line (A/B-10) and the "no need to wrap up early" line (A/B-09). Strong models get this tier.
- **rules.** Claude Code's Haiku prompt structure, section by section, in Geno's words: System, Doing tasks, Executing actions with care, Using your tools, Checking your work, Tone and style, Text output, Context management. It leaves out Haiku's memory, environment and session sections, because Geno puts these in the opening message and its notes. `qwen3.8-flash` and every unknown model get this tier.

Sizes, from `npx tsx scripts/prompt-sizes.ts`. Tokens are Geno's estimate of 3.5 characters a token.

| Text | main before P24 | principles | rules |
|---|---|---|---|
| Agent system prompt | 7,419 chars, ~2,120 tokens | 6,449 chars, ~1,843 tokens | 10,476 chars, ~2,994 tokens |
| Built-in tool definitions | 14,891 chars, ~4,255 tokens | 16,314 chars, ~4,662 tokens | 16,314 chars, ~4,662 tokens |

The rules tier adds about 1,150 tokens to the cached prefix of every call. Claude Code's Haiku prompt is 28,688 characters, and 12,920 of them are its memory section.

## Method

The five-task speed subset (`SPEED_TASKS`), with E5's check `npx tsc --noEmit` after every edit, $0.08 per task and $0.19 per run. The four runs alternated arms: principles, rules, principles, rules. The one-minute load average was 6.6 on 10 cores before the first run and 10.4 after the last; the arms alternated, so load cannot explain a difference between them. `node scripts/prompt-tier-ab.mjs <arm>=<results.jsonl>...` prints the table below from the results files. Before writing it, the request snapshots of one task from each arm were read: run 4 sent the rules text and run 3 sent the principles text.

A tool failure is a call that returned an error, a denial or a rejection. The table counts bash apart, because a test that exits non-zero before the fix is part of the work, not a failed call.

| Run | Arm | Results | Passed | Turns | Tool calls | Calls per task | Tool failures (not bash) | Edit failures | bash non-zero | Output tokens | Cache reads | Cost | Agent time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | principles | `2026-10-07T18-53-29-580Z-gcode-qwen3.8-flash` | 5/5 | 82 | 108 | 21.6 | 4 (3.7%) | 2 | 7 | 30,412 | 975,138 | $0.1724 | 747 s |
| 2 | rules | `2026-10-07T19-06-58-142Z-gcode-qwen3.8-flash` | 5/5 | 70 | 86 | 17.2 | 4 (4.7%) | 1 | 4 | 15,815 | 678,290 | $0.1172 | 431 s |
| 3 | principles | `2026-10-07T19-15-18-546Z-gcode-qwen3.8-flash` | 5/5 | 84 | 115 | 23.0 | 9 (7.8%) | 5 | 11 | 22,318 | 987,296 | $0.1687 | 817 s |
| 4 | rules | `2026-10-07T19-30-36-204Z-gcode-qwen3.8-flash` | 5/5 | 89 | 109 | 21.8 | 7 (6.4%) | 3 | 8 | 27,097 | 1,091,810 | $0.1873 | 675 s |

The results directories are under `~/.g-code/evals/runs/`.

## Results per arm

| Arm | Passed | Tool calls, mean (range) | Cost, mean (range) | Output tokens, mean (range) | Tool failures | Edit failures |
|---|---|---|---|---|---|---|
| principles | 10/10 | 111.5 (108 to 115) | $0.1706 ($0.1687 to $0.1724) | 26,365 (22,318 to 30,412) | 13 of 223 (5.8%) | 7 |
| rules | 10/10 | 97.5 (86 to 109) | $0.1523 ($0.1172 to $0.1873) | 21,456 (15,815 to 27,097) | 11 of 195 (5.6%) | 4 |
| Change | holds | -12.6% | -10.7% | -18.6% | about the same | -3 |

Mean tool calls per task, over the two runs of each arm:

| Task | principles | rules |
|---|---|---|
| payload-dayjs-bangkok | 20.5 (16, 25) | 13.5 (8, 19) |
| next-about-translations | 26.5 (40, 13) | 37.0 (31, 43) |
| next-counter-floor | 17.5 (16, 19) | 18.0 (20, 16) |
| next-theme-typography | 11.0 (12, 10) | 9.5 (10, 9) |
| next-demo-services-consolidate | 36.0 (24, 48) | 19.5 (17, 22) |

## What the numbers say

- **The pass rate held.** Every task passed in every run. Run 1's `next-about-translations` hit its $0.08 cap after its edits already passed the check.
- **The means fell, but inside the noise.** The rules arm used fewer calls on three tasks, about the same on one, and more on `next-about-translations`. One task swings the totals. `next-about-translations` took 13 calls in one principles run and 40 in the other, and `next-demo-services-consolidate` took 24 and 48. Run 4 (rules) cost more and wrote more output than both principles runs. Two runs per arm cannot separate a change of 10 to 15%.
- **The bigger prompt did not raise the cost.** Each call reads about 1,150 more prefix tokens under the rules tier. The rules arm still read fewer cache tokens on average (885,050 against 981,217), because it made fewer calls. The cost column bills cache reads at the full input price, as every Geno eval does, so it overstates the real bill for both arms alike.
- **Edit failures fell from 7 to 4.** These are small counts. The tool descriptions are the same in both arms, so a change here comes from the system prompt alone.
- **Output fell the most.** The rules tier asks for a one-sentence update before the first call, a short report at the end, and no narration of reasoning. That fits the lower output means, though run 4 shows the same spread as the other metrics.

The plan's rule is to keep the tier if the pass rate holds and calls or cost fall. Both conditions hold on the means, so the rules tier stays. A third run of each arm would cost about $0.33 and would take the spend over the $0.80 cap, so the eval stopped at four runs. A rerun can confirm or overturn this: `gcode eval speed --prompt-tier rules` and `--prompt-tier principles`, alternated.

## Spend

| Item | Estimated cost |
|---|---|
| Run 1, principles | $0.1724 |
| Run 2, rules | $0.1172 |
| Run 3, principles | $0.1687 |
| Run 4, rules | $0.1873 |
| Total | $0.6456, under the $0.80 limit |

The engine's price table bills cache reads at the full input price, so these figures overstate the real bill. The prompt iteration step did not run, because the first version met the plan's rule.
