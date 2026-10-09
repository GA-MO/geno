# A06-read-not-cat, run 1

**Task.** Answer three questions about a repository with Geno's file tools instead of shell commands.

**Prompt**, as the user typed it:

> Show me what the package.json scripts are, list the files under src, and tell me which test files exist.

**Mode.** Non-interactive (`gcode agent --non-interactive`): nobody can answer a question, so anything that needs approval is refused.

## What Geno did

1. "I'll look at package.json, the src tree, and the test files." Calls `read package.json`, `list src` and `glob **/*test*` together, in one turn.
2. Answers from the three results: one script, `test`, which runs `node --test`; five TypeScript modules under `src/`; three test files under `test/`.

No `cat`, `ls` or `find` went through the shell.

## Result

No file changed.

Every check passed: yes. Cost $0.0030 for 2 model calls on qwen3.8-flash, 7 s from the prompt to the last event.

The full run, with the session log, the transcript and every check: [results/real-usecases/runs/A06-read-not-cat/1](../results/real-usecases/runs/A06-read-not-cat/1/). `packages/engine/test/real-runs.e2e.test.ts` replays it.
