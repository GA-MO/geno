// The blind judge of the landing pages, on screenshots only: which of two pages is better, by a rubric (RUBRICS), and
// whether a second round fixed the three feedback asks. It never sees which harness made a page.
import { readFileSync } from 'node:fs';
import { ask } from '../llm.mjs';
import { ASKS, FEEDBACK, PROMPT } from './task.mjs';

export const JUDGE_MODEL = 'claude-opus-5-5';
const VIEWS = [
  ['hero', 'the first screen at 1280px wide'],
  ['desktop', 'the whole page at 1280px, one screen per tile, top to bottom'],
  ['phone', 'the whole page at 375px, one screen per tile, top to bottom'],
  ['motion', 'motion frames at 1280px: 1-2 while loading, 3-4 after the pointer crossed the hero, 5-7 scrolled to a third, two thirds and the bottom'],
];

const image = (file) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: readFileSync(file).toString('base64') } });
const views = (label, sheets) => VIEWS.filter(([key]) => sheets[key]).flatMap(([key, what]) => [{ type: 'text', text: `${label}: ${what}` }, image(sheets[key])]);

const SCORES = 'Answer with JSON only: {"A": {"brief": n, "beauty": n, "layout": n}, "B": {"brief": n, "beauty": n, "layout": n}, "why": "<two sentences>"}';

/**
 * How a pair is scored. `v1` is the rubric fixed before the run. `taste` is calibrated on the owner's own votes:
 * layout weighs most and is read the way the owner reads a page.
 */
export const RUBRICS = {
  v1: {
    weights: { brief: 0.4, beauty: 0.3, layout: 0.3 },
    system: `You judge two landing pages built from the same brief, from screenshots only. Score each page from 0 to 10 on three criteria:
- brief: how fully and visibly the page delivers what the brief asks (every requested section and fact, the warm and informative vibe, the full-bleed shader hero).
- beauty: visual craft, such as type, colour, imagery, spacing rhythm and the motion frames. Premium and intentional scores high; template-like or amateur scores low.
- layout: structure at 1280px and at 375px. Nothing broken, cramped, overlapping or misaligned.
Judge only what the images show. Do not reward length for its own sake.
${SCORES}`,
  },
  taste: {
    weights: { layout: 0.5, beauty: 0.3, brief: 0.2 },
    system: `You judge two landing pages built from the same brief, from screenshots only, for a senior frontend engineer with a strict eye for layout. Score each page from 0 to 10 on three criteria:
- layout, the one that matters most. Read it the way this reader does, at 1280px and at 375px:
  - spacing follows one rhythm: the gaps between sections, and between a heading and its content, repeat the same steps instead of varying at random;
  - padding is equal: cards, buttons and sections have the same inner space on every side and match their siblings;
  - centred things are truly centred, and edges line up on a shared grid;
  - the hierarchy reads at a glance: on each screen one thing is clearly first, then the rest, with big numbers and little text where a choice is made;
  - nothing is cluttered or busy: no crowding, no competing accents, no walls of small text;
  - the 375px page is not broken: nothing squeezed, overflowing, cut off or stacked awkwardly.
- beauty: does it look premium and intentional, like a real product team made it, and not like a template or typical AI output? Generic gradients, stock section patterns and decoration without purpose score low.
- brief: whether the page visibly delivers the requested sections and the warm, informative vibe. Most pages here deliver it, so do not let it decide close calls.
Judge only what the images show. Do not reward length for its own sake.
${SCORES}`,
  },
};

const total = (weights, s) => Object.entries(weights).reduce((sum, [k, w]) => sum + w * Number(s?.[k] ?? 0), 0);

/** One order of one pair: page A shown first. The winner is the higher weighted total; equal totals are a tie. */
export async function judgePair(a, b, via, rubric = RUBRICS.v1) {
  const content = [{ type: 'text', text: `The brief:\n${PROMPT}` }, ...views('Page A', a), ...views('Page B', b), { type: 'text', text: 'Score both pages.' }];
  const r = await ask(JUDGE_MODEL, rubric.system, content, 800, via);
  const [ta, tb] = [total(rubric.weights, r.A), total(rubric.weights, r.B)];
  return { A: r.A, B: r.B, totals: [Math.round(ta * 100) / 100, Math.round(tb * 100) / 100], winner: ta > tb ? 'A' : tb > ta ? 'B' : 'tie', why: r.why };
}

const FIX_SYSTEM = `A landing page got one round of feedback. You see it before and after, from screenshots only. For each ask, say whether the after version fixed it: "yes", "partly" or "no". Then say whether everything else stayed as it was ("kept": true), or something else changed for the worse or was removed ("kept": false).
Answer with JSON only: {${Object.keys(ASKS).map((k) => `"${k}": "yes" | "partly" | "no"`).join(', ')}, "kept": true | false, "why": "<two sentences>"}`;

/** Whether the second round fixed each feedback ask, from before and after screenshots of the same page. */
export async function judgeFixes(before, after, cards, via) {
  const crops = (label, c) => c.flatMap(([file, what]) => (file ? [{ type: 'text', text: `${label}: the plan cards at ${what}` }, image(file)] : []));
  const content = [
    { type: 'text', text: `The feedback:\n${FEEDBACK}\n\nThe asks: ${Object.entries(ASKS).map(([k, v]) => `${k} = ${v}`).join('; ')}.` },
    ...views('Before', before),
    ...crops('Before', cards.before),
    ...views('After', after),
    ...crops('After', cards.after),
  ];
  return ask(JUDGE_MODEL, FIX_SYSTEM, content, 600, via);
}
