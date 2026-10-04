# E0, E5, E6 and E14 results: Claude Code and g-code on qwen3.8-flash

Run on 2026-10-05 with `gcode eval run` over the 20 tasks in `~/.g-code/evals/tasks`. Both agents used Model Studio `qwen3.8-flash`. Every number below comes from one of these results files under `~/.g-code/evals/runs/`. `node scripts/eval-run-table.mjs <file>` reprints a file's table and totals.

| Run | Results file | Code |
|---|---|---|
| E0, Claude Code, all 20 tasks | `2026-10-04T19-49-13-629Z-claude-code-qwen3.8-flash/results.jsonl` | `c7c5f1f` |
| E0, Claude Code, `payload-site-url-runtime` again | `2026-10-04T20-48-41-258Z-claude-code-qwen3.8-flash/results.jsonl` | `749a9fc` |
| E5, g-code, all 20 tasks | `2026-10-04T21-18-46-458Z-gcode-qwen3.8-flash/results.jsonl` | `749a9fc` |
| E14, g-code with `--no-check-after-edit` | `2026-10-04T22-21-51-745Z-gcode-qwen3.8-flash/results.jsonl` | `6d5f942` |

Setup. Each task is cloned at its base commit into a fresh temp dir, set up, run by the agent, then verified with the task's hidden check. Setup and verify see only `PATH`, `HOME`, `LANG`, `TERM`, `TMPDIR` and `GCODE_TASK_DIR`. The per-task budget is $0.40 and the per-run budget $3, both estimated from our price table, which bills cache reads at the full input rate.

- Claude Code 2.1.289 runs as `claude -p <prompt> --output-format stream-json --verbose --model qwen3.8-flash --permission-mode bypassPermissions --no-session-persistence` inside the sandbox-runtime sandbox. It can write only the clone and the task's temp dir, and it can reach only the Model Studio host. `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` point it at Model Studio. `ANTHROPIC_MODEL`, the four `ANTHROPIC_DEFAULT_*_MODEL` variables, `ANTHROPIC_SMALL_FAST_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` all name `qwen3.8-flash`. `HOME`, `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_TMPDIR` are throwaway dirs in the task's temp dir. Turns are Claude Code's `num_turns`, which counts main-loop turns only. Tokens are the sum of its `modelUsage`, which also counts subagent calls, and cost is recomputed from those tokens.
- g-code runs `gcode agent` in-process with `--max-turns 40`, `--non-interactive` and `--check "npx tsc --noEmit"`, so the type checker runs after every successful edit. Its bash runs in the same sandbox with no network. Turns are model calls.
- E0 and E5 ran one after the other, not side by side, so wall times are not inflated by each other.

## E0: Claude Code

The first E0 run gave `payload-site-url-runtime` no agent run. Its setup copies a lockfile from `$GCODE_TASK_DIR`, which the runner did not yet pass to setup. Commit `749a9fc` fixed that and the task ran again on its own. The table takes that task's row from the second file and every other row from the first.

