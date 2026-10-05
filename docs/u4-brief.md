# U4 brief: a first-party-looking chat panel

Read `docs/plan-next.md` (U4), `docs/e7.md`, `docs/e12.md` and `docs/install.md`, then the panel: `packages/extension/src/chat/` (`chat.ts`, `messages.ts`, `webview.ts`), the review code in `packages/extension/src/review/`, and the integration test launcher and suites in `packages/extension/test/`. The panel today is a plain script with a textarea and two buttons; see `docs/media/phase-6/hunks.png`.

## The bar

"Looks expensive" in VS Code means a user cannot tell the panel from one Microsoft ships, in any theme, and every interaction feels deliberate. No colors, fonts or radii of our own: only VS Code's CSS variables (`--vscode-*`), its font settings, and `@vscode/codicons`. Density, spacing and motion follow VS Code's own chat and SCM views.

## Data shape first

The webview renders from one transcript model: a list of turns, each with the user message, assistant blocks (text, tool call, edit card), status (streaming, done, stopped, failed) and usage. Messages from the extension are reducer actions on that model, and the DOM is a pure render of it, so a reload or a late message never leaves the view out of sync. Name this shape in core or in the extension's shared `messages.ts` before writing UI code.

## Features

- Markdown rendering for assistant text, safe by construction (no raw HTML from the model), with code blocks highlighted by a small highlighter bundled into the webview and a copy button on hover.
- Streaming text that appends smoothly with a caret while the turn streams.
- Tool calls as one compact row each: codicon by tool kind, target (path, pattern or command), status spinner or check or cross, duration. Click to expand the output, folded by default past a few lines.
- Edits as diff cards in the transcript: file name, added and removed counts, the hunk lines, and Keep and Undo that drive the same review state as the editor CodeLens (one source of truth; a decision in either place updates both).
- A footer per turn with model, tokens in and out, cost, and a session total in the panel header.
- An empty state with the model name and three example prompts that fill the composer when clicked.
- A composer that grows with its text up to a limit, sends on Enter, adds a newline on Shift+Enter, shows Stop while a turn runs, and keeps the draft across panel hides.
- Permission prompts as an inline card with the full command and reason, and Allow and Deny buttons that take keyboard focus.
- Keyboard: focus the composer with the view's focus command, Escape stops a running turn.
- Accessibility: every control reachable by keyboard with a visible focus ring from `--vscode-focusBorder`, ARIA roles for the transcript log and live region for streaming text.

## Verify

1. `pnpm typecheck && pnpm test && pnpm build` pass.
2. Click tests in a real VS Code (the existing launcher, test workspaces with `chat.disableAIFeatures: true` and the hidden secondary sidebar): drive the webview over the Chrome DevTools Protocol (launch with `--remote-debugging-port`, find the webview's frame target) and press Send, Stop, Allow, Deny, Keep and Undo on a diff card, asserting the effect on files and the editor CodeLens state. This closes the Phase 5 gap that no test clicked the panel.
3. CDP screenshots of the same transcript (a user message, streamed markdown with a code block, three tool rows with one expanded, a diff card, a permission card, the usage footer) and of the empty state, in Dark Modern, Light Modern and Dark High Contrast. Save them under `docs/media/u4/` and view every one yourself; fix anything that looks off before reporting.
4. Rebuild the `.vsix` with `pnpm package` and run the clean-install test (`packages/extension/test/install.integration.test.ts`), also with `GCODE_VSCODE_VERSION=1.109.2`, the version the user runs.

## Rules

- Webview dependencies: `@vscode/codicons`, one small markdown parser and one small highlighter, bundled; name each with its size in the report. No UI framework.
- Content Security Policy stays strict: no inline scripts, nonce'd script, no remote resources.
- Do not touch the engine's approval, eval or sandbox files.
- Comments only for a non-obvious why. Small commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Report the branch, worktree path, `git log --oneline`, the literal check output, every screenshot path with one line on what it shows, and anything you interpreted.
