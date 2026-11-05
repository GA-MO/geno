import { describe, expect, it } from 'vitest';
import type { McpToolInfo, TurnEvent } from '@g-code/core';
import { browserExecutor, lastUrlOf, newBrowserState, type BrowserState } from '../src/mcp/browser.js';
import type { McpServerHandle } from '../src/mcp/server.js';
import type { Approval } from '../src/tools/agent.js';
import { ToolError, type ToolContext } from '../src/tools/context.js';

const WORKSPACE = '/w';
const PAGE = `file://${WORKSPACE}/index.html`;
const SCREENSHOT = { server: 'browser', tool: 'take_screenshot', readOnly: true } as McpToolInfo;

/**
 * A browser server whose pages are `pages`; a call to a page it does not have answers as chrome-devtools-mcp does, and
 * `fail` makes a call to a page it has fail with the page's own words. new_page opens the next id and selects it.
 */
type Options = {
  readonly fail?: (args: Record<string, unknown>) => string | undefined;
  readonly state?: BrowserState;
  readonly approval?: Approval;
  /** new_page leaves its tab on an error page and fails, as when nothing listens at the URL. */
  readonly openFails?: boolean;
};

function setup(pages: { id: number; url: string; selected?: boolean }[], events: TurnEvent[] = [], info: McpToolInfo = SCREENSHOT, { fail, state = newBrowserState(), approval = { kind: 'non-interactive', mcp: true }, openFails = false }: Options = {}) {
  const opened: string[] = [];
  const handle = {
    state: { status: 'ready' },
    call: async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'new_page') {
        opened.push(String(args['url']));
        for (const page of pages) page.selected = false;
        pages.push({ id: Math.max(0, ...pages.map((p) => p.id)) + 1, url: openFails ? 'chrome-error://chromewebdata/' : String(args['url']), selected: true });
        if (openFails) return { structured: undefined, content: [], isError: true };
      }
      if (tool === 'close_page') pages.splice(pages.findIndex((p) => p.id === args['pageId']), 1);
      return { structured: { pages }, content: [], isError: false };
    },
  } as unknown as McpServerHandle;
  const calls: Record<string, unknown>[] = [];
  const executor = browserExecutor(`mcp__browser__${info.tool}`, info, {
    handle,
    approval,
    state,
    allowed: new Set([`mcp__browser__${info.tool}`]),
    call: async (args) => {
      calls.push(args);
      if (!pages.some((p) => p.id === args['pageId'])) throw new ToolError('Error: No page found');
      const failed = fail?.(args);
      if (failed !== undefined) throw new ToolError(failed);
      return { text: `shot of page ${String(args['pageId'])}`, images: [] };
    },
  });
  const ctx = { workspace: WORKSPACE, signal: new AbortController().signal, events: () => events, permissions: undefined } as unknown as ToolContext;
  return { run: (args: Record<string, unknown>) => executor.run(args, ctx), calls, opened };
}

const listing = (id: number, url: string): TurnEvent =>
  ({ kind: 'tool-result', seq: 1, at: '', toolUseId: 't', name: 'mcp__browser__new_page', status: 'ok', output: `## Pages\n1: about:blank\n${id}: BeanCraft (${url}) [selected]` }) as unknown as TurnEvent;

const text = (reply: Awaited<ReturnType<ReturnType<typeof setup>['run']>>) => (typeof reply === 'string' ? reply : reply.text);

