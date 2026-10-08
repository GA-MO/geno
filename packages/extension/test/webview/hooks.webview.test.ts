import { afterAll, describe, expect, it } from 'vitest';
import type { HookProblem, HookRow } from '@g-code/core';
import { closeBrowser, openPanel } from './harness.js';

const THEMES = ['dark', 'light', 'high-contrast'] as const;

const row = (over: Partial<HookRow> & Pick<HookRow, 'event' | 'command' | 'status'>): HookRow => ({ matcher: undefined, file: '/Users/me/.claude/settings.json', scope: 'user', plugin: undefined, ...over });

const HOOKS: readonly HookRow[] = [
  row({ event: 'SessionStart', matcher: 'startup|resume|clear|compact', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh" claude', status: 'runs', file: '/Users/me/.claude/plugins/cache/pstack/hooks/hooks.json', plugin: 'pstack' }),
  row({ event: 'Stop', command: 'curl -d "Geno is done" ntfy.sh/my-topic', status: 'runs' }),
  row({ event: 'SubagentStop', command: './scripts/child-done.sh', status: 'runs' }),
  row({ event: 'Notification', command: '/Users/me/.orbit/bin/orbit hook notify', status: 'never', why: 'Geno shows its cards and notices in the editor. PermissionRequest and Stop fire at the same moments.' }),
  row({ event: 'SessionEnd', command: './scripts/cleanup.sh', status: 'untrusted', file: '/repo/.claude/settings.json', scope: 'project' }),
];

const PROBLEMS: readonly HookProblem[] = [{ severity: 'warning', text: '/repo/.claude/settings.json: SesionStart is not a hook event, so its hooks never run. Check the spelling against Claude Code\'s event names.' }];

afterAll(closeBrowser);

describe('the Hooks section of Settings', () => {
  it('asks for the hooks when Settings opens, lists each with where it came from and whether it runs, and warns about a misspelled event', async () => {
    const panel = await openPanel();
    await panel.host.post({ type: 'show-settings' });
    expect(await panel.host.next('hooks-list')).toEqual({ type: 'hooks-list' });
    await panel.host.post({ type: 'hooks', listing: { kind: 'loaded', trusted: false, hooks: HOOKS, problems: PROBLEMS } });
    await panel.eval(`(doc.querySelector('.hooks-section').scrollIntoView({ block: 'start' }), 1)`);

    const rows = await panel.eval<{ event: string; command: string; source: string; status: string; why: string | null }[]>(
      `[...doc.querySelectorAll('.hook-row')].map((r) => ({ event: r.querySelector('.hook-event').textContent, command: r.querySelector('code').textContent, source: r.querySelector('.hook-source').textContent, status: r.querySelector('.hook-status').textContent, why: r.querySelector('.hook-why')?.textContent ?? null }))`,
    );
    expect(rows).toEqual([
      { event: 'SessionStart (startup|resume|clear|compact)', command: HOOKS[0]!.command, source: 'From the pstack plugin', status: 'Runs', why: null },
      { event: 'Stop', command: HOOKS[1]!.command, source: 'From /Users/me/.claude/settings.json', status: 'Runs', why: null },
      { event: 'SubagentStop', command: './scripts/child-done.sh', source: 'From /Users/me/.claude/settings.json', status: 'Runs', why: null },
      { event: 'Notification', command: HOOKS[3]!.command, source: 'From /Users/me/.claude/settings.json', status: 'Geno never fires it', why: HOOKS[3]!.why },
      { event: 'SessionEnd', command: './scripts/cleanup.sh', source: 'From /repo/.claude/settings.json', status: 'Needs a trusted workspace', why: null },
    ]);
    expect(await panel.eval(`[...doc.querySelectorAll('.hook-problem')].map((p) => [p.dataset.severity, p.textContent])`)).toEqual([['warning', PROBLEMS[0]!.text]]);

    await panel.page.mouse.move(0, 0);
    for (const slug of THEMES) {
      await panel.theme(slug);
      await panel.eval(`(doc.querySelector('.hooks-section').scrollIntoView({ block: 'start' }), 1)`);
      await panel.screenshot(`hooks-list-${slug}`);
    }
    await panel.close();
  });

  it('says so when no hook is configured, and shows why the listing failed', async () => {
    const panel = await openPanel();
    await panel.host.post({ type: 'show-settings' });
    await panel.host.next('hooks-list');
    await panel.host.post({ type: 'hooks', listing: { kind: 'loaded', trusted: true, hooks: [], problems: [] } });
    expect(await panel.eval(`doc.querySelector('.hooks-section .perm-note').textContent`)).toBe('No hooks. Add one under "hooks" in ~/.claude/settings.json.');
    await panel.host.post({ type: 'hooks', listing: { kind: 'failed', message: 'the engine is not running' } });
    expect(await panel.eval(`doc.querySelector('.hooks-section .perm-note').textContent`)).toBe('the engine is not running');
    expect(await panel.eval(`doc.querySelectorAll('.hook-row').length`)).toBe(0);
    await panel.close();
  });
});