| Task | Pass | Stop | Turns | Tokens (in / cache read / cache write / out) | Cost | Agent wall time | Denials |
|---|---|---|---|---|---|---|---|
| next-about-translations | yes | success | 13 | 54 / 141,922 / 19,854 / 2,674 | $0.0263 | 45 s | 0 |
| next-api-host-base-url | yes | success | 18 | 84 / 245,944 / 21,759 / 3,228 | $0.0425 | 60 s | 0 |
| next-base-path | no | success | 47 | 372 / 1,414,706 / 51,890 / 22,784 | $0.2327 | 407 s | 0 |
| next-counter-floor | yes | success | 9 | 42 / 100,783 / 18,275 / 1,938 | $0.0195 | 33 s | 0 |
| next-demo-delete | yes | success | 28 | 96 / 374,493 / 29,956 / 5,784 | $0.0645 | 92 s | 0 |
| next-demo-list-query-key | yes | success | 6 | 36 / 82,773 / 17,774 / 1,215 | $0.0163 | 25 s | 0 |
| next-demo-services-consolidate | yes | success | 21 | 66 / 195,132 / 23,580 / 3,953 | $0.0356 | 66 s | 0 |
| next-fetcher-auth-token | yes | success | 30 | 138 / 526,439 / 30,484 / 9,670 | $0.0892 | 161 s | 0 |
| next-fetcher-empty-error-body | yes | success | 21 | 108 / 395,037 / 29,363 / 9,840 | $0.0694 | 171 s | 0 |
| next-form-submit-item | yes | success | 9 | 42 / 111,797 / 20,528 / 1,320 | $0.0212 | 26 s | 0 |
| next-theme-typography | yes | success | 9 | 36 / 90,633 / 21,048 / 3,544 | $0.0192 | 56 s | 0 |
| payload-dayjs-bangkok | yes | success | 19 | 96 / 417,762 / 36,077 / 12,668 | $0.0754 | 212 s | 0 |
| payload-local-db-ipv6 | yes | success | 16 | 78 / 348,041 / 35,303 / 11,900 | $0.0644 | 182 s | 0 |
| payload-manual-code-fences | yes | success | 37 | 168 / 1,236,368 / 62,597 / 31,753 | $0.2121 | 497 s | 0 |
| payload-manual-search-words | yes | success | 21 | 114 / 558,248 / 41,144 / 16,013 | $0.0990 | 239 s | 0 |
| payload-metadata-media-image | yes | success | 28 | 144 / 706,973 / 43,310 / 15,880 | $0.1217 | 276 s | 0 |
| payload-migration-check-lines | yes | success | 22 | 126 / 598,543 / 37,634 / 13,166 | $0.1030 | 217 s | 0 |
| payload-noindex-env | yes | success | 50 | 216 / 1,193,871 / 49,013 / 19,084 | $0.1973 | 339 s | 0 |
| payload-page-metadata-helper | no | success | 39 | 180 / 1,116,334 / 54,309 / 20,431 | $0.1873 | 337 s | 0 |
| payload-site-url-runtime | no | timeout | 53 | 970,236 / 0 / 0 / 0 | $0.1455 | 1800 s | 0 |
| **Total** | **17/20** | | 496 | 972,432 / 9,855,799 / 643,898 / 206,845 | $1.8422 | 5,240 s | 0 |

## E5: g-code

