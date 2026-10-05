# U17 brief: a quiet chat

The user finds the chat tiring to read: every step is spread out. A real turn has 20 to 40 steps, so the transcript becomes a long column of narration lines, reads, searches, raw tool arguments, timings and a cost line. Show what the user needs and fold the rest behind one click.

## What stays visible

- The user's message.
- The final answer: the assistant text after the last tool call, with its code blocks, diagrams and images.
- The files the turn changed, as one row of chips with `+n −m`. Each chip opens the diff, as today.
- Anything that needs the user: a pending approval card, a pending remember or ask_user card (from U13), and an error that ended the turn.

## What folds

- A finished turn's work folds into one summary line under the header, for example "Read 8 files · searched 3 times · edited 3 files · ran 4 commands · 1 failed". Clicking the line expands the full trail as it is today. The counts come from a pure function over the turn's steps, in a table keyed by tool kind, so a new tool kind adds a row and nothing else.
- While a turn runs, the rail shows the current step and the last three. Older steps of the running turn fold into "+12 earlier steps", which expands on click. The narration line shown is only the latest one.
- Tool arguments such as MCP JSON, per-step timings, and the model, token and cost line appear only in the expanded view. The cost also shows as the tooltip of "worked for".
- An auto-approved step's badge shows only in the expanded view. A denied or failed step counts in the summary and shows in full when expanded.

## Rules

- **Setting.** A `gcode.chat.detail` setting with `compact` (the default) and `full`. `full` is today's view.
- **State.** Expand and collapse is per turn and lives in the webview. Loaded sessions from history render compact too.
- **Scrolling.** Expanding a turn must not jump the scroll position of what the user is reading.
- **Data shape first.** Name the turn's view model: user message, folded steps, summary counts, final answer blocks, changed files, attention items. Name the rule that picks the final answer, and the case of a turn with no text after its last tool.
- **Style.** The glass of `docs/u7.md`. The summary line is quiet secondary text with a chevron, not a new color. High contrast stays native.
- **Coexist.** U13 is adding cards (remember, ask_user) and panes at the same time. Decide visibility through a generic "needs the user" attention rule, so U13's cards stay visible without naming them. Rebase onto main before final checks and resolve conflicts by keeping both sides.

## Check

- Unit tests for the summary counts and the final-answer rule, including a turn with no text after its last tool and a turn that ended in an error.
- Integration tests in VS Code:
  - a 20-step fake turn renders folded, with the right summary line;
  - clicking the line expands the full trail, and clicking again folds it;
  - a pending approval card stays visible while the turn is folded;
  - a running turn shows only its last four steps;
  - `gcode.chat.detail: full` shows today's view.
- CDP screenshots in dark glass, light glass and high contrast in `docs/media/u17/`, each viewed:
  - before and after for the same long turn;
  - a running turn;
  - an expanded turn.
- `pnpm typecheck && pnpm test && pnpm build`, and the `.vsix` clean-install test, also with `GCODE_VSCODE_VERSION=1.109.2`.
