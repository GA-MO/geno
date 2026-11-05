# Landing page bake-off: Geno vs Claude Code (l2)

## Verdict

**Tie** by the rule below. Claude Code was cheaper ($1.37 against $1.95).

| | Claude Code | Geno | needed to win |
|---|---|---|---|
| ก brief checks passed (final) | 33/33 | 33/33 | at least the other's |
| ข quality checks passed (final) | 22/30 | 26/30 | at least the other's |
| ค motion checks passed (final) | 24/27 | 25/27 | at least the other's |
| judged pairs won (final) | 2/9 | 2/9 | 6 |
| API cost, both rounds | $1.37 | $1.95 | tie-break |

API credit spent this round, judge and hand-back reader included: $7.20 of the $10.00 budget. Runner model: `claude-sonnet-5-5`.

## Win rule (fixed before the run)

Every count below is over the final pages, after the feedback round, summed over the runs of a side. A side wins when all four hold:

1. It passes at least as many brief checks (ก) as the other side.
2. It passes at least as many quality checks (ข) as the other side.
3. It passes at least as many motion checks (ค) as the other side.
4. It wins at least 6 of the 9 judged pairs of final pages (two thirds of the pairs when the runs differ from 3).

Otherwise the result is a tie, and the cheaper side, by API dollars over both rounds, is named. A pair is won only when the judge picks the same side in both orders. A split, or a tie in either order, counts as a tie.

## Notes on this round

- The meter changed once during this round, the same way for both sides. G1's final page recovers a lost WebGL context by reloading itself, a valid recovery. The context-restore probe ran inside the desktop session, so the reload ended that session and failed every desktop check of the page (brief 23/33 and motion 17/27 for Geno at first). The probe now runs in its own session and counts a reload that brings the hero back as a recovery. A fixture that reloads (`fixtures/reloads`) passes 30/30. Every l2 page was then measured again. No l1 page listens for `webglcontextrestored`, so the change moves no l1 number.
- Judge stability was not measured again (`--stability 0`); l1 measured it (8 of 9 pairs the same on a second judging). That kept the round under its $10 budget.
- The simulated user's "go on" is English in this round for both harnesses. In l1 it was Thai, and Geno answered those segments in Thai.

## The meter on its fixtures

Checked before the runs. The reference page under `scripts/harness-parity/landing/fixtures/` does all the brief asks; the agents never see it.

| fixture | checks passed | what it shows |
|---|---|---|
| reference | 30/30 | a page that does everything |
| blank | 0/30 | an empty page |
| hostile | 3/30 | a dialog, a stored preference, an outside font, an error, a pin, and a hang under reduced motion |
| reloads | 30/30 | the reference page, recovering a lost WebGL context by reloading itself |
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
| ข axe-core color contrast at 375px | ✗✗ | ✗✗ | ✗✗ | ✓✓ | ✗✗ | ✗✗ |
| ข no sideways scroll at 1280px | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ข no text out of its box at 1280px | ✗✗ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ข axe-core color contrast at 1280px | ✗✗ | ✗✗ | ✗✗ | ✓✓ | ✗✗ | ✗✗ |
| ข every button at least 44px tall at 375px | ✗✗ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ข no console error or uncaught exception | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ข LCP at 375px within 2500ms | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ข CLS at most 0.1 at 375 and 1280 | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ค a WebGL2 context whose shaders compile and link | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ค the hero canvas shows an image, not black | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ค moving the pointer changes the hero | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ค the hero comes back after WEBGL_lose_context | ✗✗ | ✗✗ | ✗✗ | ✓✓ | ✗✗ | ✗✗ |
| ค GSAP 3.12.5 and ScrollTrigger from cdnjs, triggers fire | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ค smooth scroll: p95 frame within 20ms, at most 3 over 33ms | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ค with reduced motion the shader stops and nothing moves but fades | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ค no ScrollTrigger pinning | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| ค a 1000px wheel scrolls 1000px | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| **ก brief total** | 11→11 | 11→11 | 11→11 | 11→11 | 11→11 | 11→11 |
| **ข quality total** | 6→6 | 8→8 | 8→8 | 10→10 | 8→8 | 8→8 |
| **ค motion total** | 8→8 | 8→8 | 8→8 | 9→9 | 8→8 | 8→8 |

Why the final pages failed:

