import { afterAll, describe, expect, it } from 'vitest';
import { closeBrowser, openPanel } from './harness.js';

afterAll(closeBrowser);

describe('the Permissions section of Settings', () => {
  it("lists the settings files' rules read-only with their file, below Geno's own removable rules", async () => {
    const panel = await openPanel();
    await panel.host.post({ type: 'show-settings' });
    await panel.host.next('permissions-list');
    await panel.host.post({
      type: 'permissions',
      listing: {
        kind: 'loaded',
        workspace: '/repo',
        rules: [{ id: 'r1', effect: 'allow', text: 'pnpm test' }],
        imported: [
          { effect: 'deny', text: 'touch', source: '.agents/settings.json' },
          { effect: 'ask', text: 'git push', source: '~/.claude/settings.json' },
        ],
      },
    });
    const rows = await panel.eval<{ effect: string; text: string; source: string | null; removable: boolean }[]>(
      `[...doc.querySelectorAll('.perm-section .perm-row')].map((r) => ({ effect: r.dataset.effect, text: r.querySelector('.perm-pattern').textContent, source: r.querySelector('.perm-source')?.textContent ?? null, removable: r.querySelector('.perm-remove') !== null }))`,
    );
    expect(rows).toEqual([
      { effect: 'allow', text: 'pnpm test', source: null, removable: true },
      { effect: 'deny', text: 'touch', source: '.agents/settings.json', removable: false },
      { effect: 'ask', text: 'git push', source: '~/.claude/settings.json', removable: false },
    ]);
    expect(await panel.eval(`doc.querySelector('.perm-imported-heading').hidden`)).toBe(false);

    await panel.host.post({ type: 'permissions', listing: { kind: 'loaded', workspace: '/repo', rules: [], imported: [] } });
    expect(await panel.eval(`[doc.querySelector('.perm-imported-heading').hidden, doc.querySelectorAll('.perm-imported').length]`)).toEqual([true, 0]);
    await panel.close();
  });
});
