# Tab model: local FIM on llama.cpp

Tab v1 shows ghost text from a local Qwen2.5-Coder base model served by `llama-server`. This page records which model file is used, why the server runs with each flag, which logged outcomes are exact, and what the E8 latency measurement found.

## Model

The default is the Qwen2.5-Coder 1.5B base model at Q8_0.

| File | Source | sha256 |
| --- | --- | --- |
| `~/.g-code/models/qwen2.5-coder-1.5b-q8_0.gguf` (1,646,573,056 bytes) | https://huggingface.co/ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF, file `qwen2.5-coder-1.5b-q8_0.gguf` | `29871c94d15727a6e243f79a37113d4ae625a6215b5e800bf41a23af2da32832` |
| `~/.g-code/models/qwen2.5-coder-3b-q8_0.gguf` (3,285,476,160 bytes) | https://huggingface.co/ggml-org/Qwen2.5-Coder-3B-Q8_0-GGUF, file `qwen2.5-coder-3b-q8_0.gguf` | `a522a906e299ed34db738b9626b2cd0da9e446c14674468a22fc2eae3dbd344d` |

Both hashes match the LFS object ids Hugging Face lists for those files. `ggml-org` is the llama.cpp project's own organization. Its FIM repos are the ones `llama-server --fim-qwen-1.5b-default` downloads, and they hold the base models, which is where FIM is trained in. The official `Qwen` organization publishes GGUFs for the instruct models only, so no instruct comparison was needed.

A Q4_K_M file was also tried. No base Q4_K_M exists from Qwen or ggml-org, so it was made locally with `llama-quantize --allow-requantize qwen2.5-coder-1.5b-q8_0.gguf qwen2.5-coder-1.5b-q4_k_m-from-q8.gguf Q4_K_M` (sha256 `355b7cbf511cc0373380d2480e3fcf419865d8b5baf194743e1782d4b68545cc`). Across 3 alternating runs per file, it generated about 20% faster (generation p50 72 ms against 85 to 96 ms), but time to first token showed no measurable difference (p50 249 to 267 ms against 219 to 270 ms for Q8_0), and quality was the same. Q8_0 stays the default.

## Server

`scripts/tab-server.sh` starts `llama-server` with these flags. Set `GCODE_TAB_MODEL` to serve another file and `GCODE_TAB_PORT` to move it off 8012. The extension starts the same server itself when nothing answers at `gcode.tab.endpoint` (`docs/install.md`), with the flags from `llamaServerArgs` in `packages/core/src/tab/server.ts`, which a test keeps equal to the script's.

- `--alias <file name>` makes the server report the model file's name, which the extension logs as the model.
- `--host 127.0.0.1 --port 8012` keeps the server local and matches the `gcode.tab.endpoint` default.
- `--n-gpu-layers 99` puts every layer on the Metal GPU.
- `--flash-attn on` measured about 3% faster prompt processing in `llama-bench` (pp512 874 against 851 tokens/s).
- `--ctx-size 4096` fits the largest prompt with room to spare. The default budget allows 1,792 estimated tokens, the estimate runs about 1.5 times the real count, and a reply is at most 64 tokens. A context smaller than the model's 32k saves KV memory.
- `--parallel 1` gives the single user a single slot. With more slots, consecutive requests can land in different slots and lose the KV cache they share.
- `--cache-reuse 256` lets the server reuse cached chunks of 256 tokens or more after they shift position, as when the prefix window slides as you type down a long file. Its effect was not measured separately. The bench's cursor positions rarely share shifted chunks.
- `--no-webui` turns off the browser UI, which Tab does not use.

`--batch-size` and `--ubatch-size 1024` were tried and dropped, because `llama-bench` showed no difference against 512 (pp512 873 against 874 tokens/s).

The server also keeps a RAM cache of earlier prompts (`--cache-ram`, 8 GB by default). This makes a repeated or overlapping prompt far cheaper, so any benchmark of cold positions must start a fresh server for each run.

## Prompt

`buildFimPrompt` in `packages/core/src/tab/prompt.ts` builds Qwen's repository-level FIM layout:

```
<|repo_name|>{workspace}
<|file_sep|>{least relevant other file}
...
<|file_sep|>{most relevant other file}
<|file_sep|>{current file}
<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>
```

The default budget is 1024 prefix tokens, 256 suffix tokens and 512 tokens of other open files, estimated at 3 characters a token. Real Qwen tokens run about 4.5 characters for this code, so the estimate is conservative. When the cursor line already has code before the cursor, the request stops at the newline. On a blank line it may return several lines, and the filter drops replies over 8 lines.

## Logged outcomes

