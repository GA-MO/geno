# T1: faster VS Code integration tests

The `vscode` vitest project ran its 46 files one at a time, each in a fresh VS Code, for about 30 minutes. T1 makes it faster in two steps. The first step runs several files at once: the full project now takes about 10 minutes by default. The second step moves the checks that only look at the chat panel into a headless browser, where a file takes 2 seconds instead of 30 to 60. This document has the measurements, the decisions, and the plan for the other files.

## Step 1: files in parallel

### What files shared

Each file already had its own temp workspace, user data dir, `GCODE_HOME`, engine socket and debug port:

- `makeWorkspace` makes a `gcode-ext-*` folder under the run's own TMPDIR (`scripts/test-tmp.ts`), with `workspace`, `home` and `ud` in it.
- The engine socket is `gcode-<hash>.sock` in TMPDIR. The hash covers the workspace path and `GCODE_HOME`, so two files never share an engine. The path is about 85 bytes, under the 104-byte macOS limit, and `socketPathOf` falls back to `/tmp` when it would not be.
- VS Code's own IPC socket is in the user data dir, also under TMPDIR, at about 90 bytes.
- Every port comes from `listen(0)` (the fake model servers) or `freePort()` (`--remote-debugging-port`). No test listens on a fixed port. The background fixtures print `localhost:5173` but listen on nothing.
- Every file passes its own `GCODE_HOME`. `CLAUDE_CONFIG_DIR` is one empty folder per run, and the engine only reads it.

Two things were shared, and T1 removes both:

- **The extensions dir.** `@vscode/test-electron` adds `--extensions-dir=<checkout>/.vscode-test/extensions` when the launch arguments name none. `setUp` now passes `--extensions-dir=<work>/extensions`. `installClean` already had its own.
- **`dist`.** `setUp` rebuilt the extension for every file, and `installClean` rebuilt it again to pack the `.vsix`. With files running at once, one file's esbuild rewrote `dist/extension.js` and the engine bundle while another file's VS Code loaded them. `vscode-setup.ts` now builds once per run, after the download, and `installClean` packs the current build with `packBuilt`.

The VS Code download in the main checkout's `.vscode-test` is still shared across worktrees. `vscode-setup.ts` downloads it under its lock before any file starts, so a file only reads it. `tab.integration.test.ts` still downloads Insiders on its own, without the lock. Only that file does this, so it never races itself.

### The setting

`GCODE_VSCODE_WORKERS` sets how many files run at once. `scripts/vscode-workers.ts` parses it: unset or empty means the default, and anything but a whole number of at least 1 stops the run with a message. `vitest.config.ts` passes it to the `vscode` project as `maxWorkers`, with `fileParallelism` on when it is above 1. `scripts/affected.ts` counts `scripts/vscode-workers.ts` as harness, so a change to it runs every file. `pnpm test:vscode:docker` passes the variable into the container and defaults it to 1 there, because the Docker VM has 4 CPUs and 4 GB.

### Measurements

Host: Apple silicon Mac, 10 cores, 16 GB, VS Code 1.140.0, on 2026-10-07 from 15:38 to 17:44. Each run is `GCODE_VSCODE_WORKERS=<n> pnpm vitest run --project vscode` on this branch, started only once no other vitest or VS Code test process ran (the U59 run had ended at 15:34). The runs went in the order N=1, 2, 3, 4, 4, 3, 2, 1, so drift falls on both ends. Three idle engine daemons from earlier runs in other worktrees stayed alive throughout, at 0% CPU. While the runs went, I ran the browser tests of step 2 a few times, a few seconds each. "Windows max" is the most VS Code main processes in a 5-second sample. It goes above N for a moment when a reload suite or `install` starts a second VS Code process as the first one exits.

| Config | Run | Wall time | Files passed | Failed files | Load (1 min) median / p90 / max | Windows max |
| --- | --- | --- | --- | --- | --- | --- |
| N=1 (before) | a | 1,769 s | 46/46 | none | 3.6 / 4.5 / 8.6 | 2 |
| N=1 (before) | b | 1,800 s | 46/46 | none | 3.3 / 3.8 / 4.6 | 2 |
| N=2 | a | 936 s | 44/46 | waits, widget-security | 3.8 / 5.0 / 6.9 | 5 |
| N=2 | b | 888 s | 46/46 | none | 3.4 / 5.4 / 9.0 | 5 |
| N=3 | a | 600 s | 46/46 | none | 4.6 / 6.3 / 8.5 | 4 |
| N=3 | b | 605 s | 44/46 | attention, widget-security | 4.8 / 8.0 / 12.7 | 4 |
| N=4 | a | 462 s | 45/46 | widget-security | 5.6 / 8.4 / 13.2 | 6 |
| N=4 | b | 452 s | 45/46 | start | 6.8 / 10.2 / 13.2 | 6 |
| N=3, the default, after the widget-security fix | final | 597 s | 46/46 | none | 5.8 / 8.3 / 9.4 | 6 |

