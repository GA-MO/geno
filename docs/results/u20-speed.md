# U20: parallel reads and a faster check

Run on 2026-10-06 (Bangkok time) against Model Studio `qwen3.8-flash`. Verdict: **both changes ship, and neither made the speed eval measurably faster.** Turns per task did not fall. Tool time fell by a third, but that drop is in `bash`, which neither change touches. Reads running together saved 0.44 s over 174 turns. The faster check saves about 0.1 to 0.2 s per edit on these tasks, because their check was already incremental. It now also leaves the workspace alone, which it did not before.

## Batches

A turn's tool uses run as consecutive batches (`packages/core/src/tool-batch.ts`):

```ts
type ToolBatch = { readonly start: number; readonly end: number }; // indexes into the turn's uses, end exclusive
```

- A batch is either a run of up to 8 consecutive uses that change nothing and ask nobody, which run at the same time, or one other use alone.
- Batches run one after another. `nextToolBatch` forms each batch only when the one before it has finished, so an "allow for the session" or a mode switch from an earlier batch counts.
- A use may join a batch when its executor's `concurrent()` says so. `read`, `grep`, `glob`, `list`, `skill` and `mcp_describe` always may. An MCP tool may when the server marks it `readOnlyHint` and `mcpDenialFor` lets it run without a question in the current mode. Edits, `bash`, `check`, the user tools and the browser tools never join a batch. The browser is left out because its read-only tools refresh shared page state before they run.
- Results are logged and sent in the order of the calls, with `seq` set by position, whatever order a batch finishes in. The session log and the transcript stay deterministic.
- Questions cannot overlap. Only a use that runs alone can ask, so two prompts never show at once and they come in the order of the calls (`packages/engine/test/parallel-mcp.e2e.test.ts`).
- Reads share two pieces of state: the edit base per file, and the glob rules a read hands out once. A read waits on `ctx.earlierCalls()` before it updates either, so the updates happen in call order. A rule goes to the first matching read of the turn even when a later read finishes first.
- A turn's `toolMs` is now the wall time its tools cover, not their sum. Overlapping reads therefore count once and overhead stays non-negative.

The system prompt gained one line, right after the tool list: "When you need several reads, searches or listings that do not depend on each other, ask for all of them in one turn; they run at the same time."

## The check after edits

**What it cost before.** The speed eval checks with `npx tsc --noEmit`. Both eval repos (`next-15-template` and `payload-site-template`) set `"incremental": true` in `tsconfig.json`, as Next.js does by default. So the old check was already incremental after its first run. It kept its build info in `tsconfig.tsbuildinfo` inside the workspace, which means every check wrote a file into the user's repo. In real use the check is `.gcode.json`'s `check`. Without one, an edit gets no check, and the `check` tool falls back to the editor's diagnostics.

**The change.** When the check is one plain `tsc --noEmit` run (`incrementalTsc` in `packages/core/src/check.ts`), it runs as follows:

```
./node_modules/.bin/tsc --noEmit --incremental --tsBuildInfoFile '<app home>/check-cache/<sha256(workspace) 16 hex>/tsbuildinfo'
```

- `npx tsc` becomes the workspace's own `node_modules/.bin/tsc` when one exists. That is the same binary npx picks, minus npx's start-up time.
- The build info lives under the app home, keyed by the workspace's real path. Only the check command may write that folder: `Sandbox.run` takes `writable` for that one command. `bash` still writes only to the workspace and the temp dir.
- The model still sees the configured command in the result's headline, so the transcript is unchanged.
- Any other command runs as it is. That covers shell operators, quotes, `-b`, `--watch`, an explicit `--incremental` or `--tsBuildInfoFile`, and anything that is not `tsc`.
- The eval removes each task's cache with its clone.

