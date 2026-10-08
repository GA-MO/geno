# P25: the agent default and the budget reminder

Run on 2026-10-08 (Bangkok time) against Model Studio `qwen3.8-flash` through the Anthropic-compatible endpoint. Verdict: **the `agent` tool stays off by default.** Both arms passed 6 of 6 tasks. The model never called `agent` in any of the six tasks where it was offered, so the arms differ only by the tool's definition in the prefix. The "on" arm's lower mean cost is run-to-run noise, not a gain from subagents.

## What was compared

Both arms ran the same build, `a99dfbd2`, which carries the first budget reminder text (`c6404604`). `gcode eval speed --agent-tool` and `--no-agent-tool` set the run's `agentTool` and override the workspace's `.gcode.json`. Since `a99dfbd2`, a task's cost and model calls include its subagents', read from each `child-end` event.

- **off.** Today's default: no `agent` tool.
- **on.** The `agent` tool is offered, with the built-in `explore`, `plan` and `review` definitions. The eval runs non-interactive, so only read-only children can start, and `worker` cannot. Ask and Auto would also allow `worker`.

## Method

Three of the five speed tasks (`--task`): `payload-dayjs-bangkok`, `next-about-translations` and `next-demo-services-consolidate`. These are the three that needed the most search in P24. Five tasks a run at P24's cost would have taken four runs past the $0.60 cap. The check is E5's `npx tsc --noEmit` after every edit, $0.08 per task and $0.15 per run. The four runs alternated arms: off, on, off, on. `node scripts/prompt-tier-ab.mjs <arm>=<results.jsonl>...` prints the table below. Before the table was written, the first request of an "on" task was read with `gcode session request`. Its tools were `agent`, `bash`, `check`, `edit`, `glob`, `grep`, `list`, `read`, `todo` and `tool_search`, so the tool was offered.

| Run | Arm | Results | Passed | Model calls | Tool calls | Tool calls per task | `agent` calls | Tool failures (not bash) | Output tokens | Cache reads | Cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | off | `2026-10-08T14-58-56-381Z-gcode-qwen3.8-flash` | 3/3 | 50 | 68 | 22.7 | 0 | 2 (2.9%) | 17,620 | 722,569 | $0.1258 |
| 2 | on | `2026-10-08T15-06-05-687Z-gcode-qwen3.8-flash` | 3/3 | 49 | 59 | 19.7 | 0 | 6 (10.2%) | 11,559 | 699,355 | $0.1181 |
| 3 | off | `2026-10-08T15-11-36-013Z-gcode-qwen3.8-flash` | 3/3 | 56 | 67 | 22.3 | 0 | 1 (1.5%) | 21,649 | 858,847 | $0.1487 |
| 4 | on | `2026-10-08T15-21-08-450Z-gcode-qwen3.8-flash` | 3/3 | 44 | 62 | 20.7 | 0 | 1 (1.6%) | 15,996 | 665,891 | $0.1163 |

The results directories are under `~/.g-code/evals/runs/`.

## Results per arm

| Arm | Passed | Model calls per task | Tool calls per task, mean (range of runs) | Cost per task | Cost per run, mean (range) | Subagents started |
|---|---|---|---|---|---|---|
| off | 6/6 | 17.7 | 22.5 (22.3 to 22.7) | $0.0457 | $0.1372 ($0.1258 to $0.1487) | 0 |
| on | 6/6 | 15.5 | 20.2 (19.7 to 20.7) | $0.0391 | $0.1172 ($0.1163 to $0.1181) | 0 |

Tool calls per task, over the two runs of each arm:

| Task | off | on |
|---|---|---|
| payload-dayjs-bangkok | 16.5 (10, 23) | 10.0 (12, 8) |
| next-about-translations | 33.0 (39, 27) | 35.0 (33, 37) |
| next-demo-services-consolidate | 18.0 (19, 17) | 15.5 (14, 17) |

## What the numbers say

- **Success did not change.** Every task passed in every run.
- **The model never used the tool.** None of the six "on" tasks has an `agent` call or a `child-end` event. On these tasks flash greps and reads for itself and never hands a search to `explore`.
- **The cost gap is noise.** With no subagent started, the only difference the "on" arm adds is the `agent` tool's definition: 3,305 characters, about 950 tokens by Geno's estimate, in every request's prefix. That should make "on" a little dearer, not 15% cheaper. One task shows the spread: `payload-dayjs-bangkok` cost $0.0239 in run 1 and $0.0648 in run 3, the same arm and build. The 2.3-call gap per task is smaller than that spread.
- **Rule check.** The plan's rule turns `agent` on in Ask and Auto only if cost and success both improve. Success held at 100% and did not improve. The cost difference has no cause in the tool. So `agentTool` stays off by default, and `.gcode.json` still turns it on per mode.

A rerun with tasks that reward delegation, such as a broad "where is X used" question over a large repository, could change this. So could a parent model that delegates more readily than flash. `gcode eval speed --agent-tool --task <id>` and `--no-agent-tool` repeat this comparison.

## The budget reminder in these runs

The reminder fired in 3 of the 12 tasks, each time from the cost limit, not the call limit:

| Run | Task | Told | Calls after | End |
|---|---|---|---|---|
| 1 | next-about-translations | $0.0150 of $0.08 left | 4, all tool calls | stopped at the budget with no report |
| 3 | next-demo-services-consolidate | $0.0037 of $0.0247 left | 1 | a report |
| 4 | next-about-translations | $0.0159 of $0.08 left | 3 | a report |

In run 1 the model spent its last calls on more checks. Flash reads a dollar figure badly, so `39285a67` adds the calls that the cost left covers at the run's mean cost a call ("about 4 more model calls are left") and says to start no new exploration. The eval's tasks passed before the stop, so the stop did not change a pass rate.

A live run of the new text: `gcode agent --non-interactive --max-turns 5 --max-cost 0.05` on a clone of `~/Development/next-15-template`, asked to audit every file under `src/services` and `src/plugins`. The model made four tool calls. The reminder was logged once, before the fifth call ("about 1 more model call is left"). The fifth call was a text answer that ended the turn: a table of each file's exports and users, with path:line references, then five findings. It cost $0.010977.

## Spend

| Item | Estimated cost |
|---|---|
| Run 1, off | $0.1258 |
| Run 2, on | $0.1181 |
| Run 3, off | $0.1487 |
| Run 4, on | $0.1163 |
| Tight `--max-turns` run | $0.0110 |
| Total | $0.5199, under the $0.60 limit |

The engine's price table bills cache reads at the full input price, so these figures overstate the real bill.