The coordinator's earlier N=1 run on main took 1,852 s. The final run set no `GCODE_VSCODE_WORKERS`, so it ran the default of 3, at 17:56, after the defect checks below. Two runs per config is fewer than a benchmark wants. The two runs of each config differ by at most 48 s (5%), far less than the gaps between configs.

### What limits it

The files do not compete for the CPU. At N=1 the load median is 3.6 of 10 cores, and the sum of the per-file times stays between 1,760 s and 1,860 s at every N. So a file takes as long next to three others as it does alone, and N=4 packs the 1,825 s of file time into 462 s, close to the ideal 456 s. A file spends its time waiting inside the suite:

- A file's VS Code starts in about 4 s. `capture-themes.mts` launches one, opens the panel, switches four themes and exits in 9.4 s.
- The screenshot loops switch the color theme three times and back, with `sleep(1500)` and `sleep(300)` per switch, whether or not `GCODE_SCREENSHOTS` is set. A static count over the suites whose loops have the usual shape gives at least 547 s of the 1,760 s (31%) in those sleeps. `fold` spends about 35 of its 41 s there, and `agents` about 79 of 89 s.
- The longest file, `start` (111 s), sets the floor for any N.

### Flakes

No file failed at N=1. Each parallel failure came from one of four files:

- **widget-security** failed in 3 of 6 parallel runs, always on the red run's form check: `expected 'unreadable TypeError' to be 'navigated'`. The suite mounted its attack frames inside the panel's `.transcript`, and every render of the transcript removes children it did not build (`reconcile` in `src/chat/dom.ts`). A window that gains or loses the OS focus makes the extension reshow the background tasks, which renders the panel. With several test windows opening, focus moves between them during the suite's 6-second wait, and the frames vanish.
- **waits** timed out once at N=2, waiting for the chat after Escape closed the Tasks pane.
- **attention** timed out once at N=3, after a window reload, waiting 30 s for the permission card to show again in the chat. The load was 11.5 when that run started.
- **start** failed once at N=4. Its somersault check polls every 20 ms for 1.5 s for an upside-down frame, and under a load of about 10 the frame did not come in time.

Run alone after the eight runs, one at a time, `waits`, `attention` and `start` passed. `widget-security` failed alone too, with the same message, which fits the focus explanation: its window takes the focus as it opens. The fix mounts the frames in a container of their own on `<body>`, which the panel never renders. Before the fix, `widget-security` beside three other short files at N=4 (`diagram`, `review`, `browser`) failed 1 of 3 times. After it, the same setup passed 3 of 3, alone it passed 5 of 5, and the final full run at N=3 passed.

The other three are timing checks that a busy machine can miss: a 30-second wait for a card after a reload, an Escape that did not close a pane, and a 1.5-second window for an animation frame. Each failed once in the six parallel runs and never alone. They are follow-ups below.

### Decision

The default is 3. `vitest.config.ts` passes `vscodeWorkers(process.env, 3)`.

- N=3 takes about 600 s against 1,785 s at N=1, a third of the time. N=4 saves another 2.5 minutes.
- The user works on this Mac while the tests run. At N=3 the load median stays under 5 of 10 cores. At N=4 the p90 reached 8.4 and 10.2, and the one load-sensitive failure, the `start` animation check, came at N=4.
- Every config above 1 had a flake in one of its two runs. After the widget-security fix, N=3 ran clean in the final run.

Set `GCODE_VSCODE_WORKERS=4` when nobody uses the Mac, and `GCODE_VSCODE_WORKERS=1` to watch one window at a time. Docker stays at 1 unless the variable says otherwise. It was not measured at more. A run of two files in Docker passed after these changes, in 151 s with the copy, install and build.

## Step 2: the chat webview in a browser

### Why Playwright

