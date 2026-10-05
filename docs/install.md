# Installing g-code

g-code ships as one `.vsix`. Once it is installed, chat, review, Cmd-K and Tab work without the repository checked out, a terminal open, or `node` on `PATH`.

## Build and install

```sh
pnpm install
pnpm package   # writes packages/extension/g-code-0.1.0.vsix
code --install-extension packages/extension/g-code-0.1.0.vsix
```

Then run **g-code: Set API Key** from the command palette, and set your Model Studio endpoint:

| Setting | Default | Meaning |
| --- | --- | --- |
| `gcode.provider` | `modelstudio` | `modelstudio` or `openrouter`. |
| `gcode.baseUrl` | empty | Model Studio's Anthropic-compatible endpoint. It embeds your workspace id and region. OpenRouter ignores it. |
| `gcode.model` | empty | Empty uses the provider's default, `qwen3.8-flash` on Model Studio. |
| `gcode.tab.modelPath` | empty | Empty uses `~/.g-code/models/qwen2.5-coder-1.5b-q8_0.gguf`. |

The key is stored in VS Code's SecretStorage, one per provider, never in settings. A key in the environment VS Code started with, such as `DASHSCOPE_API_KEY`, is used only when SecretStorage has none. The **g-code engine** output channel names where the key came from, never the key itself. Changing the key or any of these settings restarts the engine.

## What runs

- **The engine.** The extension carries the engine at `dist/engine/cli.js` and runs it with VS Code's own runtime (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`). It passes the provider, endpoint, model and key in the engine's environment. This engine reads no `.env`. `pnpm gcode` and the repository's `packages/engine/dist/cli.js` still read the repository's `.env`. The extension also points the engine at `rg` in `/opt/homebrew/bin` or `/usr/local/bin` when `GCODE_RG` is unset.
- **The Tab model server.** When Tab is on, the extension first asks `gcode.tab.endpoint` for `/health`. A server that already answers, such as one from `scripts/tab-server.sh`, is used and left alone. Otherwise, if the endpoint is on this machine and the model file exists, the extension starts `llama-server` from `/opt/homebrew/bin`, `/usr/local/bin` or `PATH`, with the flags `scripts/tab-server.sh` uses, and stops it when VS Code closes or Tab is turned off.

The status bar shows Tab as off, starting, on or failed. Hover it for the reason a start failed, and click it to turn Tab on or off.

## Checks

- `packages/extension/test/install.integration.test.ts` packs the `.vsix` and installs it with VS Code's command line into a throwaway extensions directory. It starts VS Code with `PATH=/usr/bin:/bin`, sets the key through the command, and runs a chat turn and a Tab completion against fake servers. It fails if the key appears in the test output or in any file VS Code, the engine or the extension wrote.
- `pnpm tsx packages/extension/test/live-smoke.ts` does the same against Model Studio and a real `llama-server` that the extension starts. It reads the key from the repository's `.env`, or from the file `GCODE_ENV_FILE` names, and prints the estimated cost.