**Proof that it proves the same thing** (`packages/engine/test/check-incremental.e2e.test.ts`). The test project mirrors Next's tsconfig, with `incremental` on. A fake model plants `export const n: number = 'one';`, fixes it, and plants it again. The check fails cold and fails warm. Each time its output is exactly what a plain `tsc --noEmit --incremental false` prints for the same file: `a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.` In between it passes. A second test changes the type of `n` and expects the error in `b.ts`, a file the edit never touched. It finds it warm, again with the plain check's words. Both tests assert that the workspace holds only `a.ts`, `node_modules` and `tsconfig.json`. Before the change, that assertion failed with an extra `tsconfig.tsbuildinfo`.

**Cold and warm times.** These were measured through the engine's sandbox, in copies of the two eval repos, with the old and new commands interleaved: 4 cold runs and 12 warm runs each, a file edited before every run (`check-bench.mts`, kept in the session scratchpad). The load was 8 to 11 throughout.

| Repo | Old cold p50 / p90 | Old warm p50 / p90 | New cold p50 / p90 | New warm p50 / p90 |
|---|---|---|---|---|
| next-15-template | 1.36 / 1.57 s | 0.96 / 1.02 s | 1.12 / 1.14 s | 0.83 / 0.85 s |
| payload-site-template | 3.36 / 3.71 s | 2.39 / 3.00 s | 3.21 / 3.80 s | 2.43 / 2.81 s |

The warm gain on Next is npx's start-up (0.18 s for `npx tsc --version` against 0.04 s for the binary). On Payload it is lost in the noise. A project without `incremental` in its tsconfig gains more, because its old check was cold every time. Outside the sandbox, at load 3, `--incremental false` took 1.07 s on Next against 0.73 s for the new warm check, and 2.33 s on Payload against 1.62 s. The remaining time is mostly building the program: parsing the libraries and the `node_modules` types on every run. Only a checker that stays running between edits could cut that, and this unit did not build one.

## Method

`gcode eval speed --max-cost 0.14 --max-cost-per-task 0.05`, four runs, interleaved: baseline, U20, baseline, U20. The baseline is `main` at `bd7be8c`, exported to a separate folder. Before each run, a script waited while the one-minute load was above 15. It never had to wait. The caps are tighter than the defaults so that four runs fit the $0.60 limit, and both arms ran under the same caps.

| Run | Arm | Load at start, end | Passed | Turns | Cost | Results |
|---|---|---|---|---|---|---|
| 1 | baseline | 6.7, 12.5 | 5/5 | 80 | $0.1059 | `~/.g-code/evals/runs/2026-10-05T20-29-14-770Z-gcode-qwen3.8-flash/` |
| 2 | U20 | 12.5, 8.3 | 3/4, task 5 not started | 82 | $0.1413 | `~/.g-code/evals/runs/2026-10-05T20-38-15-608Z-gcode-qwen3.8-flash/` |
| 3 | baseline | 8.3, 2.8 | 4/5 | 91 | $0.1410 | `~/.g-code/evals/runs/2026-10-05T20-48-01-544Z-gcode-qwen3.8-flash/` |
| 4 | U20 | 2.8, 2.1 | 4/5 | 92 | $0.1403 | `~/.g-code/evals/runs/2026-10-05T20-57-18-784Z-gcode-qwen3.8-flash/` |

Every failure is a budget stop, not a wrong answer. The run cap left the last task too little money: run 2's `next-theme-typography` got $0.019, and run 3's and run 4's `next-demo-services-consolidate` got $0.011 and $0.007. Every task that ended its own turn passed, in both arms. Counting the task that never started as not passed, the pass rate is 9/10 for the baseline and 7/10 for U20. Those three budget stops are not evidence about either change.

## Results, pooled over two runs per arm

Turns per task and tool time per task, from `results.jsonl` and the session logs:

| | Baseline (10 tasks) | U20 (9 tasks) |
|---|---|---|
| Turns per task | p50 15.0, p90 26.5 (171 in all) | p50 17.0, p90 27.4 (174 in all) |
| Tool time per task | p50 10.0 s, p90 21.9 s (112.2 s in all) | p50 7.0 s, p90 14.7 s (73.5 s in all) |
| Agent time per task | p50 84.8 s, p90 167.7 s (1033.0 s) | p50 94.8 s, p90 184.1 s (1040.7 s) |
| Edit plus its check, per edit | p50 1.0 s, p90 1.7 s (31 edits, 40.1 s) | p50 1.0 s, p90 1.7 s (34 edits, 37.4 s) |
| `bash` | 74 calls, 68.0 s | 76 calls, 33.1 s |
| Read, grep, glob, list, skill | 121 calls, 0.9 s | 115 calls, 1.2 s |
| Turns with a read; with 2 or more | 78; 37 (47%) | 67; 38 (57%) |
| Time saved by overlap | 0 | 0.44 s |

Turns by task (baseline runs 1 and 3; U20 runs 2 and 4): `payload-dayjs-bangkok` 9 and 19 against 22 and 16; `next-about-translations` 13 and 26 against 27 and 29; `next-counter-floor` 14 and 18 against 16 and 12; `next-theme-typography` 13 and 16 against 17 and 27; `next-demo-services-consolidate` 31 and 12 against 8 and not started.

Per part, from `gcode eval speed --from` on each arm's two `results.jsonl` files concatenated:

**Before: baseline.** 10 tasks, 171 turns, passed 9/10.

| Part | p50 per turn | p90 per turn | Total | Share of agent time |
|---|---|---|---|---|
| First token | 1.5 s | 2.5 s | 296.1 s | 28.7% |
| Thinking | 0.9 s | 7.1 s | 406.0 s | 39.3% |
| Decode | 0.6 s | 3.3 s | 203.4 s | 19.7% |
| Model | 3.5 s | 11.1 s | 910.6 s | 88.2% |
| Tools | 0.0 s | 1.5 s | 112.2 s | 10.9% |
| Overhead | 0.1 s | 0.1 s | 9.9 s | 1.0% |
| Agent time | | | 1033.0 s | 100% |

**After: U20.** 9 tasks, 174 turns, passed 7/9.

| Part | p50 per turn | p90 per turn | Total | Share of agent time |
|---|---|---|---|---|
| First token | 1.6 s | 2.2 s | 286.5 s | 27.5% |
| Thinking | 1.0 s | 5.6 s | 454.9 s | 43.7% |
| Decode | 0.7 s | 3.0 s | 209.8 s | 20.2% |
| Model | 3.7 s | 10.0 s | 957.3 s | 92.0% |
| Tools | 0.0 s | 1.5 s | 73.5 s | 7.1% |
| Overhead | 0.1 s | 0.1 s | 9.7 s | 0.9% |
| Agent time | | | 1040.7 s | 100% |

## What the numbers say

- **Turns did not fall.** The noise swamps any effect. One task went from 9 to 19 turns between two baseline runs, and another from 31 to 12. Even before this change the model already put 2 or more reads in 47% of its read turns, so batching had little left to win. With the new prompt line that share rose to 57%, which is a small move and within the run-to-run spread. Two runs per arm cannot detect a change of a turn or two per task.
- **The tool-time drop is not from this unit.** The whole drop is in `bash` (68.0 s to 33.1 s). In run 1, one `npm run test` took 6.4 s, and the model chose its commands differently from run to run. Reads cost 0.9 to 1.2 s across 115 to 121 calls, so overlapping them saved 0.44 s. U19 predicted this: parallel reads save turns, not tool time.
- **The check is a little cheaper on these tasks.** Edits with their check took 1.29 s on average in the baseline and 1.10 s with U20, and the medians match. That fits the sandbox benchmark: on Next, npx's start-up was the only thing left to remove.
- **The load was not a limit.** Every run started below 15, and the arms alternated, so the load cannot explain a difference between them.

## Spend

| Item | Estimated cost |
|---|---|
| Run 1, baseline | $0.1059 |
| Run 2, U20 | $0.1413 |
| Run 3, baseline | $0.1410 |
| Run 4, U20 | $0.1403 |
| Total | $0.5285, under the $0.60 limit |

The engine's price table bills cache reads at the full input price, so these figures overstate the real bill.