Playwright was not a dependency. `playwright-core` 1.61.1 is one package of about 10 MB with no install script, and it drives the Chromium 149 build that Playwright's cache on this Mac already held (`~/Library/Caches/ms-playwright/chromium_headless_shell-1228`), so adding it downloaded no browser. It gives real mouse and key input, hit-tested clicks, `emulateMedia` for reduced motion, screenshots and a CDP session, which the ported checks need. The repository's own CDP client (`test/cdp.ts`) could drive a headless Chrome too, but it would need a launcher, request routing and screenshots written from scratch. On a machine without the cache, `pnpm --filter ./packages/extension exec playwright-core install chromium-headless-shell` fetches it. `GCODE_CHROMIUM` points the harness at another Chromium, such as `/usr/bin/chromium` in the test container.

### The harness

The files are in `packages/extension/test/webview/`:

- `harness.ts` has `openPanel(options)`. It builds the panel's browser bundles from `BUNDLES` in `build.mts` into a temp folder of its own, once per test file. A test sees the source as it is, without `pnpm build`, and never rewrites the `dist` that a VS Code file may be loading. It serves the page at `https://webview.test/index.html` with `pageMarkup` (`src/chat/page-markup.ts`, the markup `pageHtml` serves in VS Code), so the panel runs under its real CSP. It defines `acquireVsCodeApi` before the page loads. It returns a `Panel` whose helpers mirror the suites' own: `eval` binds `doc` as the suites' `panel()` does, `click(selector, text)` fails when something covers the target, and `theme`, `look`, `frame` and `screenshot` stand in for what VS Code and the window did.
- `host.ts` is `FakeHost`, the extension's side of the protocol in `src/chat/messages.ts`. It records every `FromView` message. `next(type)` returns each message of a type once, in order, including one that came before the call. `act(...actions)` applies each `Action` with the extension's own reducer (`src/chat/transcript.ts`), then delivers it. `post` sends the other `ToView` messages. Handlers run side by side, so a turn's handler can wait for the user's answer to a card, and `settled()` reports the first handler that threw. `openPanel` answers `ready` as the extension does: the roots, the transcript, the header, the window focus, the modes and the commands.
- `turns.ts` writes the engine's turns as the actions the extension would post: `turnStart`, `toolStart` and `toolEnd` with the engine's `<name> <target>` titles and ACP kinds, `editDiff`, and `round`, which is one fake-transport `toolCall` round.
- `theme.ts` and `themes/*.json` hold what VS Code gives a webview in each theme. `capture-themes.mts` captured them once from a real VS Code 1.140 window with the chat panel open: the 797 to 935 `--vscode-*` declarations on `<html>`, the body classes and `data-vscode-theme-*` attributes, the `_defaultStyles` stylesheet, and the panel's size (597 by 794). There are dumps for Dark Modern, Light Modern, Dark High Contrast and Light High Contrast. `themedPage` puts a dump on the page as VS Code's webview host does, and `applyTheme` switches it in place. The harness paints the theme's `--vscode-sideBar-background` behind the page, where VS Code shows the side bar through the transparent webview. Run `pnpm tsx packages/extension/test/webview/capture-themes.mts` again after a VS Code upgrade.

The `webview` vitest project runs `packages/extension/test/**/*.webview.test.ts` beside the unit tests. `pnpm test:affected` runs all of it, because the panel's bundles are not in vitest's import graph and the project takes seconds. `pnpm test:all` runs it with the unit tests. `host.test.ts` and `theme.test.ts` are unit tests of the harness itself.

The harness fails a test on an uncaught page error. It does not fail on console errors, because DOMPurify's parse of each Mermaid diagram reports a refused `<style>` element under the panel's CSP. The same report happens in VS Code, where no test reads the console.

### The ported files

Times are vitest's per-file times. The VS Code times are from the two N=1 runs. The browser times are the median of 10 runs of the `webview` project at 17:55, after the VS Code runs, with nothing else running. Each browser time includes building the bundles and starting Chromium.

| File | VS Code, N=1 (runs a, b) | Browser, median (range) | Faster by | Checks not ported |
| --- | --- | --- | --- | --- |
| fold | 40.9 s, 40.6 s | 2.08 s (2.02 to 2.11 s) | 20× | none |
| style | 56.3 s, 63.5 s | 2.52 s (2.49 to 2.54 s) | 24× | the Changes view hidden in the side bar; the rainbow GIF and perf traces, which run only with `GCODE_SCREENSHOTS` or `GCODE_PERF` |
| commands | 31.0 s, 31.2 s | 1.71 s (1.63 to 1.74 s) | 18× | none |

