# Real-model runs

Every run of the real-model campaign, kept whole so it can become a recording for the shared fake model (`packages/engine/test/recordings`, see [docs/testing.md](../../../testing.md)), a regression eval, or an example. `node scripts/real-usecases/archive.mjs` writes this folder from the campaign's scratch output. It strips the Model Studio key, the workspace URL and any Authorization header, and fails if the key is still in any file, gzipped ones included.

## Index

`index.json` lists one entry per run: `case`, `layer` (A is the headless engine, B the VS Code panel), `run`, `model`, `date`, `passed` (every check of the run passed), `costUsd`, `modelCalls`, `dir`, the files, and `goodExample`. A good example passed every check, made at most 10 tool calls and logged no error, so its transcript is short and readable.

## A Layer A run: `runs/<case>/<run>/`

| File | What it holds |
|---|---|
| `case.json` | The prompts, mode, limits, env, settings overlay, the fixture's name and source (`scripts/real-usecases/fixtures.mjs`), its setup step, the workspace's initial commit hash, and the command that runs the case again. |
| `session.jsonl` | The session log as Geno wrote it. `child-<id>.jsonl` is a subagent's log. |
| `wire.jsonl` | Every HTTP request body the engine sent and the raw response stream it got, from `GCODE_WIRE_LOG`. Runs from the first batch have no wire log; they have `requests.jsonl` instead. |
| `requests.jsonl` | Each model request as sent, rebuilt by the engine from the log with `gcode session request <id> <seq>` (the gateway's snapshot). The response of each request is the `assistant` event with the same `seq` in `session.jsonl`. |
| `diff.patch` | The workspace's change against its initial commit, untracked files included. |
| `transcript.md` | The prompts, the model's text, and each tool call with its result, in order. |
| `result.json` | Cost (model calls, subagents and the Auto classifier), tokens, summed model latency, errors, and each check with its verdict. |

A file over 200 KB is gzipped (`.gz`).

## A Layer B step: `runs/<step>/<run>/`

`result.json` is the step's report from the suite, `session-<id>.jsonl` and `transcript-<id>.md` are the chats the step started (a lane is a chat of its own), and `case.json` names the screenshots in `shots/r<run>/`. The run's whole wire log and final diff are in `runs/B-panel/<run>/`.

## Expanding a request

To keep the logs small, a request that repeats the previous request of the same kind (same URL, with or without tools) stores the repeat as a reference: `system` or `tools` is `{"$same": true}`, and `messages` is `{"$prefix": n, "tail": [...]}`, the previous request's first `n` messages followed by `tail`. To expand a file in order:

```js
const last = new Map();
for (const entry of lines.map((l) => JSON.parse(l)).filter((e) => e.request?.messages)) {
  const r = entry.request, kind = `${entry.url ?? ''}|${r.tools === undefined ? 'no-tools' : 'tools'}|${r.tool_choice === undefined ? '' : 'forced'}`, prev = last.get(kind);
  if (!Array.isArray(r.messages)) r.messages = [...prev.messages.slice(0, r.messages.$prefix), ...r.messages.tail];
  if (r.system?.$same) r.system = prev.system;
  if (r.tools?.$same) r.tools = prev.tools;
  last.set(kind, r);
}
```
