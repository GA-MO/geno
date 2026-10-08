import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { changedOnDiskNote, type TurnEvent } from '@g-code/core';
import { gcodeAgent } from '../../src/serve.js';
import { call, say, scripted, sessionIdOf, WIRES } from './scripted.js';

const FILES = { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' };
const USER_TEXT = 'export const a = 1;\nexport const fromUser = true;\n';
const USER_EXCERPT = '1\texport const a = 1;\n2\texport const fromUser = true;';
// The cache breakpoint moves to the newest message each call; everything else must repeat byte for byte.
const uncached = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, v: unknown) => (key === 'cache_control' ? undefined : v)));

type Run = Awaited<ReturnType<typeof scripted>>;

/** An editor that allows every permission card, on a fresh engine, as `gcode serve` runs it. */
async function inEditor<T>(run: Run, use: (ctx: acp.ClientContext) => Promise<T>): Promise<T> {
  const editor = acp
    .client({ name: 'test-editor' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => ({ outcome: { outcome: 'selected', optionId: params.options[0]!.optionId } }))
    .onNotification(acp.methods.client.session.update, () => {});
  return editor.connectWith(gcodeAgent(run.io, run.store, { maxTurns: 20, maxCostUsd: 1 }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    return use(ctx);
  });
}

const promptIn = (ctx: acp.ClientContext, sessionId: string, text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });

const SKILL = '---\nname: guard\ndescription: Guard the vendored code.\n---\nNever touch vendor/. GUARD_RULE_7\n';
// About 2,600 tokens, so a 2,000-token tail leaves the turn that read it to the summary.
const BIG = Array.from({ length: 300 }, (_, i) => `note ${i}: nothing here matters later`).join('\n');

