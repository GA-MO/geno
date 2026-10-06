# U47 in the panel: the compaction divider and Compact

This page covers the VS Code panel's half of context compaction. The engine and core half (the `compact` event, the cut, auto compaction and `/compact`) is the rest of U47.

## Data shape

- **The wire.** The engine sends an ACP `agent_message_chunk` whose `_meta["gcode/compact"]` is a core `CompactMark`: `{ seq, trigger, tokensBefore, tokensAfter, summary, files: { read, changed }, focus? }`. Its `content.text` says the same in plain words for other ACP clients.
- **The block.** `CompactBlock` in `messages.ts` is `{ kind: 'compact', id: 'compact:<seq>', mark }`. The `compact` action carries the mark.
- **The mapping.** `agentChunkAction` in `compact-host.ts` reads an agent chunk. A chunk with a valid mark becomes the `compact` action, so its text is never appended as model text. Any other chunk, a malformed mark included, stays text.
- **The reducer.** `withCompact` in `compact-model.ts` adds the block to the last turn once per seq, and the reducer clears the turn's passing notice ("Compacting the context") as it lands. A replay sends the same chunk, so it gives the same block. `compact` is a child action too, so a subagent's compaction shows on its own rail.
- **The webview boundary.** `compact-model.ts` imports only types from `@g-code/core/compact`.

## The divider

- A dashed rule across the step, then "Context compacted" and "850,042 → about 21,613 tokens". The context after is the engine's estimate, so it says "about".
- The head is a `button` with `aria-expanded` and `aria-controls`. Enter and Space open and fold it in place, so the focus stays on it. The summary renders with the panel's markdown renderer the first time it opens.
- Opened, it shows why it happened, the focus of a `/compact` that had one, the summary, and the files read and changed. An auto compaction says "Geno compacted on its own before the context filled." An overflow says the model refused the request as too long. A manual one gives no reason, since its `/compact` turn says it.
- Compact detail keeps the divider in view when it folds a turn.
- At 300px the counts wrap under the title and nothing scrolls sideways. High contrast draws the rule and the box in `contrastBorder`.

## Compact on the ring

- Below 80%, for an unknown window, and on an external agent's session, the ring is as U36 left it.
- From 80% on Geno's own session, the ring itself becomes a button: the ring and "Compact" in an amber pill. Its tooltip keeps the numbers: "Context: 850,042 of 1,000,000 tokens (85%). Compact summarizes the older turns to free it."
- A click sends `/compact` through the same `send` path as typed text, so the panel shows a `/compact` turn with its engine chip. The draft stays in the composer.
- While a turn runs, the button stays but is `aria-disabled`, dimmed, with the reason in its tooltip: "A turn is running. Compact works between turns, and Geno compacts on its own as the context fills." It does not queue. The engine refuses `/compact` during a turn, and auto compaction already runs before the turn's next model call, so a queued `/compact` would pay for a second summary.
- From 360px to 479px the label takes the effort's room, and the model menu still shows the effort. Below 360px the pill shows the ring alone, and the button keeps its name for screen readers.

## Check

- `packages/extension/test/compact.test.ts` covers the block where it lands, the fallback text never appended, a malformed mark kept as text, the notice cleared, a replay giving the same block, one divider for a repeated chunk, the `/compact` turn, compact detail, a child's rail and the divider's words.
- `packages/extension/test/composer.test.ts` covers the ring offering Compact from 80%, not below, not for an unknown window or an external agent, and holding it with its reason while a turn runs.
- `packages/extension/test/compact.integration.test.ts` runs the real engine against a fake Model Studio in VS Code, with `GCODE_COMPACT_AT=40000`. A 2.9 MB attached log makes the session's context really hold the 850,000 tokens the fake reports, so the counts are honest. The ring offers Compact at 85% and fits at 300px. A click runs `/compact` with its chip, keeps the draft, shows the notice and holds the button while the summary is written. The divider lands folded, with 850,0xx before and under 40,000 after, the notice gone, no fallback text and the ring back below 5%. It opens to the four headings and the files read, and Enter and Space fold and open it. Two more turns read five logs, and the next one compacts on its own inside its turn, before the answer. A reload through the history replays both dividers with the same counts in the same turns. The launcher checks that the model then reads the summaries and not what they replaced.

## Media

In `docs/media/u47/`, in Dark Modern (`-dark`), Light Modern (`-light`) and Dark High Contrast (`-high-contrast`). Each has a window capture and a `-panel` capture at 2x.

- `ring-compact-*`: the ring offering Compact at 85%.
- `narrow-300-ring-compact-*`: the same at 300px, the ring alone in its pill.
- `divider-*`: the `/compact` turn's divider, folded.
- `divider-open-*`: the divider opened to the summary.
- `narrow-300-divider-open-*`: the same at 300px.

`GCODE_SCREENSHOTS=$PWD/docs/media/u47 pnpm vitest run --project vscode packages/extension/test/compact.integration.test.ts` retakes them on the host.
