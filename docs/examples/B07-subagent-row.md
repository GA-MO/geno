# B07-subagent-row, run 2

**Task.** Find a function's callers through an explore subagent, in the VS Code panel, where the subagent shows as a row under the call that started it.

**Prompt**, as the user typed it:

> Use an explore subagent to find which files call getUser, then list them. Do not change anything.

**Mode.** Ask, in the VS Code panel: Geno asks before a risky command.

## What Geno did

1. "I'll have an explore subagent search the repo for callers of `getUser`." Starts an `explore` subagent. The panel shows its row, with its role, time and cost, under the `agent` call.
   The subagent lists the workspace and greps for `getUser` and its variants. It then reads `src/user.js` and `.gitignore`, and greps `build/` and `dist/`. Its third call is its report: `getUser` is defined in `src/user.js` and called in `src/profile.js` and `src/routes.js`.
2. Runs its own `grep -i getUser` over the workspace to check the report.
3. Answers with the two calling files, the line of each import and call, and a caveat: the subagent said it searched `build/` and `dist/`, which its own search, which honours `.gitignore`, did not cover.

## Result

No file changed.

Every check passed: yes. Cost $0.0059 for 3 model calls on qwen3.8-flash, 25 s from the prompt to the last event. The subagent took 13 s and $0.0017 of that.

The full run, with the subagent's log and screenshots of its row: [results/real-usecases/runs/B07-subagent-row/2](../results/real-usecases/runs/B07-subagent-row/2/). The gallery shows it as **Real sessions › B07**.
