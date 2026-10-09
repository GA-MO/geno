# Testing

Geno has three vitest projects:

- `unit` runs in seconds on any machine.
- `webview` loads the chat panel in headless Chromium against a fake extension host, for the files in `packages/extension/test/webview/*.webview.test.ts`. It takes a few seconds and opens no window.
- `vscode` runs each file in `packages/extension/test/*.integration.test.ts` in a real VS Code. The files share one VS Code window, which stays open from suite to suite, so a full run launches VS Code a few times instead of 53. Run it with `pnpm test:vscode`, which retries a failed file once.

## Test what a change can break

While you work, and before you merge a unit, run only what the change can break:

```sh
pnpm test:affected            # VS Code files on the host
pnpm test:affected --docker   # VS Code files in the container
pnpm test:affected --dry      # print the files and why, run nothing
```

It diffs the branch against its merge base with `main` (`--base <ref>` picks another), then runs `pnpm typecheck`, `pnpm lint:deps`, the unit tests vitest relates to the changed files (`--changed`), every webview test, and only these VS Code integration files (the rules are in `scripts/affected.ts`):

- A file whose own test or suite part changed.
- Every file, when the harness changes: `vitest.config.ts`, the lockfile, `package.json`, `launch.ts`, `vscode-setup.ts`, the window pool in `test/pool/`, `suite/index.ts`, `suite/shooting.ts`, `scripts/vscode-workers.ts`, `scripts/test-vscode.ts` and the Docker entry. A root `package.json` change that only adds or edits `scripts` is not a harness change, since no suite runs a script; a dependency change is.
- `chat`, `panel` and `working` when engine or core source changed, since those suites drive whole turns.
- Every file that reads a request's `messages`, `system`, `tools` or `tool_choice`, or a session log, when a file that shapes the request or the turn's events changed: the opening, Geno's notices and arrivals, the mode's prompt and tools, tool result text, and the turn loop (`REQUEST_SHAPERS` in `scripts/affected.ts`). That is about 39 of 52 files. Without this rule, P5, P6, P11 and P17 changed the request on purpose and ten suites that check it failed only on the next full run.
- For panel source, the suites that name a class, data value, message type, command id or module that the changed lines name. A token that 60% of the suites use says nothing and is skipped. If no suite names anything the change touched, `panel`, `chat` and `composer` run.

A small panel change runs 2 to 8 files instead of 30, and they share the run's one window like any other files. Run the full suite once per batch of merges, before a release or an install, not after every change.

## The fake model

No test calls a live model. Tests answer the engine's model requests with the shared fake in `packages/engine/test/fake-model.ts`. One fake speaks both wires. It reads the request's path to tell them apart: `/v1/messages` is the Anthropic Messages API and `/chat/completions` is Chat Completions.

```ts
import { call, fakeModel, say } from './fake-model.js';

const model = fakeModel({ script: [call('Reading.', [{ id: 'tu_1', name: 'read', input: { path: 'a.ts' } }]), say('a is 1.')] });
await runCli(['agent', '--workspace', workspace, 'What is a?'], env, { fetch: model.fetch }); // in process
model.bodies();   // each request body as sent
model.misses;     // why a request got no answer, if one did
```

- `fetch` serves an engine in the test's process. `handle(req, res)` serves an engine in another process, such as the extension host, from the test's own HTTP server, and returns false for a route that is not the model's, such as a suite's `/ui`. `listen()` starts a server of its own.
- A script entry is a turn (`say`, `call`, `report`), which the fake streams on whichever wire the request used, or a raw reply for one wire (`{ anthropic: Reply }`, `{ openai: ChatReply }`) for stalls, failures and exact usage. `{ when, answer }` answers the next request that `when` accepts, and `answer` can be a function of the request that waits, to hold a turn open. Entries are served in order, and `more()` adds entries.
- A request with no answer gets a 400 that the engine shows and does not retry, and the reason goes in `misses`.

### Recordings

`fakeModel({ recording: 'name', fallback: [...] })` answers each request by its key, from `packages/engine/test/recordings/name.json`. The key is 16 hex characters of the SHA-256 of the wire and the normalized request body. Any change to a request changes its key, so a recorded test fails on a request-shape change, the way Copilot Chat's cache does. The miss names the file, the key, the end of the request's last user message, and the command that records it.

```sh
GCODE_RECORD=1 pnpm vitest run --project unit packages/engine/test/usage.e2e.test.ts      # answers from the fallback script
GCODE_RECORD=live pnpm vitest run --project unit <file>                                   # answers from Model Studio
```

