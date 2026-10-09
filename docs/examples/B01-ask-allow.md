# B01-ask-allow, run 1

**Task.** Delete a folder with `rm -rf` in Ask mode, where the user approves the command on a card in the VS Code panel.

**Prompt**, as the user typed it:

> Delete the build folder with rm -rf build, then confirm it is gone.

**Mode.** Ask, in the VS Code panel: Geno asks before a risky command.

## What Geno did

1. Runs `ls -la . && du -sh dist build; git status --short` to see the folder before touching it.
2. "The `build` folder exists. Let me check what's in it before deleting, in case it holds anything not recoverable." Lists the files in `build/`, checks which of them git tracks, and reads `.gitignore`.
3. Runs `rm -rf build && ls -d build`. The panel shows a card, "Run this command?", for `rm -rf build`, with Allow, Deny, Always allow in this workspace, and No, and tell the agent. The user clicks Allow, and the command runs.
4. Runs `git status --short; ls` to confirm.
5. Answers that the folder is gone, and points out that `build/bundle.js` was tracked in git, so git now shows it as deleted, with the command that brings it back.

## Result

`build/` and its one file are deleted. Nothing else changed. The panel run keeps one diff for all its steps, in `runs/B-panel/1/`.

Every check passed: yes. Cost $0.0069 for 5 model calls on qwen3.8-flash, 18 s from the prompt to the last event, the time on the card included.

The full run, with the session log, the transcript, and screenshots of the card: [results/real-usecases/runs/B01-ask-allow/1](../results/real-usecases/runs/B01-ask-allow/1/). `packages/engine/test/real-runs.e2e.test.ts` replays it with the question answered yes, and the gallery shows the card as **Real sessions › B01**.
