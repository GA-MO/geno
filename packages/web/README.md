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

The actions VS Code puts in the chat view's title bar (New Chat, History, Lanes, Tasks, MCP Servers, Models and Keys) sit at the right of the panel's header, read from the extension's manifest when the host starts, so a new one shows up here too. When the page is too narrow for every icon, the rest move to a `…` menu. Memory and the rules open with `/memory` and `/rules`, as in VS Code.

There is no editor. Opening a file, revealing it, or showing a diff shows a toast that says what VS Code would have done. The engine sees no unsaved buffers, diagnostics or terminals. Open and save dialogs ask for a path instead.

Review runs VS Code's own review code. A turn's Undo restores the checkpoint before the turn, and in review mode (`"gcode.review.mode": "review"`) Keep and Undo on a hunk work from the diff cards. Both write to disk, so an editor open on the folder reloads the files. The review differs from VS Code's in these ways:

- There are no CodeLens buttons, highlights or Changes view, because there is no editor. Decide in the chat.
- An undo goes straight to disk, not through an editor buffer, so an editor with unsaved changes to that file does not see it until it reloads.
- An edit made in another editor reaches the review only when the web host next reads the file. That happens before each undo, so a hunk still lands in the right place after an edit elsewhere in its file.

## How it is checked

```sh
pnpm vitest run --project unit packages/web/test
```

`web.e2e.test.ts` runs the built host against the engine's fake model. Over the host's own wire it sends a prompt, answers a permission card, undoes a turn, and keeps and undoes hunks in review mode, then reloads the host to check the engine logged those decisions. It also loads the panel in Chromium, clicks a turn’s Undo, and opens the Lanes and MCP panes from the header’s actions, at 360px and from the narrow `…` menu.
