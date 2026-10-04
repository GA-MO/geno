# Phase 5 brief: extension chat panel over the engine

Read `research/synthesis.md` sections 5 (components, buffer bridge, diagnostics bridge) and 6 (Phase 5), E12 and E13 in section 8, then the engine's agent loop (Phases 2 and 4) and the extension's existing code and integration test setup from Phase 7. This phase settles E12 (own JSON-RPC or ACP) and E13 (buffer and disk conflicts).

## Outcome

In VS Code, a chat panel talks to the engine running as a child process. Asking for a change to a file with unsaved edits makes the engine edit the unsaved buffer content, not the stale disk copy.

## Protocol (E12)

- Prefer the Agent Client Protocol (ACP). Find its official TypeScript SDK on npm (published by the protocol's maintainers; check the package's repository field), read its types, and use them on both sides. ACP's client-side file system methods (`fs/read_text_file`, `fs/write_text_file`) are the buffer bridge: the extension answers reads with the open document's current text, unsaved edits included. ACP's permission request is the approval prompt for denied commands. Diagnostics have no ACP method; add one extension method under ACP's extension-method convention.
- Fall back to a small JSON-RPC protocol of our own only if ACP cannot carry a flow this phase needs. Either way, write `docs/e12.md`: the decision, the flows mapped to protocol messages, and anything ACP could not express.
- The engine gets `gcode serve --stdio`. Sessions, tools, checkpoints and the log are the same code paths as `gcode agent`; the protocol layer is an adapter over them, not a second loop.

## Extension

- Spawns `node <engine dist>/cli.js serve --stdio` (path from a setting, defaulting to the engine bundled next to the extension in this repo), restarts it if it exits, and shows its stderr in an output channel.
- Chat panel as a webview view: message list, streamed assistant text, tool calls as one-line items, a stop button (cancels the turn), and approval prompts for denied commands. Keep the webview a small, plain module; no UI framework.
- Buffer bridge per above. Writes from the engine go through `WorkspaceEdit` when the document is open, so undo works in the editor, and to disk otherwise.
- Diagnostics bridge: returns `vscode.languages.getDiagnostics` for the requested files.
- E13 rule: when the engine asks to write a file whose open buffer changed since the engine read it, the write fails as `stale-base` (the Phase 3 failure) and the model is told to re-read.

## Done-check

1. `pnpm typecheck && pnpm test && pnpm build` pass.
2. An integration test under `@vscode/test-electron` (the Phase 7 setup) opens a fixture workspace, types unsaved text into a file, starts a chat turn through the extension's command with the engine using a fake model transport that requests a read and then an edit, and asserts: the engine's read saw the unsaved text, the edit landed in the buffer, the disk copy was untouched until save, and a concurrent buffer change between read and write produced `stale-base`.
3. A live smoke run against Model Studio `qwen3.8-flash` (estimated cost under $0.10): the same flow with the real model, reported with the session log path.
4. `docs/e12.md` exists.

## Rules

- New dependencies allowed: the official ACP TypeScript SDK. Anything else needs a reason in the report.
- The `.env` with the user's key is git-ignored and missing from your worktree. Symlink it at your worktree root (`ln -s /Users/me/Development/g-code/.env .env`), never print or commit it, and delete the symlink before reporting.
- Small ordered commits. Each ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Report the branch, worktree path, `git log --oneline`, the literal done-check output, and anything you interpreted.
