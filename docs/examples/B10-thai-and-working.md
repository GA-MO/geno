# B10-thai-and-working, run 1

**Task.** Explain a project in Thai, in the VS Code panel, without changing it.

**Prompt**, as the user typed it:

> อธิบายโปรเจกต์นี้สั้นๆ ว่าทำอะไร ไม่ต้องแก้โค้ด

In English: "Briefly explain what this project does. Don't change the code."

**Mode.** Ask, in the VS Code panel: Geno asks before a risky command.

## What Geno did

1. Lists the workspace, and runs `cat package.json; ls -R | head -50`.
2. Reads `src/routes.js`, and prints the head of every `src/*.js` file with a shell loop.
3. Prints `README.md`, `src/money.ts`, `src/slug.ts` and `test/money.test.ts` with `cat`.
4. Runs `npm test`, and calls `userRoute` and `title` with `node -e` to see how they behave.
5. Answers in Thai. It says that `tiny-shop` is a tiny demo of price and user helpers, tested with `node --test`, and lists what each file holds. It then names three things it found: the money test already fails, `routes.js` converts the id to a number but `profile.js` does not, and `formatPrice` uses plain numbers. It ends by offering the two fixes worth making.

## Result

No file changed.

Not every check passed. The answer is Thai prose around code names and file paths, and only 46% of its letters were Thai, under the campaign's threshold. The run also read files with `cat` through the shell, where `read` would do. It is here as an example of a Thai question and answer in the panel, not of tool choice.

Cost $0.0076 for 5 model calls on qwen3.8-flash, 30 s from the prompt to the last event.

The full run, with the session log, the transcript, and screenshots of the panel while it worked: [results/real-usecases/runs/B10-thai-and-working/1](../results/real-usecases/runs/B10-thai-and-working/1/).