describe.each(WIRES)('context on the %s wire', (wire) => {
  it('T-CTX-05 after a compaction the loaded skill and the newest changed file come back, recall finds an exact earlier error, and a resume sends the same bytes', async () => {
    const run = await scripted(
      wire,
      [
        call('', [{ id: 'tu_load', name: 'tool_search', input: { select: ['skill'] } }]),
        call('', [{ id: 'tu_skill', name: 'skill', input: { name: 'guard' } }]),
        call('', [{ id: 'tu_missing', name: 'read', input: { path: 'src/zone.ts' } }]),
        call('', [{ id: 'tu_a', name: 'read', input: { path: 'a.ts' } }]),
        call('', [{ id: 'tu_edit', name: 'edit', input: { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 10' } }]),
        call('', [{ id: 'tu_big', name: 'read', input: { path: 'notes.md' } }]),
        say('Set a to 10.'),
        say('Welcome.'),
        say('## Goal\nSet a.\n## Progress\n## Errors and fixes\nsrc/zone.ts was missing.\n## Current work\n## Next steps'),
        call('', [{ id: 'tu_load_recall', name: 'tool_search', input: { select: ['recall'] } }]),
        call('', [{ id: 'tu_recall', name: 'recall', input: { query: 'src/zone.ts' } }]),
        say('The read of src/zone.ts failed.'),
        say('Still here.'),
      ],
      { 'a.ts': 'export const a = 1;\n', 'notes.md': `${BIG}\n`, '.claude/skills/guard/SKILL.md': SKILL },
    );
    // A small threshold keeps a 2,000-token tail, so /compact summarizes the skill, the error and the edit.
    run.env['GCODE_COMPACT_AT'] = '8000';
    const sessionId = await inEditor(run, async (ctx) => {
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: run.workspace, mcpServers: [] });
      await promptIn(ctx, sessionId, 'Set a to 10.');
      await promptIn(ctx, sessionId, 'Thanks.');
      await promptIn(ctx, sessionId, '/compact');
      await promptIn(ctx, sessionId, 'What exactly did the read of src/zone.ts say?');
      return sessionId;
    });
    const events: readonly TurnEvent[] = await run.events(sessionId);
    const compact = events.find((e) => e.kind === 'compact');
    expect(compact?.kind === 'compact' && compact.kept.skills, 'the skill is kept').toEqual([{ name: 'guard', text: expect.stringContaining('GUARD_RULE_7') }]);
    const missing = run.seen().flatMap((s) => s.results).find((r) => r.id === 'tu_missing')!;
    expect(missing.error).toBe(true);

    const after = run.openings()[9]!.first;
    expect(after).toContain('<compacted_context>');
    expect(after, 'the summary goes in').toContain('src/zone.ts was missing.');
    expect(after, 'the skill body is attached again').toMatch(/<loaded_skill name="guard">[\s\S]*Never touch vendor\/\. GUARD_RULE_7[\s\S]*<\/loaded_skill>/);
    expect(after, 'the newest changed file is attached as it is now, numbered').toContain('<changed_file path="a.ts">\n1\texport const a = 10;\n</changed_file>');
    expect(after, 'the big read is not attached: it was not changed').not.toContain('note 299');
    expect(after, 'and the model is told how to get exact details back').toMatch(/call recall/);

    const recalled = run.seen()[11]!.results.find((r) => r.id === 'tu_recall')!;
    expect(recalled.error, recalled.text).toBe(false);
    expect(recalled.text).toContain('- this session, turn 1, before the compaction:');
    expect(recalled.text, 'the exact error, word for word').toContain(missing.text.replace(/\s+/g, ' ').trim().slice(0, 80));

    await inEditor(run, async (ctx) => {
      await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: run.workspace, mcpServers: [] });
      await promptIn(ctx, sessionId, 'Again.');
    });
    expect(run.openings()[12]!.first, 'a new engine opens the resumed request with the same compacted text').toBe(after);
  });

  it('T-CTX-01 a file read and then changed on disk gets one note at the next request, and a resume sends the same bytes', async () => {
    const run = await scripted(
      wire,
      [
        call('', [{ id: 'tu_a', name: 'read', input: { path: 'a.ts' } }]),
        call('Now b.ts.', [{ id: 'tu_b', name: 'read', input: { path: 'b.ts' } }]),
        say('a.ts has a new export; I left it as it is.'),
      ],
      FILES,
    );
    const file = path.join(run.workspace, 'a.ts');
    let edited = false;
    const first = await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', 'Look at a.ts and b.ts.'], {
      // The user saves a.ts while the model is on its second call, after the read of a.ts ran.
      onWrite: (text) => {
        if (!edited && text.includes('Now b.ts.')) {
          edited = true;
          writeFileSync(file, USER_TEXT);
        }
      },
    });
    expect(first.code).toBe(0);
    expect(edited).toBe(true);

    const [, second, third] = run.seen();
    expect(second!.text).not.toContain('changed on disk');
    expect(third!.results.map((r) => r.id)).toEqual(['tu_b']);
    expect(third!.text).toBe(changedOnDiskNote('a.ts', USER_EXCERPT));
    expect(readFileSync(file, 'utf8')).toBe(USER_TEXT);

    run.more(say('Still as you left it.'));
    expect((await run.cli(['agent', '--session', sessionIdOf(first.stdout), '--non-interactive', 'Anything else?'])).code).toBe(0);
    const bodies = run.bodies();
    const noted = bodies[2]!.messages;
    expect(uncached(bodies[3]!.messages.slice(0, noted.length)), 'the resumed request repeats the note byte for byte').toEqual(uncached(noted));
    expect(run.seen()[3]!.text, 'a change is noted once').not.toContain('changed on disk');
  });

  it("T-CTX-01 Geno's own edits get no note, and their results say the file state is current", async () => {
    const run = await scripted(
      wire,
      [
        call('', [{ id: 'tu_read', name: 'read', input: { path: 'a.ts' } }]),
        call('', [{ id: 'tu_edit', name: 'edit', input: { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 10' } }]),
        call('', [{ id: 'tu_new', name: 'edit', input: { path: 'c.ts', create: true, new_str: 'export const c = 3;\n' } }]),
        call('', [{ id: 'tu_b', name: 'read', input: { path: 'b.ts' } }]),
        say('Done.'),
      ],
      FILES,
    );
    const done = await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', 'Set a to 10 and add c.ts.']);
    expect(done.code).toBe(0);
    const seen = run.seen();
    expect(seen[2]!.results).toEqual([{ id: 'tu_edit', error: false, text: 'Edited a.ts. The file state is current in your context; no need to read it back.' }]);
    expect(seen[3]!.results).toEqual([{ id: 'tu_new', error: false, text: 'Created c.ts. The file state is current in your context; no need to read it back.' }]);
    expect(seen.map((s) => s.text).join('\n')).not.toContain('changed on disk');
    expect(readFileSync(path.join(run.workspace, 'a.ts'), 'utf8')).toBe('export const a = 10;\n');
  });
});
