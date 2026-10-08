# How AI coding extensions test, and what Geno should change

Read 2026-10-08 from GitHub and official docs. "Unverified" marks what I could not confirm.

## (a) Per project

**microsoft/vscode-copilot-chat**

| Aspect | What they do |
| --- | --- |
| Layers | vitest unit tests (`*.spec.ts`, 335 files) with `vscode` aliased to a types shim; extension-host tests (`*.test.ts`) in a real VS Code; "simulation" tests (`*.stest.ts`, 57 files) that call real LLMs ([vitest config](https://github.com/microsoft/vscode-copilot-chat/blob/main/vite.config.ts), [CONTRIBUTING](https://github.com/microsoft/vscode-copilot-chat/blob/main/CONTRIBUTING.md)) |
| Full-VS-Code launches | One. esbuild globs every extension-host test into one `dist/test-extension.js`, and `@vscode/test-cli` runs it in one instance with `--disable-extensions --profile-temp` ([.esbuild.ts](https://github.com/microsoft/vscode-copilot-chat/blob/main/.esbuild.ts), [.vscode-test.mjs](https://github.com/microsoft/vscode-copilot-chat/blob/main/.vscode-test.mjs)) |
| Model calls | Responses are cached in the repo (`test/simulation/cache`, SQLite base plus layers). The cache key is SHA-256 of a salt plus the request JSON ([cachingChatMLFetcher.ts](https://github.com/microsoft/vscode-copilot-chat/blob/main/test/base/cachingChatMLFetcher.ts)), so any change to a request body is a cache miss. CI fails on a miss (`simulate-ci` = `--ci --require-cache`), and on an uncommitted change to `baseline.json`. Each test runs 10 times when recording. Only team members may add cache layers. |
| Per PR | One `pr.yml` with typecheck, lint, vitest, `simulate-ci` from cache, `xvfb-run -a npm run test:extension`, on Linux and Windows. Separate jobs check the cache: no duplicate keys, no untrusted cache changes ([pr.yml](https://github.com/microsoft/vscode-copilot-chat/blob/main/.github/workflows/pr.yml)) |
| Nightly | No nightly workflow in the public repo. Live re-recording happens on dev boxes. Any internal pipeline is unverified. |

**cline/cline**

| Aspect | What they do |
| --- | --- |
| Layers | Bun unit tests; `@vscode/test-cli` integration tests, all in one Mocha run ([.vscode-test.mjs](https://github.com/cline/cline/blob/main/apps/vscode/.vscode-test.mjs)); 70 webview-ui tests; 7 Playwright e2e files that drive real VS Code through `_electron.launch` ([helpers.ts](https://github.com/cline/cline/blob/main/apps/vscode/src/test/e2e/utils/helpers.ts)); a gRPC "testing platform" that replays JSON spec files against the core ([README](https://github.com/cline/cline/blob/main/apps/vscode/testing-platform/README.md)) |
| Full-VS-Code launches | One for integration. e2e runs `workers: 1`, `retries: 1` ([playwright.config.ts](https://github.com/cline/cline/blob/main/apps/vscode/playwright.config.ts)) |
| Model calls | e2e uses a local `ClineApiServerMock` HTTP server ([fixtures/server](https://github.com/cline/cline/blob/main/apps/vscode/src/test/e2e/fixtures/server/index.ts)). Real-LLM smoke tests and benchmarks live in `evals/`. The auto-running regression workflow is off for now ([evals README](https://github.com/cline/cline/blob/main/evals/README.md)) |
| Per PR | `dorny/paths-filter` skips jobs that a change cannot affect. VS Code test runtime is cached. Integration tests are retried up to 3 times on non-Linux. e2e runs on Ubuntu, Windows and macOS ([ext-vscode-test.yml](https://github.com/cline/cline/blob/main/.github/workflows/ext-vscode-test.yml), [ext-vscode-test-e2e.yml](https://github.com/cline/cline/blob/main/.github/workflows/ext-vscode-test-e2e.yml)) |

**continuedev/continue**

| Aspect | What they do |
| --- | --- |
| Layers | Core and GUI unit tests (37 GUI test files); 6 active VS Code e2e files under `vscode-extension-tester`, pinned to VS Code 1.95.0 ([package.json](https://github.com/continuedev/continue/blob/main/extensions/vscode/package.json), [e2e/tests](https://github.com/continuedev/continue/tree/main/extensions/vscode/e2e/tests)) |
| Model calls | `MockLLM` and `TestLLM` providers inside the product ([Mock.ts](https://github.com/continuedev/continue/blob/main/core/llm/llms/Mock.ts)), plus a mock LLM server for the CLI |
| Per PR | Sharded by file: one GitHub job per e2e file, crossed with two config modes, against one shared packaged VSIX. Heavy `actions/cache` use ([pr-checks.yaml](https://github.com/continuedev/continue/blob/main/.github/workflows/pr-checks.yaml)) |

**RooCodeInc/Roo-Code**

| Aspect | What they do |
| --- | --- |
| Layers | About 560 vitest files, 111 of them in webview-ui; `apps/vscode-e2e` with 12 suite files in one Mocha run ([suite/index.ts](https://github.com/RooCodeInc/Roo-Code/blob/main/apps/vscode-e2e/src/suite/index.ts)) |
| Model calls | e2e uses a real OpenRouter key ([.env.local.sample](https://github.com/RooCodeInc/Roo-Code/blob/main/apps/vscode-e2e/.env.local.sample)) |
| Per PR | Only lint, types, knip and unit tests on Ubuntu and Windows. No workflow runs the e2e ([code-qa.yml](https://github.com/RooCodeInc/Roo-Code/blob/main/.github/workflows/code-qa.yml)). Turborepo runs the tasks ([turbo.json](https://github.com/RooCodeInc/Roo-Code/blob/main/turbo.json)) |

**Kilo-Org/kilocode**

| Aspect | What they do |
| --- | --- |
| Layers | `bun test` units; about 20 Playwright specs against Storybook on `localhost:6007`, with no VS Code: visual regression, accessibility and race checks ([tests/](https://github.com/Kilo-Org/kilocode/tree/main/packages/kilo-vscode/tests), [visual-regression.yml](https://github.com/Kilo-Org/kilocode/blob/main/.github/workflows/visual-regression.yml)). A `vscode-test` script exists, but the PR workflow runs only `test:unit`, lint and knip ([test-vscode.yml](https://github.com/Kilo-Org/kilocode/blob/main/.github/workflows/test-vscode.yml)) |
| Model calls | `@opencode-ai/http-recorder`: a test records real HTTP or WebSocket traffic once into a JSON cassette and replays it. When `CI=true`, a missing cassette fails the test. Credentials are redacted by default. There is no overwrite mode: you delete the cassette to re-record ([README](https://github.com/Kilo-Org/kilocode/blob/main/packages/http-recorder/README.md)) |
| Per PR | Path filters. Unit tests run in measured shards (6 on Windows) ([test.yml](https://github.com/Kilo-Org/kilocode/blob/main/.github/workflows/test.yml)) |

**sourcegraph/cody**: the GitHub API returns 404, so the repo is private or gone. Unverified.

**microsoft/vscode, the editor itself**

The repo has separate runners for unit, integration, smoke and sanity tests ([test/README](https://github.com/microsoft/vscode/blob/main/test/README.md)). Each PR fans out into parallel jobs (Electron-Unit, Electron, Electron-Smoke, Browser, Remote) on each OS ([pr.yml](https://github.com/microsoft/vscode/blob/main/.github/workflows/pr.yml)). Each step has a timeout of 15 to 30 minutes, and Linux runs under an xvfb service ([pr-linux-test.yml](https://github.com/microsoft/vscode/blob/main/.github/workflows/pr-linux-test.yml)).

**VS Code docs**

`@vscode/test-cli` uses Mocha only. Labeled configs run one after another. A runner adds every matched file to one Mocha instance ([Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension)). Headless Linux needs `xvfb-run -a`, and the docs show a three-OS matrix ([Continuous Integration](https://code.visualstudio.com/api/working-with-extensions/continuous-integration)). The docs give no guidance on testing webviews. Mocking `acquireVsCodeApi` in a browser is a community pattern ([example](https://github.com/stack-spot/vscode-async-webview/blob/main/docs/client.md)).

## (b) The common pattern

1. **Few real-editor launches.** Every project that runs VS Code tests uses one launch per suite, not one per file (Copilot, Cline, Roo). Where they parallelize, they shard across CI jobs: Continue runs one job per file, and VS Code runs one job per layer.
2. **The real-editor layer stays small.** Most tests run in Node with a `vscode` shim, or in a browser. Kilo and Cline test the webview without VS Code. Kilo uses Storybook plus Playwright, with screenshots.
3. **No live model on a PR.** Projects use a recorded cache keyed by the request hash (Copilot) or cassettes (Kilo), and fail in CI on a miss. Others use a mock server or a mock provider. Copilot's request hash also acts as a snapshot test of the exact request body. Similar tools: [nock back `lockdown`](https://github.com/nock/nock#nock-back).
4. **Live-model evals run on a schedule or on demand**, not as PR gates. Cline keeps them in `evals/`. Copilot re-records on dev boxes.
5. **CI hygiene.** Path filters or affected detection ([Nx](https://nx.dev/docs/features/ci-features/affected), [Turborepo `--affected`](https://turborepo.dev/docs/crafting-your-repository/constructing-ci), [vitest `--changed`](https://vitest.dev/guide/cli)). Caches for the editor download and dependencies. Shards ([vitest `--shard`](https://vitest.dev/guide/cli), [Playwright sharding](https://playwright.dev/docs/test-sharding)). Bounded retries only at the slow layer (Cline: 1 to 3; [vitest `retry`](https://vitest.dev/config/retry)). Test-level quarantine lists: none seen in these repos. They skip whole files instead (Continue `*.skip.ts`).

## (c) Gaps in Geno, ranked

Geno today: 53 integration files, each launching VS Code (`packages/extension/test/launch.ts`); a hand-written `node:http` fake model per suite; 2 snapshot files in total; no `.github/` and no git remote, so there is no CI and every gate runs on the Mac.

| # | Change | Expected effect | Effort |
| --- | --- | --- | --- |
| 1 | Replace the theme-switch `sleep(1500)`/`sleep(300)` loops with waits on a condition, and run them only when `GCODE_SCREENSHOTS` is set. Repo measurement: at least 547 of 1,760 s (31%) is spent in these sleeps; the suites hold 51× `sleep(300)` and 18× `sleep(1500)`. | Full run about 600 s → about 420 s at N=3; `agents` 89 → about 10 s | S |
| 2 | Move the panel-only checks to the webview project, as `docs/t1-fast-tests.md` already sorts them (the Kilo and Cline pattern) | Each moved file saves about 4 s of startup plus its waits; `test:affected` runs fewer VS Code files on panel changes | M |
| 3 | Group the files into a few suites, each a single VS Code launch (the Copilot, Cline and Roo pattern). Keep isolation per suite for files that need their own `GCODE_HOME` or a reload. | Saves about 4 s × about 45 launches, plus less focus contention between windows (the widget-security flake class) | M |
| 4 | Build one shared recorded fake model: cassettes keyed by a hash of the request, failing on a miss under `CI`, with redaction (Kilo's recorder or Copilot's cache as the model). Replace the per-suite fakes. | Requests become golden files, which also answers the `REQUEST_SHAPERS` problem: a request change fails a fast unit test, not 39 VS Code files | M |
| 5 | Add an ACP contract-test layer: recorded engine↔extension message transcripts replayed against each side in Node (Cline's gRPC spec files are the analogue) | Moves the `chat`/`panel`/`working` engine-driven checks out of VS Code; `test:affected` can skip them on engine-only changes | M–L |
| 6 | Set up CI: GitHub Actions with unit+webview+typecheck on every PR; VS Code files sharded over a matrix (`--shard`, blob reports) under `xvfb-run -a`; cache `.vscode-test` and the Playwright browsers | PR wall time of about the longest shard (`start`, 111 s) plus setup, instead of 600 s on the dev Mac; frees the laptop | M |
| 7 | Retries only for the `vscode` project (`retry: 1`), and record retried passes as flakes | Removes reruns of the known load flakes (waits, attention, start) without hiding unit-test bugs | S |
| 8 | A scheduled live-model smoke against real providers, not a PR gate | Catches provider drift; costs PR time 0 | S–M |

Not verified: that the 4 s startup grows when suites are merged, that cassettes fit the streaming ACP path, and the PR-time figures for #3 to #6.