- Without `GCODE_RECORD`, a recording only replays, and the fallback is never used. A missing entry fails the test.
- `GCODE_RECORD=1` adds each missing entry with the fallback's next answer. This is how a hand-written answer goes into a recording.
- `GCODE_RECORD=live` sends each missing request to Model Studio's Anthropic endpoint and keeps the whole stream. It reads `DASHSCOPE_API_KEY` and `DASHSCOPE_BASE_URL` from the main checkout's `.env`. It never prints them, and a recording holds only the reply events, not the request headers. It speaks only the Anthropic wire.
- Recording adds entries and keeps the old ones. To drop the entries a test no longer uses, delete the file and record again.

### Recordings from real runs

`packages/engine/test/real-runs.e2e.test.ts` runs the real engine through six runs of the real-model campaign (`docs/results/real-usecases/runs/`), with the model's own answers replayed, no network and no cost. Each recording is `packages/engine/test/recordings/real/<case>.json`:

| Recording | Run | What the test checks |
| --- | --- | --- |
| `A13-fail-then-fix` | A code fix | Reads the stub and its test before the one edit, runs the test, and leaves the archived `diff.patch`. |
| `A06-read-not-cat` | A search and read task | `read`, `list` and `glob` in one turn, no shell, no change. |
| `A10-plan-mode` | A multi-step task in Plan | Searches, reads, read-only commands, one todo update with every item pending, no edit. |
| `A02-thai-fix` | A Thai prompt | Reads before the edit, the slug test passes, the archived diff. |
| `A11-explore-subagent` | Subagents | A capped explore subagent, a retried one that reports, each one's tool order, the parent's own grep. |
| `B01-ask-allow` | An approval in Ask | Two looks, then one question for `rm -rf build`, which the test allows; `build/` is gone and `dist/` is not. |

A real run cannot be recorded again without a model, and the engine's requests change whenever the system prompt, a tool or a notice does. So these recordings say `"keyBy": "turn"`, and the fake model answers each request by its turn key instead of the request key (`requestTurnKey` in `request-normal.ts`): 8 hex characters of the SHA-256 of the normalized text that opened the conversation, `#`, and how many assistant messages the request holds. The opening text is the last text block of the first user message: the user's prompt, or the task a subagent was given. A subagent's turns therefore stay apart from its parent's. A request that has no recorded turn fails, with the file, the key, and the command that makes the recording again. That happens when the engine takes a turn the real run did not take, or opens a conversation with other text.

The file also keeps what the test needs to start the run again: the run's folder, its mode, its prompts, and the files its workspace started with. Paths into the run's workspace in the model's answers and in a subagent's task are written relative to the workspace, so they work in the test's own temp repository.

To make a recording from a run, or from a new real run of the same case after the engine changed, convert its archived folder:

```sh
pnpm tsx scripts/run-to-recording.ts docs/results/real-usecases/runs/A13-fail-then-fix/1
pnpm vitest run --project unit packages/engine/test/real-runs.e2e.test.ts
```

The script reads `session.jsonl` and each `child-*.jsonl` of a Layer A run, or the `session-*.jsonl` files of a panel step, and writes one entry per assistant event, with thinking left out. A new real run comes from `node scripts/real-usecases/run.mjs --case <id>` and `node scripts/real-usecases/archive.mjs`, which costs money. A panel step starts from `packages/extension/test/suite/real-model-fixture.ts` alone, without the changes the steps before it made. A case with a sibling repository or a setup step is refused, since the recording does not carry them yet.

### Normalization

`request-normal.ts` takes out the parts of a request that change from run to run. The key and the goldens below both use it:

- Every `cache_control` key is dropped, since the breakpoint moves to the newest message on each call.
- Paths under the temp dir, either spelling of it on macOS, become `<tmp>`. The six random characters that `mkdtemp` adds after a dash become `XXXXXX`.
- Uuids, such as session ids, become `<uuid-N>`, numbered by first appearance in the request, so one session named twice stays apart from two sessions.
- ISO dates and times become `<date>`. The environment block's `Platform:` and `OS version:` values become `<platform>` and `<os-version>`. Commit hashes at the start of a git log line become `<commit>`.
- Tool-call ids stay, since the script or the recording chooses them.

A missing rule shows up as a key or a golden that changes on every run. Add the rule to `RULES` with the case it covers.

### Golden requests

`packages/engine/test/golden/requests.test.ts` runs a few turns on both wires and compares the normalized bodies of every model request with the files in `packages/engine/test/golden/requests/`: a plain prompt, a tool call round trip, a steer, a background notice, a `/compact`, an MCP server's instructions, and hook context. A change to the system prompt, a tool, a notice or the turn loop fails it in about ten seconds, with a diff of the lines that changed. This is the check that would have caught the requests that P5, P6 and P11 changed, before the VS Code suites that read them failed on the next full run.

