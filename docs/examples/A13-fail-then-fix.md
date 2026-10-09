# A13-fail-then-fix, run 1

**Task.** Implement a stub function so its test file passes, without fixing unrelated failing tests.

**Prompt**, as the user typed it:

> Implement parseDuration in src/duration.ts so test/duration.test.ts passes.

**Mode.** Non-interactive (`gcode agent --non-interactive`): nobody can answer a question, so anything that needs approval is refused.

## What Geno did

1. "I'll look at the test and the stub first." Reads `src/duration.ts` and `test/duration.test.ts` in one turn.
2. Sums up what the tests cover: single units, combined units with optional spaces, and bad input. Then writes the whole implementation in one `edit src/duration.ts`. The project's check (`node --test`) runs after the edit and fails, but only on `slugify` and `formatPrice`, which were broken before the task.
3. Runs `node --test test/duration.test.ts` and `git status --short` to tell its own result apart from the old failures.
4. Answers: `parseDuration` is done, the duration tests pass, and the other two failures were there before and are out of scope. It changed no other file.

## Result

`src/duration.ts` +15 −1. The diff adds a table of unit sizes and a loop that requires each `<number><unit>` match to start where the last one ended, so `1x` and `10` throw.

Every check passed: yes. Cost $0.0072 for 4 model calls on qwen3.8-flash, 36 s from the prompt to the last event.

The full run, with the session log, the transcript and every check: [results/real-usecases/runs/A13-fail-then-fix/1](../results/real-usecases/runs/A13-fail-then-fix/1/). `packages/engine/test/real-runs.e2e.test.ts` replays it, and the gallery shows it as **Real sessions › A13**.
