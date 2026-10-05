# U21: effort per turn kind

Run on 2026-10-06 (Bangkok time) against Model Studio `qwen3.8-flash` through the Anthropic-compatible endpoint. Verdict: **the table ships with flat defaults**, equal to today's behavior. Stepping effort down per turn made Model Studio miss its prompt cache, so cache writes doubled, cost rose by about a quarter and model time per turn went up. Output tokens did not fall.

## The table

`packages/core/src/effort.ts` holds the policy table, keyed by turn kind. `turnKindOf(events)` names the kind of the next model call from the session log:

| Turn kind | When | `flat` (default) | `stepped` (measured, rejected) |
|---|---|---|---|
| `prompt` | The first call after the user's message | 0 | 0 |
| `after-tools` | A follow-up after tool results that all succeeded, or after a paused turn | 0 | -1 |
| `after-failure` | A follow-up after a batch where any tool errored or was denied, a command exited non-zero or was killed, or a check failed or timed out | 0 | 0 |

A step is `0`, `-1` or `-2` levels below the session effort, stopping at `low`. The type has no positive step, so no turn can spend more than the user chose. The session effort is the **base and the ceiling** at once: a policy moves each turn down from it and never above it. The base keeps the user's choice meaningful at every level (a user on `high` still gets more thought than one on `low`), and the ceiling keeps the promise of no surprise spend.

The table has no row for the final answer. Whether a call answers or asks for tools is known only after the call returns.

`gcode eval speed --effort-policy flat|stepped` picks a policy, so the comparison below can be rerun as providers change.

## Method

Two runs of each policy, interleaved: flat, stepped, flat, stepped. Each run was `gcode eval speed --effort-policy <name> --max-cost 0.19` on the five-task subset, with the default $0.08 per-task cap. The session effort was `medium` in every run, so `stepped` sent `low` on `after-tools` turns. Before each run after the first, a script waited until the one-minute load average fell below 15.

| Run | Policy | Load at start, end | Results |
|---|---|---|---|
| 1 | flat | 57.6, 22.6 | `~/.g-code/evals/runs/2026-10-05T17-31-29-345Z-gcode-qwen3.8-flash/` |
| 2 | stepped | 13.6, 5.0 | `~/.g-code/evals/runs/2026-10-05T17-49-49-902Z-gcode-qwen3.8-flash/` |
| 3 | flat | 5.0, 4.8 | `~/.g-code/evals/runs/2026-10-05T18-01-43-961Z-gcode-qwen3.8-flash/` |
| 4 | stepped | 4.8, 3.8 | `~/.g-code/evals/runs/2026-10-05T18-13-56-114Z-gcode-qwen3.8-flash/` |

Run 1 started before the coordinator asked for the load gate, under a load of 57.6 on 10 cores. Load inflates tool time, mostly the type check after each edit, and barely touches model time. So the verdict rests on model time, first token, output tokens, cache writes and cost.

## Results per run

| Run | Policy | Passed | Turns | Output tokens | Cache writes | Cost | Model p50 | First token p50 | Output p50 per turn |
|---|---|---|---|---|---|---|---|---|---|
| 1 | flat | 5/5 | 99 | 23,574 | 54,665 | $0.1467 | 2.6 s | 0.7 s | 133 |
| 3 | flat | 5/5 | 101 | 33,656 | 70,891 | $0.1884 | 3.2 s | 0.7 s | 178 |
| 2 | stepped | 4/4, task 5 not started | 98 | 29,760 | 128,742 | $0.1914 | 3.5 s | 0.9 s | 196 |
| 4 | stepped | 4/5 | 96 | 29,763 | 128,340 | $0.1915 | 3.9 s | 1.0 s | 194 |

Both stepped runs hit the $0.19 run cap. Run 2 stopped before its fifth task. Run 4 gave its fifth task only $0.021, and `next-demo-services-consolidate` stopped on that budget and failed its check. Every task that ran to its own end passed under both policies. Counting the task that never started as not passed, the pass rate is 10/10 for flat and 8/10 for stepped. The two misses are budget stops, and the budget ran out because stepped spends more.

On the four tasks every run finished (all but `next-demo-services-consolidate`), the means of the two runs are:

| Policy | Output tokens | Cache writes | Cost |
|---|---|---|---|
| flat | 24,212 | 53,738 | $0.146 |
| stepped | 27,915 (+15%) | 119,442 (2.2x) | $0.181 (+24%) |

The output-token difference is inside the noise. One task alone swung from 7 turns to 20 between the two flat runs. The cache-write difference is not noise: the lowest stepped run wrote 128,340 tokens, and the highest flat run wrote 70,891.

## Speed per part, pooled over two runs

`gcode eval speed --from` on the two runs of each policy, concatenated. Re-reporting spends nothing.

**Before: flat.** 10 tasks, 200 turns, passed 10/10.