```sh
pnpm test:golden        # check
pnpm test:golden -u     # the change is meant: rewrite the files, then review and commit the diff
```

A file shows each request one value per line, and each line of a string after `|`. A long value that a request repeats from an earlier one, or from `plain-prompt`, is written as `= <file> <where>`, so the system prompt and the tools appear once in `plain-prompt.<wire>.golden`.

## One run at a time

Every vitest run on the machine takes `~/.g-code/test-run.lock` when its config loads (`scripts/test-lock.ts`). A second run prints `waiting for the test run of pid N` and starts when the first ends; a lock left by a run that died is taken over. A run started inside a held run, such as a test that runs vitest, does not wait. `GCODE_TEST_LOCK=off` skips the lock.

Once it holds the lock, a run also waits until the machine has room: at least 3 GB of memory the OS can hand out (free, inactive and speculative pages on macOS) and a load average under 1.5 per core. It prints `waiting for the machine to have room before testing` with the reason, once. The Mac kernel-panicked once when VS Code test windows ran out of memory. `GCODE_TEST_MIN_FREE_GB` and `GCODE_TEST_MAX_LOAD_PER_CORE` change the limits, and `GCODE_TEST_HEADROOM=off` skips the wait.

The unit and webview projects use at most `GCODE_TEST_WORKERS` workers (default 4), and a run lowers its own CPU priority, so the editor stays usable while tests run. Four delegates once ran full suites at once with every core each, and the Mac froze.

While working on a change, run only the test files it touches (`pnpm vitest run --project unit <file>`). Run `pnpm test:affected` once at the end, not a full `--project unit` run as well.

## The VS Code windows

The integration files run in a pool of long-lived VS Code windows, the way Copilot Chat, Cline and Roo Code run their extension tests in one launch instead of one per file (`docs/testing-research.md`). `vscode-setup.ts` builds the extension once, then starts the pool (`packages/extension/test/pool/`). The pool launches a window when a file first needs one, keeps it for the files after, and closes every window when the run ends.

A file leases a window for its test and runs its suite there:

```ts
const { work, workspace, home, suite } = await setUp('modes', FILES, settings);
const vscodeWindow = await leaseWindow();     // from ./pool/client.js; released when the test ends
debugPort = vscodeWindow.debugPort;           // for CDP input and screenshots
await vscodeWindow.run(suite, { workspace, work }, { GCODE_HOME: home, ... }); // throws the suite's error
```

Each `run` opens the suite's own workspace in the window, which starts a fresh extension host. A small extension in the window, `pool/host.ts`, sets the env the test passed and runs the suite in that host. A second `run` in the same folder is a real window reload, which is what the `-reload` suites check. So suites stay independent:

- Each suite has its own workspace folder and so its own workspace storage, its own `GCODE_HOME` and engine, and its own fake model and ports.
- Before the folder opens, the window's `User` files are reset to the suite's: `settings.json` to the user settings `setUp` was given, or to `{}`, and `mcp.json` to the suite's or to none. A theme or setting one suite wrote does not reach the next.
- Secrets are kept in memory, so the reload clears them. Terminals are closed, and unsaved editors are reverted, before a new folder opens.
- A released window opens an empty folder, so the last suite's extension host, and its connections to the test's servers, end with the test.

The window loads Geno from a copy of `dist` and `media` whose manifest depends on the host extension. VS Code then activates the host, which sets the env, before it activates Geno, even when Geno's restored view activates it first thing after a reload. The suite runs from a copy inside that folder, because VS Code gives a module's `require('vscode')` the API of the extension whose folder holds it.

`GCODE_VSCODE_WORKERS` sets how many windows the pool keeps, which is also how many files run at once. The default is 1, so one VS Code window is open at a time. Do not raise it on a 16 GB Mac, which ran out of memory and panicked during runs with two windows. Every vitest run also waits for 3 GB of free memory and a load under 1.5 per core before it starts (`scripts/test-lock.ts`). Two files launch a VS Code of their own and hold a place in the pool while they do: `install`, which installs the packed `.vsix`, and the Tab test in VS Code Insiders, which needs a proposed API. The pool closes an idle window to make that room.

```sh
pnpm vitest run --project vscode packages/extension/test/modes.integration.test.ts   # one suite, one window
pnpm vitest run --project vscode packages/extension/test/modes.integration.test.ts -t 'Ask'   # one test
```

