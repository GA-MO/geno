# Hooks

A hook is a command that Geno runs at a session event, such as the start of a session. Geno runs it, not the model, so a hook always runs. Geno reads hooks in Claude Code's format, so a hook you wrote for Claude Code, or one a Claude Code plugin such as pstack installs, runs in Geno unchanged.

This page covers the hook files, the events Geno fires, what a hook receives and what its exit code and output mean, and which hooks run in which workspace. The design and its tests are in [claude-code-parity.md](claude-code-parity.md) (rows B/B-89 to B/B-126) and [conformance.md](conformance.md) (T-HOOK).

## Where Geno reads hooks

Geno reads the `hooks` key of each of these files. Every hook in every file runs. No file overrides another.

| File | Scope |
|---|---|
| `~/.g-code/settings.json` (or `$GCODE_HOME/settings.json`) | You. Geno only. |
| `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) | You. Claude Code reads it too. |
| `hooks/hooks.json` of each installed Claude Code plugin | You, for a plugin installed for your user. The workspace, for a plugin installed for one project. |
| `.gcode.json` in the workspace | The workspace. |
| `.claude/settings.json` in the workspace | The workspace. |
| `.claude/settings.local.json` in the workspace | The workspace. |

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
| `UserPromptSubmit`, `PreToolUse` | Coming in P14 | Listed in Settings as "Not run yet". |
| `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop` | Coming in P15 | Listed in Settings as "Not run yet". |
| `PermissionRequest`, `SubagentStart`, `SubagentStop`, a lane-create hook | Coming in P16 | Listed in Settings as "Not run yet". |
| Every other Claude Code event, such as `Notification` or `PreCompact` | Never | Geno has no trigger for it, or another event covers it. |

An event name that Claude Code does not have, such as `SesionStart`, is a mistake. Claude Code ignores it without a word. Geno ignores it too, and warns in Settings under Hooks and on the command line.

### Matchers

A group's `matcher` picks the events it runs for:

- No matcher, `""` or `"*"` matches everything.
- A plain name, or names joined by `|`, must match exactly: `startup|resume`.
- Any other matcher is a regular expression that must match the whole value: `mcp__.*__write`.

SessionStart matches its source and SessionEnd its reason. The tool events (P14 and P15) match the tool's name. A matcher may name Claude Code's tools: `Bash` matches `bash`, `Read` matches `read`, `Edit`, `Write` and `MultiEdit` match `edit`, `Grep` matches `grep`, `Glob` matches `glob`. The table is `CLAUDE_TOOL_NAMES` in `packages/core/src/hooks.ts`.

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
- `permission_mode` is `default` in Ask, `auto` in Auto, `plan` in Plan, and `dontAsk` in a non-interactive run.
- SessionEnd has `reason` in place of `source`.

The environment has `CLAUDE_PROJECT_DIR`, the workspace. A plugin's hook also has `CLAUDE_PLUGIN_ROOT`, the plugin's folder. `CLAUDE_CONFIG_DIR` is passed on when it is set.

## Exit codes and output

Geno reads a hook's result as Claude Code does:

| Result | Meaning |
|---|---|
| Exit 0, plain stdout | SessionStart: the model gets the text. SessionEnd: the text is ignored. |
| Exit 0, stdout that starts with `{` | JSON. `hookSpecificOutput.additionalContext` goes to the model. `systemMessage` goes to you, not the model. Other fields (`continue`, `decision`, `permissionDecision`) matter for the events of P14 and P15. |
| Exit 0, JSON that does not parse | An error that blocks nothing. |
| Exit 2 | Blocks the action, for an event that can block it (P14 and P15). The reason is stderr, and JSON on stdout cannot override it. SessionStart and SessionEnd cannot block, so exit 2 is an error there. |
| Any other exit | An error that blocks nothing. Valid JSON on stdout still counts. |
| Killed at the timeout | An error that blocks nothing. |

Geno shows each error, and each `systemMessage`, on the command line's stderr, or in the Geno output channel in VS Code. The model sees none of them.

The model sees a hook's text in Claude Code's words, under Geno's note mark:

```
[Geno] SessionStart:startup hook success: <stdout>
[Geno] SessionStart:startup hook additional context: <additionalContext>
```

The `startup` text opens the first request, after the loaded instructions and the environment, before your prompt. A `resume` or `compact` text joins the next request. The system prompt never changes, so the cached prefix holds. Geno keeps the first 10,000 characters of each hook's text. A line of hook output that starts with `[Geno` loses its bracket, so a hook cannot pose as Geno.

## Timeouts and parallel runs

- A hook has 600 seconds, unless its `timeout` (in seconds) says otherwise. UserPromptSubmit will have 30 (P14). At the timeout Geno kills the hook and everything it started.
- All hooks that match an event run at the same time.
- An identical hook in two files runs once: the same command, with the same plugin folder. Your own files come first, so the copy that runs is yours.

## Settings

Settings, under Hooks, lists every hook Geno found for the open folder: its event and matcher, its command, the file or plugin it came from, and whether it runs. "Needs a trusted workspace" marks a workspace hook in a workspace VS Code does not trust. A warning above the list names each mistake, such as an unknown event or a file that is not valid JSON.

## Example: a phone notice when Geno stops

This needs the `Stop` event, which comes in P15. Until then Settings lists the hook as "Not run yet".

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

The hook is yours, so it runs outside the sandbox and can reach ntfy.sh. Put the same hook in `~/.claude/settings.json` to get the notice from Claude Code as well.
