# Testing

Geno has two vitest projects. The `unit` project runs in seconds on any machine. The `vscode` project launches a real VS Code for each file in `packages/extension/test/*.integration.test.ts`, and each launch opens a window.

## Run the vscode project in Docker

By default, run the `vscode` project in a Linux container:

```sh
pnpm test:vscode:docker                                                  # every file
pnpm test:vscode:docker packages/extension/test/modes.integration.test.ts  # some files
```

The container runs VS Code under Xvfb, so no window appears on the host's screen. Do not run `pnpm test` or `pnpm vitest run --project vscode` on the host. Run the `vscode` project on the host only when the user says they are away from the machine.

## The merge gate

The full gate before a merge is:

```sh
pnpm typecheck && pnpm lint:deps && pnpm build && pnpm vitest run --project unit && pnpm test:vscode:docker
```

`pnpm test:all` runs exactly this.

## What the container needs

- Docker. The image is `node:22-bookworm` with Xvfb, the Electron libraries, Noto and DejaVu fonts, bubblewrap, and Chromium for the browser tool. Google ships no Linux arm64 Chrome, so the image links Chromium to `/opt/google/chrome/chrome`, where the browser server looks for Chrome.
- `--security-opt seccomp=unconfined --security-opt systempaths=unconfined`. The engine sandbox runs commands in bubblewrap, which needs a user namespace and a fresh `/proc`. These two options allow that without `--privileged` and without added capabilities.
- Three named volumes. `gcode-vscode-work-<checkout>` holds the container's copy of the checkout and its Linux `node_modules`. `gcode-vscode-download` holds the VS Code download, which every checkout shares under the download lock in `packages/extension/test/vscode-setup.ts`. `gcode-vscode-pnpm` is the pnpm store.

The host checkout is mounted read-only. Each run copies it into the work volume, then runs `pnpm install` and `pnpm -r build` before the tests. One run per checkout can run at a time, because the container is named after the checkout.

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