When a run ends, it prints how many suites it ran in how many launches, such as `vscode pool: 58 suite runs in 4 pooled VS Code launches, and 2 files that launched their own`. Each window keeps its VS Code output in `<TMPDIR>/p-*/<n>/vscode.log` and its logs under `<n>/ud/logs`. The run removes its TMPDIR when it exits; to keep it, set `GCODE_TEST_TMP_ROOT` and `TMPDIR` to a folder you made.

## Retries and flakes

`pnpm test:vscode [files] [vitest options]` runs the `vscode` project, then runs each failed file once more. A file that passes the second time is a flake: the run passes, lists it at the end with its first failure, and appends it to the flake log, `GCODE_FLAKE_LOG` or `gcode-vscode-flakes.jsonl` in the temp dir. A file that fails twice fails the run. `pnpm test:affected` and the Docker entry run the files this way.

The retry is per file, not vitest's per-test `retry`. A file's fake model keeps its first attempt's requests in module state, so a test retried in the same module would replay against the wrong script. A flake caused by state one suite leaves for the next is a bug in the pool, not something to retry.

## Webview tests

A webview test opens the chat panel with `openPanel()` from `packages/extension/test/webview/harness.ts`. The harness builds the panel's bundles from source, serves the page under its real CSP with the variables VS Code gives a webview in the chosen theme, and puts a `FakeHost` behind `acquireVsCodeApi`. The test plays the engine's turns as the actions the extension would post (`turns.ts`) and checks the panel with the same expressions the VS Code suites use. `panel.theme('light')` switches the theme, and `GCODE_SCREENSHOTS` writes the shots to `<folder>/webview/`.

- Write a webview test for a check that only looks at the panel: layout, colors, themes, clicks and keys. Keep a VS Code test for what crosses into VS Code or the engine. `docs/t1-fast-tests.md` sorts the 46 VS Code files this way.
- The theme dumps in `webview/themes/` come from VS Code 1.140. After a VS Code upgrade, capture them again with `pnpm tsx packages/extension/test/webview/capture-themes.mts`, which opens one VS Code window.
- Playwright runs the Chromium in Playwright's cache. On a new machine, run `pnpm --filter ./packages/extension exec playwright-core install chromium-headless-shell` once. `GCODE_CHROMIUM` names another Chromium.
- To show that a test catches a defect, `sh scripts/defect-check.sh <file> <from> <to> <tests...>` makes the change, runs the tests and puts the file back.

## Run the vscode project in Docker

To keep the windows off the screen, run the `vscode` project in a Linux container:

```sh
pnpm test:vscode:docker                                                  # every file
pnpm test:vscode:docker packages/extension/test/modes.integration.test.ts  # some files
```

The container runs VS Code under Xvfb, so no window appears on the host's screen. It runs `pnpm test:vscode` with one pooled window, since the Docker VM is small, unless `GCODE_VSCODE_WORKERS` says otherwise. It prints its flakes at the end; its flake log stays in the container.

## The full gate

Run it once per batch of merges and before every install. It is:

```sh
pnpm typecheck && pnpm lint:deps && pnpm build && pnpm vitest run --project unit --project webview && pnpm test:vscode:docker
```

`pnpm test:all` runs exactly this.

## What the container needs

- Docker. The image is `node:22-bookworm` with Xvfb, the Electron libraries, Noto and DejaVu fonts, bubblewrap, and Chromium for the browser tool. Google ships no Linux arm64 Chrome, so the image links Chromium to `/opt/google/chrome/chrome`, where the browser server looks for Chrome.
- `--security-opt seccomp=unconfined --security-opt systempaths=unconfined`. The engine sandbox runs commands in bubblewrap, which needs a user namespace and a fresh `/proc`. These two options allow that without `--privileged` and without added capabilities.
- Three named volumes. `gcode-vscode-work` holds the container's copy of the checkout being tested and its Linux `node_modules`; every checkout shares it, one run at a time under the lock in `scripts/test-vscode-docker.sh`, so it does not pile up per worktree. `gcode-vscode-download` holds the VS Code download, which every checkout shares under the download lock in `packages/extension/test/vscode-setup.ts`. `gcode-vscode-pnpm` is the pnpm store.

The host checkout is mounted read-only. Each run copies it into the work volume, then runs `pnpm install` and `pnpm -r build` before the tests. Runs from any checkout queue one at a time, because the Docker VM is small and each run starts a whole VS Code.

## Screenshots

A suite's `screenshots()` switches the color theme three times and back, with a pause per switch for the window to repaint, and takes a shot in each. Without `GCODE_SCREENSHOTS` it returns at once (`suite/shooting.ts`), since the webview tests check the themes. The pauses took at least 31% of the file time before. The CPU profiles of `style`, `start` and `working` run only with `GCODE_PERF=1`; `start` and `working` spent more than 60 s each on them.

