# E3 and E4 results: edit formats on Model Studio Qwen

Run on 2026-10-04 with `gcode eval apply` over the 47 mined triples (3 `commit`, 44 `file-slice`). Every number below comes from one of these results files under `~/.g-code/evals/apply-runs/`. Running `gcode eval apply --applier <format> --model <model> --resume <file>` on a finished file reprints its summary without calling the model.

| Run | Results file |
|---|---|
| str_replace, qwen3.8-flash | `2026-10-04T17-54-32-239Z-str_replace-qwen3.8-flash.jsonl` |
| apply_patch, qwen3.8-flash | `2026-10-04T17-54-32-239Z-apply_patch-qwen3.8-flash.jsonl` |
| whole_file, qwen3.8-flash | `2026-10-04T17-54-32-241Z-whole_file-qwen3.8-flash.jsonl` |
| str_replace, qwen3.7-plus | `2026-10-04T18-10-04-515Z-str_replace-qwen3.7-plus.jsonl` (stopped by `--max-cost` after 43 triples, finished with `--resume`) |
| whole_file, qwen3.7-plus | `2026-10-04T18-10-04-515Z-whole_file-qwen3.7-plus.jsonl` |
| noop and oracle baselines | `2026-10-04T18-20-58-285Z-noop.jsonl`, `2026-10-04T18-20-58-527Z-oracle.jsonl` |

Setup. Each model call carries the applier's own system prompt, the instruction, the file numbered by line, and one edit tool. Effort is `medium`. A turn whose edits fail sends the errors back as `is_error` tool results, up to 2 retry turns. The code was commit `c7f7f7a`. The plus str_replace resume ran at `3733b6a`, which changed no applier code.

## Results

Each rate cell reads: all 47 triples, then `commit` (c, of 3) and `file-slice` (s, of 44). Tokens are input / cache read / cache write / output. Cost is the estimate at list price.

| Format | Model | Exact | Exact ignoring trailing whitespace | First-try failed | Final failed | Mean retries | Failures by reason (first try → final) | Tokens | Cost |
|---|---|---|---|---|---|---|---|---|---|
| str_replace | qwen3.8-flash | 14.9% (c 1, s 6) | 14.9% (c 1, s 6) | 2.1% (c 0, s 1) | 2.1% (c 0, s 1) | 0.00 (c 0.00, s 0.00) | no-edit 1 → no-edit 1 | 13,240 / 142,294 / 73,144 / 32,964 | $0.0525 |
| apply_patch | qwen3.8-flash | 10.6% (c 1, s 4) | 10.6% (c 1, s 4) | 19.1% (c 0, s 9) | 0.0% (c 0, s 0) | 0.19 (c 0.00, s 0.20) | parse-error 7, zero-matches 2 → none | 13,155 / 107,025 / 76,873 / 35,452 | $0.0491 |
| whole_file | qwen3.8-flash | 12.8% (c 1, s 5) | 12.8% (c 1, s 5) | 0.0% (c 0, s 0) | 0.0% (c 0, s 0) | 0.00 (c 0.00, s 0.00) | none → none | 15,522 / 100,882 / 97,317 / 58,567 | $0.0632 |
| str_replace | qwen3.7-plus | 6.4% (c 1, s 2) | 6.4% (c 1, s 2) | 4.3% (c 0, s 2) | 2.1% (c 0, s 1) | 0.06 (c 0.00, s 0.07) | zero-matches 1, parse-error 1 → zero-matches 1 | 14,310 / 206,317 / 165,814 / 127,609 | $0.3753 |
| whole_file | qwen3.7-plus | 6.4% (c 0, s 3) | 10.6% (c 1, s 4) | 4.3% (c 0, s 2) | 4.3% (c 0, s 2) | 0.00 (c 0.00, s 0.00) | no-edit 2 → no-edit 2 | 13,583 / 69,602 / 123,852 / 89,605 | $0.2386 |
| noop | none | 0.0% | 0.0% | 0.0% | 0.0% | 0.00 | none | none | $0 |
| oracle | none | 100.0% | 100.0% | 0.0% | 0.0% | 0.00 | none | none | $0 |

The two qwen3.7-plus runs used str_replace and whole_file, the two formats with the highest flash exact-match rate.