Each request that reaches the model is one `request` line in `$GCODE_HOME/tab-events.jsonl`. Later `outcome` and `persisted` lines refine it by id. A call cancelled during the debounce never sends a request and is not logged. A request that fails, for example because the server is down, is not logged either.

| Outcome | How it is observed | Exact? |
| --- | --- | --- |
| `cancelled` | VS Code cancels the call after the request was sent. | Exact. |
| `suppressed` | A filter dropped the reply. The line names the filter. | Exact. |
| `shown` | The provider returned an item. | Approximate. VS Code may still not render it. |
| `accepted` | The command attached to the item ran, which VS Code does after a full accept. | Exact for a full accept. |
| `partial` | The next edit inserted more than one character matching the start of the ghost text, as a word accept does. | Approximate. A paste of the same text also counts. |
| `typed-over` | The next edit at the cursor inserted text that diverges from the ghost text. | Approximate. |
| `rejected` | The next edit was elsewhere, deleted text, or a newer completion replaced this one. | Approximate. Escape and cursor moves are invisible until the next edit, and a completion never followed by an edit stays `shown`. |
| `persisted` | Five minutes after an accept, whether the accepted text still appears anywhere in the document. | Approximate. It is unknown when VS Code closed first. |

Typing one character that matches the ghost text keeps the completion alive. The provider then reuses the cached reply, and the same record stays open.

## E8 measurement

`pnpm tab:bench` replays 100 cursor positions from the 27 `.ts` and `.tsx` files in `~/Development/next-15-template`. Each position sits inside a non-trivial line with the rest of that line removed, as if the user were typing it. Up to two files from the same directory serve as the open files. Requests go one at a time, after 5 uncounted warmup requests at other positions, through the same `buildFimPrompt` and `streamFim` the extension uses. `--half` halves every budget. `--keystroke` times the request after one more typed character, once the server has seen the position, which is what live typing looks like.

Each configuration ran 3 times on the 1.5B model, alternating configurations, with a fresh server per run. The table gives the median run with the range across runs. All runs used seed 1, so they replay the same positions.

| 1.5B Q8_0 | TTFT p50 | TTFT p90 | Total p50 | Total p90 | Prompt tokens p50 / p90 | Processed p50 / p90 |
| --- | --- | --- | --- | --- | --- | --- |
| Cold, full budget | 268 (164 to 279) | 683 (400 to 720) | 383 (249 to 389) | 893 (556 to 980) | 305 / 608 | 100 / 307 |
| Cold, half budget | 213 (151 to 214) | 541 (391 to 683) | 360 (266 to 369) | 712 (544 to 872) | 245 / 362 | 86 / 234 |
| Keystroke, full budget | 148 (143 to 166) | 462 (450 to 516) | 284 (280 to 311) | 587 (576 to 668) | 306 / 608 | 43 / 184 |
| Keystroke, half budget | 144 (141 to 148) | 285 (278 to 295) | 274 (255 to 276) | 471 (454 to 481) | 245 / 362 | 43 / 97 |

All times are in ms. The 3B model, 2 runs each, measured a cold TTFT p50 of 519 to 577 ms and a keystroke half-budget total p50 of 503 to 537 ms. Its first line matched the removed text as often as the 1.5B's did (66 of 100 cold).

**Verdict.** The local 1.5B misses the bar of 200 ms p50 and 500 ms p90 for total latency in every configuration. Its time to first token meets the bar once the server has seen the position, which is the live-typing case (148 ms p50 and 462 ms p90 at the full budget, 144 and 285 at half), and misses it for cold positions. The 3B is about twice as slow and no better.

**What limits it.** Prompt processing sets the time to first token. Server prompt-eval time tracks it within 10 ms in every run, at about 2 to 2.6 ms for each token the server has not cached. That is slower than `llama-bench`'s 880 tokens/s for 512-token batches, because small batches cost more per token (pp32 ran 46 ms, the time of a 16-token batch). Generation adds 85 to 95 ms at p50 for about 5 tokens, at 48 to 55 tokens/s, bound by reading 1.6 GB of weights per token. Halving the budget cut cold time to first token by about 20%, not half. The likely reason, inferred and not measured, is that most of these files are small, so the budget rarely binds, and the server caches each directory's snippet context after its first request.

**What else limits the numbers.**

- The GPU is shared with the desktop. With no model running, `ioreg` showed the GPU 8% to 92% busy from WindowServer, Chrome and the Claude app. The 1-minute load average ranged from 2.7 to 22.7 during the runs, from Spotlight and media analysis indexing and other agents' work. This is the machine as it is really used, and it makes run-to-run spread wide.
- The corpus is small. 27 files yield prompts of 305 tokens at p50, far under the budget, so larger repos would cost more cold.
- The requests are sequential, and the 5 warmup requests are excluded.
- Errors: every run completed all 100 requests with a non-empty reply, since the bench throws on any failed request.

