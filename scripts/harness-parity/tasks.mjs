// The tasks both harnesses run. Each starts from the workspace as one of the user's own Geno prompts saw it (a Geno
// checkpoint of ~/Development/เฉิงตู, read-only) and is scored by a hidden check the agent never sees.
// `stall`: a prompt where Geno handed work back to the user. `phase`: a step of docs/plans/chengdu-trip-site.md.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PAGE_BASICS, withPage } from './page.mjs';

/** The shadow repository Geno keeps checkpoints of ~/Development/เฉิงตู in. */
export const CHENGDU_CHECKPOINTS = process.env.HP_CHECKPOINTS ?? path.join(os.homedir(), '.g-code/checkpoints/dffed5b7058a00738581961857b67839');

const read = (ws, rel) => (existsSync(path.join(ws, rel)) ? readFileSync(path.join(ws, rel), 'utf8') : '');
const ok = (pass, detail = '') => ({ pass, detail });

const normalize = (error) => error.replace(/https?:\/\/127\.0\.0\.1:\d+/g, '').split('\n')[0];

/**
 * Loads at 375px with no new uncaught error (one the starting page already threw does not count) and no sideways
 * scroll, then runs `more(page)` for the task's own facts.
 */
const pageCheck = (more = async () => ok(true)) => async ({ ws, base }) => {
  const known = new Set(base === undefined ? [] : await withPage(base, async (page) => page.errors.map(normalize)));
  return withPage(ws, async (page) => {
    const basics = await page.eval(PAGE_BASICS);
    const fresh = page.errors.map(normalize).filter((e) => !known.has(e));
    if (fresh.length > 0) return ok(false, `uncaught: ${fresh[0].slice(0, 160)}`);
    if (basics.width > 376) return ok(false, `scrolls sideways at 375px (${basics.width}px wide)`);
    if (basics.text < 500) return ok(false, `page shows almost nothing (${basics.text} chars)`);
    return more(page);
  });
};

const changed = ({ ws, base }) => read(ws, 'index.html') !== read(base, 'index.html');

const WINYU_TOKENS = `:root {
  /* Winyu design tokens */
  --wy-color-primary: #5b3fd9;
  --wy-color-primary-soft: #f1edff;
  --wy-color-ink: #1d1a2e;
  --wy-color-muted: #6b6880;
  --wy-color-surface: #faf9fd;
  --wy-radius-card: 13px;
  --wy-shadow-card: 0 1px 2px rgb(15 23 42 / 0.06), 0 8px 24px rgb(15 23 42 / 0.06);
  --wy-font-sans: "Anuphan", system-ui, sans-serif;
}
`;

const BATON_SKILL = `---\nname: baton\ndescription: Drive the user's local Chrome through baton run.\n---\n# Baton\n\nRun \`baton run <script.js>\` to drive the browser. Each script gets a \`page\` object.\n`;

const FRONTEND_DESIGN = `---\nname: frontend-design\ndescription: Guidance for distinctive, intentional visual design when building or reshaping UI.\n---\n# Frontend design\n\nPick a clear aesthetic direction before you write CSS: typography with character, a restrained palette with one accent, generous spacing rhythm, and motion only where it explains a change. Avoid templated defaults (centered hero, purple gradients, generic cards). Check the result at the real widths it ships at and iterate until it holds up.\n`;

const PLAN_MD = `# Chengdu trip site (7–14 Nov 2026)

เป้าหมาย: PWA หน้าเดียวบนมือถือ ใช้ออฟไลน์ได้ แสดงแผนเดินทาง เที่ยวบิน ชื่อจีนให้ยื่นคนขับ และแก้เวลา/เลขจองได้เอง
ไฟล์: \`index.html\` (ทั้งแอป), \`sw.js\`, \`manifest.webmanifest\`, \`icon.svg\`, \`plan.jpg\`

## Phases

1. UI มือถือ + ภาษาอังกฤษ + ดีไซน์ใหม่ (serif, สีทะเลสาบ/แดงพริก)
2. หน้า Edit trip (เก็บใน localStorage) แก้เวลาและเลขจองได้
3. ภาพ \`plan.jpg\` ใน section Original plan + ใช้ออฟไลน์ได้
4. Deploy GitHub Pages ชื่อ repo \`chengdu-jiuzhaigou-trip-2026\` แล้วให้ลิงก์
`;

const ICON_LABELS = ['คัดลอก', 'แสดงใหญ่', 'แผนที่', 'คัดลอกเลขจอง'];

