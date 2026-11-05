// What passes, read from measure.mjs's facts. One table of checks in three groups: the brief (ก), quality at 375
// and 1280 (ข), and motion (ค). A check passes only when it saw the thing work: an empty page fails "no sideways
// scroll" because there is nothing to scroll, not because it scrolls.

const PRICE = /[$€£¥฿]\s?\d+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?\s?(?:USD|EUR|GBP|THB|baht|€|£|฿)/i;
const ok = () => ({ pass: true, detail: '' });
const fail = (detail) => ({ pass: false, detail });
const when = (pass, detail) => (pass ? ok() : fail(detail));
const MIN_TEXT = 800;
export const LCP_MS = 2500;
export const CLS_MAX = 0.1;
export const FRAME_P95_MS = 20;
export const LONG_FRAMES_MAX = 3;

const host = (href) => {
  try {
    return new URL(href).hostname;
  } catch {
    return '';
  }
};
const isPdf = (href) => {
  try {
    return new URL(href).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
};
const section = (m, heading) => m.brief.headings.filter((h) => heading.test(h.text)).map((h) => `${h.text} ${h.body}`).join(' ');
const hasContent = (layout) => layout !== undefined && layout.textChars >= MIN_TEXT;
const isLocal = (url) => url.startsWith('/');
const GSAP_FILE = /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/gsap\/3\.12\.5\//;

/** Each check names the measuring session it reads, so a session that failed fails its checks with its reason. */
export const CHECKS = [
  {
    id: 'plans', group: 'brief', session: 'desktop', label: 'three plan cards, each with a price per bag',
    test: (m) => {
      const cards = new Set(m.brief.subscribes.map((s) => s.card).filter((c) => c !== null && PRICE.test(c) && /\bbag\b|\/\s?bag/i.test(c)));
      return when(cards.size >= 3, `${cards.size} cards with a Subscribe control and a price per bag`);
    },
  },
  {
    id: 'checkout', group: 'brief', session: 'desktop', label: 'every Subscribe links out to a Stripe-hosted checkout',
    test: (m) => {
      const s = m.brief.subscribes;
      const bad = s.filter((x) => x.href === null || !x.href.startsWith('https://') || !/(^|\.)stripe\.com$/.test(host(x.href)));
      if (s.length < 3) return fail(`${s.length} Subscribe controls`);
      return when(bad.length === 0, `${bad.length} of ${s.length} Subscribe controls do not link to https://…stripe.com (${bad[0]?.href ?? bad[0]?.tag})`);
    },
  },
  { id: 'pdf', group: 'brief', session: 'desktop', label: 'a brew guide PDF download link', test: (m) => when(m.brief.links.some((l) => isPdf(l.href)), 'no link to a .pdf') },
  { id: 'roaster', group: 'brief', session: 'desktop', label: 'a roaster profile section', test: (m) => when(section(m, /roaster|roastmaster|roast master/i).length > 120, 'no section under a heading that names the roaster') },
  {
    id: 'shipping', group: 'brief', session: 'desktop', label: 'a shipping schedule',
    test: (m) => when(/\b(mon|tues|wednes|thurs|fri|satur|sun)day\b|\bweek(ly|s)?\b|\bmonth(ly)?\b|\bevery \w+ (days|weeks)\b|\bcut-?off\b/i.test(section(m, /ship|deliver/i)), 'no section on shipping or delivery that gives days or a cadence'),
  },
  { id: 'pause', group: 'brief', session: 'desktop', label: 'a "Pause anytime" explainer', test: (m) => when(/pause[^.]{0,80}any ?time|any ?time[^.]{0,80}pause/i.test(m.brief.text), 'nothing says you can pause anytime') },
  {
    id: 'faq', group: 'brief', session: 'desktop', label: 'an FAQ that covers freshness and grinding',
    test: (m) => {
      const faq = section(m, /faq|frequently asked|questions/i);
      if (faq === '') return fail('no FAQ heading');
      return when(/fresh/i.test(faq) && /grind/i.test(faq), `the FAQ does not cover ${/fresh/i.test(faq) ? 'grinding' : 'freshness'}`);
    },
  },
  {
    id: 'sustainability', group: 'brief', session: 'desktop', label: 'a sustainability statement on farms, certifications and packaging',
    test: (m) => {
      const s = section(m, /sustainab/i);
      if (s === '') return fail('no sustainability heading');
      const missing = [['farms', /farm/i], ['certifications', /certif|fair ?trade|organic|rainforest alliance|b corp/i], ['packaging', /packag/i]].filter(([, re]) => !re.test(s)).map(([w]) => w);
      return when(missing.length === 0, `says nothing on ${missing.join(', ')}`);
    },
  },
  {
    id: 'explains', group: 'brief', session: 'desktop', label: 'explains roast profiles, sourcing and delivery cadence',
    test: (m) => {
      const t = m.brief.text;
      const missing = [['roast profiles', (t.match(/\b(light|medium|dark)(-| )roast/gi) ?? []).length >= 2 || /roast profile/i.test(t)], ['sourcing', /sourc/i.test(t)], ['cadence', /cadence|every (two|three|four|2|3|4) weeks|weekly|biweekly|fortnight|monthly/i.test(t)]].filter(([, has]) => !has).map(([w]) => w);
      return when(missing.length === 0, `does not explain ${missing.join(', ')}`);
    },
  },
  {
    id: 'no-storage', group: 'brief', session: 'phone', label: 'writes no localStorage, sessionStorage or cookie',
    test: (m) => (!hasContent(m.layout375) ? fail('nothing on the page') : when(m.storage.length === 0 && !m.stored, `writes ${m.storage[0] ?? 'stored data'}`)),
  },
  {
    id: 'self-contained', group: 'brief', session: 'desktop', label: 'one index.html: loads nothing but itself and GSAP from cdnjs',
    test: (m) => {
      const extra = m.requests.filter((u) => u !== '/index.html' && !(GSAP_FILE.test(u)));
      if (!hasContent(m.layout1280)) return fail('nothing on the page');
      return when(m.requests.some(isLocal) && extra.length === 0, `also loads ${extra.slice(0, 2).join(', ')}`);
    },
  },
  ...[375, 1280].flatMap((w) => [
    {
      id: `no-hscroll@${w}`, group: 'quality', session: w === 375 ? 'phone' : 'desktop', label: `no sideways scroll at ${w}px`,
      test: (m) => {
        const l = m[`layout${w}`];
        if (!hasContent(l)) return fail('nothing on the page');
        if (l.viewport !== w) return fail(`lays out ${l.viewport}px wide: no width=device-width viewport`);
        return when(l.scrollWidth <= w + 1, `${l.scrollWidth}px wide`);
      },
    },
    { id: `no-overflow@${w}`, group: 'quality', session: w === 375 ? 'phone' : 'desktop', label: `no text out of its box at ${w}px`, test: (m) => (!hasContent(m[`layout${w}`]) ? fail('nothing on the page') : when(m[`layout${w}`].overflows.length === 0, m[`layout${w}`].overflows[0])) },
    {
      id: `contrast@${w}`, group: 'quality', session: w === 375 ? 'phone' : 'desktop', label: `axe-core color contrast at ${w}px`,
      test: (m) => (!hasContent(m[`layout${w}`]) ? fail('nothing on the page') : when(m[`layout${w}`].contrast.violations === 0, `${m[`layout${w}`].contrast.violations} elements: ${m[`layout${w}`].contrast.examples[0]}`)),
    },
  ]),
  {
    id: 'tap-targets@375', group: 'quality', session: 'phone', label: 'every button at least 44px tall at 375px',
    test: (m) => (!hasContent(m.layout375) ? fail('nothing on the page') : when(m.layout375.smallButtons.length === 0, `${m.layout375.smallButtons.length} short: ${m.layout375.smallButtons.slice(0, 2).map((b) => `${b.el} ${b.height}px`).join(', ')}`)),
  },
  { id: 'console', group: 'quality', session: 'desktop', label: 'no console error or uncaught exception', test: (m) => (!hasContent(m.layout1280) ? fail('nothing on the page') : when(m.console.length === 0, m.console[0])) },
  { id: 'lcp', group: 'quality', session: 'phone', label: `LCP at 375px within ${LCP_MS}ms`, test: (m) => when(m.vitals375.lcp > 0 && m.vitals375.lcp <= LCP_MS, m.vitals375.lcp === 0 ? 'nothing was painted' : `${m.vitals375.lcp}ms`) },
  {
    id: 'cls', group: 'quality', session: 'phone', label: `CLS at most ${CLS_MAX} at 375 and 1280`,
    test: (m) => (!hasContent(m.layout375) ? fail('nothing on the page') : when(Math.max(m.vitals375.cls, m.vitals1280?.cls ?? 0) <= CLS_MAX, `CLS ${m.vitals375.cls} at 375, ${m.vitals1280?.cls} at 1280`)),
  },
  {
    id: 'webgl2', group: 'motion', session: 'desktop', label: 'a WebGL2 context whose shaders compile and link',
    test: (m) => {
      const w = m.webgl;
      if (!w.contexts.some((c) => c.type === 'webgl2' && c.ok)) return fail(w.contexts.length ? `asked for ${w.contexts.map((c) => c.type).join(', ')} only` : 'never asked for a WebGL context');
      if (w.compileFailed.length || w.linkFailed.length) return fail(`shader error: ${w.compileFailed[0] ?? w.linkFailed[0]}`);
      return when(w.linked > 0, 'no shader program linked');
    },
  },
  { id: 'hero-renders', group: 'motion', session: 'desktop', label: 'the hero canvas shows an image, not black', test: (m) => (!m.hero.found ? fail('no canvas in the first screen') : when(m.hero.mean > 8 || m.hero.std > 3, `canvas is black (mean luma ${Math.round(m.hero.mean)})`)) },
  {
    id: 'pointer', group: 'motion', session: 'desktop', label: 'moving the pointer changes the hero',
    test: (m) => (!m.hero.found ? fail('no canvas in the first screen') : when(m.hero.pointerDiff > m.hero.timeDiff * 1.25 + 0.5, `pointer move changed ${m.hero.pointerDiff}, time alone ${m.hero.timeDiff}`)),
  },
  {
    id: 'context-restore', group: 'motion', session: 'desktop', label: 'the hero comes back after WEBGL_lose_context',
    test: (m) => {
      const r = m.restore;
      if (r === undefined || !r.tried) return fail('no WebGL context to lose');
      const back = r.after.std >= r.before.std * 0.4 && Math.abs(r.after.mean - r.before.mean) <= Math.max(12, r.before.mean * 0.5);
      return when(back && r.before.mean + r.before.std > 8, `after restoring: mean ${Math.round(r.after.mean)} std ${Math.round(r.after.std)}, before ${Math.round(r.before.mean)}/${Math.round(r.before.std)}`);
    },
  },
  {
    id: 'gsap', group: 'motion', session: 'desktop', label: 'GSAP 3.12.5 and ScrollTrigger from cdnjs, triggers fire',
    test: (m) => {
      const g = m.gsap;
      if (g.version !== '3.12.5') return fail(g.version ? `GSAP ${g.version}` : 'no GSAP');
      if (!g.sources.some((s) => GSAP_FILE.test(s) && /ScrollTrigger/.test(s))) return fail('ScrollTrigger is not loaded from cdnjs 3.12.5');
      return when(g.scrollTrigger && g.fired > 0, `${g.triggers} ScrollTriggers, ${g.fired} fired`);
    },
  },
  {
    id: 'frames', group: 'motion', session: 'desktop', label: `smooth scroll: p95 frame within ${FRAME_P95_MS}ms, at most ${LONG_FRAMES_MAX} over 33ms`,
    test: (m) => (!hasContent(m.layout1280) ? fail('nothing on the page') : when(m.frames.p95 <= FRAME_P95_MS && m.frames.over33 <= LONG_FRAMES_MAX, `p95 ${m.frames.p95}ms, ${m.frames.over33} of ${m.frames.count} frames over 33ms`)),
  },
  {
    id: 'reduced-motion', group: 'motion', session: 'reduced', label: 'with reduced motion the shader stops and nothing moves but fades',
    test: (m) => {
      if (m.normalMovers.length === 0 && !(m.hero.timeDiff > 0.5)) return fail('nothing moves even without reduced motion');
      if (m.reduced.canvasDiff > 0.5) return fail(`the shader still animates (${m.reduced.canvasDiff})`);
      return when(m.reduced.movers.length === 0, `still moves: ${m.reduced.movers.slice(0, 3).join(', ')}`);
    },
  },
  { id: 'no-pin', group: 'motion', session: 'desktop', label: 'no ScrollTrigger pinning', test: (m) => (!m.gsap.scrollTrigger ? fail('no ScrollTrigger') : when(m.gsap.pinned === 0, `${m.gsap.pinned} pinned`)) },
  { id: 'wheel-1000', group: 'motion', session: 'desktop', label: 'a 1000px wheel scrolls 1000px', test: (m) => (m.wheel.expected < 1000 ? fail(`the page is only ${m.wheel.expected}px taller than the screen`) : when(Math.abs(m.wheel.moved - 1000) <= 25, `moved ${m.wheel.moved}px`)) },
];

export const GROUPS = { brief: 'ก brief', quality: 'ข quality', motion: 'ค motion' };

/** Every check's result for one page's measures: { id: { group, pass, detail } }. */
export function score(m) {
  return Object.fromEntries(
    CHECKS.map((c) => {
      let r;
      if (m.fatal) r = fail(m.fatal);
      else if (m.errors?.[c.session]) r = fail(`could not measure: ${m.errors[c.session]}`);
      else {
        try {
          r = c.test(m);
        } catch (error) {
          r = fail(`could not measure: ${error.message}`);
        }
      }
      return [c.id, { group: c.group, ...r }];
    }),
  );
}

export const passed = (scores, group) => Object.values(scores).filter((s) => s.pass && (group === undefined || s.group === group)).length;
export const groupSize = (group) => CHECKS.filter((c) => c.group === group).length;

/** Checks that passed in the first round and fail after the feedback round. */
export const regressions = (before, after) => Object.keys(before).filter((id) => before[id].pass && !after[id].pass);

/** The supporting numbers for the three feedback asks: section gap spread at 375 and how the prices are set. */
export function feedbackFacts(m) {
  const gaps = m.layout375?.gaps ?? [];
  const mean = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;
  const spread = gaps.length > 1 && mean > 0 ? Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length) / mean : null;
  const prices = m.layout375?.prices ?? [];
  const ratios = prices.map((p) => (p.color && p.background ? contrastRatio(p.color, p.background) : null)).filter((r) => r !== null);
  return {
    gapSpread: spread === null ? null : Math.round(spread * 100) / 100,
    priceFontPx: prices.length ? Math.min(...prices.map((p) => p.fontSize)) : null,
    priceContrast: ratios.length ? Math.round(Math.min(...ratios) * 10) / 10 : null,
  };
}

const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG contrast of a text colour on its background; a translucent text colour is blended onto the background first. */
export function contrastRatio(fg, bg) {
  const a = fg[3] ?? 1;
  const mixed = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
  const [l1, l2] = [lum(mixed), lum(bg)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
