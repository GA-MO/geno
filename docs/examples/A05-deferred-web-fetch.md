# A05-deferred-web-fetch, run 1

**Task.** Read a heading from a web page, where the fetch tool must be loaded first and the fetch needs approval.

**Prompt**, as the user typed it:

> What is the main heading on https://example.com ? Just tell me the heading text.

**Mode.** Non-interactive (`gcode agent --non-interactive`): nobody can answer a question, so anything that needs approval is refused.

## What Geno did

1. "I'll load the web fetch tool and get the page." Calls `tool_search`, since `web_fetch` is listed by name only until it is loaded.
2. Calls `web_fetch https://example.com`. The fetch of another host needs the user's approval, and in this mode nobody can give it, so it is denied.
3. Says that it could not fetch the page and why, and does not guess the heading.

## Result

No file changed. The answer is an honest "I could not", which is what the case checks for in this mode.

Every check passed: yes. Cost $0.0045 for 3 model calls on qwen3.8-flash, 9 s from the prompt to the last event.

The full run, with the session log, the transcript and every check: [results/real-usecases/runs/A05-deferred-web-fetch/1](../results/real-usecases/runs/A05-deferred-web-fetch/1/).