# Next-edit model: Zeta 2.1 on llama.cpp

Tab v2 predicts the next edit, possibly away from the cursor, from the recent edit history. It uses Zed's Zeta 2.1, an 8B model finetuned from Seed-Coder-8B-Base (Apache-2.0). It is off by default (`gcode.tab.nextEdit`), because it misses the latency bar on this Mac. `docs/e9-e10-e11.md` has the measurements.

## Model file

| File | Source | sha256 |
| --- | --- | --- |
| `~/.g-code/models/zeta-2.1.Q4_K_M.gguf` (5,071,410,080 bytes) | https://huggingface.co/mradermacher/zeta-2.1-GGUF at revision `8c2528af755e2a640232eb25e7991cd812e04b07`, file `zeta-2.1.Q4_K_M.gguf` | `f031e71d3a467f23457964f7168b9158189a91231efc28cc8b91e6ea473dd71b` |

The hash matches the LFS object id Hugging Face lists for that file. The model's own repo, https://huggingface.co/zed-industries/zeta-2.1 (revision `9a83b321df711c0d207a1c23a92534337798c2ab`), holds only safetensors. Its page links its quantizations through the model tree, and `mradermacher/zeta-2.1-GGUF` is the GGUF repo there with the most downloads. That repo's card names `zed-industries/zeta-2.1` as its base model.

## Prompt

`buildNextEditPrompt` in `packages/core/src/tab/zeta.ts` ports Zed's `V0318SeedMultiRegions` format, which Zed's source names as the Zeta 2.1 format (`crates/zeta_prompt` in zed-industries/zed). The model card gives the outline. Zed's source gives the details the card leaves out:

```
<[fim-suffix]>{code after the editable region}
<[fim-prefix]><filename>{related file}
{its lines}
<filename>edit_history
--- a/{path}
+++ b/{path}
@@ -l,n +l,n @@
{unified diff of one edit, 3 lines of context}

<filename>{current file}
{context before the editable region}<|marker_1|>{block}<|marker_2|>{block with <|user_cursor|>}...<|marker_k|>
<[fim-middle]>
```

- The editable region is about 350 estimated tokens of whole lines around the cursor, with about 150 more tokens of context lines. A token is estimated as 3 characters, as Zed does. Zed also widens the region to syntax nodes. This port has no syntax tree and grows line by line.
- Markers split the region into blocks of 6 to 16 lines, preferring a split after a blank line and never starting a block on a closing line such as `}` or `return;`.
- History holds at most 6 edits, newest kept first when the 4096-token budget runs short, then related files. Related files are the open tabs, each cut to the lines from its top that fit.
- The reply is `<|marker_i|>{new text}<|marker_j|>`, a rewrite of the blocks from marker i to marker j. A repeated marker means no edit. `parseNextEdit` trims the rewrite to the smallest changed range.

The builder reproduces the card's sample prompt byte for byte (`packages/core/test/tab-zeta.test.ts`), and the parser reads the card's sample output as the one-word edit it is.

**The BOS token.** Seed-Coder was trained with `<[begin▁of▁sentence]>` at the start of every prompt, but the GGUF tells llama-server not to add it. Without it, Zeta answered "no edit" to the card's own sample. With it, it returned the sample output, apart from where it placed the cursor marker. `nextEditRequestBody` prepends it.

## Server

`scripts/next-edit-server.sh` runs `tab-server.sh` with the Zeta file on port 8013 and `--ctx-size 8192`. Zeta's prompts run up to 4096 estimated tokens, and the reply can rewrite the whole region, so 4096 would be too small. On the replayed prompts the 3-character estimate ran 5% above the real Seed-Coder count (`docs/results/*.jsonl`). The FIM server keeps port 8012, so the two can run side by side.

Speculative decoding by prompt n-grams (`--spec-type ngram-simple --spec-draft-n-max 16`) suits Zeta, because most of its reply copies the region from the prompt. On the card's sample, with the prompt cached, it cut generation from 7.7 s to 3.4 s for the same 151 tokens. Over the 69 replayed moments it cut generation p90 from about 11 s to 5.2 s and returned all 69 replies unchanged. It is still not the default, for two reasons. It does not change the verdict, and with `--spec-ngram-simple-size-n 6` the sample's reply changed from the edit to "no edit". Speculation is therefore not guaranteed to preserve output on this backend at temperature 0, and its settings need checking against a replay before use.
