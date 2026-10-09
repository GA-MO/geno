import { afterAll, describe, expect, it } from 'vitest';
import type { CatalogHit, CatalogPreviewResponse, InstalledItem } from '@g-code/core';
import { closeBrowser, openPanel, type Panel } from './harness.js';

const THEMES = ['dark', 'light', 'high-contrast'] as const;
const CATALOG = '/Users/me/catalogs/team';

const ITEMS: readonly InstalledItem[] = [
  { kind: 'skill', name: 'verify', description: 'Drive the app the way a user does', where: 'workspace', path: '.claude/skills/verify/SKILL.md', loads: true },
  {
    kind: 'skill',
    name: 'release-notes',
    description: 'Write release notes from merged pull requests',
    where: 'user',
    path: '/Users/me/.g-code/skills/release-notes/SKILL.md',
    install: { id: 'i-1', version: '1.2.0', catalog: CATALOG },
    loads: true,
  },
];

const hit = (over: Partial<CatalogHit> & Pick<CatalogHit, 'name'>): CatalogHit => ({
  catalog: CATALOG,
  catalogName: 'Team skills',
  kind: 'skill',
  description: `The ${over.name} skill`,
  version: '1.0.0',
  files: [{ path: 'SKILL.md', size: 812 }],
  installed: [],
  ...over,
});

const HITS: readonly CatalogHit[] = [
  hit({
    name: 'deploy-notes',
    description: 'Write release notes for a deploy',
    files: [
      { path: 'SKILL.md', size: 812 },
      { path: 'references/steps.md', size: 2_400 },
      { path: 'install.sh', size: 64 },
    ],
  }),
  hit({ name: 'reviewer', kind: 'agent', description: 'Reviews a diff for bugs', files: [{ path: 'reviewer.md', size: 300 }], installed: ['project'] }),
  hit({ name: 'escape', description: 'Writes outside its folder', problem: '../../.zshrc: the path has a ".." segment', files: [{ path: 'SKILL.md' }, { path: '../../.zshrc' }] }),
];

const PREVIEW: CatalogPreviewResponse = {
  hit: HITS[0]!,
  file: 'SKILL.md',
  fields: [
    ['name', 'deploy-notes'],
    ['description', 'Write release notes for a deploy'],
  ],
  body: '# Deploy notes\n\nRead references/steps.md, then write the notes.\n\n<img src=x onerror="document.body.dataset.pwned=1">\n',
};

async function openSettings(): Promise<Panel> {
  const panel = await openPanel();
  await panel.host.post({ type: 'show-settings' });
  await panel.host.next('skills-list');
  await panel.host.post({ type: 'skills', listing: { kind: 'loaded', items: ITEMS, pluginSkills: 54, catalogs: [CATALOG] } });
  await panel.host.post({ type: 'catalog-results', results: { kind: 'found', query: '', hits: HITS, problems: ['https://skills.example.com/catalog.json answered HTTP 404'] } });
  await panel.eval(`(doc.querySelector('.skills-section').scrollIntoView({ block: 'start' }), 1)`);
  return panel;
}

const card = (name: string) => `.skills-hit[data-name="${name}"]`;

async function screenshots(panel: Panel, name: string): Promise<void> {
  await panel.page.mouse.move(0, 0);
  for (const slug of THEMES) {
    await panel.theme(slug);
    await panel.screenshot(`${name}-${slug}`);
  }
  await panel.theme('dark');
}

afterAll(closeBrowser);