| Task | Pass | Stop | Turns | Tokens (in / cache read / cache write / out) | Cost | Agent wall time | Denials |
|---|---|---|---|---|---|---|---|
| next-about-translations | yes | end_turn | 13 | 78 / 52,885 / 7,311 / 2,667 | $0.0106 | 59 s | 0 |
| next-api-host-base-url | yes | end_turn | 18 | 108 / 151,567 / 13,000 / 8,986 | $0.0294 | 166 s | 0 |
| next-base-path | no | max-turns | 40 | 240 / 820,841 / 37,179 / 17,605 | $0.1384 | 353 s | 0 |
| next-counter-floor | yes | end_turn | 14 | 84 / 65,019 / 5,158 / 3,304 | $0.0123 | 71 s | 0 |
| next-demo-delete | yes | end_turn | 33 | 198 / 442,124 / 22,200 / 10,610 | $0.0755 | 224 s | 0 |
| next-demo-list-query-key | yes | end_turn | 21 | 126 / 207,333 / 13,215 / 6,650 | $0.0367 | 144 s | 0 |
| next-demo-services-consolidate | yes | end_turn | 18 | 108 / 108,327 / 8,334 / 4,203 | $0.0198 | 84 s | 0 |
| next-fetcher-auth-token | yes | end_turn | 13 | 78 / 118,308 / 14,240 / 10,880 | $0.0255 | 185 s | 0 |
| next-fetcher-empty-error-body | yes | end_turn | 12 | 72 / 92,484 / 10,746 / 7,918 | $0.0196 | 142 s | 0 |
| next-form-submit-item | yes | end_turn | 28 | 168 / 269,683 / 16,978 / 8,118 | $0.0475 | 165 s | 0 |
| next-theme-typography | yes | end_turn | 15 | 90 / 85,246 / 5,914 / 2,296 | $0.0150 | 62 s | 0 |
| payload-dayjs-bangkok | yes | end_turn | 8 | 48 / 23,827 / 1,613 / 1,346 | $0.0045 | 30 s | 0 |
| payload-local-db-ipv6 | yes | end_turn | 11 | 66 / 100,861 / 12,402 / 8,111 | $0.0213 | 149 s | 0 |
| payload-manual-code-fences | yes | end_turn | 14 | 84 / 163,444 / 20,316 / 12,725 | $0.0343 | 207 s | 0 |
| payload-manual-search-words | yes | end_turn | 22 | 132 / 306,208 / 20,660 / 12,814 | $0.0558 | 233 s | 0 |
| payload-metadata-media-image | yes | max-turns | 40 | 240 / 799,305 / 31,963 / 15,851 | $0.1334 | 317 s | 0 |
| payload-migration-check-lines | yes | end_turn | 13 | 78 / 108,109 / 11,929 / 7,108 | $0.0218 | 140 s | 1 |
| payload-noindex-env | yes | max-turns | 40 | 240 / 1,033,634 / 43,218 / 16,963 | $0.1712 | 327 s | 0 |
| payload-page-metadata-helper | no | end_turn | 32 | 192 / 444,084 / 23,310 / 12,310 | $0.0768 | 258 s | 0 |
| payload-site-url-runtime | no | end_turn | 39 | 234 / 863,717 / 38,018 / 18,333 | $0.1453 | 356 s | 1 |
| **Total** | **17/20** | | 444 | 2,664 / 6,257,006 / 357,704 / 188,798 | $1.0948 | 3,669 s | 2 |

## Side by side

| | Claude Code (E0) | g-code (E5) |
|---|---|---|
| Passed | 17/20 (85%) | 17/20 (85%) |
| Turns | 496 | 444 |
| Tokens (in / cache read / cache write / out) | 972,432 / 9,855,799 / 643,898 / 206,845 | 2,664 / 6,257,006 / 357,704 / 188,798 |
| Estimated cost | $1.8422 | $1.0948 |
| Agent wall time | 5,240 s | 3,669 s |
| Denials | 0 | 2 |

E5's hypothesis was that g-code reaches at least 80% of the E0 pass rate at similar cost. It reaches 100% of it (17 against 17) at 59% of the cost. The same 17 tasks pass for both agents, and both fail `next-base-path`, `payload-page-metadata-helper` and `payload-site-url-runtime`.

Claude Code's own cost figure for E0's first file is $14.13. It prices `qwen3.8-flash` with rates it does not know (`costBasis: "unknown"`), so the table uses our recomputation, as the brief asks.

## Failures

Each line comes from the task's transcript and the tail of its verify output in the results file.

- Claude Code, `next-base-path`. It read the base path from `NEXT_PUBLIC_BASE_PATH` with an empty default and set the value only in a new `.env.production` and the Dockerfile, so `next.config.ts` alone serves the app at `''`, not `/app-path`.
- Claude Code, `payload-page-metadata-helper`. The helper turns the share image into an absolute URL (`https://example.test/images/contact.jpg`), and the check expects the path it was given (`/images/contact.jpg`).
- Claude Code, `payload-site-url-runtime`. It ran `npm run build` in the background, which waits on Google Fonts with no network, then polled it with `sleep 400` until the 30-minute timeout killed it. The edits it had made so far still left `metadataBase` at the first `SERVER_URL`.
- g-code, `next-base-path`. It hit `--max-turns 40` while reading Next's compiled sources in `node_modules`, and the check still read the base path as `/`.
- g-code, `payload-page-metadata-helper`. The same cause as Claude Code's: the helper makes the image URL absolute, and the check expects the relative path.
- g-code, `payload-site-url-runtime`. The layout's `metadataBase` still read the `SERVER_URL` from the first call, so changing the variable at runtime did not change it.

