# Hooks

A hook is a command that Geno runs at a session event, such as the start of a session. Geno runs it, not the model, so a hook always runs. Geno reads hooks in Claude Code's format, so a hook you wrote for Claude Code, or one a Claude Code plugin such as pstack installs, runs in Geno unchanged.

This page covers the hook files, the events Geno fires, what a hook receives and what its exit code and output mean, and which hooks run in which workspace. The design and its tests are in [claude-code-parity.md](claude-code-parity.md) (rows B/B-89 to B/B-126) and [conformance.md](conformance.md) (T-HOOK).

## Where Geno reads hooks

Geno reads the `hooks` key of each settings file that [config.md](config.md) lists, and of each installed plugin's `hooks/hooks.json`. Every hook in every file runs. No file overrides another.

| File | Scope |
|---|---|
| `~/.g-code/settings.json` (or `$GCODE_HOME/settings.json`) | You. Geno only. |
| `~/.agents/settings.json` | You. |
| `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) | You. Claude Code reads it too. |
| `hooks/hooks.json` of each installed Claude Code plugin | You, for a plugin installed for your user. The workspace, for a plugin installed for one project. |
| `.g-code/settings.json`, and `.gcode.json` from before it | The workspace. |
| `.agents/settings.json` | The workspace. |
| `.claude/settings.json` in the workspace | The workspace. |
| `.g-code/settings.local.json`, `.agents/settings.local.json` and `.claude/settings.local.json` | The workspace. |

Geno reads the plugins listed in `~/.claude/plugins/installed_plugins.json`. A plugin that `enabledPlugins` turns off (`"name@marketplace": false` in any of the settings files) runs no hooks.

Geno reads a session's hooks once, at the session's first run in the engine process. Restart the engine, or start a new session, after you change a hook file.

The format is Claude Code's:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|compact",
        "hooks": [{ "type": "command", "command": "~/bin/session-context.sh", "timeout": 30 }]
      }
    ]
  }
}
```

Geno runs `command` hooks only. It skips `http`, `mcp_tool`, `prompt` and `agent` hooks, and Settings says so.

## Who runs which hooks

Your own hooks always run. A hook from your files or from a plugin installed for your user runs as you, outside the sandbox, so it can reach the network, for example to send a notice.

A workspace's hooks come from the repository, so anyone who can change the repository can change them. Geno runs them only when both of these are true:

- The session runs in VS Code, and VS Code trusts the workspace (workspace trust).
- The command runs inside Geno's sandbox: it can write only in the workspace and the session's scratchpad, it cannot read your credential folders, and it has no network.

The command line (`gcode agent`) never runs a workspace's hooks. No editor says that you trust the folder.

A hook gets only `PATH`, `HOME`, `LANG`, `TERM` and `TMPDIR` from Geno's environment, plus the variables below. It never gets a provider API key.

## Events

