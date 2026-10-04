# Phase 0 brief: workspace scaffold and eval seed

Read `research/synthesis.md` sections 5 and 6 first. This brief builds Phase 0 only.

## Outcome

A pnpm workspace with three packages, an eval store, a triple miner, and a replay command. Every later phase plugs into these.

## Layout

- `package.json` (private, `packageManager: pnpm@11`), `pnpm-workspace.yaml`, `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ES2023, NodeNext).
- `packages/core`. Pure library. No I/O. Types plus pure functions (diffing, triple selection rules). Later phases add the prompt builders here.
- `packages/engine`. Node CLI, binary name `gcode`. Owns all filesystem and git I/O. Depends on core.
- `packages/extension`. VS Code extension stub. `engines.vscode` `^1.95.0`, one command `gcode.hello` that shows an info message. Bundled with esbuild to `dist/extension.js`. No engine wiring yet.
- Tests with vitest. One root `pnpm test`, `pnpm typecheck`, `pnpm build`.
- Run TypeScript directly with `tsx` for the CLI during development (`pnpm gcode ...` root script).

## Data shapes (packages/core)

Brand ids. Parse every JSON file at the boundary with zod (engine side), and trust the types inside.

- `EvalTask`. `id: TaskId`, `repo: string` (absolute path), `baseCommit: string`, `prompt: string`, `verify: string` (shell command run in the repo).
- `ApplyTriple`. `id: TripleId`, `repo`, `commit` (the commit that made the change), `path` (repo-relative), `instruction` (commit subject plus body), `before` (file text at the parent), `expected` (file text at the commit).
- `Applier`. `{ name: ApplierName; apply(input: { path; before; instruction }): Promise<ApplyOutcome> }`.
- `ApplyOutcome`. Discriminated union. `{ kind: 'applied'; after: string }` or `{ kind: 'failed'; reason: ApplyFailure; detail: string }`. `ApplyFailure` is `'zero-matches' | 'multiple-matches' | 'stale-base' | 'parse-error' | 'model-error'` (synthesis section 5, "Proposed change").
- `ReplayResult`. `tripleId`, `applier`, `outcome`, `exactMatch: boolean`, `diff: string` (unified diff of result against expected, empty on exact match or on failure).
- Applier registry. A `Record<ApplierName, Applier>` table, not a switch. Phase 0 ships two baseline appliers. `noop` returns `before` unchanged (the floor). `oracle` returns `expected` (proves the harness reports exact matches). Phase 3 adds real ones to the same table.

## Storage

App home is `$GCODE_HOME`, default `~/.g-code`. Evals live in `$GCODE_HOME/evals/`, outside the repo, because triples copy code from the user's other repos.

- `evals/tasks/<id>.json`, one `EvalTask` each, hand-written by the user.
- `evals/apply/<id>.json`, one `ApplyTriple` each, written by the miner.

## CLI (packages/engine)

- `gcode eval list`. Prints tasks then triples, one line each: id, repo basename, and the first 60 chars of the prompt or instruction. Prints the counts. Exit 0 with empty store, and say the store path.
- `gcode eval mine --repo <path> [--limit 50] [--max-lines 40]`. Walks `git log --no-merges` newest first. Keeps a commit only when it changes exactly one text file (skip binary, lockfiles, generated or minified files, files over 2000 lines), the diff touches at most `--max-lines` changed lines, the file exists at both parent and commit, and the subject is at least 3 words. Writes one triple per kept commit. Triple id is `<repo-basename>-<short-sha>`, so a rerun overwrites the same files (idempotent). Prints how many commits it scanned, kept, and skipped by reason. Put the keep/skip rules in core as a pure function over parsed commit facts so they are unit-testable.
- `gcode eval replay <triple-id> [--applier noop|oracle]`. Runs one triple through the named applier, prints the `ReplayResult` summary and the diff. Exit 0 on exact match, 1 otherwise.
- `gcode eval apply [--applier name]`. Replays every triple and prints exact-match rate and failure rate. Phase 3 extends this; keep it minimal.
- Unknown command or bad flags print usage and exit 2. Use `node:util` `parseArgs`, no CLI framework.

## Tests that must exist

- Miner rules. A commit touching two files is skipped with reason `multi-file`. A lockfile change is skipped. A 41-line diff is skipped at `--max-lines 40`. A clean one-file commit is kept.
- Miner end to end. Build a throwaway git repo in a temp dir with three commits (one keepable, one two-file, one lockfile), run the mine command against it with `GCODE_HOME` pointed at another temp dir, and assert exactly one triple file exists with the right before and expected text. Run it twice and assert the file count is still one.
- Replay. `oracle` gives `exactMatch: true` and an empty diff. `noop` on a triple whose before differs from expected gives `exactMatch: false` and a non-empty diff.
- Store parsing. A malformed task JSON produces an error naming the file path.

## Done-check (the coordinator reruns these)

1. `pnpm install && pnpm typecheck && pnpm test && pnpm build` all pass.
2. `GCODE_HOME=$(mktemp -d) pnpm gcode eval list` prints an empty store message and exits 0.
3. `pnpm gcode eval mine --repo <this repo or any local repo>` writes triples, and `pnpm gcode eval replay <one id> --applier oracle` exits 0 while `--applier noop` exits 1 with a diff.
4. `packages/extension/dist/extension.js` exists after build.

## Rules

- Comments only for a non-obvious why. No phase-narrating comments.
- No dependency beyond: typescript, tsx, vitest, zod, esbuild, @types/node, @types/vscode, and `diff` (or `jsdiff`) for unified diffs.
- Commit in small ordered units on your branch: workspace scaffold, core types, store and list, miner, replay, extension stub. End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Report back with the branch name, the commit list, and the literal output of each done-check command.
