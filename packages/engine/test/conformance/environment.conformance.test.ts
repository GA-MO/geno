import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENVIRONMENT_HEADING, type TurnEvent } from '@g-code/core';
import { call, say, scripted, sessionIdOf, WIRES } from './scripted.js';

const scratchpadOf = (events: readonly TurnEvent[]): string => {
  const head = events[0];
  if (head?.kind !== 'session-start' || head.environment === undefined) throw new Error('no environment in the log');
  return head.environment.scratchpad;
};

describe.each(WIRES)('request assembly on the %s wire', (wire) => {
  it('T-ASM-03 the session facts open the first user message, the system prompt holds none of them, and a resume sends the same bytes', async () => {
    const one = await scripted(wire, [say('Ready.'), say('Still here.')]);
    const other = await scripted(wire, [say('Ready.')]);
    const first = await one.cli(['agent', '--workspace', one.workspace, '--non-interactive', 'What day is it?']);
    expect(first.code).toBe(0);
    expect((await other.cli(['agent', '--workspace', other.workspace, '--non-interactive', 'What day is it?'])).code).toBe(0);
    const id = sessionIdOf(first.stdout);
    expect((await one.cli(['agent', '--session', id, '--non-interactive', 'And now?'])).code).toBe(0);

    const [opened, resumed] = one.openings();
    expect(opened!.system, 'the system prompt is the same in every workspace').toBe(other.openings()[0]!.system);
    expect(opened!.system).not.toContain(one.workspace);
    expect(opened!.system).not.toMatch(/\d{4}-\d{2}-\d{2}/);

    const facts = opened!.first.slice(opened!.first.indexOf(ENVIRONMENT_HEADING));
    expect(facts).toContain(` - Workspace: ${one.workspace}`);
    expect(facts).toContain(` - Scratchpad directory: ${scratchpadOf(await one.log(first.stdout))}.`);
    expect(facts).toMatch(/ - Date: \d{4}-\d{2}-\d{2}, the local date when this session started/);
    expect(facts).toMatch(/Git status when this session started\. It is a snapshot and will not update/);
    expect(facts).toContain('Current branch: main');
    expect(opened!.first.endsWith('What day is it?')).toBe(true);
    expect(resumed!.first, 'the resumed session opens with the same bytes').toBe(opened!.first);
  });
});

describe.each(WIRES)('permissions on the %s wire', (wire) => {
  it('T-PERM-08 a write in the scratchpad runs without a question, even in Ask', async () => {
    const run = await scripted(wire, [say('Ready.')]);
    const started = await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', 'Get ready.']);
    const scratchpad = scratchpadOf(await run.log(started.stdout));
    const note = path.join(scratchpad, 'note.txt');
    run.more(call('', [{ id: 'tu_note', name: 'bash', input: { command: `printf noted > '${note}' && cat -v '${note}'` } }]), say('Noted.'));

    const questions: string[] = [];
    const asked = await run.cli(['agent', '--session', sessionIdOf(started.stdout), '--mode', 'ask', 'Write a note in the scratchpad.'], {
      confirm: (question) => (questions.push(question), false),
    });
    expect(asked.code).toBe(0);
    expect(questions).toEqual([]);
    expect(run.seen().at(-1)!.results[0]).toEqual({ id: 'tu_note', error: false, text: 'noted\n[exit code 0]' });
    expect(existsSync(note) && readFileSync(note, 'utf8')).toBe('noted');
  });

  it('T-PERM-08 edit creates a file in the scratchpad without a question, by its /tmp name too, and still refuses one outside it', async () => {
    const run = await scripted(wire, [say('Ready.')]);
    const started = await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', 'Get ready.']);
    const scratchpad = scratchpadOf(await run.log(started.stdout));
    const real = path.join(scratchpad, 'note.md');
    // The model may name the scratchpad by the alias of its real path, as /tmp is on macOS.
    const typed = path.join('/tmp', path.relative(realpathSync('/tmp'), real));
    const outside = path.join(mkdtempSync(path.join(tmpdir(), 'gcode-outside-')), 'note.md');
    run.more(
      call('', [{ id: 'tu_real', name: 'edit', input: { path: real, create: true, new_str: 'real\n' } }]),
      call('', [{ id: 'tu_typed', name: 'edit', input: { path: typed.replace('note.md', 'typed.md'), create: true, new_str: 'typed\n' } }]),
      call('', [{ id: 'tu_out', name: 'edit', input: { path: outside, create: true, new_str: 'out\n' } }]),
      say('Noted.'),
    );

    const questions: string[] = [];
    const asked = await run.cli(['agent', '--session', sessionIdOf(started.stdout), '--mode', 'ask', 'Write notes.'], {
      confirm: (question) => (questions.push(question), true),
    });
    expect(asked.code).toBe(0);
    expect(questions).toEqual([]);
    const results = run.seen().slice(-3).map((seen) => seen.results[0]!);
    expect(results.map((result) => [result.id, result.error])).toEqual([['tu_real', false], ['tu_typed', false], ['tu_out', true]]);
    expect(results[2]!.text).toContain('is outside the workspace');
    expect(readFileSync(real, 'utf8')).toBe('real\n');
    expect(readFileSync(path.join(scratchpad, 'typed.md'), 'utf8')).toBe('typed\n');
    expect(existsSync(outside)).toBe(false);
  });
});
