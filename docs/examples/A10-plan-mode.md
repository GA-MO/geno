# A10-plan-mode, run 1

**Task.** Plan a small feature and its test in Plan mode, where Geno may read and run read-only commands but not edit.

**Prompt**, as the user typed it:

> Make formatPrice support negative amounts like -$12.50 and add a test for it.

**Mode.** Plan (`gcode agent --mode plan`): Geno reads and plans, and cannot edit.

## What Geno did

1. "I'll find `formatPrice` and see how it handles input today." Calls `grep formatPrice`.
2. Reads `src/money.ts` and `test/money.test.ts`.
3. Notices that the code cannot produce two decimals at all, so it runs `npm test 2>&1 | tail -30` to see the current state.
4. "Several tests were already failing before my task." Runs `npm test` again, filtered to the failing test names.
5. Lists `src`.
6. Says what it found: `formatPrice` has no fixed decimals and no sign handling, and the two-decimals test already fails. Then writes a todo list of three items, all pending: rework `formatPrice`, add tests for negative amounts, run `npm test`.
7. Writes the plan: the new `formatPrice` (sign first, then the symbol, then `Math.abs(cents) / 100` with `toFixed(2)`), the new test, how to verify it, and the open questions, such as where locales put the sign.

## Result

No file changed, as Plan requires.

Every check passed: yes. Cost $0.0124 for 7 model calls on qwen3.8-flash, 49 s from the prompt to the last event.

The full run, with the session log, the transcript and every check: [results/real-usecases/runs/A10-plan-mode/1](../results/real-usecases/runs/A10-plan-mode/1/). `packages/engine/test/real-runs.e2e.test.ts` replays it, and the gallery shows it as **Real sessions › A10**.
