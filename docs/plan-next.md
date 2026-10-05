# Next: from working phases to a daily driver

Phases 0 to 8 work inside test harnesses. This plan makes g-code something the user runs every day in their own VS Code, then makes it look and feel first-party. Each unit ends in a check a reviewer can rerun.

## Order

1. U1 and U3 in parallel. They touch disjoint files.
2. U4 after U1 merges, because it styles the panel U1 ships.
3. U5 after U4, because @-mentions live in the polished input.

A sandbox for eval `verify` is already running as a separate task. It touches `eval-run.ts`, `check-task.ts` and `sandbox.ts`; no unit below edits those files.

## U1. Install as a daily driver

The user installs one `.vsix` and uses chat, review and Tab without the repo checked out or a terminal open.

- Bundle the engine inside the extension (`dist/engine/cli.js`) and spawn it with VS Code's own runtime (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`), so no `node` on `PATH` is needed and launching VS Code from the Dock works.
- Keys move to VS Code SecretStorage. A `g-code: Set API Key` command stores the Model Studio key; settings hold the provider, base URL and model. The extension passes them to the engine in the child environment. The CLI keeps reading `.env`.
- Tab's model server starts with the extension when Tab is enabled and the model file exists, found at `/opt/homebrew/bin/llama-server`, `/usr/local/bin/llama-server` or `PATH`, and stops on deactivate. A status bar item shows Tab as on, starting, off or failed, and clicking it toggles Tab.
- `pnpm package` builds `g-code-<version>.vsix` with `@vscode/vsce`. Version 0.1.0.
- Check: a test launches a clean VS Code with an empty extensions dir, installs the `.vsix` from the command line, sets the key through the command, and runs one chat turn and one Tab completion against fake servers. A live smoke on `qwen3.8-flash` under $0.02. Then the coordinator installs the `.vsix` into the user's VS Code.

## U3. Ask before deleting inside the workspace in interactive use

The deny list now allows `rm -rf` of paths inside the workspace, which suits throwaway eval clones but not the user's real projects, where gitignored folders such as `node_modules` are not checkpointed. The default chosen for the user: interactive sessions (the chat panel and `gcode agent` without `--non-interactive`) ask before `rm -rf` of anything outside the agent's temp dirs; non-interactive eval runs keep today's behavior. The user can tell us to drop the prompt.

- Check: tests for both modes, the nine eval false positives still allowed in non-interactive mode, and the same commands asking in interactive mode.

## U4. A first-party-looking chat panel

"Looks expensive" in VS Code means indistinguishable from a built-in panel in every theme, with motion and density that feel deliberate.

- Markdown rendering with syntax-highlighted code blocks and a copy button.
- Smooth streaming text with a caret.
- Tool calls as compact collapsible rows with a codicon, the target, status and duration; long output folds.
- Edits as diff cards inside the transcript with Keep and Undo that drive the same review state as the editor CodeLens.
- A per-turn footer with model, tokens and cost, and a running session total.
- An empty state with three example prompts, and a composer that grows with its text, sends on Enter and adds a newline on Shift+Enter, with a Stop button while a turn runs.
- VS Code theme variables and `@vscode/codicons` only; no colors of our own.
- Check: CDP screenshots in Dark Modern, Light Modern and a high-contrast theme, reviewed by the coordinator; click tests that press Send, Stop, Allow, Keep and Undo in the real panel, closing the Phase 5 gap that no test clicked the panel.

## U5. Context the user expects

- Load project rules from `AGENTS.md`, `CLAUDE.md` and `.cursor/rules/*.mdc` (globs honored) into the system prompt, cached and marked untrusted per synthesis section 5.
- `@file` and `@selection` mentions in the composer with completion.
- `grep` and `glob` also search unsaved buffers through the bridge, closing the Phase 5 gap.
- Check: an eval run on the 20 tasks shows no pass-rate drop, and integration tests cover each mention kind.

## Later, only if wanted

MCP client, Zed as a second client over ACP, worktrees for parallel tasks, context compaction tuning.