/** Phase 2: an edit view whose text field survives a reload through localStorage. */
const editPersists = async (page) => {
  const opened = await page.eval(`(() => {
    const want = /edit|setting|แก้|ตั้งค่า/i;
    const el = [...document.querySelectorAll('button,a,summary,[role=button]')].find((b) => want.test(b.innerText + ' ' + (b.getAttribute('aria-label') ?? '') + ' ' + (b.getAttribute('href') ?? '') + ' ' + (b.title ?? '')));
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!opened) return ok(false, 'no edit or settings control');
  await new Promise((r) => setTimeout(r, 800));
  const set = await page.eval(`(() => {
    const inputs = [...document.querySelectorAll('input:not([type]),input[type=text],input[type=search],textarea')].filter((i) => i.offsetParent !== null);
    if (inputs.length === 0) return 0;
    const i = inputs[0];
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set;
    setter.call(i, 'HP-TEST-123');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    i.dispatchEvent(new Event('blur', { bubbles: true }));
    const save = [...document.querySelectorAll('button,[role=button]')].find((b) => /save|บันทึก|done|เสร็จ/i.test(b.innerText + (b.getAttribute('aria-label') ?? '')));
    save?.click();
    return inputs.length;
  })()`);
  if (set === 0) return ok(false, 'the edit view has no text field');
  await new Promise((r) => setTimeout(r, 500));
  await page.reload();
  const kept = await page.eval(`JSON.stringify(Object.assign({}, localStorage)).includes('HP-TEST-123')`);
  return ok(kept, kept ? '' : 'a typed value is gone from localStorage after a reload');
};

const planImage = async ({ ws, base }) => {
  const html = read(ws, 'index.html');
  if (!/plan\.jpg/.test(html)) return ok(false, 'index.html does not show plan.jpg');
  if (!/plan\.jpg/.test(read(ws, 'sw.js'))) return ok(false, 'sw.js does not cache plan.jpg for offline use');
  return pageCheck(async (page) => {
    const loaded = await page.eval(`(async () => { const img = [...document.images].find((i) => /plan\\.jpg/.test(i.src)); if (!img) return false; img.loading = 'eager'; img.scrollIntoView(); await new Promise((r) => setTimeout(r, 800)); return img.naturalWidth > 0; })()`);
    return ok(loaded, loaded ? '' : 'plan.jpg does not load in the page');
  })({ ws, base });
};

/** Phase 4: a fake gh and a local bare repository stand in for GitHub; the shim logs every call. */
const deployed = ({ ws, home }) => {
  const log = read(home, '.hp/gh.log');
  if (!/repo create/.test(log)) return ok(false, 'never ran gh repo create');
  if (!/pages/.test(log)) return ok(false, 'never turned on GitHub Pages');
  const name = [...log.matchAll(/repo create\s+(?:\S+\/)?([^\s]+)/g)].at(-1)?.[1] ?? '';
  if (!/^[a-z0-9-]+$/.test(name)) return ok(false, `repo name is not plain English: ${name}`);
  const bare = path.join(home, '.hp/github/dev', `${name}.git`);
  try {
    const files = execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (!files.split('\n').includes('index.html')) return ok(false, 'the pushed tree has no index.html');
  } catch {
    return ok(false, 'nothing was pushed');
  }
  return ok(true);
};

/** Tasks from the user's own stalled Geno prompts, replayed at the checkpoint each one saw. */
export const TASKS = [
  {
    id: 'skill-copy',
    set: 'stall',
    sha: '9c1b5f26df',
    homeFiles: { '.claude/skills/baton/SKILL.md': BATON_SKILL },
    prompt: 'ดึง skill ของ baton (อยู่ที่ ~/.claude/skills/baton) มาไว้ในโปรเจกต์นี้ด้วยได้ไหม',
    check: ({ ws, home }) => ok(read(ws, '.claude/skills/baton/SKILL.md') === read(home, '.claude/skills/baton/SKILL.md'), 'no copy of the skill at .claude/skills/baton/SKILL.md'),
  },
  {
    id: 'outside-tokens',
    set: 'stall',
    sha: '3041190275',
    homeFiles: { 'Development/winyu/app/globals.css': WINYU_TOKENS, 'Development/winyu/package.json': '{ "name": "winyu", "private": true }\n' },
    prompt: 'ทำให้ดูสวยใช้ง่ายกว่านี้ ดู modern แบบ saas ใช้ design token จาก winyu project',
    check: async (ctx) => {
      // The planted winyu, or the user's real one that a whole-machine search (Spotlight) can reach: colours from
      // either that the page did not have before count.
      const colours = (text) => new Set((text.toLowerCase().match(/#[0-9a-f]{6}\b/g) ?? []));
      const winyu = new Set([...colours(read(ctx.home, 'Development/winyu/app/globals.css')), ...colours(read(os.homedir(), 'Development/winyu/app/globals.css'))]);
      const before = colours(read(ctx.base, 'index.html'));
      const used = [...colours(read(ctx.ws, 'index.html'))].filter((c) => winyu.has(c) && !before.has(c));
      if (used.length < 3) return ok(false, `uses ${used.length} of winyu's colours`);
      return pageCheck()(ctx);
    },
  },
  {
    id: 'icon-buttons',
    set: 'stall',
    sha: 'd4d2c87d29',
    prompt: 'ใช้ icon แทน text ที่ปุ่มก็ได้นะจะได้ไม่ยาว',
    check: pageCheck(async (page) => {
      const r = await page.eval(`(() => { const labels = ${JSON.stringify(ICON_LABELS)}; const bs = [...document.querySelectorAll('button,a')]; return { worded: bs.filter((b) => labels.includes(b.innerText.trim())).length, icons: bs.filter((b) => b.querySelector('svg') && (b.getAttribute('aria-label') || b.title)).length }; })()`);
      if (r.worded > 0) return ok(false, `${r.worded} buttons still show a word label`);
      return ok(r.icons >= 20, r.icons >= 20 ? '' : `only ${r.icons} labelled icon buttons`);
    }),
  },
  {
    id: 'mobile-375',
    set: 'stall',
    sha: '3e261349b2',
    prompt: 'ตรวจ mobile 375px ด้วยและทดสอบให้ละเอียด',
    check: pageCheck(),
  },
  {
    id: 'agent-review',
    set: 'stall',
    sha: 'bcecddcf47',
    prompt: 'Mobile จะใช้เป็นหลักต้องใช้ง่ายกว่า desktop และจัดเรียงให้ดูง่าย ลองให้ agent review และทดลองใช้ว่าต้องปรับตรงไหน',
    check: async (ctx) => (changed(ctx) ? pageCheck()(ctx) : ok(false, 'index.html unchanged')),
  },
  {
    id: 'review-fix',
    set: 'stall',
    sha: '4a16f2369c',
    prompt: 'มีอะไรอยากปรับอีกไหม ตรวจดูให้ละเอียด จะส่ง agent เปิดใช้งานจริงและตรวจก็ได้',
    check: async (ctx) => (changed(ctx) ? pageCheck()(ctx) : ok(false, 'index.html unchanged')),
  },
  {
    id: 'animation',
    set: 'stall',
    sha: 'fa5e06a967',
    prompt: 'ควรเพิ่ม animation อะไรไหม',
    check: async (ctx) => {
      const html = read(ctx.ws, 'index.html');
      const before = read(ctx.base, 'index.html');
      const count = (s) => (s.match(/@keyframes|transition\s*:|\.animate\(|view-transition/g) ?? []).length;
      if (count(html) <= count(before)) return ok(false, 'no new animation in index.html');
      if (!/prefers-reduced-motion/.test(html)) return ok(false, 'ignores prefers-reduced-motion');
      return pageCheck()(ctx);
    },
  },
  {
    id: 'redesign',
    set: 'phase',
    sha: '11a50c201b',
    homeFiles: { '.claude/skills/frontend-design/SKILL.md': FRONTEND_DESIGN },
    prompt: '/frontend-design ปรับแก้ให้ดีขึ้นหน่อยเน้นใช้บน mobile ปรับ ux/ui ได้หมด',
    check: async (ctx) => (changed(ctx) ? pageCheck()(ctx) : ok(false, 'index.html unchanged')),
  },
  {
    id: 'icon-labels-en',
    set: 'stall',
    sha: '24d6a35918',
    prompt: 'หลายจุดเปลี่ยน English เข้าใจง่ายกว่า Thai',
    check: async (ctx) => (changed(ctx) ? pageCheck()(ctx) : ok(false, 'index.html unchanged')),
  },
  {
    id: 'edit-page',
    set: 'phase',
    sha: '95d405d152',
    prompt: 'ทำหน้า setting เวลาอาจจะเปลี่ยนได้ อยากให้แก้ได้ booking no ด้วย เลขขบวนและอื่นๆ',
    check: pageCheck(editPersists),
  },
  {
    id: 'plan-image',
    set: 'phase',
    sha: '887aebc947',
    prompt: 'ผมใส่ plan image ให้ที่ project เอาไปใส่ที่ website ด้วย',
    check: planImage,
  },
  {
    id: 'deploy',
    set: 'phase',
    sha: '427d0ba500',
    ghShim: true,
    prompt: 'deploy github ชื่อ repo เป็น english ทำ publish link',
    check: deployed,
  },
  {
    id: 'phases-all',
    set: 'phase',
    sha: '11a50c201b',
    extra: { 'docs/plans/chengdu-trip-site.md': PLAN_MD, 'plan.jpg': { fromSha: '887aebc947' } },
    ghShim: true,
    prompt: 'ทำตามแผนใน docs/plans/chengdu-trip-site.md ให้ครบทุก phase',
    check: async (ctx) => {
      for (const [name, step] of [['phase 2', pageCheck(editPersists)], ['phase 3', planImage], ['phase 4', deployed]]) {
        const r = await step(ctx);
        if (!r.pass) return ok(false, `${name}: ${r.detail}`);
      }
      return ok(true);
    },
  },
];
