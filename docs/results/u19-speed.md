# U19: speed baseline, effort and thinking on qwen3.8-flash

Run on 2026-10-05 and 2026-10-06 (Bangkok time). Model Studio `qwen3.8-flash` through the Anthropic-compatible endpoint. One run of `gcode eval speed` at commit `e69833c` (`4860b3d` after this branch was rebased onto main), with the speed eval's first caps ($0.05 per task, $0.12 per run). Results and per-turn timings: `~/.g-code/evals/runs/2026-10-05T16-53-05-262Z-gcode-qwen3.8-flash/` (`results.jsonl`, `speed.json`). `gcode eval speed --from <results.jsonl>` reprints the table.

## What is measured

Each assistant or error event in the session log now carries `timing` (`ModelMarks`, ms since the epoch):

| Mark | When |
|---|---|
| `startAt` | The loop began the call, before its checkpoint, attachment load and any retry. |
| `requestAt` | The request of the attempt that produced the result went out. |
| `firstTokenAt` | The first streamed content block start or delta of any kind. |
| `firstAnswerAt` | The first text or tool-call content, after any thinking. |
| `lastTokenAt` | The last streamed content. |
| `endAt` | The call returned. |

Each tool result carries `timing: { startAt, endAt }`. An abort during a tool batch logs no results, so the abort error carries `tools`, the batch's tools timed up to the interrupt. Every field is optional, so logs written before U19 still read, and the request is built from the events' content only, so the bytes the model sees do not change (`packages/core/test/timing.test.ts`, "leaves the request bytes the model sees unchanged").

`turnTimings` (`packages/core/src/timing.ts`) turns these into one `TurnTiming` per model call:

- **first token**: `firstTokenAt - requestAt`. Network, queueing and prefill.
- **thinking**: `firstAnswerAt - firstTokenAt`. Zero for a call that did not think.
- **decode**: `lastTokenAt - firstAnswerAt`. The visible answer and tool-call arguments.
- **model**: `endAt - requestAt`. The three parts above plus the stream's tail (3.1 s in total over this run).
- **tools**: the sum of the turn's tool durations. With `--check`, an edit's duration includes the type check that runs after it.
- **overhead**: the rest of the turn. A turn runs from its `startAt` to the next call's `startAt`, so overhead holds checkpoints, retry waits, spilling and logging.

The thinking-token count is an estimate. The usage block reports one output-token number, so `turnTimings` splits it by the share of thinking characters in the turn's content.

## Baseline

| Part | p50 per turn | p90 per turn | Total | Share of agent time |
|---|---|---|---|---|
| First token | 0.8 s | 1.2 s | 72.9 s | 12.8% |
| Thinking | 1.4 s | 4.8 s | 206.5 s | 36.4% |
| Decode | 0.9 s | 4.2 s | 143.2 s | 25.2% |
| Model (all of the above plus tail) | 3.4 s | 10.4 s | 425.6 s | 75.0% |
| Tools | 0.0 s | 4.2 s | 135.1 s | 23.8% |
| Overhead | 0.1 s | 0.1 s | 6.8 s | 1.2% |
| Outside turns (session start, sandbox) | | | 0.2 s | 0.0% |
| Agent time | | | 567.7 s | 100% |

Model plus tool time explains 98.8% of agent time, above the 90% the brief requires. The remaining 1.2% is per-turn overhead. Of its 6.8 s, 6.6 s fell between a call's start and its request, about 80 ms per turn. The run logged no retries, so that is the shadow-repo checkpoint and the attachment load before each call.

Tokens per turn: output p50 178, p90 600; estimated thinking p50 96, p90 278. Over the run, an estimated 12,675 of 22,427 output tokens (57%) were thinking. Streamed output ran at p50 68.5 and p90 88.6 tokens per second of thinking plus decode.

| Task | Pass | Stop | Turns | Agent time | First token | Thinking | Decode | Tools | Output tokens |
|---|---|---|---|---|---|---|---|---|---|
| payload-dayjs-bangkok | yes | end_turn | 14 | 142.6 s | 17.2 s | 69.3 s | 33.9 s | 20.7 s | 6,208 |
| next-about-translations | yes | budget | 32 | 228.8 s | 27.8 s | 74.9 s | 57.0 s | 65.9 s | 8,724 |
| next-counter-floor | yes | end_turn | 20 | 114.4 s | 15.9 s | 29.4 s | 29.7 s | 36.2 s | 4,129 |
| next-theme-typography | yes | end_turn | 13 | 74.9 s | 9.5 s | 31.3 s | 20.2 s | 12.2 s | 3,075 |
| next-demo-services-consolidate | no | budget | 3 | 7.0 s | 2.5 s | 1.6 s | 2.4 s | 0.1 s | 291 |

