import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOL_SEARCH_TOOL, type ToolRoster, type TurnEvent } from '@g-code/core';
import { executor, ToolError, type ToolContext } from '../src/tools/context.js';
import { runTool } from '../src/tools/index.js';
import { rosterExecutors } from '../src/tools/tool-search.js';

const NAME = 'mcp__browser__lighthouse_audit';
const definition = { name: NAME, description: 'Audit a page.', input_schema: { type: 'object' as const, properties: { pageId: { type: 'number' } } } };
const use = (id: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name: NAME, input }) as unknown as ToolUseBlock;
const roster: ToolRoster = { offered: [{ name: TOOL_SEARCH_TOOL, description: '', input_schema: { type: 'object' } }], deferred: new Map([[NAME, { definition, hint: 'audit' }]]) };

describe("a deferred tool's first call that runs and fails", () => {
  it('loads the tool, so the next call runs with no definition preamble', async () => {
    let runs = 0;
    const inner = executor({
      input: z.record(z.string(), z.unknown()),
      describe: () => NAME,
      async run() {
        runs += 1;
        if (runs === 1) throw new ToolError('Error: No page found');
        return 'audited';
      },
    });
    const executors = rosterExecutors(roster, { [NAME]: inner });
    const events: TurnEvent[] = [];
    const ctx = { signal: new AbortController().signal, events: () => events, toolUseId: 'u1' } as unknown as ToolContext;
    const first = await runTool(use('u1', { pageId: 2 }), ctx, executors);
    expect(first.status).toBe('error');
    expect(first.loaded).toEqual([NAME]);
    expect(first.text).toContain(`You called ${NAME} before loading it with ${TOOL_SEARCH_TOOL}. Geno loaded it and ran this call, which failed; it stays loaded, so call it directly.`);
    expect(first.text).toContain('Error: No page found');
    events.push({ kind: 'tool-result', seq: 1, at: '', toolUseId: 'u1', name: NAME, status: 'error', loaded: first.loaded, output: first.text } as unknown as TurnEvent);
    const second = await runTool(use('u2', { pageId: 2 }), { ...ctx, toolUseId: 'u2' } as ToolContext, executors);
    expect([second.status, second.text, runs]).toEqual(['ok', 'audited', 2]);
  });

  it('words a failure the tool returns, with what settled it, as it words one the tool throws', async () => {
    const approval = { mode: 'ask', rule: 'mcp-tool', reason: 'r', command: NAME, decidedBy: 'user', verdict: 'allow', kept: 'session' } as const;
    const inner = executor({ input: z.record(z.string(), z.unknown()), describe: () => NAME, run: async () => ({ text: 'Error: No page found', status: 'error', approval }) });
    const ctx = { signal: new AbortController().signal, events: () => [], toolUseId: 'u1' } as unknown as ToolContext;
    const r = await runTool(use('u1', { pageId: 2 }), ctx, rosterExecutors(roster, { [NAME]: inner }));
    expect([r.status, r.loaded, r.approval]).toEqual(['error', [NAME], approval]);
    expect(r.text).toContain('Geno loaded it and ran this call, which failed; it stays loaded, so call it directly.');
  });

  it('still loads nothing when the input does not match the schema, since nothing ran', async () => {
    const inner = executor({ input: z.strictObject({ pageId: z.number() }), describe: () => NAME, run: async () => 'audited' });
    const executors = rosterExecutors(roster, { [NAME]: inner });
    const ctx = { signal: new AbortController().signal, events: () => [], toolUseId: 'u1' } as unknown as ToolContext;
    const r = await runTool(use('u1', { pageId: 'not a page' }), ctx, executors);
    expect([r.status, r.loaded]).toEqual(['error', undefined]);
    expect(r.text).toContain('Its input does not match the input_schema, so it did not run');
  });
});
