# Landing page bake-off: Geno vs Claude Code (l2)

Results pending: the run had not started when this was written.

## Win rule (fixed before the run)

Every count below is over the final pages, after the feedback round, summed over the runs of a side. A side wins when all four hold:

1. It passes at least as many brief checks (ก) as the other side.
2. It passes at least as many quality checks (ข) as the other side.
3. It passes at least as many motion checks (ค) as the other side.
4. It wins at least 6 of the 9 judged pairs of final pages (two thirds of the pairs when the runs differ from 3).

Otherwise the result is a tie, and the cheaper side, by API dollars over both rounds, is named. A pair is won only when the judge picks the same side in both orders. A split, or a tie in either order, counts as a tie.

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