describe('a browser call to a page that is gone', () => {
  it('runs on the only real page open and says so', async () => {
    const { run, calls } = setup([{ id: 1, url: 'about:blank' }, { id: 3, url: PAGE }]);
    const reply = await run({ pageId: 2 });
    expect(calls.map((c) => c['pageId'])).toEqual([2, 3]);
    expect(typeof reply === 'string' ? reply : reply.text).toContain(`[Geno] Page 2 is not open, so this ran on page 3 (${PAGE}), the only page open.`);
  });

  it('still moves a read-only call onto the page the model opened itself in the new run, whose listing lacks the old id', async () => {
    const reopenedByModel = { ...listing(2, PAGE), output: `## Pages\n1: about:blank\n2: BeanCraft (${PAGE}) [selected]` } as TurnEvent;
    const { run, calls, opened } = setup([{ id: 1, url: 'about:blank' }, { id: 2, url: PAGE }], [listing(3, `file://${WORKSPACE}/menu.html`), reopenedByModel]);
    expect(text(await run({ pageId: 3 }))).toContain(`[Geno] Page 3 is not open, so this ran on page 2 (${PAGE}), the only page open.`);
    expect(calls.map((c) => c['pageId'])).toEqual([3, 2]);
    expect(opened).toEqual([]);
  });

  it('lists the open pages and the URL the missing page showed when it may not open that URL again itself', async () => {
    const { run, calls, opened } = setup([{ id: 1, url: 'about:blank' }], [listing(2, 'https://unapproved.example/')]);
    await expect(run({ pageId: 2 })).rejects.toThrow('Page 2 is not open: the browser starts fresh in each run, and pages can close. Open pages: 1: about:blank. Page 2 showed https://unapproved.example/; open it again with new_page.');
    expect(calls).toHaveLength(1);
    expect(opened).toEqual([]);
  });

  it('does not choose between two real pages', async () => {
    const { run } = setup([{ id: 3, url: PAGE }, { id: 4, url: `file://${WORKSPACE}/other.html` }]);
    await expect(run({ pageId: 2 })).rejects.toThrow(/Open pages: 3: .*index\.html, 4: .*other\.html\./);
  });

  it('does not move a call onto a page on a host nobody approved', async () => {
    const { run, calls } = setup([{ id: 3, url: 'https://unapproved.example/' }]);
    await expect(run({ pageId: 2 })).rejects.toThrow(/Page 2 is not open/);
    expect(calls).toHaveLength(1);
  });

  it('never moves a call that changes a page, such as close_page, onto a page the model did not name', async () => {
    const { run, calls } = setup([{ id: 1, url: 'about:blank' }, { id: 3, url: PAGE }], [], { server: 'browser', tool: 'close_page', readOnly: false } as McpToolInfo);
    await expect(run({ pageId: 2 })).rejects.toThrow(/Page 2 is not open/);
    expect(calls.map((c) => c['pageId'])).toEqual([2]);
  });

  it('does not move a screenshot that writes a file', async () => {
    const { run, calls } = setup([{ id: 3, url: PAGE }]);
    await expect(run({ pageId: 2, filePath: '/w/shot.png' })).rejects.toThrow(/Page 2 is not open/);
    expect(calls).toHaveLength(1);
  });

  it("passes a page's own 'No page found' error through once, without a retry", async () => {
    const own = setup([{ id: 2, url: PAGE }], [], SCREENSHOT, { fail: () => 'Error: No page found for /missing' });
    await expect(own.run({ pageId: 2 })).rejects.toThrow(/^Error: No page found for \/missing$/);
    expect(own.calls).toHaveLength(1);
    const exact = setup([{ id: 2, url: PAGE }], [], SCREENSHOT, { fail: () => 'Error: No page found' });
    await expect(exact.run({ pageId: 2 })).rejects.toThrow(/^Error: No page found$/);
    expect(exact.calls).toHaveLength(1);
  });

  it('keeps the note when the call on the other page fails too', async () => {
    const { run } = setup([{ id: 3, url: PAGE }], [], SCREENSHOT, { fail: (args) => (args['pageId'] === 3 ? 'Error: element 1_7 not found' : undefined) });
    await expect(run({ pageId: 2 })).rejects.toThrow(`[Geno] Page 2 is not open, so this ran on page 3 (${PAGE}), the only page open.\nError: element 1_7 not found`);
  });

  it('leaves other errors and calls without a pageId as they were', async () => {
    const { run } = setup([{ id: 3, url: PAGE }]);
    await expect(run({})).rejects.toThrow('Error: No page found');
    await expect(run({ pageId: 'two' })).rejects.toThrow('Error: No page found');
  });
});