- C1 contrast@375: 1 elements: .sm: Element has insufficient color contrast of 2.6 (foreground color: #f0dfc8, background color: #c8782f, font size: 11.0pt 
- C1 no-overflow@1280: "to Household on Stripe (opens in a new tab)" runs past the screen edge
- C1 contrast@1280: 1 elements: .sm: Element has insufficient color contrast of 2.6 (foreground color: #f0dfc8, background color: #c8782f, font size: 11.0pt 
- C1 tap-targets@375: 1 short: a.btn.sm "See plans" 39px
- C1 context-restore: after restoring: mean 0 std 0, before 43/23
- C2 contrast@375: 3 elements: .btn-primary[target="_blank"][rel="noopener noreferrer"]: Element has insufficient color contrast of 4.22 (foreground color: #ffffff, background color: #b8662b, font size: 12.0pt
- C2 contrast@1280: 3 elements: .btn-primary[target="_blank"][rel="noopener noreferrer"]: Element has insufficient color contrast of 4.22 (foreground color: #ffffff, background color: #b8662b, font size: 12.0pt
- C2 context-restore: after restoring: mean 0 std 0, before 57/30
- C3 contrast@375: 3 elements: #plans > .wrap > .eyebrow: Element has insufficient color contrast of 4.12 (foreground color: #b4531f, background color: #f3e8d6, font size: 9.4pt 
- C3 contrast@1280: 3 elements: #plans > .wrap > .eyebrow: Element has insufficient color contrast of 4.12 (foreground color: #b4531f, background color: #f3e8d6, font size: 9.4pt 
- C3 context-restore: after restoring: mean 0 std 0, before 45/20
- G2 contrast@375: 13 elements: .badge: Element has insufficient color contrast of 3.53 (foreground color: #ffffff, background color: #c4752f, font size: 9.0pt 
- G2 contrast@1280: 13 elements: .badge: Element has insufficient color contrast of 3.53 (foreground color: #ffffff, background color: #c4752f, font size: 9.0pt 
- G2 context-restore: after restoring: mean 0 std 0, before 36/9
- G3 contrast@375: 3 elements: .light > .notes: Element has insufficient color contrast of 3.86 (foreground color: #f5e8d7, background color: #9a6a3c, font size: 12.0pt
- G3 contrast@1280: 3 elements: .light > .notes: Element has insufficient color contrast of 3.86 (foreground color: #f5e8d7, background color: #9a6a3c, font size: 12.8pt
- G3 context-restore: after restoring: mean 0 std 0, before 43/15

## Judge

Each cell names the pair's winner, then the weighted totals of the first and second page shown in each order (Claude Code first, then Geno first).

### Final pages: Claude Code 2, Geno 2, tie 5

| | G1 | G2 | G3 |
|---|---|---|---|
| C1 | tie (8.1/8.1, 7.4/7.7) | Claude Code (7.4/7.4, 7.1/8.1) | Claude Code (7.4/7.3, 7.1/8.1) |
| C2 | Geno (7.1/8.4, 7.7/6.4) | Geno (7.1/8.1, 7.7/6.7) | tie (7.4/7.7, 7.4/7.8) |
| C3 | tie (8.4/8.4, 7.4/8.4) | tie (7.4/7.7, 8.1/8.4) | tie (8.1/8.1, 7.7/8.4) |

### Round 1 pages: Claude Code 3, Geno 3, tie 3

| | G1 | G2 | G3 |
|---|---|---|---|
| C1 | tie (8.1/8.1, 8.4/8.1) | tie (8.1/7.4, 8.1/7.8) | Claude Code (7.8/7.7, 7.4/8.1) |
| C2 | Geno (6.4/7.7, 7.7/6) | Geno (6.4/7.7, 8.1/7.1) | Geno (7.4/8.4, 7.4/7.1) |
| C3 | Claude Code (7.7/7.4, 8.1/8.4) | Claude Code (7.4/7.4, 8.1/8.4) | tie (8.1/8.1, 7.8/8.1) |

The judge ran through the Messages API.

## The feedback round

Diff is index.html lines added and removed against round 1, and the share of round 1's lines removed. Fixed is the judge's read of the three asks (heroMotion, spacing375, prices): yes, partly or no. Gap spread is the standard deviation of the gaps between sections at 375px over their mean, before and after. Price is the smallest price font size and its contrast at 375px.

| page | diff | broke | fixed | kept the rest | gap spread | price |
|---|---|---|---|---|---|---|
| C1 | +54 −34 (6%) | 0 | partly, partly, yes | yes | 0.37 → 0.42 | 48px 14.9:1 → 60px 15.7:1 |
| C2 | +53 −36 (7%) | 0 | yes, yes, yes | yes | 0.34 → 0.42 | 48px 16:1 → 56px 17.8:1 |
| C3 | +39 −22 (5%) | 0 | yes, yes, yes | yes | 0.7 → 0.86 | 44.8px 16.1:1 → 54.4px 7.2:1 |
| G1 | +31 −16 (3%) | 0 | no, yes, yes | yes | 0.38 → 0.45 | 44.8px 16.7:1 → 52px 18.1:1 |
| G2 | +27 −19 (3%) | 0 | no, no, yes | no | 0.27 → 0.39 | 48px 16.3:1 → 54.4px 6.7:1 |
| G3 | +17 −8 (2%) | 0 | no, no, yes | yes | 0.37 → 0.33 | 44.8px 16.3:1 → 48px 5.9:1 |

## How each agent worked

Per round (1 / 2). Shots are screenshots it took of its own work. Edits against writes counts edit calls and whole-file writes, and rewrites are writes over a file that was already there. Shell changes are file changes made from bash: a heredoc, a sed, or a Python replace script. The diff share in the feedback table tells a spot fix from a rewrite. Hand-backs are segments that ended without finishing, each answered with "go on".

| page | shots | edits / writes (rewrites) | shell changes | tool errors | model calls | hand-backs |
|---|---|---|---|---|---|---|
| C1 | 4 / 3 | 0/1 (0) · 0/0 (0) | 1 / 1 | 1 / 0 | 10 / 9 | 0 / 0 |
| C2 | 2 / 1 | 0/1 (0) · 1/0 (0) | 1 / 1 | 0 / 0 | 5 / 8 | 0 / 0 |
| C3 | 0 / 6 | 0/1 (0) · 0/0 (0) | 1 / 3 | 0 / 1 | 2 / 17 | 0 / 3 |
| G1 | 13 / 2 | 2/1 (0) · 4/0 (0) | 1 / 1 | 7 / 2 | 28 / 9 | 3 / 0 |
| G2 | 6 / 1 | 2/2 (0) · 0/0 (0) | 1 / 1 | 2 / 1 | 16 / 9 | 0 / 0 |
| G3 | 7 / 1 | 0/1 (0) · 0/0 (0) | 2 / 1 | 2 / 2 | 18 / 6 | 1 / 0 |

## Cost

| page | round 1 | round 2 |
|---|---|---|
| C1 | $0.36 · 162s · 409k tokens | $0.17 · 87s · 501k tokens |
| C2 | $0.30 · 130s · 185k tokens | $0.12 · 63s · 376k tokens |
| C3 | $0.21 · 101s · 65k tokens | $0.21 · 107s · 761k tokens |
| G1 | $0.60 · 249s · 1047k tokens | $0.22 · 98s · 517k tokens |
| G2 | $0.45 · 167s · 521k tokens | $0.17 · 61s · 435k tokens |
| G3 | $0.41 · 168s · 546k tokens | $0.11 · 51s · 251k tokens |

## Owner vote

A blind page of 3 pairs of final pages, sides shuffled: [landing-beancraft-l2/vote.html](landing-beancraft-l2/vote.html). The key is kept apart in `docs/results/landing-beancraft-l2/vote-key.json`. After voting, `node scripts/harness-parity/landing/agree.mjs --round l2 --votes <the code the page shows>` says how many pairs the judge and the owner agree on.

## Judge calibrated on the owner

The same screenshots of the final pages, judged again in both orders with the `taste` rubric in `scripts/harness-parity/landing/judge.mjs`: layout weighs 50, beauty 30 and brief 20, and layout is read the way the owner reads a page (one spacing rhythm, equal padding, true centring, a hierarchy that reads at a glance, nothing cluttered, a 375px page that holds; beauty means premium, not template or AI-made). No agent ran. The verdicts are in `docs/results/landing-beancraft-l2/judge-taste.json`, apart from the round's judge.json, and cost $1.58.

| | rubric fixed before the run | taste rubric |
|---|---|---|
| the 9 final pairs | Claude Code 2, Geno 2, tie 5 | Claude Code 4, Geno 2, tie 3 |

4 of the 9 pairs changed: C1-G3: claude → tie, C3-G1: tie → claude, C3-G2: tie → claude, C3-G3: tie → claude. The owner has not voted on this round's pages yet, so how well either rubric matches the owner is not known here. The win rule above still uses the rubric fixed before the run.

## Compare the live pages

`scripts/harness-parity/landing/compare.html` shows the same three pairs, sides hidden as in the vote, as live pages in frames at 375 and 1280, first round or after feedback, so the shader, the pointer and the reveals run for real. Reveal sides names the harnesses and the judge's verdict. Start it with `node scripts/harness-parity/landing/compare.mjs --round l2` and open http://127.0.0.1:4600/ (`--port` picks another port). The pages are served from `/Users/sbpdigital/Development/hp-runs/l2`, so they open on this Mac only.

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

Run folders: `/Users/sbpdigital/Development/hp-runs/l2`.

