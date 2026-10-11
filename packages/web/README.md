# Geno web

Geno's chat panel in an ordinary browser. The extension's own chat host runs under Node with `vscode` replaced by a shim (`src/vscode-shim.ts`), and starts the engine exactly as the extension does.

## Start it

```sh
pnpm web -- --workspace <dir> [--trust] [--port <n>]
```

The command builds the extension and this package, then prints one line:

```
Geno web: http://127.0.0.1:<port>/?token=<token>
```

Open that address. The token moves into a cookie and leaves the address bar. Add `?theme=light` for the light theme.

- `--workspace` is the project folder. It defaults to the folder you ran the command in.
- `--trust` trusts the folder, as VS Code's workspace trust does, so its own hooks run in the engine.
- `--port` picks the port. It defaults to a free one.

## Settings and keys

Settings live in `$GCODE_HOME/web-settings.json` (by default `~/.g-code/web-settings.json`), keyed like VS Code's `settings.json`, for example `{ "gcode.provider": "openrouter" }`. The panel's own settings page writes to it.

Keys come from the environment the command runs in, under the names the extension reads (`DASHSCOPE_API_KEY`, `OPENROUTER_API_KEY`, and so on). A key set in the page lasts until the server stops; the web host never writes a key to disk.

## What differs from VS Code

There is no editor. Opening a file, revealing it, or showing a diff shows a toast that says what VS Code would have done. Keep and Undo on reviewed changes need VS Code's review, which is not loaded. The engine sees no unsaved buffers, diagnostics or terminals. Open and save dialogs ask for a path instead.

## How it is checked

```sh
pnpm vitest run --project unit packages/web/test
```

`web.e2e.test.ts` runs the built host against the engine's fake model, sends a prompt and answers a permission card over the host's own wire, and loads the panel in Chromium.
