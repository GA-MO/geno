# P34: forced structured output for workflow schema steps

Run on 2026-10-09 (Bangkok time) against Model Studio `qwen3.8-flash` through the Anthropic-compatible endpoint. Verdict: **keep the forced `structured_output` call, on by default, but only when the report's JSON block does not fit the schema.** Over 30 runs each, the block alone gave valid fields in 26, and the block with a forced call when it failed gave valid fields in 30 and correct fields in 29. A forced call after every report gave valid fields in 30, but correct fields in only 27, because it replaced correct blocks with paraphrases. All runs together cost $0.220.

## What was compared

`pnpm tsx packages/engine/test/structured-output-eval.ts <env file> <out dir> <reps>` runs one-step workflows in an editor session, as the VS Code panel does. Each step is an `explore` child capped at 6 turns and $0.03, whose step has a `schema`. A run is **valid** when the workflow finishes with the step's fields, and **correct** when the fields also match the case's answer.

The six cases ask for fields of four types:

- `exports`: the functions a file exports, as `names` (string[]) and `count` (number).
- `quote`: a string literal that holds double quotes, character for character, and its line number.
- `review`: a review of a file with two bugs, as `pass`, `bugs` and `lines`.
- `todos`: the TODO comments under `src/`, as a count and the files.
- `package`: three values from `package.json`, of string and boolean type.
- `readme`: a README's title, its headings in order, a boolean, a count and a sentence.

Three arms ran five reps of each case, with the arm that goes first rotated per case and rep:

- **block** is `GCODE_STRUCTURED_OUTPUT=off`: the fields come from the report's JSON block alone, as before P34.
- **always** forces a `structured_output` call after every report, and its fields win over the block.
- **fallback** is the default: the block when it fits, and a forced call only when it does not.

The forced request carried `tool_choice: {"type": "tool", "name": "structured_output"}` and `thinking: {"type": "disabled"}`, as the request snapshots in the run folders show. Model Studio honoured it in every forced request: 39 of 39 forced calls, the pilot's and the first fallback arm's included, returned a `structured_output` call whose input fit the schema.

## Results

| Arm | Valid | Correct | Report's block fits | Forced calls | Child cost per run |
|---|---|---|---|---|---|
| block | 26 of 30 | 26 of 30 | 26 of 30 | 0 | $0.00176 |
| always | 30 of 30 | 27 of 30 | 28 of 30 | 30 | $0.00246 |
| fallback | 30 of 30 | 29 of 30 | 25 of 30 | 5 | $0.00215 |

| Case | block valid | always correct | fallback correct |
|---|---|---|---|
| exports | 3 of 5 | 5 of 5 | 5 of 5 |
| quote | 4 of 5 | 2 of 5 | 4 of 5 |
| review | 4 of 5 | 5 of 5 | 5 of 5 |
| todos | 5 of 5 | 5 of 5 | 5 of 5 |
| package | 5 of 5 | 5 of 5 | 5 of 5 |
| readme | 5 of 5 | 5 of 5 | 5 of 5 |

In the block arm, valid and correct are the same runs: every block that fit held the right answer.

## What the numbers say

**The block fails in one way.** In three of the four failed block runs, the report ended with the JSON object and no fence; in two of those, the model had written the fenced block in its text just before the report call. In the fourth, the report had no JSON, though the text before it did. The fallback arm's five forced calls came after the same kind of failure, and all five returned fields that fit. So the forced call rescues the failure the block parse has, at the cost of one more call in about one run in six.

**A forced call after every report costs accuracy.** In the `quote` case, the forced call's `message` field was a sentence about the literal in three of five `always` runs, and in two of those the report's block held the exact literal. Its fields win in `always`, so a correct answer became a wrong one, which the next step would read as fact. The fallback arm keeps the block when it fits, so the forced call can only fill a gap. That is why the default forces the call only after the block fails, though Claude Code forces its `StructuredOutput` call on every schema step.

**The difference is small.** 30 of 30 against 26 of 30 is a two-sided Fisher p of about 0.11 for one arm alone. Both forced arms together have 0 failures in 60 runs against 4 in 30, a p of about 0.01. The mechanism also holds in every run: each forced call fit, and each block failure is one a forced call answers. Five reps of six cases is still a small sample, and the cases were written for this eval.

**Cost.** A forced call after every report adds $0.00067 a run, 40% of the step. The fallback arm adds a forced call to five runs in 30. Its recorded cost per run, $0.00215, includes three more forced calls that a parse defect caused, described next.

## A parse defect the eval found

Three `review` runs in the first fallback arm stopped although their forced call fit. Their reports had a ```` ```ts ```` block before the JSON block. `readFields` opened a fence only on ```` ``` ```` or ```` ```json ````, so the closing fence of the `ts` block paired with the opening fence of the JSON block, and no block was read: neither the model's, nor the one the forced call's fields became. A fence with any language tag now opens a block, and a core test covers it.

`--rescore <out dir>` scores the runs' logs again with the current `readFields`, as each arm picks its fields, without another model call. The table above is the rescored result. It changes only the fallback arm: the three `review` runs read their own block and need no forced call. Before the fix, the fallback arm had 27 valid of 30 with 8 forced calls. Five more fallback runs of `review` with the fixed code ran live: 5 of 5 valid and correct, with no forced call.

## Spend

| Part | Runs | Cost |
|---|---|---|
| Pilot | 3 | $0.0145 |
| block and always arms | 60 | $0.1264 |
| fallback arm | 30 | $0.0645 |
| fallback, `review`, after the fix | 5 | $0.0144 |
| Total | 98 | $0.2198 |

The editor session made no model call of its own: the run's report would wake it, and the eval stops before the wake.