## Cost accounting

The Claude Code timeout row is a lower bound. A killed run writes no result line, so its tokens come from the streamed messages, which carry input tokens only (970,236 here, $0.1455). Its output and cache-write tokens are missing.

## E6: sandbox friction

E6's hypothesis was fewer than 2 approval prompts per task with workspace-only writes and no network. The eval runs non-interactively, so every deny-list match is a denial instead of a prompt.

- g-code had 2 denials in E5 (0.1 per task) and 7 in E14 (0.35 per task). Every one is in the task's transcript, and none was a command that should have been stopped.
  - 5 were `rm -rf` of a scratch dir the model had just made: `$d` from `mktemp -d`, `$S` under `/tmp`, `.tmp-check` and `.scratch` inside the clone. The deny list sees `$d`, not the path it holds, and it denies `rm -rf` inside the workspace too, as the brief's "outside temp" rule says.
  - 2 were `curl` to a dev server the model had started on `127.0.0.1` (`next-base-path`, `payload-noindex-env` in E14).
  - 2 were the body of a heredoc that writes a scratch test (`payload-manual-search-words`, `payload-metadata-media-image` in E14). The splitter reads `from '../src/lib/manual'` inside the heredoc as a path argument that leaves the workspace.
- Claude Code had 0 permission denials, since it ran with `bypassPermissions` and the sandbox was its only limit. The sandbox did cost it one task: `next build` hangs on font downloads without network, and Claude Code waited on it until the timeout.
- Neither agent tried to install a package: no transcript has an `npm install`, `bun add`, `pnpm add` or `npx --yes` command.

Decision. Keep the network closed and the write allowlist as it is; the hypothesis holds at 0.1 and 0.35 denials per task. Every denial was a false positive of the deny list's parser, not of the sandbox policy, so the next changes go there: skip heredoc bodies when splitting a command, allow `rm -rf` of a target inside the task's temp dir or under the system temp dir, and allow `curl` to `127.0.0.1` and `localhost`. A `next build` that needs fonts would take a task-level allowlist entry for `fonts.googleapis.com` and `fonts.gstatic.com`; no verify command here needed one.

## E14: check after every edit

E0 and E5 together cost an estimated $2.94, under the $4 the brief sets for running E14. E14 ran on `6d5f942` with the same flags as E5 plus `--no-check-after-edit`. The `check` tool stayed available, so the model could still run the type checker when it chose to.