describe('the Skills section of Settings', () => {
  it('lists what Geno loads, with Uninstall only on what Geno installed, and the catalogs and their problems', async () => {
    const panel = await openSettings();
    const rows = await panel.eval<{ name: string; where: string; uninstall: boolean }[]>(
      `[...doc.querySelectorAll('.skills-row')].map((r) => ({ name: r.dataset.name, where: r.querySelector('.skills-where').textContent, uninstall: r.querySelector('.skills-uninstall') !== null }))`,
    );
    expect(rows).toEqual([
      { name: 'verify', where: 'Workspace', uninstall: false },
      { name: 'release-notes', where: 'You', uninstall: true },
    ]);
    expect(await panel.eval(`doc.querySelector('.skills-plugins').textContent`)).toBe('Also 54 skills from Claude Code plugins, which Claude Code installs.');
    expect(await panel.eval(`[...doc.querySelectorAll('.skills-catalog code')].map((c) => c.textContent)`)).toEqual([CATALOG]);
    expect(await panel.eval(`doc.querySelector('.skills-problems').textContent`)).toBe('https://skills.example.com/catalog.json answered HTTP 404');
    expect(await panel.eval(`doc.querySelector('.skills-status').textContent`)).toBe('3 entries');

    await panel.click(`.skills-row[data-name="release-notes"] .skills-uninstall`);
    expect(await panel.host.next('catalog-uninstall')).toEqual({ type: 'catalog-uninstall', id: 'i-1', name: 'release-notes' });

    await panel.click('.skills-catalog-input');
    await panel.type('https://skills.example.com/catalog.json');
    await panel.press('Enter');
    expect(await panel.host.next('catalog-add')).toEqual({ type: 'catalog-add', text: 'https://skills.example.com/catalog.json' });
    await panel.click(`.skills-catalog .perm-remove`);
    expect(await panel.host.next('catalog-remove')).toEqual({ type: 'catalog-remove', text: CATALOG });

    await panel.click('.skills-query');
    await panel.type('release notes');
    expect(await panel.host.next('catalog-search')).toEqual({ type: 'catalog-search', query: 'release notes' });
    await screenshots(panel, 'skills-list');
    await panel.close();
  });

  it('opens an entry read-only, shows its checked main file as text, and installs only once the preview is in', async () => {
    const panel = await openSettings();
    await panel.click(`${card('deploy-notes')} .provider-head`);
    expect(await panel.host.next('catalog-open')).toEqual({ type: 'catalog-open', catalog: CATALOG, kind: 'skill', name: 'deploy-notes' });
    expect(await panel.eval(`doc.querySelector('${card('deploy-notes')} .skills-install-button').disabled`), 'Install waits for the preview').toBe(true);
    expect(await panel.eval(`[...doc.querySelectorAll('${card('deploy-notes')} .skills-files code')].map((c) => c.textContent)`)).toEqual(['SKILL.md', 'references/steps.md', 'install.sh']);

    const key = `${CATALOG}\nskill\ndeploy-notes`;
    await panel.host.post({ type: 'catalog-preview', state: { kind: 'shown', key, preview: PREVIEW } });
    await panel.frame();
    expect(await panel.eval(`[...doc.querySelectorAll('${card('deploy-notes')} .skills-fields dt')].map((d) => d.textContent)`)).toEqual(['name', 'description']);
    expect(await panel.eval(`doc.querySelector('${card('deploy-notes')} .skills-body').textContent`)).toBe(PREVIEW.body);
    expect(await panel.count(`${card('deploy-notes')} .skills-body img`), 'the body is text, never markup').toBe(0);
    expect(await panel.eval(`doc.body.dataset.pwned ?? null`)).toBe(null);
    expect(await panel.eval(`[...doc.querySelectorAll('${card('deploy-notes')} .skills-scope option')].map((o) => o.textContent)`)).toEqual(['For you, in ~/.g-code', 'This workspace, in .g-code']);

    await panel.eval(`(() => { const s = doc.querySelector('${card('deploy-notes')} .skills-scope'); s.value = 'project'; s.dispatchEvent(new Event('change')); return 1; })()`);
    await panel.frame();
    await panel.eval(`(doc.querySelector('${card('deploy-notes')}').scrollIntoView({ block: 'start' }), 1)`);
    await screenshots(panel, 'skills-preview');
    await panel.click(`${card('deploy-notes')} .skills-install-button`);
    expect(await panel.host.next('catalog-install')).toEqual({ type: 'catalog-install', catalog: CATALOG, kind: 'skill', name: 'deploy-notes', scope: 'project' });

    await panel.host.post({ type: 'catalog-outcome', outcome: { key, tone: 'failed', text: 'deploy-notes from team: SKILL.md does not match its sha256 in the catalog; nothing was installed' } });
    await panel.frame();
    expect(await panel.eval(`doc.querySelector('${card('deploy-notes')} .skills-outcome').dataset.tone`)).toBe('failed');
    await screenshots(panel, 'skills-refused');

    await panel.click(`${card('escape')} .provider-head`);
    await panel.frame();
    expect(await panel.eval(`doc.querySelector('${card('escape')} .skills-detail .provider-test').textContent`)).toBe('../../.zshrc: the path has a ".." segment');
    expect(await panel.eval(`doc.querySelector('${card('escape')} .skills-install-button').disabled`)).toBe(true);
    expect(panel.host.received.filter((m) => m.type === 'catalog-open'), 'an unusable entry is never fetched').toHaveLength(1);

    await panel.click(`${card('reviewer')} .provider-head`);
    await panel.host.next('catalog-open');
    await panel.host.post({ type: 'catalog-preview', state: { kind: 'shown', key: `${CATALOG}\nagent\nreviewer`, preview: { ...PREVIEW, hit: HITS[1]!, file: 'reviewer.md' } } });
    await panel.eval(`(() => { const s = doc.querySelector('${card('reviewer')} .skills-scope'); s.value = 'project'; s.dispatchEvent(new Event('change')); return 1; })()`);
    await panel.frame();
    expect(await panel.eval(`doc.querySelector('${card('reviewer')} .skills-install-button').textContent`), 'installed in the chosen scope').toBe('Installed');
    await panel.close();
  });

  it('fits a 300px panel, with nothing running past the section edge', async () => {
    const panel = await openSettings();
    await panel.click(`${card('deploy-notes')} .provider-head`);
    await panel.host.post({ type: 'catalog-preview', state: { kind: 'shown', key: `${CATALOG}\nskill\ndeploy-notes`, preview: PREVIEW } });
    await panel.page.setViewportSize({ width: 300, height: 794 });
    await panel.frame();
    const outside = await panel.eval<string[]>(
      `(() => { const c = doc.querySelector('.skills-section').getBoundingClientRect(); return [...doc.querySelectorAll('.skills-section *')].filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().right > c.right + 0.5).map((e) => e.className || e.tagName); })()`,
    );
    expect(outside).toEqual([]);
    expect(await panel.eval(`doc.scrollingElement.scrollWidth <= doc.scrollingElement.clientWidth`)).toBe(true);
    await panel.eval(`(doc.querySelector('${card('deploy-notes')}').scrollIntoView({ block: 'start' }), 1)`);
    await screenshots(panel, 'skills-300');
    await panel.close();
  });
});
