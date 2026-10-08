# Testing

Geno has three vitest projects:

- `unit` runs in seconds on any machine.
- `webview` loads the chat panel in headless Chromium against a fake extension host, for the files in `packages/extension/test/webview/*.webview.test.ts`. It takes a few seconds and opens no window.
- `vscode` launches a real VS Code for each file in `packages/extension/test/*.integration.test.ts`, three files at a time, and each launch opens a window.

## Test what a change can break

While you work, and before you merge a unit, run only what the change can break:

```sh
pnpm test:affected            # VS Code files on the host
pnpm test:affected --docker   # VS Code files in the container
pnpm test:affected --dry      # print the files and why, run nothing
```

It diffs the branch against its merge base with `main` (`--base <ref>` picks another), then runs `pnpm typecheck`, `pnpm lint:deps`, the unit tests vitest relates to the changed files (`--changed`), every webview test, and only these VS Code integration files (the rules are in `scripts/affected.ts`):

- A file whose own test or suite part changed.
- Every file, when the harness changes: `vitest.config.ts`, the lockfile, `package.json`, `launch.ts`, `vscode-setup.ts`, `suite/index.ts`, `scripts/vscode-workers.ts`.
- `chat`, `panel` and `working` when engine or core source changed, since those suites drive whole turns.
- Every file that reads a request's `messages`, `system`, `tools` or `tool_choice`, or a session log, when a file that shapes the request or the turn's events changed: the opening, Geno's notices and arrivals, the mode's prompt and tools, tool result text, and the turn loop (`REQUEST_SHAPERS` in `scripts/affected.ts`). That is about 39 of 52 files. Without this rule, P5, P6, P11 and P17 changed the request on purpose and ten suites that check it failed only on the next full run.
- For panel source, the suites that name a class, data value, message type, command id or module that the changed lines name. A token that 60% of the suites use says nothing and is skipped. If no suite names anything the change touched, `panel`, `chat` and `composer` run.

A small panel change runs 2 to 8 files instead of 30. Run the full suite once per batch of merges, before a release or an install, not after every change.

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

The unit and webview projects use at most `GCODE_TEST_WORKERS` workers (default 4), and a run lowers its own CPU priority, so the editor stays usable while tests run. Four delegates once ran full suites at once with every core each, and the Mac froze.

While working on a change, run only the test files it touches (`pnpm vitest run --project unit <file>`). Run `pnpm test:affected` once at the end, not a full `--project unit` run as well.

## Files at once

`GCODE_VSCODE_WORKERS` sets how many VS Code files run at once. The default is 3, which runs the full project in about 10 minutes instead of 30 on a 10-core Mac. Each file has its own workspace, user data, extensions dir, `GCODE_HOME`, engine socket and ports, and `vscode-setup.ts` builds the extension once per run, so no file rewrites `dist` while another loads it. `docs/t1-fast-tests.md` has the runs at 1 to 4.

```sh
GCODE_VSCODE_WORKERS=4 pnpm vitest run --project vscode   # nobody uses the Mac
GCODE_VSCODE_WORKERS=1 pnpm vitest run --project vscode   # one window at a time
```

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

The container runs VS Code under Xvfb, so no window appears on the host's screen. It runs one file at a time, since the Docker VM is small, unless `GCODE_VSCODE_WORKERS` says otherwise. One file takes about 7% longer there than on the host, so the host at three files at once finishes about three times sooner.

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

Set `GCODE_SCREENSHOTS` to a host folder. The container writes the screenshots there:

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
