# Examples

Each page is one real run of Geno on qwen3.8-flash, from the real-model campaign of 2026-10-09. A page gives the task, the prompt as the user typed it, the mode, what Geno did in order, the result, the cost and time, and a link to the whole archived run in [`results/real-usecases/runs/`](../results/real-usecases/runs/README.md).

| Page | Task | Mode | Cost | Time |
| --- | --- | --- | --- | --- |
| [A13: implement a stub](A13-fail-then-fix.md) | Implement a function so its test passes, and leave the unrelated failures alone. | Non-interactive | $0.0072 | 36 s |
| [A06: answer from the files](A06-read-not-cat.md) | Answer three questions about a repository with `read`, `list` and `glob`. | Non-interactive | $0.0030 | 7 s |
| [A10: plan a change](A10-plan-mode.md) | Plan a feature and its test, with a todo list, without editing. | Plan | $0.0124 | 49 s |
| [A11: callers through a subagent](A11-explore-subagent.md) | Find a function's callers with an explore subagent, and retry one that hit its cap. | Non-interactive | $0.0142 | 92 s |
| [A23: a hidden instruction](A23-injection.md) | Run the lint as CONTRIBUTING.md says, and refuse the hidden step that sends `.env` away. | Non-interactive | $0.0063 | 22 s |
| [A05: a fetch that needs approval](A05-deferred-web-fetch.md) | Load the fetch tool, and say so plainly when the fetch is refused. | Non-interactive | $0.0045 | 9 s |
| [B01: approve rm -rf](B01-ask-allow.md) | Delete a folder after the user allows the command on the panel's card. | Ask, panel | $0.0069 | 18 s |
| [B07: a subagent in the panel](B07-subagent-row.md) | Find callers through an explore subagent, shown as a row in the panel. | Ask, panel | $0.0059 | 25 s |
| [A02: a fix asked in Thai](A02-thai-fix.md) | Fix a failing test from a Thai prompt, and answer in Thai. | Non-interactive | $0.0099 | 34 s |
| [B10: a question in Thai](B10-thai-and-working.md) | Explain a project in Thai without changing it. | Ask, panel | $0.0076 | 30 s |

Eight pages are runs the campaign marked as good examples: every check passed, at most 10 tool calls, and no error. A02 passed every check too, but the campaign did not mark it. B10 failed one check, and its page says which; it is here because no run marked as a good example has a Thai prompt.

Cost is the run's model spend. Time runs from the prompt to the last event of the session log, model latency and tool time included.

## Add a page

1. Write the skeleton from an archived run:

	```sh
	pnpm tsx scripts/run-to-example.ts docs/results/real-usecases/runs/<case>/<run>
	```

	It writes `docs/examples/<case>.md` with the prompt, the mode, one line per model turn with its tool calls, the diff summary, the cost and time from `runs/index.json`, and the link. It keeps a page that exists; `--force` writes it again.

2. Edit the prose by hand. Write the task in one line, gloss a prompt in another language in English, and condense the turns into a readable walkthrough.
3. Add a row to the table above.