| Event | In Geno | When |
|---|---|---|
| `SessionStart` | Runs | `startup`: the first run of a new session. `resume`: the first run, in this engine process, of a session the model already answered. `compact`: after Geno compacts the context. Geno has no `/clear`, so `clear` never fires. |
| `SessionEnd` | Runs | `reason` is `other`. A `gcode agent` run ends its session when it exits. In VS Code, the engine ends each session it ran when it exits after the last window closes. A stop by a signal ends no session. |
| `UserPromptSubmit` | Runs | Before the model sees a prompt you typed. A hook can block the prompt or add to it ([UserPromptSubmit](#userpromptsubmit)). Geno's own messages, such as a wake-up or a steer during a turn, do not fire it. |
| `PreToolUse` | Runs | Once for every tool call of a model turn, before the first call of the turn runs. A hook can deny, ask about, allow or change a call ([PreToolUse](#pretooluse)). A subagent's calls fire it too. |
| `PermissionRequest` | Runs | When Geno would show you a permission card, or would refuse a call only because nobody can answer, as in a `gcode agent` run. A hook can answer the card for you ([PermissionRequest](#permissionrequest)). A subagent's cards fire it too. |
| `PostToolUse` | Runs | After a call that succeeded, and after Geno's own check of an edit. A hook can add text to the result the model reads ([PostToolUse and PostToolUseFailure](#posttooluse-and-posttoolusefailure)). |
| `PostToolUseFailure` | Runs | After a call that failed, such as a command that exits non-zero. A call that a rule, a hook or the user refused fires neither event. |
| `PostToolBatch` | Runs | Once after all the calls of a model turn have results, before the next model call. A hook can add text after the results, or stop the run ([PostToolBatch](#posttoolbatch)). |
| `Stop` | Runs | When the session's model ends its turn. A hook can keep the turn going, once in a row ([Stop](#stop)). A subagent's end fires `SubagentStop` instead. |
| `SubagentStart` | Runs | When the session starts a subagent, or resumes one with `message_agent`. A hook can add text to the subagent's context ([SubagentStart and SubagentStop](#subagentstart-and-subagentstop)). |
| `SubagentStop` | Runs | When a subagent finishes: it hands back its report, or its model ends its turn. A hook can keep the subagent going, once in a row. |
| `LaneCreated` | Runs | Geno's own event, which Claude Code does not have. After Geno sets up a new lane, before a session runs in it. A hook can, for example, install the lane's dependencies ([LaneCreated](#lanecreated)). |
| Every other Claude Code event, such as `Notification`, `PreCompact` or `WorktreeCreate` | Never | Geno has no trigger for it, or another event covers it. [Events Geno never fires](#events-geno-never-fires) says why for each one. |

An event name that Claude Code does not have, such as `SesionStart`, is a mistake. Claude Code ignores it without a word. Geno ignores it too, and warns in Settings under Hooks and on the command line.

### Matchers

A group's `matcher` picks the events it runs for:

- No matcher, `""` or `"*"` matches everything.
- A plain name, or names joined by `|`, must match exactly: `startup|resume`.
- Any other matcher is a regular expression that must match the whole value: `mcp__.*__write`.

SessionStart matches its source and SessionEnd its reason. SubagentStart and SubagentStop match the agent's name, such as `explore` or `worker`. UserPromptSubmit, PostToolBatch, Stop and LaneCreated have no matcher, so every group runs. The tool events, PermissionRequest among them, match the tool's name. A matcher may name Claude Code's tools: `Bash` matches `bash`, `Read` matches `read`, `Edit`, `Write` and `MultiEdit` match `edit`, `Grep` matches `grep`, `Glob` matches `glob`. The table is `CLAUDE_TOOL_NAMES` in `packages/core/src/hooks.ts`.

## What a hook receives

The hook gets one JSON object on stdin:

```json
{
  "session_id": "c7802610-309e-42f9-9030-608b3a753230",
  "transcript_path": "/Users/me/.g-code/sessions/c7802610-309e-42f9-9030-608b3a753230.jsonl",
  "cwd": "/Users/me/projects/app",
  "permission_mode": "default",
  "hook_event_name": "SessionStart",
  "source": "startup"
}
```

- `transcript_path` is the Geno session log, one JSON event per line. Its events are Geno's, not Claude Code's.
- `permission_mode` is `default` in Ask, `auto` in Auto, `plan` in Plan, and `dontAsk` in a non-interactive run. Unlike Claude Code's `dontAsk`, a non-interactive run fires PermissionRequest, as Claude Code's `-p` does in its default mode.
- SessionEnd has `reason` in place of `source`.
- UserPromptSubmit has `prompt`, the text you sent. Geno sends no `prompt_id`.
- PreToolUse has `tool_name`, `tool_input` and `tool_use_id`. For a call of a subagent it also has `agent_id`, the subagent's session, and `agent_type`, the agent's name. The other tool events have them too.
- PostToolUse adds `tool_response`, the call's result, and `duration_ms`, the time from the call's start to its result. The time leaves out the PreToolUse hooks. Unlike Claude Code's, it includes the time you take to answer a question about the call.
- PostToolUseFailure adds `error`, the result the model reads, and `is_interrupt`, which is always `false`. For a command, `error` starts with `Exit code <n>` and goes on with the output. A call you stop fires no hook. `duration_ms` is there too.
- PostToolBatch has `tool_calls`: every call of the turn that has a result, in call order, each with `tool_name`, `tool_input`, `tool_use_id` and `tool_response`.
- Stop has `stop_hook_active` and `last_assistant_message`, the text of the model's last turn. `stop_hook_active` is `true` when a Stop hook already kept this run going. Geno sends no `background_tasks` or `session_crons`.
- PermissionRequest has `tool_name` and `tool_input`, as PreToolUse has them, without `tool_use_id`. `permission_suggestions`, when the card offers to keep an answer, holds Claude Code's permission update entry: `{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "kubectl get pods"}], "behavior": "allow", "destination": "localSettings"}` for a command's "Always allow in this workspace" pattern, or a `toolName` alone with `"destination": "session"` for an MCP tool. A subagent's card has `agent_id` and `agent_type`. Geno sends no `mcp_server`.
- SubagentStart has `agent_id`, the subagent's own session, and `agent_type`, the agent's name. `session_id` and `transcript_path` stay the parent session's.
- SubagentStop has `agent_id`, `agent_type`, `stop_hook_active`, `agent_transcript_path`, the subagent's own session log, and `last_assistant_message`, the subagent's report, or the text of its last turn when it handed back none.
- LaneCreated has `name`, the lane's name, `worktree_path`, the lane's folder, `branch`, `base_commit`, the commit the lane started from, and `main_checkout`. `cwd` is the lane. A new lane has no session yet, so the payload has no `session_id`, `transcript_path` or `permission_mode`.

A tool event's hook sees Claude Code's tool, so a hook written for Claude Code reads the fields it looks for. The table is `CLAUDE_SHAPES` in `packages/core/src/hooks.ts`:

| Geno call | `tool_name` | `tool_input` |
|---|---|---|
| `bash` | `Bash` | `command`, `description`, `timeout` in milliseconds, `run_in_background` |
| `read` | `Read` | `file_path` (absolute), `offset`, `limit`, `pages` |
| `edit` with `create` | `Write` | `file_path` (absolute), `content` |
| any other `edit` | `Edit` | `file_path` (absolute), `old_string`, `new_string`, `replace_all` |
| another tool with a Claude Code name, such as `grep` | That name, such as `Grep` | Geno's input |
| any other tool, such as an MCP tool | Geno's name | Geno's input |

`tool_response` has Claude Code's shape for these tools, and is the result text the model reads for every other tool:

| `tool_name` | `tool_response` |
|---|---|
| `Bash` | `stdout`, the command's output with stdout and stderr together as they came, then `stderr` (always `""`), `interrupted`, `isImage` and `noOutputExpected` (all `false`) |
| `Write` | `type` (`"create"`), `filePath` and `content` |
| `Edit` | `filePath`, `oldString`, `newString` and `replaceAll` |

The environment has `CLAUDE_PROJECT_DIR`, the workspace. A plugin's hook also has `CLAUDE_PLUGIN_ROOT`, the plugin's folder. `CLAUDE_CONFIG_DIR` is passed on when it is set.

## Exit codes and output

Geno reads a hook's result as Claude Code does:

| Result | Meaning |
|---|---|
| Exit 0, plain stdout | SessionStart and UserPromptSubmit: the model gets the text. Other events: the text is ignored. |
| Exit 0, stdout that starts with `{` | JSON. `hookSpecificOutput.additionalContext` goes to the model, for every event that runs except SessionEnd. `systemMessage` goes to you, not the model. `decision`, `continue` and `permissionDecision` are below, for each event. |
| Exit 0, JSON that does not parse | An error that blocks nothing. |
| Exit 2 | Blocks the action, for an event that can block it: a tool call for PreToolUse, a prompt for UserPromptSubmit, the next model call for PostToolBatch, the end of the turn for Stop. PostToolUse and PostToolUseFailure come after the call ran, so the model reads the reason beside the result. The reason is stderr, and JSON on stdout cannot override it. SessionStart, SessionEnd, SubagentStart and LaneCreated cannot block, so exit 2 is an error there. PermissionRequest does not take exit 2 as an answer: only its `decision` object answers the card. |
| Any other exit | Valid JSON on stdout decides, as on exit 0, and the exit code is ignored. Without valid JSON it is an error that blocks nothing. |
| Killed at the timeout | An error that blocks nothing, and it decides nothing. |

The row for any other exit is Claude Code's: its hooks reference says that with valid JSON "Claude Code ignores the exit code and the JSON alone decides the outcome", `permissionDecision` included. So a PreToolUse hook that exits 1 and prints `"permissionDecision": "allow"` allows the call, as in Claude Code. To refuse a call, a hook must exit 2 or print `"deny"`. An exit 1 without JSON lets the call go on.

Geno shows each error, and each `systemMessage`, on the command line's stderr, or in the Geno output channel in VS Code. The model sees none of them.

The model sees a hook's text in Claude Code's words, under Geno's note mark:

```
[Geno] SessionStart:startup hook success: <stdout>
[Geno] SessionStart:startup hook additional context: <additionalContext>
[Geno] PostToolUse:Write hook additional context: <additionalContext>
[Geno] Stop hook blocking error: <reason>
[Geno] SubagentStart hook additional context: <additionalContext>
[Geno] SubagentStop hook blocking error: <reason>
```

The `startup` text opens the first request, after the loaded instructions and the environment, before your prompt. A `resume` or `compact` text joins the next request. A UserPromptSubmit text follows the prompt it is about. A SubagentStart text comes before the subagent's task, in the subagent's request, never the parent's. A tool call's hook text ends that call's result, and PostToolBatch's follows the results of the turn. The reason of a block reads `hook blocking error`, a wording of Geno's. Geno logs every text the model reads, so a resumed session sends the same bytes. The system prompt never changes, so the cached prefix holds. Geno keeps the first 10,000 characters of each hook's text. A line of hook output that starts with `[Geno` loses its bracket, so a hook cannot pose as Geno.

## UserPromptSubmit

A UserPromptSubmit hook runs before the model sees your prompt:

- Exit 2, `"decision": "block"` or `"continue": false` blocks the prompt, and the model never sees it. The turn ends with `[blocked] A UserPromptSubmit hook blocked this prompt, so the model did not see it: <reason>`. The reason is stderr, `reason` or `stopReason`. Your prompt stays in the transcript, and your next prompt goes to the model without it. `gcode agent` exits with code 1.
- Plain stdout and `additionalContext` reach the model after your prompt, as `[Geno] UserPromptSubmit hook success: <stdout>` and `[Geno] UserPromptSubmit hook additional context: <additionalContext>`.

Geno does not read `sessionTitle` or `suppressOriginalPrompt`. A blocked prompt's text stays in Geno's transcript, as it stays in Claude Code's.

## PreToolUse

When the model asks for tool calls, Geno runs the PreToolUse hooks of every call of the turn first, all at once. Then it runs the calls in order. When hooks disagree, the strictest wins, as in Claude Code: `deny`, then `defer`, then `ask`, then `allow`.

| The hooks say | What happens |
|---|---|
| Exit 2, or `"permissionDecision": "deny"` | The call does not run. The model reads `[Geno] PreToolUse:<Tool> hook error: <reason>` as an error. The reason is stderr or `permissionDecisionReason`. The other calls of the turn still run. |
| `"permissionDecision": "ask"` | You get a permission card before the call runs, in every mode, Auto included: "A PreToolUse hook [settings] asks first: <reason>". A plugin's hook says `[plugin:<name>]`. A no turns the call down. A yes counts as the hook's allow. Nobody can answer in a non-interactive run, so the call is refused with the reason, unless a [PermissionRequest](#permissionrequest) hook answers the card. |
| `"permissionDecision": "allow"` | The question a command would ask, and the classifier in Auto, are skipped. Nothing else is. These still hold: a deny rule from Settings, the question before a credentials file such as `.env` or a path outside the workspace, what Geno always asks (such as a force push, or `rm -rf` outside the workspace), the read-before-edit and stale-file checks, and the sandbox. A command with `dangerouslyDisableSandbox` still asks you before it runs outside the sandbox. Plan stays read-only, and a non-interactive run still refuses what it would ask about, unless a PermissionRequest hook answers: a refusal is not a question. |
| `"permissionDecision": "defer"`, or no decision | The call goes through Geno's checks as usual. |

The older top-level `"decision": "approve"` and `"decision": "block"` count as `allow` and `deny`.

`updatedInput`, with `allow` or `ask`, replaces the call's whole input before it runs. Write it in Claude Code's shape, the one `tool_input` has. The call's checks judge the new input, not the model's, and the model reads the result of what ran. The session log keeps the call as the model sent it.

A hook's allow answers the question of a command: `bash`, `monitor` and `preview_start`. An MCP tool, `web_fetch`, `web_search` and the browser still ask their own questions after a hook's allow, and after a yes to a hook's ask they may ask again.

A PreToolUse hook's `additionalContext` ends the call's result, as `[Geno] PreToolUse:<Tool> hook additional context: <text>`, unless that hook says `defer`. `"continue": false` refuses the call with the `stopReason`, and stops the run once the turn's calls have results, as [PostToolBatch](#posttoolbatch) describes.

A subagent's calls run its parent session's tool hooks (PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure and PostToolBatch), with `agent_id` and `agent_type`, and a hook's card names the subagent. A subagent on an external agent, such as Codex, makes its calls inside that agent, so Geno's hooks do not see them. The Arena and evals run no hooks.

## PostToolUse and PostToolUseFailure

PostToolUse runs after each call that succeeded, and PostToolUseFailure after each call that failed. A command fails when it exits non-zero or is killed at its timeout. Any other tool fails when its result is an error, such as an edit of a file the model has not read. A call that was refused or turned down fires neither.

Each call's hooks run once the call ends, and before the next call of the turn starts, so a formatter finishes before the model's next edit. An edit's hooks run after Geno's own check (`--check`), so the result reads the edit, then the check, then the hooks' text.

| The hooks say | What happens |
|---|---|
| `hookSpecificOutput.additionalContext` | The text ends the call's result: `[Geno] PostToolUse:<Tool> hook additional context: <text>`. |
| Exit 2, or `"decision": "block"` | The call already ran, so nothing is undone. The reason ends the call's result: `[Geno] PostToolUse:<Tool> hook blocking error: <reason>`. The reason is stderr or `reason`. |
| `"continue": false` | The run stops once the turn's calls have results, as a PostToolBatch block does. |
| Plain stdout on exit 0 | Ignored. |

PostToolUseFailure takes the same output; its text reads `PostToolUseFailure:<Tool>`. Geno does not read `updatedToolOutput`, `updatedMCPToolOutput` or `classifierContext`: the model always reads the call's own result.

This hook formats each file the model writes, as a team would set it up for Claude Code, in `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "jq -r .tool_input.file_path | xargs npx prettier --write" }]
      }
    ]
  }
}
```

A workspace hook runs only in a trusted workspace, inside the sandbox, which has no network. `npx` must find prettier in the workspace's `node_modules`.

## PostToolBatch

PostToolBatch runs once after all the calls of a model turn have results, before the next model call.

| The hooks say | What happens |
|---|---|
| `hookSpecificOutput.additionalContext` | The text follows the turn's results: `[Geno] PostToolBatch hook additional context: <text>`. |
| Exit 2, `"decision": "block"` or `"continue": false` | The run stops before the next model call. You read `blocked: A PostToolBatch hook stopped the turn: <reason>`, and `gcode agent` exits with code 1. The reason stays in the session: when you send the next prompt, the model reads `[Geno] PostToolBatch hook blocking error: <reason>` after the results. |

## Stop

Stop runs when the session's model ends its turn. It does not run when the turn ends for another reason: you stop it, you turn down a call, a limit such as `--max-turns` is reached, or a model call fails.

| The hooks say | What happens |
|---|---|
| Exit 2, or `"decision": "block"` | The turn goes on. The model's next message is `[Geno] Stop hook blocking error: <reason>`. The reason is stderr or `reason`. |
| `hookSpecificOutput.additionalContext` | The turn goes on, as for a block. The message reads `Stop hook additional context`. |
| `"continue": false` | The turn ends, whatever the other hooks say. Geno shows you the `stopReason`. |
| Anything else | The turn ends. |

A Stop hook can keep the turn going once in a row. When the model ends its turn again without calling a tool, Stop runs again, with `stop_hook_active: true`, and a second block does not count: the turn ends, and Geno tells you so. Once the model calls a tool, the next block counts again. So a hook that always blocks cannot keep the model talking, and a hook that asks for tests gets them run before it lets the turn end. The run's limits, such as `--max-turns`, still hold.

Claude Code lets a Stop hook block eight times in a row. Geno allows one, so a hook that blocks the same way each time costs one extra model call, not eight. A hook that should block only once can read `stop_hook_active`:

```sh
#!/bin/sh
in=$(cat)
case "$in" in *'"stop_hook_active":true'*) exit 0 ;; esac
echo 'Run the tests before you finish.' >&2
exit 2
```

Geno writes the payload without spaces, so the pattern matches it. A script that must also read Claude Code's payload should parse it, for example with `jq -e '.stop_hook_active'`.

## PermissionRequest

A PermissionRequest hook answers a permission card in your place. It runs at the moment Geno would show you the card: before a flagged command such as `git reset --hard`, a read of a credentials file, an MCP tool, a page on another host, or the card of a PreToolUse hook's `ask`. In Auto it runs when the classifier sends the question on to you, and before what Auto always asks. A run nobody can answer, such as `gcode agent` or a scheduled task, would refuse such a call. There the hook runs where Ask would show the card, so the hook can let the run go on.

It never runs where the answer cannot change: a call that needs no card, a deny rule from Settings, Plan's refusal of a change, a URL Geno never fetches, Auto's classifier refusing a call without a card, and the checks that hold whoever answers (the lane's bounds, the sandbox, read-before-edit). It never answers the card of a command that would run outside the sandbox, either: only you approve that one, and a run nobody can answer refuses it. An external agent's own permission requests, such as Codex's, do not fire it.

| The hooks say | What happens |
|---|---|
| `"decision": {"behavior": "allow"}` | The call runs, as after your "Allow once". Nothing is saved: Geno does not read `updatedPermissions`. |
| `"behavior": "allow"` with `updatedInput` | The call runs with `updatedInput` in place of its whole input, in Claude Code's shape, the shape `tool_input` has. The call's own checks judge the new input, and any card it shows counts as answered, so the hook runs once per call. The model reads the result of what ran, and the session log keeps the call as the model sent it. |
| `"behavior": "deny"` | The call does not run. The model reads `` denied: `<command>` did not run. A PermissionRequest hook answered for the user and refused it: <message>. `` and goes on. |
| `"behavior": "deny"` with `"interrupt": true` | As your "Reject": the call does not run, and the turn ends. |
| No `decision`, exit 2, or a timeout | Nothing is answered. You get the card, or a run nobody can answer refuses the call. Exit 2 is not an answer, as in Claude Code. |

When hooks disagree, a deny wins. The whole object is `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {...}}}`.

This hook lets a `gcode agent` run reset its own checkout, and nothing else that `git reset --hard` would ask about, in `~/.g-code/settings.json`:

```json
{
  "hooks": {
    "PermissionRequest": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "~/bin/allow-reset.sh" }] }
    ]
  }
}
```

```sh
#!/bin/sh
cmd=$(jq -r .tool_input.command)
# The answer covers the whole command line, so allow only the exact command.
[ "$cmd" = 'git reset --hard' ] || exit 0
echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
```

A card is about the whole command line, so a hook that allows `git reset --hard*` would also allow `git reset --hard && rm -rf ~/.ssh`. Match the exact command, or refuse any line with `;`, `&`, `|` or `$(`.

## SubagentStart and SubagentStop

SubagentStart runs when the session starts a subagent, and again when it resumes one with `message_agent`. `hookSpecificOutput.additionalContext` reaches the subagent before its task, as `[Geno] SubagentStart hook additional context: <text>`. The parent never reads it. On a resume the text goes in again only when the subagent's log does not already hold the same text, so the subagent's cached prefix holds. SubagentStart cannot block a subagent; its exit 2 is an error that you see.

SubagentStop runs when a subagent finishes: when its `report` call hands back its report, or when its model ends its turn. It takes Stop's output:

| The hooks say | What happens |
|---|---|
| Exit 2, or `"decision": "block"` | The subagent goes on. Its next message is `[Geno] SubagentStop hook blocking error: <reason>`, and it reports again. |
| `hookSpecificOutput.additionalContext` | The subagent goes on, as for a block. |
| `"continue": false`, or anything else | The subagent ends, and its parent gets its report. |

A SubagentStop hook can keep a subagent going once in a row, as Stop does. A second block counts only after the subagent calls a tool other than `report`, so a hook that always blocks costs one more subagent turn. The subagent's limits still hold. Stop never runs for a subagent.

A subagent on an external agent, such as Codex, runs its turn inside that agent, so it fires neither event.

## LaneCreated

LaneCreated is Geno's own event: Claude Code has no lanes. It runs after Geno sets up a new lane, from `gcode lane new` or from a lane the panel, a spin-off, a schedule or the Arena starts. It runs after `.worktreeinclude`, the copy of `node_modules` and the approved `laneSetup` commands, and before a session runs in the lane. The hook runs in the lane, as you, outside the sandbox, so it can reach the network.

Only your own hooks run: those in `~/.g-code/settings.json`, `~/.agents/settings.json`, `~/.claude/settings.json` and plugins installed for your user. A workspace's own LaneCreated hook never runs, and Settings says so. A repository's setup for its lanes belongs in `laneSetup` in `.g-code/settings.json`, which you approve once with `gcode lane new --approve-setup`.

This hook installs a new lane's dependencies, in `~/.g-code/settings.json`:

```json
{
  "hooks": {
    "LaneCreated": [
      { "hooks": [{ "type": "command", "command": "test -f pnpm-lock.yaml && pnpm install --frozen-lockfile --prefer-offline >&2", "timeout": 300 }] }
    ]
  }
}
```

A hook that fails is reported, on the command line's stderr or in the Geno output channel, and the lane stays. Its output decides nothing. A file the hook leaves that git does not ignore counts as a change of the lane.

Claude Code's WorktreeCreate does not fit a lane: its hook replaces creating the worktree and prints the new folder, and a lane must be a git worktree on its own `geno/<name>` branch, which Geno applies and discards. So Geno never fires WorktreeCreate or WorktreeRemove, and a hook written for them does not run.

## Events Geno never fires

Settings lists a hook for one of these events as "Geno never fires it", with the reason. The reasons are `HOOK_EVENTS` in `packages/core/src/hooks.ts`.

| Event | Why |
|---|---|
| `WorktreeCreate` | Its hook replaces creating the worktree and prints the new path, but a lane must be a git worktree on its own branch. Use LaneCreated to set up a new lane. |
| `WorktreeRemove` | It removes what a WorktreeCreate hook made, and Geno runs no WorktreeCreate hook. |
| `Setup` | Geno has no `--init` or `--maintenance` run. |
| `UserPromptExpansion` | Geno has no hook on expanding a slash command; UserPromptSubmit sees the prompt. |
| `PermissionDenied` | Auto's classifier refuses a call without a card, and the model reads why in the call's result. |
| `Notification` | Geno shows its cards and notices in the editor. PermissionRequest and Stop fire at the same moments. |
| `MessageDisplay` | Geno has no hook on the text it shows. |
| `TaskCreated`, `TaskCompleted` | Geno has a todo list, not a task list. |
| `StopFailure` | A failed model call ends the turn with the error, which Geno shows. |
| `TeammateIdle` | Geno has no agent teams. |
| `InstructionsLoaded` | Geno loads instruction files when a session starts, which SessionStart covers. |
| `ConfigChange` | Geno reads hooks once per session and does not watch the settings files. |
| `CwdChanged` | A Geno session keeps its workspace. |
| `DirectoryAdded` | Geno has no `/add-dir`. |
| `FileChanged` | Geno tells the model itself about files that changed on disk, before each model call. |
| `PreCompact`, `PostCompact` | SessionStart with the source `compact` runs after a compaction. |
| `PreModelSwitch`, `PostModelSwitch` | Geno has no hook on a model switch. |
| `Elicitation`, `ElicitationResult` | Geno answers no MCP elicitation. |

## Timeouts and parallel runs

- A hook has 600 seconds, unless its `timeout` (in seconds) says otherwise. UserPromptSubmit has 30. At the timeout Geno kills the hook and everything it started.
- All hooks that match an event run at the same time.
- An identical hook in two files runs once: the same command, with the same plugin folder. Your own files come first, so the copy that runs is yours.

## Settings

Settings, under Hooks, lists every hook Geno found for the open folder: its event and matcher, its command, the file or plugin it came from, and whether it runs. A warning above the list names each mistake, such as an unknown event or a file that is not valid JSON. Each hook has one of these statuses:

| Status | Meaning |
|---|---|
| Runs | Geno runs the hook at its event. |
| Needs a trusted workspace | A workspace hook in a workspace VS Code does not trust. |
| Geno never fires it | An event in [Events Geno never fires](#events-geno-never-fires), or a workspace's LaneCreated hook. The row says why. |

## Example: a phone notice when Geno stops

Install the ntfy app on your phone and subscribe to a topic name that only you know. Then add this to `~/.g-code/settings.json`, so that only Geno sends it:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -d \"Geno finished in $(basename \"$CLAUDE_PROJECT_DIR\")\" https://ntfy.sh/my-geno-topic-4f7a",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

The hook is yours, so it runs outside the sandbox and can reach ntfy.sh. It runs each time the model ends a turn, in VS Code and with `gcode agent`. When another Stop hook keeps the turn going, you get a notice for each end. The hook prints nothing and exits 0, so it never keeps the turn going itself. `-s` keeps curl quiet, and the `timeout` of 10 seconds keeps a slow network from holding the end of the turn. Put the same hook in `~/.claude/settings.json` to get the notice from Claude Code as well.

To put the model's last words in the notice, read them from the payload with jq: `jq -r .last_assistant_message | curl -s --data-binary @- https://ntfy.sh/my-geno-topic-4f7a`. Here `--data-binary @-` sends stdin as the message.
