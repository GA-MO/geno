# Landing page bake-off: Geno vs Claude Code (l1)

## Verdict

**Claude Code wins** by the rule below. Claude Code was cheaper ($1.30 against $2.21).

| | Claude Code | Geno | needed to win |
|---|---|---|---|
| ก brief checks passed (final) | 33/33 | 33/33 | at least the other's |
| ข quality checks passed (final) | 23/30 | 22/30 | at least the other's |
| ค motion checks passed (final) | 24/27 | 24/27 | at least the other's |
| judged pairs won (final) | 7/9 | 0/9 | 6 |
| API cost, both rounds | $1.30 | $2.21 | tie-break |

API credit spent this round, judge and hand-back reader included: $8.90 of the $14.50 budget. Runner model: `claude-sonnet-5-5`.

## Win rule (fixed before the run)

Every count below is over the final pages, after the feedback round, summed over the runs of a side. A side wins when all four hold:

1. It passes at least as many brief checks (ก) as the other side.
2. It passes at least as many quality checks (ข) as the other side.
3. It passes at least as many motion checks (ค) as the other side.
4. It wins at least 6 of the 9 judged pairs of final pages (two thirds of the pairs when the runs differ from 3).

Otherwise the result is a tie, and the cheaper side, by API dollars over both rounds, is named. A pair is won only when the judge picks the same side in both orders. A split, or a tie in either order, counts as a tie.

## Meter corrections after the first scoring

The first scoring had four checks failing the same way on all six pages, so the raw facts were read before the numbers were trusted. Two of the four were real. No page listens for `webglcontextrestored`, so the hero stays black after a lost context. Every page sets small eyebrow labels below 4.5:1 contrast. The other two were meter bugs, and a re-read turned up three more. Each fix applies to both sides the same way, and every page was measured again afterwards. The fixtures gained the cases behind them (an off-screen skip link, visually hidden text, editorial section headings), and the reference page still passes 30/30.

- FAQ and sustainability: the meter looked for headings that say "FAQ" and "Sustainability". All six pages use editorial headings such as "Freshness and grinding, answered." The meter now reads each section of the page by its content.
- Overflow and tap targets: an off-screen skip link and visually hidden "(opens in a new tab)" text counted as text past the screen edge and as a short button. Text and controls parked wholly off screen are now skipped. G2's hidden text still counts, because it ends about 35px inside the screen (white on cream).
- PDF link: C1 builds its brew guide as a `blob:` PDF behind a link that says PDF. That now counts.
- Pointer: the check compared the whole hero, so a ripple under the pointer was drowned by time animating the rest. G1 passed in one round and failed in the next. The check now compares the areas around where the pointer started and ended.
- Price size, a supporting number only: it took the first price-like text in a card, which after a fix was sometimes "$36 per month". It now takes the card's largest number.

Totals on the final pages at the first scoring, before these fixes: Claude Code brief 24, quality 18, motion 24. Geno brief 26, quality 16, motion 23. The judge's verdicts did not change, because it judges screenshots, not checks.

An independent review after the first report found two counting errors, and both are fixed in this version. Claude Code reports a resumed session's cost as a running total, and the first report added those totals up. That put Claude Code's round 2 at $0.35 to $0.50 instead of $0.11 to $0.18, and its total at $2.14 instead of $1.30. Geno writes a new file with `edit` and `create: true`, which the first report counted as an edit and not as a write. Both now come from each run's own logs. Neither changes a check or a judged pair. Because the pages were measured again after the meter fixes, the screenshots on the vote page are newer than the ones the judge saw. They show the same pages.

From this version on, each run has a $4 cap over both rounds on either harness: each segment gets what the run has left (`--max-budget-usd` for Claude Code, `--max-cost` for Geno), a run that hits it is not told to go on, and a run starts only when the round can pay for every running one at the cap. This round ran without a cap, and no run cost more than $1.05.

## The meter on its fixtures

Checked before the runs. The reference page under `scripts/harness-parity/landing/fixtures/` does all the brief asks; the agents never see it.

| fixture | checks passed | what it shows |
|---|---|---|
| reference | 30/30 | a page that does everything |
| blank | 0/30 | an empty page |
| hostile | 3/30 | a dialog, a stored preference, an outside font, an error, a pin, and a hang under reduced motion |
| missing | 0/30 | a folder with no index.html |

## Checks per page

C is Claude Code, G is Geno. Each cell is round 1 then the final page.

