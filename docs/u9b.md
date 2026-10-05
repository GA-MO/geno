# U9b: the Plan, Ask and Auto picker in the chat

The composer's approval line is now a picker. It switches the open chat between Ask and Auto, the modes U9a added to the engine (`docs/u9-brief.md`), and Plan, a read-only mode borrowed from OpenCode.

## Plan

- **What it allows.** In Plan the agent reads but changes nothing. It gets `read`, `grep`, `glob`, `list`, `check` and `bash`, and no `edit`. Plan is a column in the rules (`packages/core/src/approval.ts`) that denies every rule, the unlisted one included. So bash runs exactly what the safe list runs, and anything else is denied with "Plan mode is read-only; switch to Ask or Auto to make changes", never asked or classified. The safe list includes `mkdir -p`, which Plan therefore runs. MCP tools are offered too, and their rules have a plan column: a tool its server marks `readOnlyHint` runs, and every other one is denied with the same reason, even one the user allowed for the session in Ask.
- **Prompt and tools.** A fixed addition to the system prompt says the session is in Plan and asks for a numbered plan, the files it would change, and the risks. Each mode's tool list and prompt are built once (`AGENT_MODE_TOOL_DEFINITIONS`, `AGENT_MODE_SYSTEM_PROMPTS` in `packages/core/src/agent.ts`), so each mode's cached prefix stays byte-stable. A run offers the tools of the mode it starts in. A tool the current mode leaves out is refused when called, which covers a switch to Plan in the middle of a turn.
- **Protocol.** `gcode serve` advertises `plan` ("Plan") first in `availableModes`. `session/set_mode` switches to it, and the existing `mode` event logs it, so resume and load keep it. `session/load` replays the mode each turn ran in under `_meta["gcode/turn"].mode`. `gcode agent --mode plan` works in the CLI. The default stays Ask.
- **In the panel.** The picker lists Plan, Ask and Auto, in that order. A turn that ran in Plan carries a quiet "Plan" chip beside its status. While the session is still in Plan, the last finished Plan turn offers a white primary **Start building** button. It switches the session to Ask, or to Auto when `gcode.approvalMode` is `auto`, and sends "Go ahead with the plan."

## In the panel

- **Picker.** The composer shows "Plan", "Ask before risky commands" or "Auto". Clicking it opens a menu of the modes the engine advertises through ACP session modes (`availableModes` on `session/new`, `session/load` and `session/resume`), each with the engine's description. Arrow keys move through it. Enter or a click chooses, and Escape closes it and returns the focus to the picker. Choosing sends `session/set_mode`. The picker changes once the engine has answered `session/set_mode` or sent `current_mode_update`, so it never shows a mode the engine is not in.
- **Marker.** While Auto is on, the picker is an amber pill with a bolt, and the composer carries `data-mode="auto"`. The amber is the status color the panel already uses for a turn waiting on the user. In high contrast the pill also gets the theme's contrast border.
- **Default.** `gcode.approvalMode` (`ask` or `auto`, default `ask`) sets the mode new chats start in. A window's first chat takes a mode picked before it exists, too. A chat loaded from the history keeps the mode its log recorded.
- **Badges.** A bash step whose command the classifier settled shows a badge under the step, visible while the step is folded. "Auto-approved" in green carries the classifier's reason, and "Auto-denied" in red carries its denial reason. They come from `_meta["gcode/approval"]` on the call's closing `tool_call_update`, when `decidedBy` is `classifier`. A command the user decided gets no badge. When the classifier asks instead, the permission card adds "Auto could not decide:" and its reason, taken from the question the engine sends. A loaded session replays the approval records, so its badges come back too.

The classifier's model stays an engine setting (`GCODE_CLASSIFIER_MODEL`, `off` to turn it off). The extension adds no setting for it.

## Check

`packages/extension/test/modes.integration.test.ts` drives the real panel. The workspace sets `gcode.approvalMode` to `auto`, so the chat starts in Auto. The fake model then runs three gray commands, and the fake classifier allows, denies and asks about them. The test checks each badge, the classifier's reason on the question, the menu's order and keyboard handling, and the switch to Ask. After the switch, Ask asks about `rm -rf` without calling the classifier. It then switches to Plan, checks that the model is offered no `edit`, and clicks Start building, which switches to Auto (this workspace's default) and sends the follow-up with `edit` offered again. Engine tests cover the mode by rule table with its plan column, a `gcode agent --mode plan` run that is offered no edit and has a write command and an edit denied, and `session/set_mode` to `plan` over ACP.

## Media

All in `docs/media/u9b/`, as Dark Modern glass (`-dark`), Light Modern glass (`-light`) and Dark High Contrast (`-high-contrast`, native).

- `auto-*.png`: a finished Auto turn with an auto-approved and an auto-denied step, a question the classifier left to the user, and the Auto pill.
- `menu-*.png`: the mode menu open on Auto.
- `ask-*.png`: after switching to Ask, the same kind of command waits on Allow or Deny.
- `plan-*.png`: a finished Plan turn with its chip, its plan and Start building, and the picker on Plan.

`GCODE_SCREENSHOTS=<dir> pnpm vitest run packages/extension/test/modes.integration.test.ts` reruns the test and retakes every capture.