What the exact-match rate measures. The triple instructions are commit messages, and most do not say what the new text is: version numbers, wording, or which of several files a change lands in. The rate is therefore mostly a measure of guessing the author's intent, not of applying an edit. Closeness makes this visible. It is 1 minus the line-diff distance from the result to the expected file, divided by the distance from the base to the expected file, computed from each results file and its triples. 1 is the expected file and 0 is no closer than the base. The median closeness of applied results is 0.00 in the three flash runs and plus str_replace, and -0.29 in plus whole_file. In each run, 21 to 27 applied results sit further from the expected file than the base did. The differences between formats are one or two triples out of 47, which is within noise. The failure rates are the format signal.

No silent misapplies from the matcher. Replaying every applied str_replace call against the base text shows that all 79 (flash) and 70 (plus) calls matched exactly. None went through the whitespace-normalized fallback.

## Native text editor tool

`text_editor_20250728` (`str_replace_based_edit_tool`) is not usable on Model Studio. The endpoint does not reject it. It returns HTTP 200, but drops the tool from the prompt. A one-message probe on qwen3.8-flash billed 91 input tokens. The model's reasoning said no edit tool was available. It then wrote a pretend call as plain text, `<tool_call><function=functions.edit>…`, and stopped with `end_turn` and no `tool_use` block. There is no error message to record, so the format was dropped from the run and not emulated.

## Three representative failures

1. apply_patch, qwen3.8-flash, `next-15-template-e0e52bf-0`, reason `parse-error`. The patch began at `*** Update File: next.config.ts` with no envelope. The applier answered `patch line 1: the patch must start with "*** Begin Patch"`. The retry added the envelope and applied. This is 7 of the 9 apply_patch first-try failures, and every one recovered.
2. apply_patch, qwen3.8-flash, `payload-site-template-63b251f-1`, reason `zero-matches`. The patch listed its second chunk above its first in the file. The applier answered `chunk 2: its context and - lines do not appear in Dockerfile after line 31.`, then gave the closest region, lines 19 to 21. The retry put the chunks in file order and applied. The message is accurate, but it would be faster to act on if it said the chunks are out of order.
3. str_replace, qwen3.7-plus, `payload-site-template-63b251f-6`, reason `zero-matches`. The model's first call replaced all of `src/app/sitemap.ts` and applied. It then sent the identical call again. That call's old text was gone, so it failed with `old_str does not appear in src/app/sitemap.ts, even ignoring indentation and trailing whitespace`, and the model ended its turn. The file already held the edit, so this was a false failure. After the run, commit `42be7c7` made such a resend an applied no-op. Replaying the recorded calls through the new matcher applies both. This is the only str_replace final failure on plus, so the rate under current code would be 0/47.

The other final failures are `no-edit`. The model ended its turn without editing, once for str_replace on flash and twice for whole_file on plus. The instruction describes a whole commit, and these models judged the file needed no change.

## E4: is a merge model worth adding?

No. The best diff format's final failure rate is 0.0% (apply_patch on flash) to 2.1% (str_replace on both models), which is 0 or 1 triple per run. Every first-try apply failure except the resent edit recovered within the 2 retries, from the precise error alone. E4's rule is to add sketch-merge only if it fixes more than half the failures. There are not enough failures for that to be measurable, and the ones left are a model choosing not to edit, which a merge model cannot fix. The large gap is exact match, and it comes from the model not knowing the intended content. A merge model applies the model's own sketch, so it would not move that rate either. One caveat. These files are at most 7,987 characters, and E4's method also called for 10 edits to files over 1,000 lines. The set has none, so revisit E4 with long files when Phase 4's agent tasks produce them.

E3 decision for Model Studio Qwen. Use str_replace as the default. Its first-try failure rate is the lowest of the diff formats (2.1% and 4.3%). It never needed the whitespace fallback. Its flash cost is the second lowest. apply_patch reaches 0% final failures, but it fails 19% of first tries, mostly on the envelope, and each of those costs a retry turn. whole_file never misapplies an edit, but 2 of its 47 plus results differed from the expected file only in trailing whitespace (the one checked had lost its final newline), and its output grows with the file. Its plus cost was lower than str_replace's because plus str_replace spent more output across turns. That cost gap is worth re-measuring on longer files.