Set `GCODE_SCREENSHOTS` to a folder, on the host or for the container. The container writes the screenshots there:

```sh
GCODE_SCREENSHOTS=/tmp/shots pnpm test:vscode:docker packages/extension/test/style.integration.test.ts
```

Linux screenshots differ from macOS ones in these ways:

- VS Code draws its own title bar with a menu bar (File, Edit, Selection and so on).
- The UI font is Noto Sans and the editor font is DejaVu Sans Mono, which is wider than the macOS font.
- Keybinding hints read Ctrl and Shift instead of the macOS symbols.
- Scrollbars are classic, always shown and with arrow buttons, instead of macOS overlay scrollbars.

Use macOS screenshots for visual review of fonts and scrollbars. Use the container's screenshots for layout, color and state.

## Checks that run only on macOS

A suite check that only means something on macOS goes through `onMac(reason, run)` in `packages/extension/test/suite/mac-only.ts`. On another platform it logs `[mac-only] skipped on <platform>: <reason>` and skips the check. On macOS every assertion still runs.

| Suite | Check | Reason |
| --- | --- | --- |
| `suite/widget.ts` | Copy as Image puts a PNG on the clipboard | The clipboard is read through `osascript`. |

## Timing

Measured on 2026-10-06 on an Apple silicon Mac, with Docker 29.8.0 on linux/aarch64:

- Container, full `vscode` project: 28 files and 29 tests, all passed. Vitest reported 1065s. The wall time was 1071s, which includes the copy, install and build, with the image and volumes already in place.
- Host, full `vscode` project: about 1003s. This is the 1019.6s of a host `pnpm test` run minus about 17s for the `unit` project.

The container is about 7% slower than the host. The first run on a machine also builds the image and downloads VS Code.

Measured on 2026-10-07 on a 10-core Apple silicon Mac, host, full `vscode` project with 46 files: 1,769 s and 1,800 s one file at a time, 600 s and 605 s three at a time, 452 s and 462 s four at a time. The three ported webview files take 1.7 to 2.5 s each, against 31 to 64 s in VS Code.

Measured on 2026-10-08 on the same Mac, host, full `vscode` project with 53 files, through `pnpm test:vscode`:

| Layout | Wall time | VS Code launches | Windows at once | Load (1 min) median |
| --- | --- | --- | --- | --- |
| One launch per file, 3 at a time (main before T3, 52 files) | 666 s | 52 | 3 | not recorded |
| Pool of 2 windows, run D | 451 s | 7: 5 pooled, 2 of their own | 2 | 12.7 |
| Pool of 2 windows, run E | 585 s, 506 s before the retry | 6, and 2 more for the retry | 2 | 17.9 |
| Pool of 1 window, the default, final run | 1,022 s, 917 s before the retry | 5: 3 pooled, 2 of their own, and 1 more for the retry | 1 | 10.6 |

The final run passed 52 of 53 files the first time and all 53 after the retry. `start` failed once on its peek check (`the peek ducks rather than vanishing`) and passed on the retry. Its file times add up to 871 s, so one window can do no better than about 870 s. The old layout took 1,769 to 1,800 s one file at a time, for 46 files, so the pool takes about 57% of that time with 53. It is slower than three launches at once (666 s), which the Mac's memory no longer allows.

Run D passed all 53 files the first time. In run E, at a load of 18 to 24, four files failed the first time: `attention` (the 30-second wait for the card after the reload), `widget` (the grown widget's height), `composer` (one model request short) and `settings` (a user setting write that did not land in 60 s). The first three passed on the retry; `settings` failed again. `settings` ran first in a newly launched window in the retry, so no earlier suite's state reached it.

For an engine change outside the request shapers, such as `packages/engine/src/checkpoints.ts`, `pnpm test:affected` picks `chat`, `panel` and `working`. Their VS Code part took 136 s in 2 launches, most of it `working`. `working` now takes about 7.5 s, since its CPU profile runs only with `GCODE_PERF=1` and its panel checks are in `webview/working.webview.test.ts`.

The file times in run D add up to 839 s, so two windows can finish in no less than about 420 s, and the run took 447 s of vitest time. The pool is limited by the suites themselves: `start` (101 s) and `working` (95 s) were a quarter of it. They now take about 2.3 s and 7.5 s, with their panel checks in the webview project (`docs/t1-fast-tests.md`). The other agents on the machine kept the load between 7 and 22 during both runs, so a quiet machine is faster. `modes` now takes about 9 s; its five screenshot loops held about 36 s of pauses, by a count of the sleeps in them.
