# Eval tasks

An eval task is one request you would give the agent, plus a command that decides whether the agent did it. The engine runs each task in a throwaway clone, so the source repo is never touched.

## Files

- `$GCODE_HOME/evals/tasks/<id>.json` holds one `EvalTask` (`packages/core/src/types.ts`).
- `$GCODE_HOME/evals/tasks/<id>/` holds files the task needs that the agent must not see. That means hidden checks, and `reference.patch`, which is a known-good solution.

## How a task runs

1. Clone `repo` into a temp directory and check out `baseCommit`.
2. Run `setup` in the clone, for example `npm ci` or `bun install --frozen-lockfile`.
3. Give `prompt` to the agent with the clone as its workspace.
4. Run `verify` in the clone with `GCODE_TASK_DIR` set to the task's sibling directory. Exit 0 means pass.

`verify` usually copies a hidden check into the clone and runs it, for example `cp "$GCODE_TASK_DIR/check.test.ts" src/__eval__.test.ts && npx vitest run src/__eval__.test.ts`.

## What makes a task valid

- `verify` exits non-zero at `baseCommit` after `setup`.
- `verify` exits 0 after `git apply "$GCODE_TASK_DIR/reference.patch"`.
- `verify` runs offline, without a database or secrets, in under two minutes once `setup` has run.
- `verify` checks behavior, not one exact spelling of the code. A correct solution that differs from the reference patch must pass.
- `prompt` reads like a request a developer would type. It never names the hidden check, and it never pastes the reference solution.