| Task | Pass | Stop | Turns | Tokens (in / cache read / cache write / out) | Cost | Agent wall time | Denials |
|---|---|---|---|---|---|---|---|
| next-about-translations | yes | end_turn | 11 | 66 / 47,613 / 4,666 / 2,273 | $0.0091 | 45 s | 0 |
| next-api-host-base-url | yes | end_turn | 16 | 96 / 133,922 / 10,844 / 7,846 | $0.0258 | 128 s | 0 |
| next-base-path | no | end_turn | 40 | 240 / 826,982 / 36,080 / 21,640 | $0.1410 | 428 s | 1 |
| next-counter-floor | yes | end_turn | 21 | 126 / 102,873 / 5,139 / 3,436 | $0.0180 | 79 s | 0 |
| next-demo-delete | yes | end_turn | 26 | 156 / 286,114 / 16,959 / 9,210 | $0.0504 | 162 s | 0 |
| next-demo-list-query-key | yes | end_turn | 23 | 138 / 169,508 / 9,534 / 5,697 | $0.0299 | 121 s | 0 |
| next-demo-services-consolidate | yes | end_turn | 15 | 90 / 100,320 / 7,596 / 3,515 | $0.0181 | 63 s | 0 |
| next-fetcher-auth-token | yes | end_turn | 20 | 120 / 200,618 / 15,761 / 10,717 | $0.0381 | 182 s | 0 |
| next-fetcher-empty-error-body | yes | end_turn | 16 | 96 / 185,525 / 15,694 / 12,311 | $0.0366 | 208 s | 0 |
| next-form-submit-item | yes | end_turn | 33 | 198 / 391,798 / 19,696 / 7,872 | $0.0662 | 169 s | 0 |
| next-theme-typography | yes | end_turn | 22 | 132 / 151,910 / 9,760 / 5,356 | $0.0272 | 126 s | 0 |
| payload-dayjs-bangkok | yes | end_turn | 15 | 90 / 71,872 / 7,111 / 4,241 | $0.0141 | 81 s | 0 |
| payload-local-db-ipv6 | yes | end_turn | 22 | 132 / 346,714 / 24,696 / 15,651 | $0.0640 | 281 s | 0 |
| payload-manual-code-fences | yes | end_turn | 28 | 168 / 566,507 / 32,557 / 19,614 | $0.1003 | 348 s | 1 |
| payload-manual-search-words | yes | end_turn | 28 | 168 / 508,696 / 25,686 / 10,440 | $0.0861 | 204 s | 2 |
| payload-metadata-media-image | no | max-turns | 40 | 240 / 1,268,263 / 57,675 / 35,587 | $0.2178 | 577 s | 1 |
| payload-migration-check-lines | yes | end_turn | 11 | 66 / 89,873 / 10,625 / 6,721 | $0.0186 | 112 s | 0 |
| payload-noindex-env | yes | max-turns | 40 | 240 / 965,496 / 37,391 / 16,572 | $0.1597 | 474 s | 2 |
| payload-page-metadata-helper | no | end_turn | 39 | 234 / 615,916 / 27,293 / 13,712 | $0.1040 | 264 s | 0 |
| payload-site-url-runtime | no | max-turns | 40 | 240 / 1,019,400 / 45,194 / 24,098 | $0.1727 | 443 s | 0 |
| **Total** | **16/20** | | 506 | 3,036 / 8,049,920 / 419,957 / 236,509 | $1.3978 | 4,495 s | 7 |

| | Check after every edit (E5) | No check after edits (E14) |
|---|---|---|
| Passed | 17/20 | 16/20 |
| Turns | 444 | 506 |
| Estimated cost | $1.0948 | $1.3978 |
| Agent wall time | 3,669 s | 4,495 s |
| Runs stopped by --max-turns | 3 | 3 |
| Denials | 2 | 7 |

The pass rate is 1 task lower without the check (16/20 against 17/20). One task out of 20 on one run each is within noise, so this run does not show that the check raises the pass rate. It does show the check is not a cost: with it the run took 62 fewer turns and $0.3031 less.

E14's new failure, `payload-metadata-media-image`, is the case the check exists for. The model left a scratch test, `scripts/__tests__/scratch.test.ts`, that does not type-check (`Cannot find name 'connection'`), ran out of turns, and the task's verify runs `tsc --noEmit`. With the check after each edit, that error would have come back on the edit that made the file; that is an inference, since E5 never made the file. The other E14 failures are E5's three. `payload-site-url-runtime` failed differently: the sitemap still used `http://localhost:3000` instead of the runtime `SERVER_URL`.

Decision. Keep the check after every edit as the default. Rerun E5 and E14 twice more each before treating the one-task gap as real.

## Spend

| Item | Estimated cost |
|---|---|
| E0, both results files | $1.8422 |
| E5 | $1.0948 |
| E14 | $1.3978 |
| Smoke runs in `~/.g-code/evals/runs-smoke/` (three single-task runs) | $0.2017 |
| An E0 start stopped after the usage bug was found, part of one task, unrecorded | at most $0.40 by the per-task cap |
| Total recorded | $4.5365 |

The first smoke run is also why tokens come from `modelUsage`. Its result line's `usage` showed 148,766 tokens and $0.0244, while `modelUsage` showed 989,545 tokens and $0.1591, because an Explore subagent's calls are only in `modelUsage`. Commit `c7c5f1f` switched to `modelUsage` before E0 started.