| check | C1 | C2 | C3 | G1 | G2 | G3 |
|---|---|---|---|---|---|---|
| ก three plan cards, each with a price per bag | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ก every Subscribe links out to a Stripe-hosted checkout | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ก a brew guide PDF download link | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ก a roaster profile section | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ก a shipping schedule | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ก a "Pause anytime" explainer | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ก an FAQ that covers freshness and grinding | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ก a sustainability statement on farms, certifications and packaging | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ก explains roast profiles, sourcing and delivery cadence | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ก writes no localStorage, sessionStorage or cookie | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ก one index.html: loads nothing but itself and GSAP from cdnjs | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ข no sideways scroll at 375px | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ข no text out of its box at 375px | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ข axe-core color contrast at 375px | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ |
| ข no sideways scroll at 1280px | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ข no text out of its box at 1280px | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✗✗ | ✓✓ |
| ข axe-core color contrast at 1280px | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ |
| ข every button at least 44px tall at 375px | ✓✓ | ✗✗ | ✓✓ | ✓✓ | ✓✓ | ✗✗ |
| ข no console error or uncaught exception | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ข LCP at 375px within 2500ms | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ข CLS at most 0.1 at 375 and 1280 | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ค a WebGL2 context whose shaders compile and link | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ค the hero canvas shows an image, not black | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ค moving the pointer changes the hero | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ค the hero comes back after WEBGL_lose_context | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ | ✗✗ |
| ค GSAP 3.12.5 and ScrollTrigger from cdnjs, triggers fire | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ค smooth scroll: p95 frame within 20ms, at most 3 over 33ms | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ค with reduced motion the shader stops and nothing moves but fades | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ค no ScrollTrigger pinning | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ค a 1000px wheel scrolls 1000px | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| **ก brief total** | 11→11 | 11→11 | 11→11 | 11→11 | 11→11 | 11→11 |
| **ข quality total** | 8→8 | 7→7 | 8→8 | 8→8 | 7→7 | 7→7 |
| **ค motion total** | 8→8 | 8→8 | 8→8 | 8→8 | 8→8 | 8→8 |

Why the final pages failed:

- C1 contrast@375: 1 elements: #sustainability > .wrap > .eyebrow: Element has insufficient color contrast of 4.49 (foreground color: #e8d9a8, background color: #56653a, font size: 9.4pt 
- C1 contrast@1280: 1 elements: #sustainability > .wrap > .eyebrow: Element has insufficient color contrast of 4.49 (foreground color: #e8d9a8, background color: #56653a, font size: 9.4pt 
- C1 context-restore: after restoring: mean 0 std 0, before 46/16
- C2 contrast@375: 12 elements: .r1 > dl > dt:nth-child(1): Element has insufficient color contrast of 3.73 (foreground color: #c8812f, background color: #4a3226, font size: 11.0pt
- C2 contrast@1280: 12 elements: .r1 > dl > dt:nth-child(1): Element has insufficient color contrast of 3.73 (foreground color: #c8812f, background color: #4a3226, font size: 11.0pt
- C2 tap-targets@375: 1 short: a.btn.btn-primary "See plans" 42px
- C2 context-restore: after restoring: mean 0 std 0, before 37/20
- C3 contrast@375: 5 elements: .two > div:nth-child(1) > .eyebrow: Element has insufficient color contrast of 4.23 (foreground color: #b5532a, background color: #f6ecdc, font size: 9.4pt 
- C3 contrast@1280: 5 elements: .two > div:nth-child(1) > .eyebrow: Element has insufficient color contrast of 4.23 (foreground color: #b5532a, background color: #f6ecdc, font size: 9.4pt 
- C3 context-restore: after restoring: mean 0 std 0, before 45/19
- G1 contrast@375: 2 elements: .badge: Element has insufficient color contrast of 4.42 (foreground color: #ffffff, background color: #b8602b, font size: 9.0pt 
- G1 contrast@1280: 2 elements: .badge: Element has insufficient color contrast of 4.42 (foreground color: #ffffff, background color: #b8602b, font size: 9.0pt 
- G1 context-restore: after restoring: mean 0 std 0, before 51/17
- G2 contrast@375: 6 elements: #roasts > .wrap > .eyebrow: Element has insufficient color contrast of 2.63 (foreground color: #c98a4b, background color: #faf3e8, font size: 9.0pt 
- G2 no-overflow@1280: "to Household (opens Stripe)" runs past the screen edge
- G2 contrast@1280: 6 elements: #roasts > .wrap > .eyebrow: Element has insufficient color contrast of 2.63 (foreground color: #c98a4b, background color: #faf3e8, font size: 9.0pt 
- G2 context-restore: after restoring: mean 0 std 0, before 57/20
- G3 contrast@375: 4 elements: #plans > .wrap > .eyebrow: Element has insufficient color contrast of 4.17 (foreground color: #b4532a, background color: #f4ead6, font size: 9.4pt 
- G3 contrast@1280: 4 elements: #plans > .wrap > .eyebrow: Element has insufficient color contrast of 4.17 (foreground color: #b4532a, background color: #f4ead6, font size: 9.4pt 
- G3 tap-targets@375: 6 short: summary "How fresh is the coffee when i" 40px, summary "When does it taste best?" 22.4px
- G3 context-restore: after restoring: mean 0 std 0, before 42/23

## Judge

Each cell names the pair's winner, then the weighted totals of the first and second page shown in each order (Claude Code first, then Geno first).

### Final pages: Claude Code 7, Geno 0, tie 2

| | G1 | G2 | G3 |
|---|---|---|---|
| C1 | Claude Code (8.4/7.4, 7.1/8.1) | tie (8.4/8.4, 7.8/8.4) | Claude Code (8.4/7.8, 7.4/8.1) |
| C2 | Claude Code (8.4/7.1, 7.4/8.1) | Claude Code (8.4/8.1, 7.4/8.1) | Claude Code (8.4/7.8, 7.4/8.4) |
| C3 | Claude Code (8.4/8.1, 8.1/8.4) | tie (8.4/8.4, 8.4/8.1) | Claude Code (8.4/8.1, 7.4/8.1) |

### Round 1 pages: Claude Code 8, Geno 0, tie 1

| | G1 | G2 | G3 |
|---|---|---|---|
| C1 | Claude Code (8/7.1, 7.1/8.1) | tie (8.4/8.4, 7.8/8.1) | Claude Code (8.4/7.8, 7.8/8.1) |
| C2 | Claude Code (8.4/6.7, 7.1/8.1) | Claude Code (8.4/7.7, 7.4/8.1) | Claude Code (8.4/7.4, 7.4/8.1) |
| C3 | Claude Code (8.4/7, 7.1/8.1) | Claude Code (8.4/7.7, 7.7/8.4) | Claude Code (8.4/8, 7.4/8.1) |

### How stable the judge is

The 9 final pairs judged a second time got the same pair verdict 8 of 9 times, and the same pick in a given order 15 of 18 times. In the first judging, both orders agreed on a winner in 7 of 9 pairs.

| | G1 | G2 | G3 |
|---|---|---|---|
| C1 | Claude Code (8.4/6.8, 7.1/8.1) | tie (8.4/8.4, 8.4/8.4) | Claude Code (8.4/8.1, 7.4/8.1) |
| C2 | Claude Code (8.4/6.7, 7.1/8.1) | Claude Code (8.4/7.8, 8.1/8.4) | Claude Code (8.4/7.4, 7.4/8.1) |
| C3 | Claude Code (8.4/8.1, 7.4/8.4) | Claude Code (8.4/8.1, 8.1/8.4) | Claude Code (8.4/7.8, 7.4/8.1) |

The judge ran through the Messages API.

## The feedback round

Diff is index.html lines added and removed against round 1, and the share of round 1's lines removed. Fixed is the judge's read of the three asks (heroMotion, spacing375, prices): yes, partly or no. Gap spread is the standard deviation of the gaps between sections at 375px over their mean, before and after. Price is the smallest price font size and its contrast at 375px.

| page | diff | broke | fixed | kept the rest | gap spread | price |
|---|---|---|---|---|---|---|
| C1 | +41 −30 (5%) | 0 | partly, yes, yes | yes | 0.31 → 0.4 | 48px 15.2:1 → 64px 17.5:1 |
| C2 | +30 −26 (5%) | 0 | yes, yes, yes | yes | 0.45 → 0.4 | 48px 16.3:1 → 49.6px 18.2:1 |
| C3 | +44 −27 (5%) | 0 | no, yes, yes | no | 0.45 → 0.47 | 48px 16:1 → 54.4px 7.2:1 |
| G1 | +29 −17 (3%) | 0 | partly, partly, yes | yes | 0.38 → 0.35 | 48px 16.7:1 → 54.4px 18.5:1 |
| G2 | +64 −17 (3%) | 0 | yes, yes, yes | yes | 0.27 → 0.34 | 48px 15.4:1 → 56px 8.2:1 |
| G3 | +41 −13 (3%) | 0 | yes, yes, yes | no | 0.74 → 0.86 | 44.8px 17:1 → 44.8px 17:1 |

## How each agent worked

Per round (1 / 2). Shots are screenshots it took of its own work. Edits against writes counts edit calls and whole-file writes, and rewrites are writes over a file that was already there. Shell changes are file changes made from bash: a heredoc, a sed, or a Python replace script. The diff share in the feedback table tells a spot fix from a rewrite. Hand-backs are segments that ended without finishing, each answered with "go on".

| page | shots | edits / writes (rewrites) | shell changes | tool errors | model calls | hand-backs |
|---|---|---|---|---|---|---|
| C1 | 0 / 3 | 0/1 (0) · 0/0 (0) | 0 / 1 | 0 / 1 | 3 / 8 | 0 / 0 |
| C2 | 4 / 1 | 0/1 (0) · 0/0 (0) | 2 / 1 | 0 / 0 | 9 / 11 | 0 / 0 |
| C3 | 2 / 2 | 0/1 (0) · 0/0 (0) | 1 / 2 | 0 / 1 | 7 / 14 | 0 / 0 |
| G1 | 8 / 2 | 0/1 (0) · 0/0 (0) | 1 / 2 | 5 / 0 | 24 / 12 | 3 / 0 |
| G2 | 7 / 9 | 1/1 (0) · 15/0 (0) | 2 / 1 | 1 / 9 | 20 / 25 | 0 / 1 |
| G3 | 4 / 1 | 0/1 (0) · 2/0 (0) | 1 / 1 | 0 / 2 | 10 / 6 | 0 / 0 |

## Cost

| page | round 1 | round 2 |
|---|---|---|
| C1 | $0.24 · 116s · 103k tokens | $0.11 · 60s · 332k tokens |
| C2 | $0.33 · 155s · 366k tokens | $0.17 · 89s · 565k tokens |
| C3 | $0.27 · 135s · 241k tokens | $0.18 · 99s · 641k tokens |
| G1 | $0.51 · 220s · 803k tokens | $0.26 · 86s · 632k tokens |
| G2 | $0.48 · 169s · 671k tokens | $0.57 · 197s · 1575k tokens |
| G3 | $0.28 · 111s · 247k tokens | $0.11 · 45s · 205k tokens |

## Owner vote

A blind page of 3 pairs of final pages, sides shuffled: [landing-beancraft-l1/vote.html](landing-beancraft-l1/vote.html). The key is kept apart in `docs/results/landing-beancraft-l1/vote-key.json`. After voting, `node scripts/harness-parity/landing/agree.mjs --round l1 --votes <the code the page shows>` says how many pairs the judge and the owner agree on.

## Method

Both harnesses get the same brief word for word, in an empty folder (`~/Development/beancraft` in a fresh HOME), on `claude-sonnet-5-5`. Claude Code runs `claude -p --permission-mode auto`, and Geno runs `gcode agent --mode auto --browser`. Both get the same headless browser server (chrome-devtools-mcp). The brief follows UI-Bench prompt #21, with the stack and motion asks added. When a request ends by handing work back, the simulated user answers "go on" up to twice. After the first request ends, the same session gets one feedback message. Each side builds the page 3 times.

A script scores each page after round 1 and after round 2, in headless Chrome on the Mac's GPU, with no model involved. cdnjs was reachable. The meter still serves GSAP from one in-memory copy fetched from cdnjs, so a page's LCP does not depend on the network. LCP and CLS are unthrottled local numbers. Smooth scroll is measured while a script wheels from top to bottom in 100px steps every 60ms. Pass lines: LCP within 2500ms at 375px, CLS at most 0.1, p95 frame within 20ms with at most 3 frames over 33ms. A check passes only when it saw the thing work, so an empty page fails "no sideways scroll" too.

The judge is `claude-opus-5-5` and sees screenshots only: the first screen at 1280px, the whole page at 1280px and at 375px, and a strip of motion frames (load, pointer on the hero, scroll to the bottom). It scores each page on brief fit (40), beauty (30) and layout (30). Every Claude Code page meets every Geno page (3 × 3 = 9 pairs), in both orders, for the first and the final pages. The 9 final pairs are judged a second time to measure how stable the judge is. For round 2 the judge also sees each page before and after and says whether each of the three asks was fixed.

The brief:

```
Build a landing page for BeanCraft, a subscription that ships rotating single-origin coffee.
Explain roast profiles, sourcing, and delivery cadence. Include three plan cards with price per bag, with "Subscribe" linking to an external Stripe-hosted checkout. Add a roaster profile section, a brew guide PDF download link, and a shipping schedule. Add a "Pause anytime" explainer and an FAQ on freshness and grinding. No accounts or stored preferences on-site. Add a short sustainability statement covering farms, certifications, and packaging.
Vibe: warm and informative, pairing sensory cues with operational clarity.
One page, a single index.html with inline CSS and JS, no build step.
Hero: a full-bleed WebGL2 shader background (raw WebGL2, no three.js) that reacts to the pointer.
Use GSAP 3.12.5 and ScrollTrigger from cdnjs for section reveals and micro-interactions.
Respect prefers-reduced-motion. No scroll pinning or scroll-jacking.
No other external assets. It must look right at 375px and 1280px wide.
```

The feedback:

```
The hero motion feels stiff. At 375px the spacing between sections is uneven. The prices on the plan cards are hard to read. Fix these three and keep everything else as it is.
```

Run folders: `/Users/sbpdigital/Development/hp-runs/l1`.

