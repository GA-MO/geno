# P22: explore without the instruction files

Run on 2026-10-08 (Bangkok time) against Model Studio `qwen3.8-flash` through the Anthropic-compatible endpoint. Verdict: **`explore` and `plan` get `omitClaudeMd`.** A fresh `explore` child's first request fell from 8,354 to 2,377 input tokens, and a run cost 64% less. The lean arm answered 16 of 18 questions, and the full arm 18 of 18. Both misses hit the 4-turn cap with tool calls in the last turn instead of a report. Two misses in 18 do not separate the arms. The cheaper arm costs less per answered question even if every miss is retried.

## What was compared

Two agent files in the app home, `scout-full` and `scout-lean`, carry the built-in `explore` prompt, tools, low effort, 4 turns and the $0.02 cap. They differ only in `omitClaudeMd: true`. With it, a fresh child starts with:

- no instruction files: no `<global_instructions>`, no `<project_instructions>` and no rules;
- no memory notes;
- `Is a git repository: true` and no git status, branch or commits;
- no skill listing, because the child has no `skill` tool to load one with.

The environment block keeps the workspace, platform, scratchpad and the package.json facts. A fork keeps its parent's whole opening either way, for the cache.

The workspace is a clone of `payload-site-template` at `786f5f5`. Its `CLAUDE.md` is one `@AGENTS.md` line, and its `AGENTS.md` is 12,862 characters. The real home directory gave both arms the user's `~/.claude/CLAUDE.md` with its one import and the user's installed skills. Each run is `gcode agent --non-interactive "@scout-<arm> <question>"`. A mention runs the child as the user's own call, so the parent makes no model call and every cent below is the child's.

Six questions, each with one right place:

| Question | Answer |
|---|---|
| Where is the function that returns the site's public origin URL defined? | `src/lib/site.ts:18` |
| Which file defines the block whose slug is pair-image? | `src/blocks/PairImageBlock.ts:4` |
| Where is serverURL set in the Payload config, and to what value? | `src/payload.config.ts:21` |
| Where is LenisProvider rendered in the app? | `src/app/(frontend)/layout.tsx` |
| Where is the cn class-name helper defined? | `src/lib/cn.ts:4` |
| Which function builds a media file's URL for an image size, and where? | `src/lib/media.ts:14` |

A run counts as answered when its report names the file and line. Three reps ran every question in both arms. Each rep alternated which arm went first. `node scripts/omit-claude-md-ab.mjs <workspace> <app-home> <rep> <results.jsonl>` runs one rep, and `--summary <results.jsonl>` prints the table below. The one-minute load average was between 15 and 22 on 10 cores. The arms alternated, so the load cannot explain a gap between them.

## Results

| Arm | Runs | Answered | Capped | Cost per run | Cost, all runs | First-request input | Input per run | Tool calls per run | Output per run |
|---|---|---|---|---|---|---|---|---|---|
| full | 18 | 18 | 0 | $0.00590 | $0.1063 | 8,354 | 35,164 | 3.06 | 751 |
| lean | 18 | 16 | 2 | $0.00214 | $0.0385 | 2,377 | 11,476 | 4.00 | 758 |
| Change | | -2 | +2 | -64% | | -5,977 | -67% | +0.94 | about the same |

## What the numbers say

- **The opening is most of explore's bill.** The full arm's first request is 8,354 tokens, and each of its four turns repeats it. Dropping 5,977 tokens from the opening takes 67% off the input of a whole run. Model Studio bills cache reads at the full input price here, so the cost falls by about as much.
- **The saving has three parts.** The `AGENTS.md` that `CLAUDE.md` imports is about 3,700 tokens at Geno's 3.5 characters a token. The rest is the user's installed skill listing, the user's `CLAUDE.md` with its import, and the git status. A workspace with no instruction files saves only the skill listing and the git status.
- **Both misses ran out of turns, not into a wrong answer.** In rep 1, `pair-image` and `media-url` made 7 tool calls each. `pair-image` found and read `src/blocks/PairImageBlock.ts` in its first two turns, then kept searching. `media-url` searched the Media collection first and read `src/lib/media.ts` only in its fourth turn. Both spent turn 4 on tool calls instead of a report, and the cap ended them with an empty one. In the other 16 runs the lean arm cited the right line. The full arm made 3 calls in 17 of 18 runs, and `AGENTS.md`, which describes `src/blocks` and `src/lib`, may be what keeps it this direct [inf].
- **The lean arm is cheaper per answer.** $0.0385 for 16 answers is $0.0024 an answer, against $0.0059 for the full arm. Rerunning both misses at the lean price still costs less than half of the full arm.
- **The other arm is still there.** A user's own `explore` definition without `omitClaudeMd` gets the full opening, and `review` keeps it.

`plan` was not measured. It gets the field because Claude Code's Plan omits the same context and it shares `explore`'s read-only tools.

## Cost

The three reps cost $0.1448. A first attempt, stopped after 4 runs, cost $0.0183 and less than $0.02 for the run it cut off. Its lean arm told the model `Is a git repository: false` in a git clone, and one child said it had no task because only a skill listing came before it. The runs above are after the fix: an omitted status is logged as `git: "omitted"`, and a child without the `skill` tool gets no listing. The whole eval cost less than $0.19.

## Open

A capped `explore` loses what it found: its report is empty when the last turn makes tool calls instead of reporting. The prompt says the last of 4 turns must answer, and nothing enforces it. Taking the tools away on the last turn would likely turn both misses into answers [guess].
