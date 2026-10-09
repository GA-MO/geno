# A02-thai-fix, run 1

**Task.** Fix a failing test from a prompt in Thai, and summarise the fix in Thai.

**Prompt**, as the user typed it:

> เทสของ slugify พังอยู่ ช่วยแก้โค้ดให้ผ่านหน่อย แล้วสรุปสั้นๆ ว่าแก้อะไร

In English: "The slugify test is broken. Please fix the code so it passes, then sum up briefly what you changed."

**Mode.** Non-interactive (`gcode agent --non-interactive`): nobody can answer a question, so anything that needs approval is refused.

## What Geno did

1. "ดูโค้ดและเทสของ slugify ก่อนครับ" ("Let me look at the slugify code and its test first.") Calls `grep slugify` and `list`.
2. Reads `src/slug.ts` and `test/slug.test.ts`.
3. Explains the bug, in English this time: `.replace(/ /g, '-')` turns each space into a dash, so runs of spaces become runs of dashes. Runs the slug test to see the real failure.
4. "ตรงคาด แก้ให้ collapses ช่องว่างหลายตัวเป็นขีดเดียว และจัด trim ใหม่อีกทีครับ" ("As expected. I'll make runs of spaces collapse into one dash and redo the trim.") One `edit src/slug.ts`.
5. Runs the slug test, which passes. Then it uses `git stash` to show that the failing money test failed before its change too.
6. Answers in Thai: the slug test passes, with the old and new code and what each step does. It notes that `test/money.test.ts` still fails one case, which it did not touch because the task did not ask for it.

## Result

`src/slug.ts` +5 −1. `slugify` now lowercases, turns every run of other characters into one space, trims, and joins the words with single dashes.

Every check passed: yes, the answer in Thai included. The campaign did not mark it a good example. Cost $0.0099 for 6 model calls on qwen3.8-flash, 34 s from the prompt to the last event.

The full run, with the session log, the transcript and every check: [results/real-usecases/runs/A02-thai-fix/1](../results/real-usecases/runs/A02-thai-fix/1/). `packages/engine/test/real-runs.e2e.test.ts` replays it, and the gallery shows it as **Real sessions › A02**.
