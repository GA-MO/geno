# Phase 4 brief: checkpoints, sandboxed bash, check command, eval runner

Read `research/synthesis.md` sections 5 (Checkpoint, agent task flow) and 6 (Phase 0 E0, Phase 4), 8 (E0, E5, E6, E14), then `docs/eval-tasks.md`, the Phase 2 loop and the Phase 3 applier. This phase turns `gcode ask` into a full CLI agent and runs the baseline comparison: Claude Code against our engine, both on `qwen3.8-flash`, over the 20 tasks.

## Outcome

`gcode agent` edits code, runs commands in a sandbox, checks its work, and can rewind. `gcode eval run` runs either our agent or Claude Code on every task in a fresh clone, verifies, and records pass rate, turns, tokens, cost and wall time.

## Agent tools

- The read-only tools from Phase 2, plus `edit` in the format `docs/e3-results.md` names as best for `qwen3.8-flash` (read that file; if it is missing, use `str_replace`).
- `bash`: runs a command with cwd at the workspace through `@anthropic-ai/sandbox-runtime` (`srt`). Read its README and type definitions in `node_modules` before writing the config. Policy: writes only inside the workspace and a temp dir; reads denied for `~/.g-code/evals`, `~/.ssh`, the g-code repo's `.env`, and every task's source repo path; network denied. Output over the spill limit spills like other tools. Timeout per command, default 120 s.
- Deny-to-approve list as a table of patterns: `rm -rf` outside temp, `git push`, `git reset --hard`, paths outside the workspace, `curl`/`wget`, cloud and database CLIs. Interactive mode asks y/n on the terminal. Non-interactive mode (eval) denies and returns a `denied` tool result. Count denials.
- `check`: runs the workspace's check command (from `--check "<cmd>"`, else `.gcode.json` `check` field, else none) in the same sandbox and returns pass/fail and the tail of output. After every successful edit the engine runs it automatically when `--check-after-edit` is on (default on) and appends the result to the edit's tool result.
- Child processes (bash, check, eval setup and verify) get a minimal environment: `PATH`, `HOME`, `LANG`, `TERM`, `TMPDIR` and nothing else. No API keys reach them. Test this.

## Checkpoints

- A shadow git directory per workspace at `$GCODE_HOME/checkpoints/<hash of workspace path>/`, used as `GIT_DIR` with `GIT_WORK_TREE` set to the workspace. Respect the workspace's `.gitignore`; never touch the workspace's own `.git`.
- A checkpoint is taken before every model turn that can edit. The `Checkpoint` record (session id, turn seq, commit sha, files touched since the previous checkpoint, label) is appended to the session log as a `checkpoint` event.
- `gcode rewind --session <id> --to <seq>` checks those files out of the shadow repo, keeps the conversation, and appends a `restored` event. Idempotent: running it twice leaves the same state.

## Agent command

`gcode agent [--session] [--workspace] [--max-turns 40] [--max-cost 0.40] [--check "<cmd>"] [--no-check-after-edit] [--non-interactive] <task...>`, built on the Phase 2 loop. Its system prompt extends the base prompt with editing and checking guidance.

## Eval runner

- `gcode eval run --agent gcode|claude-code [--task <id> | --all] [--model qwen3.8-flash] [--max-cost-per-task 0.40] [--max-cost 3] [--runs-dir]`.
- Per task: `cloneAt` the base commit into a temp dir, run `setup` with the minimal env, run the agent with the task prompt and the clone as workspace, then reset nothing and run `verify` with `GCODE_TASK_DIR`. Record pass or fail, turns, input, cache read, cache write and output tokens, estimated cost, wall time, denials, and the agent's final message to `$GCODE_HOME/evals/runs/<run-id>/results.jsonl`, plus a summary table on stdout. Stop the run when its estimated cost passes `--max-cost`.
- `claude-code` adapter: run `claude -p "<prompt>" --output-format json` with cwd at the clone, inside the same `srt` sandbox except that network allows only the Model Studio host. Point it at Model Studio with `ANTHROPIC_BASE_URL` from `DASHSCOPE_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` from `DASHSCOPE_API_KEY`, `ANTHROPIC_API_KEY` empty, and the model variables Claude Code reads set to the chosen model (check `claude --help` and Claude Code's settings docs for the exact names; do not guess). Give it a throwaway `CLAUDE_CONFIG_DIR` in the temp dir so it never reads or writes the user's own Claude Code settings, history or credentials. Use its JSON output for turns, usage and cost when present, and recompute cost from our price table.
- The two adapters sit in a `Record<AgentName, AgentAdapter>`.

## Done-check

1. `pnpm typecheck && pnpm test && pnpm build` pass.
2. Rewind: a scripted run on a temp repo edits two files across two turns, rewinds to before the first, and the files match their original sha256. The test prints the hashes.
3. Sandbox: tests show a write outside the workspace fails, a read of the task source repo fails, network fails, and `env` inside bash shows no API key.
4. E0 and E5: `gcode eval run --agent claude-code --all` then `gcode eval run --agent gcode --all`, both on `qwen3.8-flash`, each capped at an estimated $3. Write `docs/e0-e5-results.md` with one table per agent (task, pass, turns, tokens, cost, wall time, denials), the pass rates side by side, total cost, and every failure's cause in one line from its transcript. Every number comes from a named results file.
5. E14, only if E0 plus E5 together cost under $4: rerun our agent with `--no-check-after-edit` and report the pass-rate difference. Otherwise write that it was skipped for budget.

## Tests that must exist

- Checkpoint and rewind on a temp workspace, including untracked new files and the workspace's own `.git` left untouched.
- The deny list table: each pattern denied in non-interactive mode, an ordinary `npx vitest run` allowed.
- Minimal environment: a fake key in the parent env does not appear in the child.
- Eval runner end to end with a stub agent adapter that applies the reference patch, on the `check-task` fixture repo: the run records a pass and the summary prints it.

## Rules

- Allowed new dependency: `@anthropic-ai/sandbox-runtime`.
- The `.env` with the user's key is git-ignored and missing from your worktree. Symlink it at your worktree root (`ln -s /Users/me/Development/g-code/.env .env`), never print or commit it, and delete the symlink before reporting.
- Never modify the source repos under `~/Development` or the user's `~/.claude`.
- Small ordered commits. Each ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Report the branch, worktree path, `git log --oneline`, the literal done-check output, total estimated spend, and anything you interpreted.