The whole `webview` project took 3.3 s of wall time (3.29 to 3.36 s), since vitest runs the three files at once. None of the 30 file runs failed. With `GCODE_SCREENSHOTS` set, the browser tests write `webview/<name>.png` for each shot the VS Code suites take, in dark, light and high contrast, at the panel's captured size.

Every other check in the three suites runs in the browser with the same expression and the same expected value. The engine's turns are written as actions, so these files no longer test the engine's tool titles or outputs. The VS Code versions and the `chat`, `panel` and `working` files still do. Two checks needed a change to hold in a faster page:

- **fold, full detail.** `look()` waits for the panel's next frame, since the view renders a new look on its next animation frame. In VS Code the round trips took longer than a frame.
- **commands, the stuck request.** The bubble's clipping is a `scroll-state(stuck: top)` container query, which Chromium settles on the frame after a scroll. The browser test scrolls, waits a frame, then reads. The VS Code check scrolls and reads in one evaluation, so it holds only while the request was already stuck before the scroll.

In the browser the window focus is a message. The commands test sends `window-focus: false` before its permission card, to check that the peek stays down in the case the VS Code suite's comment names: a test window without the focus.

### The defect checks

Each row broke one thing in the panel source, ran both versions of the file, and restored the source. `scripts/defect-check.sh <file> <from> <to> <tests...>` does this, and builds first for a VS Code file. Every defect failed both versions on the same check.

| Defect | Browser test | VS Code test |
| --- | --- | --- |
| `toggle` no longer calls `holdPlace()` (`webview.ts`) | fold fails: "opening the turn does not move the summary line: expected 438 to be less than 1" | fold fails on the same check: `{"before":154,"after":-373}` |
| Dark glass bubble fill 7% to 12% (`webview.css`) | style fails: "the user message is neutral glass, with no accent tint: expected 'rgba(255, 255, 255, 0.12)' to be 'rgba(255, 255, 255, 0.07)'" | style fails on the same check: `"fill":"rgba(255, 255, 255, 0.12)"` |
| Light glass base `#f5f5f5` to `#eeeeee` (`webview.css`) | style fails: "a light theme gets light glass on a plain light surface: expected 'rgb(238, 238, 238)' to be 'rgb(245, 245, 245)'" | style fails on the same check: `"surface":"rgb(238, 238, 238)"` |
| Glass no longer excludes high contrast (`webview.css`) | style fails: "high contrast has no blur: expected 'blur(14px) saturate(1.6)' to be 'none'" | style fails on the same check: `"blur(14px) saturate(1.6)"` |
| Command boxes `white-space: pre` (`command.css`) | commands fails: "the long command wraps in its box at about 300px, nothing cut off: expected { wraps: false, fits: false }" | commands fails on the same check: `{"wraps":false,"fits":false,"width":297}` |

The light and high-contrast rows fail only because the harness applies the captured theme classes and variables. Without them the page would be neither light nor high contrast.

## Which files could move

Each of the 46 files falls in one of three groups:

- **Browser.** Every check is on the panel, and the extension's side is a script of actions. The whole file can move.
- **Split.** The panel checks move to a browser file. A smaller VS Code file keeps what crosses into VS Code or the engine: what reaches the model, files on disk, settings, editors and the clipboard. The screenshot loops move with the panel checks, which removes most of their sleeps.
- **Stays.** The file tests VS Code, the engine, or the path between them.

