# U9b: the Ask and Auto picker in the chat

The composer's approval line is now a picker. It switches the open chat between Ask and Auto, the modes U9a added to the engine (`docs/u9-brief.md`).

## In the panel

- **Picker.** The composer shows "Ask before risky commands" or "Auto". Clicking it opens a menu of the modes the engine advertises through ACP session modes (`availableModes` on `session/new`, `session/load` and `session/resume`), each with the engine's description. Arrow keys move through it. Enter or a click chooses, and Escape closes it and returns the focus to the picker. Choosing sends `session/set_mode`. The picker changes when the engine confirms with `current_mode_update`, so it never shows a mode the engine is not in.
- **Marker.** While Auto is on, the picker is an amber pill with a bolt, and the composer carries `data-mode="auto"`. The amber is the status color the panel already uses for a turn waiting on the user. In high contrast the pill also gets the theme's contrast border.
- **Default.** `gcode.approvalMode` (`ask` or `auto`, default `ask`) sets the mode new chats start in. A window's first chat takes a mode picked before it exists, too. A chat loaded from the history keeps the mode its log recorded.
- **Badges.** A bash step whose command the classifier settled shows a badge under the step, visible while the step is folded. "Auto-approved" in green carries the classifier's reason, and "Auto-denied" in red carries its denial reason. They come from `_meta["gcode/approval"]` on the call's closing `tool_call_update`, when `decidedBy` is `classifier`. A command the user decided gets no badge. When the classifier asks instead, the permission card adds "Auto could not decide:" and its reason, taken from the question the engine sends. A loaded session replays the approval records, so its badges come back too.

The classifier's model stays an engine setting (`GCODE_CLASSIFIER_MODEL`, `off` to turn it off). The extension adds no setting for it.

## Check

`packages/extension/test/modes.integration.test.ts` drives the real panel. The workspace sets `gcode.approvalMode` to `auto`, so the chat starts in Auto. The fake model then runs three gray commands, and the fake classifier allows, denies and asks about them. The test checks each badge, the classifier's reason on the question, the menu's keyboard handling, and the switch to Ask. After the switch, Ask asks about `rm -rf` without calling the classifier.

## Media

All in `docs/media/u9b/`, as Dark Modern glass (`-dark`), Light Modern glass (`-light`) and Dark High Contrast (`-high-contrast`, native).

- `auto-*.png`: a finished Auto turn with an auto-approved and an auto-denied step, a question the classifier left to the user, and the Auto pill.
- `menu-*.png`: the mode menu open on Auto.
- `ask-*.png`: after switching to Ask, the same kind of command waits on Allow or Deny.

`GCODE_SCREENSHOTS=<dir> pnpm vitest run packages/extension/test/modes.integration.test.ts` reruns the test and retakes every capture.
