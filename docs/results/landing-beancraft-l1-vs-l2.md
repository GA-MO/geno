# Landing bake-off: l1 against l2

Three runs a side in each round, the same brief, feedback, model and checks. Between them the Geno engine changed (commit f663761b): a browser call to a page that is gone, a deferred tool's failed first call, arrays sent as JSON text, the macOS sed note, and two prompt lines on checking before ending and on screenshots. The simulated user's "go on" also changed from Thai to English for both harnesses. Claude Code did not change, so its two rounds show how much a side moves from run to run alone.

## Geno

| | l1 | l2 |
|---|---|---|
| API cost, both rounds | $2.21 | $1.95 |
| model calls | 97 | 86 |
| tool errors | 17 | 16 |
| hand-backs (needless) | 4 (2) | 4 (0) |
| screenshots it took | 31 | 30 |
| ก brief checks (final) | 33/33 | 33/33 |
| ข quality checks (final) | 22/30 | 26/30 |
| ค motion checks (final) | 24/27 | 25/27 |

| in the transcripts | l1 | l2 |
|---|---|---|
| stale page | 13 | 13 |
| deferred preamble | 10 | 4 |
| array as JSON text | 1 | 0 |
| GNU sed on macOS | 1 | 0 |
| Thai reply | 3 | 0 |
| asks the user to check | 1 | 0 |

## Claude Code, for the run-to-run spread

| | l1 | l2 |
|---|---|---|
| API cost, both rounds | $1.30 | $1.37 |
| model calls | 52 | 51 |
| tool errors | 2 | 2 |
| hand-backs (needless) | 0 (0) | 3 (3) |
| screenshots it took | 12 | 16 |
| ก brief checks (final) | 33/33 | 33/33 |
| ข quality checks (final) | 23/30 | 22/30 |
| ค motion checks (final) | 24/27 | 24/27 |

| in the transcripts | l1 | l2 |
|---|---|---|
| stale page | 1 | 0 |
| deferred preamble | 0 | 0 |
| array as JSON text | 0 | 0 |
| GNU sed on macOS | 0 | 1 |
| Thai reply | 0 | 0 |
| asks the user to check | 0 | 1 |

## Judge on the final pages

| rubric | l1 | l2 |
|---|---|---|
| fixed before the run | Claude Code 7, Geno 0, tie 2 | Claude Code 2, Geno 2, tie 5 |
| taste (layout first) | Claude Code 6, Geno 0, tie 3 | Claude Code 4, Geno 2, tie 3 |

Counts are summed over the three runs of a side. "asks the user to check" is a pattern over the agent's text and misses rewordings. With three runs a side, a difference of one or two in a count is within what Claude Code's own two rounds show.

## Reading

- **Fixed in the transcripts.** Thai replies (3 to 0), arrays sent as JSON text (1 to 0), GNU sed on macOS (1 to 0) and asking the user to check what a tool could check (1 to 0) are gone from Geno's runs. The definition preamble on deferred tools fell from 10 to 4; the 4 left are first calls, which show the definition once by design.
- **Not fixed: stale pages, 13 and 13.** Every "go on" starts a new `gcode agent` process, so the browser starts fresh with only about:blank open, and Sonnet's first calls in the new segment still name page 2. The fix lists the open pages and the URL page 2 showed, and Sonnet then opens it again, but only after the first two or three parallel calls fail. Running on "the only open page" never applies, because the only page left is blank. The next step that would remove these errors is to open the missing page's last local URL again and run the call there. It is not built or measured yet.
- **Cost and turns.** Geno spent $1.95 against $2.21 and made 86 model calls against 97. Its needless hand-backs went from 2 to 0. Claude Code's own two rounds moved by $0.07 and 1 call, so these Geno changes are larger than the run-to-run spread on cost and calls. On tool errors (17 to 16) and screenshots (31 to 30) Geno did not move.
- **Checks.** Geno's final pages pass 4 more quality checks and 1 more motion check. Claude Code's final pages moved by 1 quality check between its rounds.
- **Judge.** The judge moved most. With the rubric fixed before the run, Claude Code went from 7 of 9 pairs to 2, and Geno from 0 to 2. Part of that is Claude Code's run-to-run spread, since nothing on its side changed. Three runs a side cannot separate the two.