| File | Group | Why |
| --- | --- | --- |
| agents | Stays | External agent CLIs, terminals, the clipboard and the settings command |
| arena | Stays | Lanes in worktrees, a review answer and a grafted file on disk |
| attachments | Split | The tray and thumbnails move; the image bytes and file text that reach the model stay |
| attention | Stays | Needs-you state across sessions and a window reload |
| auto-review | Stays | Editor documents and review hunks on disk, across a reload |
| backends | Stays | External backends and their config options |
| background | Stays | Background commands and what the model hears when they end |
| browser | Stays | The MCP browser server and Chrome |
| chat | Stays | Editor diagnostics, unsaved buffers and undo |
| commands | Browser | Ported in T1 |
| compact | Split | The divider card moves; the summary calls and the history stay |
| composer | Split | The toolbar, IME guard, `/` picker, queue, Stop and tray layout move; the effort that reaches the model and the `gcode.model` and `gcode.browser.enabled` writes stay |
| context | Split | The rules and memory panes move; a saved note in the next prompt stays |
| diagram | Split | Lazy loading, rendering and sizes move; the diagram tab and the clipboard stay |
| editor-actions | Stays | Opening files, revealing and diffs in the editor |
| fold | Browser | Ported in T1 |
| history-search | Split | The list and the hits move; the engine's search, Thai word breaks included, stays |
| install | Stays | Packs and installs the `.vsix` |
| lanes | Stays | Lanes, worktrees and applying a lane |
| mcp | Stays | MCP servers, trust and tool lists |
| mentions | Stays | Completions from workspace files, unsaved buffers and selections |
| modes | Split | The mode picker moves; the tools and tool choice per mode stay |
| panel | Split | The start page, Noodle, the composer and the cards move; Keep and Undo through the CodeLens commands, the clipboard and the files stay |
| permissions | Stays | Rules saved to disk |
| pr-status | Stays | The `gh` calls and their pacing |
| preview | Stays | Dev servers and the browser tools |
| question | Split | The card's tabs, Other row, markdown preview and colors move; the answers that reach the model stay |
| read-terminal | Stays | VS Code terminals and shell integration |
| review | Stays | Keep and Undo in the editor and on disk |
| rewind | Stays | Checkpoints, files and forks |
| sessions | Stays | Session logs, renaming and the trash |
| settings | Stays | Secret storage and provider requests |
| slash | Split | The picker moves; skill and command expansion in the prompt stays |
| spinoff | Stays | Starting a suggested task runs it |
| start | Browser | The start page, recent sessions from a `history` message, and Noodle's moves; its one request check is a `send` the host records |
| steer | Stays | Steering lands in the engine's next tool round |
| style | Browser | Ported in T1; two checks stay in VS Code |
| subagents | Stays | Child sessions and their reports |
| tab | Stays | Inline completions in the editor |
| todo | Split | The todo card moves; Plan offering the todo tool stays |
| usage | Split | The usage pane moves; the numbers the engine reports stay |
| waits | Stays | Network loss, retries and the offline probe |
| wake | Stays | Turns Geno starts when background tasks end |
| widget-security | Stays | The real webview host's sandbox and CSP, proven with red runs |
| widget | Split | The widget frame and its sandbox attributes move; Copy as Image and the widget tab stay |
| working | Browser | Noodle's working animation, the 300px layout and the footer |

That is 5 Browser, 13 Split and 28 Stays. The classification comes from each suite's checks and the VS Code APIs it calls. Only the three ported files are proven.

## Next steps

In order of what each saves:

1. **Port `start` and `working`.** They are the two longest files, 111 s and 99 s at N=1, and the longest file sets the floor for any N. Both are Browser files, and `start` holds the animation check that failed under load.
2. **Stop the screenshot loops from sleeping when nothing takes a screenshot.** Without `GCODE_SCREENSHOTS`, each loop still switches the theme three times and back, with 1.8 s of sleep per switch: at least 547 s of the 1,760 s of file time, about 180 s of a run at N=3. Returning early from each suite's `screenshots()` when the variable is unset removes them. The cost is that a normal run no longer switches themes in VS Code. The browser tests check the themes instead. Done in T3 (`suite/shooting.ts`), with the window pool in `docs/testing.md`.
3. **Port the 13 Split files.** Each keeps a short VS Code file for its end-to-end checks and moves its panel checks and screenshot loops to the browser.
4. **Harden the three timing flakes.** `attention-reload.ts` waits 30 s for a card to show again. Whether that is a slow replay under load, or a card that is sometimes never shown again, needs the engine log of a failing run. `waits.ts` presses Escape once and waits. `start.ts` polls an animation for 1.5 s.
5. **Fix the stuck-request check in `suite/commands.ts`.** It reads a scroll-state query in the same task as the scroll, so it passes only while the request was stuck before.
6. **Stop the test engines.** An engine outlives its window by design, and some from test runs stay alive after the run's TMPDIR is gone: three from other worktrees, 5 to 10 hours old, and three from this branch's runs, which ignored SIGTERM. The suite teardown could stop the engine for its `GCODE_HOME`.
7. **Read the debug port from Chromium.** `freePort()` closes its socket before VS Code binds the port, so two files could in principle get the same port. `--remote-debugging-port=0` with the `DevToolsActivePort` file in the user data dir closes that gap. No run hit it.
8. **Capture the themes again on a VS Code upgrade.** The dumps are from 1.140.0, and the harness does not check the version.