describe('a browser call after the run started again with a blank browser', () => {
  const EMULATE = { server: 'browser', tool: 'emulate', readOnly: false } as McpToolInfo;

  it('opens the local page the id showed again and runs a read-only call there, in one call', async () => {
    const { run, calls, opened } = setup([{ id: 1, url: 'about:blank' }], [listing(2, PAGE)]);
    const reply = await run({ pageId: 2 });
    expect(opened).toEqual([PAGE]);
    expect(calls.map((c) => c['pageId'])).toEqual([2, 2]);
    expect(text(reply)).toContain(`shot of page 2\n\n[Geno] Page 2 is not open: the browser starts fresh in each run, and pages can close. Geno opened ${PAGE}, which page 2 showed, again as page 2, and this ran there.`);
  });

  it('opens a page again on a host the user or the classifier approved earlier in this run, in Auto', async () => {
    const state = newBrowserState();
    state.approvedHosts.add('approved.example');
    const { run, calls, opened } = setup([{ id: 1, url: 'about:blank' }], [listing(4, 'https://approved.example/pricing')], SCREENSHOT, { state, approval: { kind: 'interactive', mode: () => 'auto' } as unknown as Approval });
    const reply = await run({ pageId: 4 });
    expect(opened).toEqual(['https://approved.example/pricing']);
    expect(calls.map((c) => c['pageId'])).toEqual([4, 2]);
    expect(text(reply)).toContain('again as page 2, and this ran there.');
  });

  it('opens the page again for a call that changes it, but leaves running that call to the model', async () => {
    const { run, calls, opened } = setup([{ id: 1, url: 'about:blank' }], [listing(2, PAGE)], EMULATE);
    await expect(run({ pageId: 2, viewport: '375x800x1' })).rejects.toThrow(`Geno opened ${PAGE}, which page 2 showed, again as page 2; call emulate on page 2.`);
    expect(opened).toEqual([PAGE]);
    expect(calls.map((c) => c['pageId'])).toEqual([2]);
  });

  it('points to a page that already shows the URL instead of opening another', async () => {
    const { run, calls, opened } = setup([{ id: 1, url: 'about:blank' }, { id: 3, url: PAGE }, { id: 4, url: `file://${WORKSPACE}/other.html` }], [listing(2, PAGE)]);
    const reply = await run({ pageId: 2 });
    expect(opened).toEqual([]);
    expect(calls.map((c) => c['pageId'])).toEqual([2, 3]);
    expect(text(reply)).toContain(`[Geno] Page 2 is not open: the browser starts fresh in each run, and pages can close. Page 3 shows ${PAGE}, which page 2 showed, and this ran there.`);
  });

  it('opens nothing for a page that showed only about:blank, a file outside the workspace, or no URL at all', async () => {
    for (const events of [[listing(2, 'about:blank')], [listing(2, 'file:///etc/hosts')], []]) {
      const { run, opened } = setup([{ id: 1, url: 'about:blank' }], events);
      await expect(run({ pageId: 2 })).rejects.toThrow(/Page 2 is not open/);
      expect(opened).toEqual([]);
    }
  });

  it('opens each page the latest listing had again at its own URL, not the first one back', async () => {
    const both = { ...listing(2, PAGE), output: `## Pages\n1: about:blank\n2: BeanCraft (${PAGE})\n3: Menu (file://${WORKSPACE}/menu.html) [selected]` } as TurnEvent;
    const { run, calls, opened } = setup([{ id: 1, url: 'about:blank' }], [both]);
    await run({ pageId: 2 });
    await run({ pageId: 3 });
    expect(opened).toEqual([PAGE, `file://${WORKSPACE}/menu.html`]);
    expect(calls.map((c) => c['pageId'])).toEqual([2, 2, 3, 3]);
  });

  it('does not move a call for a page it may not open again onto the page that came back', async () => {
    const both = { ...listing(2, PAGE), output: `## Pages\n1: about:blank\n2: BeanCraft (${PAGE})\n3: Shop (https://unapproved.example/) [selected]` } as TurnEvent;
    const { run, calls } = setup([{ id: 1, url: 'about:blank' }], [both]);
    await run({ pageId: 2 });
    await expect(run({ pageId: 3 })).rejects.toThrow('Page 3 showed https://unapproved.example/; open it again with new_page.');
    expect(calls.map((c) => c['pageId'])).toEqual([2, 2, 3]);
  });

  it('does not move a call onto the page that came back when its own page failed to open again', async () => {
    const pages = [{ id: 1, url: 'about:blank' }, { id: 2, url: PAGE }];
    const { run, calls } = setup(pages, [listing(3, 'http://localhost:5173/')], SCREENSHOT, { openFails: true });
    await expect(run({ pageId: 3 })).rejects.toThrow('Page 3 showed http://localhost:5173/; open it again with new_page.');
    expect(calls.map((c) => c['pageId'])).toEqual([3]);
  });

  it('reads the URL of a page with no title, which the listing shows bare', async () => {
    const untitled = { ...listing(2, PAGE), output: `## Pages\n1: about:blank\n2: ${PAGE} [selected]` } as TurnEvent;
    const { run, opened } = setup([{ id: 1, url: 'about:blank' }], [untitled]);
    expect(text(await run({ pageId: 2 }))).toContain('again as page 2, and this ran there.');
    expect(opened).toEqual([PAGE]);
  });

  it('closes the tab a failed reopen left behind and lists the pages as they are', async () => {
    const pages = [{ id: 1, url: 'about:blank' }];
    const { run, opened } = setup(pages, [listing(2, 'http://localhost:5173/')], SCREENSHOT, { openFails: true });
    await expect(run({ pageId: 2 })).rejects.toThrow('Open pages: 1: about:blank. Page 2 showed http://localhost:5173/; open it again with new_page.');
    expect(opened).toEqual(['http://localhost:5173/']);
    expect(pages.map((p) => p.url)).toEqual(['about:blank']);
  });

  it('does not open a page again that the model closed, which the latest listing no longer has', async () => {
    const closed = { ...listing(2, PAGE), name: 'mcp__browser__close_page', output: '## Pages\n1: about:blank [selected]' } as TurnEvent;
    const { run, opened } = setup([{ id: 1, url: 'about:blank' }], [listing(2, PAGE), closed]);
    await expect(run({ pageId: 2 })).rejects.toThrow(`Page 2 showed ${PAGE}; open it again with new_page.`);
    expect(opened).toEqual([]);
  });

  it('does not point a call at a page that shows the URL when that URL is on a host nobody approved', async () => {
    const { run, calls, opened } = setup([{ id: 3, url: 'https://unapproved.example/' }, { id: 4, url: PAGE }], [listing(2, 'https://unapproved.example/')]);
    await expect(run({ pageId: 2 })).rejects.toThrow(/Open pages: 3: https:\/\/unapproved\.example\/, 4: /);
    expect(calls).toHaveLength(1);
    expect(opened).toEqual([]);
  });

  it('does not open the page again in Plan mode, where the browser may not open a page', async () => {
    const { run, opened } = setup([{ id: 1, url: 'about:blank' }], [listing(2, PAGE)], SCREENSHOT, { approval: { kind: 'interactive', mode: () => 'plan' } as unknown as Approval });
    await expect(run({ pageId: 2 })).rejects.toThrow(/Page 2 is not open/);
    expect(opened).toEqual([]);
  });
});

describe('lastUrlOf', () => {
  it("reads the page's URL from the latest browser listing, and nothing from other tools", () => {
    expect(lastUrlOf([listing(2, 'file:///a.html'), listing(2, 'file:///b.html')], 2)).toBe('file:///b.html');
    expect(lastUrlOf([listing(2, 'file:///a.html')], 5)).toBeUndefined();
    expect(lastUrlOf([{ ...listing(2, 'file:///a.html'), name: 'bash' } as TurnEvent], 2)).toBeUndefined();
  });
});
