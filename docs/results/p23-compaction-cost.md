# P23: what a long qwen3.8-flash session costs at two compaction points

This eval chose the default compaction point for `qwen3.8-flash` (parity row A/E-01). Geno compacted at 80% of the window, which is 800,000 tokens on flash. The eval compares that point with 200,000 tokens. Result: flash now compacts at 200,000 tokens, and every other model keeps 80% of its window.

Run it with `GCODE_ENV_FILE=<path to .env> pnpm tsx packages/engine/test/compact-cost.ts`. The live part costs about $0.10.

## Method

A live session at 800,000 tokens costs about $0.12 a call, so the eval does not run one. It has two parts:

1. **A live run at a small scale.** Two sessions on `qwen3.8-flash` compact at 12,000 and 48,000 tokens, the same 1:4 ratio as 200,000 and 800,000. Each session reads 20 files of about 7,000 characters. Each file hides a key on a line in its middle. After the last file, the model lists the 20 keys without reading again. The run measures cost, calls, compactions, the context left after each compaction, and how many keys the model recalled.
2. **A projection at full size.** A session of 1,500 calls starts at 3,900 tokens, the system prompt and tools. The context grows by 800 tokens of input and 400 of output a call, the means over the 65 longer flash sessions in the local store (1,845 calls). Each call reads its whole context. A compaction costs a summary call that reads at most 60,000 tokens and writes 2,000. It leaves the system prompt, the 20,000-token kept tail and the summary, 25,900 tokens. Prices are the ones Geno bills flash at.

## Live results

| Compaction point | Calls | Compactions | Context after each | Cost | Keys recalled |
|---|---|---|---|---|---|
| 12,000 | 23 | 7 | 7,740 to 8,062 | $0.047 | 20 of 20 |
| 48,000 | 13 | 1 | 17,108 | $0.052 | 20 of 20 |

The 48,000 session took fewer calls because the model read several files in one call. Per call, it cost twice as much: $0.0040 against $0.0020. Each summary cost $0.0016 to $0.0022 at 12,000 and $0.0075 at 48,000.

The context after a compaction matched the projection's rule within about 1,000 tokens: 3,900 for the system prompt and tools, plus the kept tail (a quarter of the point, at most 20,000), plus about 1,000 for the summary.

Recall held through 7 compactions in a row.

An earlier run of this eval put each key on a file's first line. The model then read only the first line of most files, so the context grew by about 100 tokens a call and the 48,000 session never compacted. That run cost $0.041.

## Projection at full size

| Compaction point | Cost of 1,500 calls | Compactions | Mean context |
|---|---|---|---|
| 200,000 | $25.26 | 10 | 110,584 |
| 800,000 | $84.29 | 2 | 373,286 |
| 967,000 (Claude Code's window minus 33,000) | $105.09 | 1 | 465,770 |

A call costs in proportion to its context, so the mean context sets the bill. Summaries add $0.10 at 200,000 and $0.02 at 800,000. That is under 1% of either total.

## Limits

- Geno bills flash's cache reads at the full input rate, so a budget never underestimates. Model Studio reported 93% of the input as cache reads in the local sessions, and its list price for an implicit cache hit is lower. The real bill is lower at both points, by about the same factor, so the ratio holds.
- The live sessions are short. Recall at 7 compactions says the summary keeps facts the task names. It does not say that a 1,500-call session keeps every detail.
- Total live spend for this eval was $0.14: $0.099 and $0.041 for the two runs, and under $0.001 for the output-limit probes.
