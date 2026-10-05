# Installing g-code

g-code ships as one `.vsix`. Once it is installed, chat, review, Cmd-K and Tab work without the repository checked out, a terminal open, or `node` on `PATH`.

## Build and install

```sh
pnpm install
pnpm package   # writes packages/extension/g-code-0.1.0.vsix
code --install-extension packages/extension/g-code-0.1.0.vsix
```

Then open **Geno: Models and Keys** from the gear in the chat view's title bar, or run **Geno: Set API Key** from the command palette. Set the chat provider's key, and for Model Studio its endpoint.

| Setting | Default | Meaning |
| --- | --- | --- |
| `gcode.provider` | `modelstudio` | The chat provider: one of the providers in the table below. |
| `gcode.model` | empty | Empty uses the provider's default, `qwen3.8-flash` on Model Studio. A provider with no default needs one. |
| `gcode.baseUrl` | empty | Model Studio's Anthropic-compatible endpoint. It embeds your workspace id and region. Read from your user settings only. |
| `gcode.providers` | `{}` | Values per provider that are not secret: `baseUrl`, AWS `region` and `profile`, Google Cloud `project` and `region`. Read from your user settings only. |
| `gcode.roles` | `{}` | The provider and model of the Auto-mode `classifier` and the `explore` helper. A role left out keeps Geno's default. |
| `gcode.tab.modelPath` | empty | Empty uses `~/.g-code/models/qwen2.5-coder-1.5b-q8_0.gguf`. |

Keys are stored in VS Code's SecretStorage, one entry per provider and secret field, never in settings. The settings page takes a key and then shows only that it is set. A key in the environment VS Code started with, such as `DASHSCOPE_API_KEY`, is used only when SecretStorage has none. The **Geno engine** output channel names where each key came from, never the key itself. Changing a key or any of these settings restarts the engine.

A base URL decides where your key is sent, so Geno reads it only from your user settings or your environment. A base URL in a workspace's `.vscode/settings.json` is ignored.

## Providers

| Provider | Format | Key | Other values |
| --- | --- | --- | --- |
| `modelstudio` | Anthropic | `DASHSCOPE_API_KEY` | `DASHSCOPE_BASE_URL` (required) |
| `openrouter` | Anthropic | `OPENROUTER_API_KEY` | |
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY` | |
| `bedrock` | Anthropic, through `@anthropic-ai/bedrock-sdk` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, or none for the default AWS chain | `AWS_REGION` (required), `AWS_PROFILE` |
| `vertex` | Anthropic, through `@anthropic-ai/vertex-sdk` | `GCODE_VERTEX_ACCESS_TOKEN`, or none for gcloud application default credentials | `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION` (both required) |
| `openai`, `gemini`, `deepseek`, `groq`, `cerebras`, `xai`, `mistral` | OpenAI Chat Completions | `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY` | |
| `azure-openai` | OpenAI Chat Completions, `api-key` header | `AZURE_OPENAI_API_KEY` | `GCODE_AZURE_OPENAI_BASE_URL` (required), such as `https://<resource>.openai.azure.com/openai/v1` |
| `ollama`, `lmstudio` | OpenAI Chat Completions | none, or `OLLAMA_API_KEY`, `LMSTUDIO_API_KEY` | Served on `127.0.0.1:11434` and `127.0.0.1:1234` |

The CLI reads these variables from its environment and from the `.env` next to the engine. Every provider except Model Studio takes a base URL override in `GCODE_<PROVIDER>_BASE_URL`, such as `GCODE_OPENAI_BASE_URL`. Costs are known for Model Studio, OpenRouter and Anthropic models; any other model shows its cost as unknown.

```sh
gcode providers list                      # each provider, and the variable it still needs
gcode providers models openai             # the models the provider lists
gcode providers test openai --model gpt-x # one tiny call
```

## What runs

- **The engine.** The extension carries the engine at `dist/engine/cli.js` and runs it with VS Code's own runtime (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`). It passes the provider, endpoint, model and key in the engine's environment. This engine reads no `.env`. `pnpm gcode` and the repository's `packages/engine/dist/cli.js` still read the repository's `.env`. The extension also points the engine at `rg` in `/opt/homebrew/bin` or `/usr/local/bin` when `GCODE_RG` is unset.
- **The Tab model server.** When Tab is on, the extension first asks `gcode.tab.endpoint` for `/health`. A server that already answers, such as one from `scripts/tab-server.sh`, is used and left alone. Otherwise, if the endpoint is on this machine and the model file exists, the extension starts `llama-server` from `/opt/homebrew/bin`, `/usr/local/bin` or `PATH`, with the flags `scripts/tab-server.sh` uses, and stops it when VS Code closes or Tab is turned off.

The status bar shows Tab as off, starting, on or failed. Hover it for the reason a start failed, and click it to turn Tab on or off.

## Checks

- `packages/extension/test/install.integration.test.ts` packs the `.vsix` and installs it with VS Code's command line into a throwaway extensions directory. It starts VS Code with `PATH=/usr/bin:/bin`, sets the key through the command, and runs a chat turn and a Tab completion against fake servers. It fails if the key appears in the test output or in any file VS Code, the engine or the extension wrote.
- `packages/extension/test/settings.integration.test.ts` sets an OpenAI key and base URL through the settings page, tests the connection, lists models, maps roles and runs a chat turn against a fake OpenAI-compatible server. It fails if the key appears in any file under VS Code's user data, the output channels included, or in the page.
- `pnpm tsx packages/engine/test/providers-smoke.ts` calls Model Studio live through both adapters: its Anthropic endpoint, and its OpenAI-compatible endpoint through the `openai` row with a base URL override.
- `pnpm tsx packages/extension/test/live-smoke.ts` does the same against Model Studio and a real `llama-server` that the extension starts. It reads the key from the repository's `.env`, or from the file `GCODE_ENV_FILE` names, and prints the estimated cost.
