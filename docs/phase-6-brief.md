# Phase 6 brief: review UX and Cmd-K

Read `research/synthesis.md` sections 5 (Proposed change, Checkpoint, chat-edit flow) and 6 (Phase 6, E7), then the Phase 3 `ProposedChange` and hunks, the Phase 4 checkpoints, and the Phase 5 extension and protocol.

## Outcome

After the agent edits files, each changed hunk shows in the editor with Keep and Undo controls, a changed-files view lists every touched file, any file opens in a diff against its checkpoint, and Cmd-K on a selection runs an inline edit through the same applier.

## Behavior

- Edits are on disk (or in the buffer) as soon as they apply; review is after the fact, as in Cursor's agent mode.
- Per hunk: a background decoration on the new lines, a gutter marker for removed lines, and CodeLens `Keep` and `Undo` above the hunk. Undo restores that hunk's old text through a `WorkspaceEdit` and marks it `undone`; Keep marks it `kept`. Hunk status changes are appended to the session log so a reload restores the review state.
- Line ranges shift when the user edits around a hunk. Track hunks with decorations' tracked ranges, not stored line numbers.
- A changed-files tree view: file, hunk counts by status, `Keep all` and `Undo all` per file, and `Undo all` for the session, which restores the session's first checkpoint through the Phase 4 rewind.
- `Open diff` uses `vscode.diff` between the checkpoint's content (served by a `TextDocumentContentProvider` on a `gcode-checkpoint:` scheme) and the current file.
- Cmd-K (`gcode.inlineEdit`, keybinding `cmd+k cmd+i` to avoid clobbering the built-in chord prefix): an input box for the instruction, then a one-shot edit of the selection through the engine with the selection, its file and current diagnostics as context. The result lands as hunks with the same review controls.

## Done-check

1. `pnpm typecheck && pnpm test && pnpm build` pass.
2. Integration test under `@vscode/test-electron` with a fake model transport: an agent turn edits two hunks in one file and one hunk in another; the test keeps one hunk, undoes another, edits a line above a pending hunk and confirms the hunk's controls moved with it, then asserts every file on disk matches the expected bytes. Then `Undo all` restores the checkpoint byte for byte.
3. Cmd-K integration test: select a function, run the command with a fixed instruction against the fake transport, the edit lands as reviewable hunks.
4. Screenshots of the review UI from the integration run (VS Code's window capture or `@vscode/test-electron` plus a screenshot step) saved under `docs/media/phase-6/`, at least: hunks with CodeLens, the changed-files view, the diff view.
5. E7 cannot be settled without use; write `docs/e7.md` listing the review surfaces built and what to watch for during use.

## Rules

- No new dependencies without a reason in the report.
- Small ordered commits. Each ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Report the branch, worktree path, `git log --oneline`, the literal done-check output, the screenshot paths, and anything you interpreted.
