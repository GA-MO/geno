# Configuration files

Geno reads its configuration from three vendors' folders, for you and for each project. Geno's own folder comes first, then the vendor-neutral `.agents`, then Claude Code's `.claude`, which Geno reads so that a setup written for Claude Code works unchanged. One table in `core/src/config-roots.ts` (`CONFIG_ROOTS`) lists every folder and what it holds, and every reader takes its paths from it.

## The config roots

| Vendor | Your root | The project's root |
|---|---|---|
| Geno | `~/.g-code`, or `$GCODE_HOME` | `<workspace>/.g-code` |
| Vendor-neutral | `~/.agents` | `<workspace>/.agents` |
| Claude Code | `~/.claude`, or `$CLAUDE_CONFIG_DIR` | `<workspace>/.claude` |

Geno never guesses your home. When the environment names no `HOME`, Geno reads no `~/.agents`, and `~/.claude` only from `CLAUDE_CONFIG_DIR`.

Each root holds some of these items:

| Item | Path in the root | Geno roots | `.agents` roots | `.claude` roots |
|---|---|---|---|---|
| Settings | `settings.json`, and `settings.local.json` in a project root | yes | yes | yes |
| Slash commands | `commands/*.md` | yes | yes | yes |
| Skills | `skills/<name>/SKILL.md` | yes | yes | yes |
| Agent definitions | `agents/*.md` | yes | yes | yes |
| Workflows | `workflows/*.json` | yes | no | no |
| Launch file | `launch.json` | project only | no | project only |

A command, skill or agent of one name is taken from the first root that has it: your roots before the project's, and in each, Geno's before `.agents` before `.claude`. A project item that one of your own shadows is reported once. A workflow in the project shadows one of yours of the same name. An entry in `.g-code/launch.json` wins over one of the same name in `.claude/launch.json`.

The Skills catalog installs a skill or an agent into Geno's own root: for you into `~/.g-code`, and for the project into `.g-code`. A project install that an earlier Geno made in `.claude` stays there. Settings lists it as installed, and Uninstall removes it from `.claude`.

## Settings files

Geno reads ten settings files, by scope:

| Scope | Files, highest precedence first |
|---|---|
| Project, local | `.g-code/settings.local.json`, `.agents/settings.local.json`, `.claude/settings.local.json` |
| Project, shared | `.g-code/settings.json`, `.gcode.json`, `.agents/settings.json`, `.claude/settings.json` |
| You | `~/.g-code/settings.json`, `~/.agents/settings.json`, `~/.claude/settings.json` |

A local file is personal. Keep `.g-code/settings.local.json`, `.agents/settings.local.json` and `.claude/settings.local.json` out of the repository with a line in `.gitignore`:

```gitignore
.g-code/settings.local.json
.agents/settings.local.json
.claude/settings.local.json
```

## One schema for every file

Every settings file has the same schema. `engine/src/settings.ts` reads it.

| Key | Read from | Meaning |
|---|---|---|
| `permissions` | every file | `allow`, `ask` and `deny` rules and `additionalDirectories`, in Claude Code's format. [conformance.md](conformance.md) (P29) lists the rules Geno can apply. |
| `hooks` | every file | Commands that run at session events. See [hooks.md](hooks.md). |
| `enabledPlugins` | every file | `"name@marketplace": false` turns off a Claude Code plugin's hooks. |
| `check` | Geno's files | The command the `check` tool runs, such as `"pnpm typecheck"`. |
| `agentTool` | Geno's files | The approval modes whose model may start subagents itself, such as `["ask", "auto"]`. |
| `appendSystemPrompt` | Geno's files | Text that ends the system prompt of every run. |
| `arena` | Geno's files | The Arena's default `variety`, its `models`, or a list of `variants`. |
| `laneSetup` | the project's Geno files | Commands that set up each new lane, which you approve once per repository. |

A Geno key in a `.agents` or `.claude` file is ignored, with one warning line that names the file. An unknown key in a Geno or `.agents` file is also ignored with a warning. A `.claude` file may hold any of Claude Code's other keys, such as `model` or `env`, and Geno skips them without a warning. A key with a value Geno cannot use, such as `"check": 5`, is ignored with a warning. A file that is not valid JSON gets one warning and never stops a run.

The warnings go to stderr on the command line and to the **Geno engine** output channel in the editor, as lines that start with `settings:` or `permissions:`.

## How the files combine

Geno merges the files as Claude Code merges its scopes:

- **Permissions.** Rules from every file apply together. A deny in any file beats an allow in any file, whatever its scope or vendor. A project allow applies only in a workspace that VS Code trusts, since anyone who can commit wrote it, and so do the project's `additionalDirectories`. Your own files apply without trust. Geno's own rules, which Settings under Permissions saves outside the repository, sit above all of them. A refusal names the rule and the file it came from.
- **Hooks.** Every hook in every file runs. A project's hooks run only in a trusted workspace. The same handler in two files runs once.
- **`enabledPlugins` and Geno's own keys.** The highest file that sets a value wins: a project-local file over a project-shared one over yours, and in one scope Geno's over `.agents` over `.claude`.

Settings under Permissions lists the rules from the settings files read-only, each with its file, below the rules you can remove. An allow that waits for a trusted workspace is not listed.

## Move from .gcode.json

Geno still reads `.gcode.json` in the workspace root, as the project's shared Geno file. It sits just below `.g-code/settings.json`, so a key in both takes the new file's value. When both files exist, Geno prints one note that asks you to move the keys.

To move:

1. Create `.g-code/settings.json` with the contents of `.gcode.json`.
2. Delete `.gcode.json`.

The keys and their meanings are the same in the new file.