| Part | p50 per turn | p90 per turn | Total | Share of agent time |
|---|---|---|---|---|
| First token | 0.7 s | 1.0 s | 154.0 s | 10.3% |
| Thinking | 1.0 s | 7.1 s | 558.4 s | 37.5% |
| Decode | 0.7 s | 3.7 s | 285.7 s | 19.2% |
| Model | 2.9 s | 11.2 s | 1005.3 s | 67.6% |
| Tools | 0.0 s | 5.9 s | 455.0 s | 30.6% |
| Overhead | 0.1 s | 0.2 s | 26.2 s | 1.8% |
| Agent time | | | 1487.7 s | 100% |

Output tokens per turn p50 146, p90 689. Estimated thinking tokens p50 77, p90 436.

**After: stepped.** 9 tasks, 194 turns, passed 8/9.

| Part | p50 per turn | p90 per turn | Total | Share of agent time |
|---|---|---|---|---|
| First token | 1.0 s | 1.7 s | 222.0 s | 17.1% |
| Thinking | 1.2 s | 6.5 s | 539.9 s | 41.7% |
| Decode | 1.0 s | 3.3 s | 301.5 s | 23.3% |
| Model | 3.7 s | 11.0 s | 1071.9 s | 82.8% |
| Tools | 0.1 s | 3.0 s | 210.8 s | 16.3% |
| Overhead | 0.1 s | 0.1 s | 12.4 s | 1.0% |
| Agent time | | | 1295.3 s | 100% |

Output tokens per turn p50 195, p90 644. Estimated thinking tokens p50 88, p90 385.

Stepped's lower agent time comes from tools (455.0 s against 210.8 s), and most of that gap is run 1's load of 57.6. Model time per turn rose: p50 2.9 s to 3.7 s. First token rose from p50 0.7 s to 1.0 s and p90 1.0 s to 1.7 s, which is what a prefill of uncached history looks like.

By turn kind, `after-tools` turns are 79 to 81 of the roughly 100 turns in each run, so they are where a policy acts. Their output p50 was 136 and 192 in the flat runs, and 208 and 219 at `low` in the stepped runs.

## Why: an effort change misses Model Studio's cache

The request bytes Geno sends keep the system prompt, tools and messages identical whatever the effort. `packages/core/test/effort.test.ts` proves that only `output_config` changes. Model Studio's cache does not see those bytes, though. It sees its own rendering of the request, and that rendering depends on the effort.

A replay probe resent the request of one logged turn of `next-theme-typography` six times, varying only the effort (`replay-probe.mts`, kept in the session scratchpad, not the repo):

| Call | Effort | Cache read | Cache write | Output tokens |
|---|---|---|---|---|
| 1 | medium | 2,869 | 2,098 | 213 |
| 2 | medium | 4,967 | 0 | 209 |
| 3 | low | 2,895 | 2,098 | 287 |
| 4 | low | 4,993 | 0 | 229 |
| 5 | medium | 4,967 | 0 | 177 |
| 6 | low | 4,993 | 0 | 396 |

Call 3 sent the same messages as call 2 and missed the 2,098 tokens of history that call 2 had just read. The prefix that did hit was 26 tokens longer at `low` (2,895 against 2,869), so Model Studio renders the effort into the prompt ahead of the conversation. Each effort level keeps its own cache chain. Under `stepped`, every switch between `low` and `medium` writes the history since that level's last call again. Cache writes are billed above the input price, and an uncached prefill delays the first token.

The same probe shows that `low` does not reliably shorten an agent follow-up. On this turn, `low` gave 287, 229 and 396 output tokens against 213, 209 and 177 at `medium`. On three turns of `next-counter-floor`, `low` was shorter on two (84 and 62 against 124 and 102; 408 and 231 against 610 and 1,294) and level on the third. U19's single counting question, where `low` always used fewer tokens, does not carry over to tool turns.

So the brief's premise, that `output_config` is outside the cached prefix, holds for the bytes Geno sends and does not hold for Model Studio's cache. A policy only pays off where an effort change keeps the cache, or where it saves more output than it costs in cache writes. Neither holds on Model Studio today.

## The composer hook

The session effort is now an ACP session config option. `session/new`, `session/resume` and `session/load` return it in `configOptions`:

```json
{"id":"effort","name":"Effort","category":"thought_level","type":"select","currentValue":"medium",
 "options":[{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},
            {"value":"xhigh","name":"Extra high"},{"value":"max","name":"Max"}]}
```

`session/set_config_option` with `configId: "effort"` logs an `effort` event in the session log. Like a mode switch, it applies from the next model call and survives resume and load. An unknown option or value is an invalid-params error. U36 shows this next to the model.

Per the U35 note, the OpenAI-compatible wire does not send `output_config`. The policy only changes the effort on the session the gateway gets, so on such a provider it changes nothing in the request.

## Spend

| Item | Estimated cost |
|---|---|
| Run 1, flat | $0.1467 |
| Run 2, stepped | $0.1914 |
| Run 3, flat | $0.1884 |
| Run 4, stepped | $0.1915 |
| Replay probe, 18 calls | at most $0.03 |
| Total | at most $0.75, under the $0.80 limit |

The engine's price table bills cache reads at the full input price, so these estimates overstate the real bill.
