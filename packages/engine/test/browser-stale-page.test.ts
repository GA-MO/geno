import { describe, expect, it } from 'vitest';
import type { McpToolInfo, TurnEvent } from '@g-code/core';
import { browserExecutor, lastUrlOf, newBrowserState } from '../src/mcp/browser.js';
import type { McpServerHandle } from '../src/mcp/server.js';
import { ToolError, type ToolContext } from '../src/tools/context.js';

const WORKSPACE = '/w';
const PAGE = `file://${WORKSPACE}/index.html`;
const SCREENSHOT = { server: 'browser', tool: 'take_screenshot', readOnly: true } as McpToolInfo;

/**
 * A browser server whose pages are `pages`; a call to a page it does not have answers as chrome-devtools-mcp does, and
 * `fail` makes a call to a page it has fail with the page's own words.
 */
function setup(pages: { id: number; url: string }[], events: TurnEvent[] = [], info: McpToolInfo = SCREENSHOT, fail?: (args: Record<string, unknown>) => string | undefined) {
  const handle = { state: { status: 'ready' }, call: async () => ({ structured: { pages } }) } as unknown as McpServerHandle;
  const calls: Record<string, unknown>[] = [];
  const executor = browserExecutor(`mcp__browser__${info.tool}`, info, {
    handle,
    approval: { kind: 'non-interactive', mcp: true },
    state: newBrowserState(),
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
  return { run: (args: Record<string, unknown>) => executor.run(args, ctx), calls };
}

const listing = (id: number, url: string): TurnEvent =>
  ({ kind: 'tool-result', seq: 1, at: '', toolUseId: 't', name: 'mcp__browser__new_page', status: 'ok', output: `## Pages\n1: about:blank\n${id}: BeanCraft (${url}) [selected]` }) as unknown as TurnEvent;

describe('a browser call to a page that is gone', () => {
  it('runs on the only real page open and says so', async () => {
    const { run, calls } = setup([{ id: 1, url: 'about:blank' }, { id: 3, url: PAGE }]);
    const reply = await run({ pageId: 2 });
    expect(calls.map((c) => c['pageId'])).toEqual([2, 3]);
    expect(typeof reply === 'string' ? reply : reply.text).toContain(`[Geno] Page 2 is not open, so this ran on page 3 (${PAGE}), the only page open.`);
  });

  it('lists the open pages and the URL the missing page showed when only a blank page is left', async () => {
    const { run, calls } = setup([{ id: 1, url: 'about:blank' }], [listing(2, PAGE)]);
    await expect(run({ pageId: 2 })).rejects.toThrow(`Page 2 is not open: the browser starts fresh in each run, and pages can close. Open pages: 1: about:blank. Page 2 showed ${PAGE}; open it again with new_page.`);
    expect(calls).toHaveLength(1);
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
    const own = setup([{ id: 2, url: PAGE }], [], SCREENSHOT, () => 'Error: No page found for /missing');
    await expect(own.run({ pageId: 2 })).rejects.toThrow(/^Error: No page found for \/missing$/);
    expect(own.calls).toHaveLength(1);
    const exact = setup([{ id: 2, url: PAGE }], [], SCREENSHOT, () => 'Error: No page found');
    await expect(exact.run({ pageId: 2 })).rejects.toThrow(/^Error: No page found$/);
    expect(exact.calls).toHaveLength(1);
  });

  it('keeps the note when the call on the other page fails too', async () => {
    const { run } = setup([{ id: 3, url: PAGE }], [], SCREENSHOT, (args) => (args['pageId'] === 3 ? 'Error: element 1_7 not found' : undefined));
    await expect(run({ pageId: 2 })).rejects.toThrow(`[Geno] Page 2 is not open, so this ran on page 3 (${PAGE}), the only page open.\nError: element 1_7 not found`);
  });

  it('leaves other errors and calls without a pageId as they were', async () => {
    const { run } = setup([{ id: 3, url: PAGE }]);
    await expect(run({})).rejects.toThrow('Error: No page found');
    await expect(run({ pageId: 'two' })).rejects.toThrow('Error: No page found');
  });
});

describe('lastUrlOf', () => {
  it("reads the page's URL from the latest browser listing, and nothing from other tools", () => {
    expect(lastUrlOf([listing(2, 'file:///a.html'), listing(2, 'file:///b.html')], 2)).toBe('file:///b.html');
    expect(lastUrlOf([listing(2, 'file:///a.html')], 5)).toBeUndefined();
    expect(lastUrlOf([{ ...listing(2, 'file:///a.html'), name: 'bash' } as TurnEvent], 2)).toBeUndefined();
  });
});
