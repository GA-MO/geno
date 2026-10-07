import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changedOnDiskNote } from '@g-code/core';
import { call, closeServers, say, scripted, sessionIdOf, WIRES } from './scripted.js';

afterEach(closeServers);

const FILES = { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' };
const USER_TEXT = 'export const a = 1;\nexport const fromUser = true;\n';
const USER_EXCERPT = '1\texport const a = 1;\n2\texport const fromUser = true;';
// The cache breakpoint moves to the newest message each call; everything else must repeat byte for byte.
const uncached = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, v: unknown) => (key === 'cache_control' ? undefined : v)));

describe.each(WIRES)('context on the %s wire', (wire) => {
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
