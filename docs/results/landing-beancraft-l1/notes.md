## Meter corrections after the first scoring

The first scoring had four checks failing the same way on all six pages, so the raw facts were read before the numbers were trusted. Two of the four were real. No page listens for `webglcontextrestored`, so the hero stays black after a lost context. Every page sets small eyebrow labels below 4.5:1 contrast. The other two were meter bugs, and a re-read turned up three more. Each fix applies to both sides the same way, and every page was measured again afterwards. The fixtures gained the cases behind them (an off-screen skip link, visually hidden text, editorial section headings), and the reference page still passes 30/30.

- FAQ and sustainability: the meter looked for headings that say "FAQ" and "Sustainability". All six pages use editorial headings such as "Freshness and grinding, answered." The meter now reads each section of the page by its content.
- Overflow and tap targets: an off-screen skip link and visually hidden "(opens in a new tab)" text counted as text past the screen edge and as a short button. Text and controls parked wholly off screen are now skipped. G2's hidden text still counts, because it ends about 35px inside the screen (white on cream).
- PDF link: C1 builds its brew guide as a `blob:` PDF behind a link that says PDF. That now counts.
- Pointer: the check compared the whole hero, so a ripple under the pointer was drowned by time animating the rest. G1 passed in one round and failed in the next. The check now compares the areas around where the pointer started and ended.
- Price size, a supporting number only: it took the first price-like text in a card, which after a fix was sometimes "$36 per month". It now takes the card's largest number.

Totals on the final pages at the first scoring, before these fixes: Claude Code brief 24, quality 18, motion 24. Geno brief 26, quality 16, motion 23. The judge's verdicts did not change, because it judges screenshots, not checks.