The pass rate is 4/5, and that number is not a model result. `next-demo-services-consolidate` got only the $0.0012 left in the run's $0.12 cap and stopped after 3 turns. `next-about-translations` hit its $0.05 per-task cap, but its edits already passed the check. The four tasks that ran to the end all passed. The caps estimate cache reads at the full input price, so they overstate spend; the run spent an estimated $0.1204. The speed eval's defaults are now $0.08 per task and $0.25 per run, so all five tasks finish next time.

Tool time by tool: `bash` 33 calls, 94.9 s; `edit` 18 calls, 39.8 s (with the type check after each edit); `read`, `grep`, `glob` and `list` 51 calls, 0.4 s together.

## Effort and thinking on Model Studio

Settled with `scripts/effort-probe.mjs`, which sends one short question per setting to `$DASHSCOPE_BASE_URL/v1/messages`, streamed:

```json
{"model":"qwen3.8-flash","max_tokens":4000,"stream":true,
 "messages":[{"role":"user","content":"How many times does the letter r appear in \"strawberry raspberry cranberry\"? Reply with only the number."}],
 "output_config":{"effort":"<level>"}}
```

| Setting sent | Calls | Content blocks | Thinking characters | Output tokens | Answer (correct is 9) |
|---|---|---|---|---|---|
| `output_config.effort: "low"` | 4 | thinking, text | 167, 301, 232, 202 | 81, 131, 104, 92 | 9 every time |
| `output_config.effort: "medium"` | 1 | thinking, text | 256 | 129 | 9 |
| `output_config.effort: "high"` | 3 | thinking, text | 864, 1046, 805 | 267, 330, 313 | 9 every time |
| no `output_config` | 1 | thinking, text | 910 | 348 | 9 |
| `effort: "medium"` and `thinking: {"type":"disabled"}` | 2 | text only | 0 | 1, 2 | 8, then 10 |

Findings:

- **Model Studio honors `output_config.effort` for `qwen3.8-flash`.** Low and high do not overlap: low used 81 to 131 output tokens, high 267 to 330, on the same prompt. Every response had status 200. The final `message_delta` usage reports `output_tokens` with no separate thinking count.
- **Thinking can be turned off per request** with `thinking: {"type": "disabled"}`. The response then has no thinking block and answers in 1 or 2 output tokens, in 0.6 and 1.2 s. On this counting question it answered wrong both times, so turning thinking off is not free on quality.
- **No `output_config` behaves like high**, not like medium. Geno always sends one (`buildRequest` sends the session's effort, `medium` by default), so this matters only to other clients.
- On the first call, `message_delta` reported `input_tokens` 46 where `message_start` reported 23. The engine reads the final message, so it takes the `message_delta` number. Only that call was checked.

The probe made 11 calls in total, about 1,800 output tokens and 600 input tokens, about $0.001.

## Is Geno decode-bound?

The research guessed that Geno is decode-bound: that writing output takes most of each turn, so fewer output tokens and fewer turns are the biggest wins (`research/competitors-2026-10.md`, sections 0 and 2.1).

Verdict: **mostly confirmed, with two corrections.**

- Confirmed: streaming output (thinking plus decode) is 61.6% of agent time, the largest share by far. First token is 12.8% and tools are 23.8%.
- Correction 1: the larger part of that output is hidden thinking, not the visible answer. Thinking is 36.4% of agent time against 25.2% for decode, and an estimated 57% of output tokens. The first lever is the effort setting (proven to work above), before terse narration or edit format.
- Correction 2: tools are not negligible. They are 23.8% of agent time, almost all of it `bash` and the type check after edits, which parallel read-only tools (U20) would not touch. Reads, greps, globs and lists took 0.4 s in total, so running them in parallel saves turns, not tool time.
- The research's per-turn arithmetic used a 55 tokens per second rate. This run measured p50 68.5 tokens per second while streaming. Its mean turn was 6.9 s and 273 output tokens, against E5's 8.3 s and 425.

Limits of this evidence. It is one run of 82 turns on 4.6 tasks. The machine's load average was 11.6 on 10 cores at the start (other agents were running), which inflates tool time, mostly the type checks, and does not touch model time. The thinking-token split is an estimate by characters. A rerun with all five tasks, on a quieter machine, would tighten the tool share.

## Spend

| Item | Estimated cost |
|---|---|
| `gcode eval speed`, one run | $0.1204 |
| Effort and thinking probe, 11 calls | about $0.001 |
| Total | about $0.121 |

Both use the engine's price table, which bills cache reads at the full input rate. At a 10% cache-read price, the speed run would cost about $0.03.
