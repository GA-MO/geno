import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Denial, type SessionMode, type ToolResultEvent } from '@g-code/core';
import { runAgent } from '../../src/agent.js';
import { startSession } from '../../src/chat.js';
import { freshAuto, type Approval, type PermissionAnswer } from '../../src/tools/agent.js';
import { twoColorPng } from '../../../core/test/png.js';
import { loadTools, type FakeToolUse } from '../fake-transport.js';
import { call, say, scripted, WIRES, type Wire } from './scripted.js';

const BEFORE = twoColorPng(8, 8, [250, 250, 250], [200, 40, 40]);
const AFTER = twoColorPng(8, 8, [250, 250, 250], [40, 160, 80]);

let ids = 0;
const use = (name: string, input: unknown): FakeToolUse => ({ id: `tu_show_${ids++}`, name, input });

/**
 * One run on `wire` in `mode` whose turns may name the session's spill folder, which holds before.png and after.png
 * before the run starts, as a tool's spilled screenshots would.
 */
async function run(wire: Wire, mode: SessionMode | 'non-interactive', turns: (spill: string) => readonly (readonly FakeToolUse[] | string)[], answers: readonly PermissionAnswer[] = []) {
  const { workspace, io, store, seen, more, bodies } = await scripted(wire, []);
  const opened = await startSession(store, io, { workspace, provider: undefined, model: undefined, effort: undefined });
  const spill = path.join(store.spillDir, opened.log.session.id);
  await mkdir(spill, { recursive: true });
  await writeFile(path.join(spill, 'before.png'), BEFORE);
  await writeFile(path.join(spill, 'after.png'), AFTER);
  more(...turns(spill).map((turn) => (typeof turn === 'string' ? say(turn) : call('', turn))));
  const asked: Denial[] = [];
  const pending = [...answers];
  const approval: Approval =
    mode === 'non-interactive'
      ? { kind: 'non-interactive' }
      : {
          kind: 'interactive',
          mode: () => mode,
          approve: async (denial) => {
            asked.push(denial);
            return pending.shift() ?? 'reject';
          },
          classify: async () => {
            throw new Error('no classifier in these tests');
          },
          auto: freshAuto(),
        };
  const result = await runAgent(io, store, opened, 'Show me the page before and after.', { limits: { maxTurns: 6, maxCostUsd: 1 }, check: undefined, checkAfterEdit: false, approval });
  const results = new Map(seen().flatMap((request) => request.results.map((r) => [r.id, r] as const)));
  const logged = result.events.filter((event): event is ToolResultEvent => event.kind === 'tool-result');
  return { spill, real: await realpath(spill), asked, results, logged, sent: () => JSON.stringify(bodies()) };
}

/** A directory beside the workspace, which no rule lets a tool read unasked. */
async function outside(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-shots-')));
  await writeFile(path.join(dir, 'shot.png'), BEFORE);
  return dir;
}

describe.each(WIRES)('show_files on the %s wire', (wire) => {
  it('loads through tool_search, shows two PNGs from the spill folder unasked, and returns what it showed without the bytes', async () => {
    const load = loadTools('show_files');
    let shown: FakeToolUse | undefined;
    const done = await run(wire, 'ask', (spill) => {
      shown = use('show_files', { files: [path.join(spill, 'before.png'), path.join(spill, 'after.png')], caption: 'The page before and after the fix' });
      return [[load], [shown], 'There they are.'];
    });
    expect(done.results.get(load.id)!.text).toContain('{"name":"show_files"');
    expect(done.asked).toEqual([]);
    const result = done.results.get(shown!.id)!;
    expect(result).toEqual({
      id: shown!.id,
      error: false,
      text: [
        'Shown to the user in the chat, images in a grid, under the caption "The page before and after the fix":',
        `- ${path.join(done.spill, 'before.png')} (image, ${BEFORE.length} B)`,
        `- ${path.join(done.spill, 'after.png')} (image, ${AFTER.length} B)`,
      ].join('\n'),
    });
    expect(done.sent()).not.toContain(BEFORE.toString('base64'));
    const logged = done.logged.find((event) => event.toolUseId === shown!.id)!;
    expect(logged.shown).toEqual({
      caption: 'The page before and after the fix',
      layout: 'grid',
      files: ['before.png', 'after.png'].map((name) => ({ kind: 'shown', given: path.join(done.spill, name), path: path.join(done.real, name), name, bytes: BEFORE.length, show: 'image' })),
    });
  });

  it('asks in Ask before a path outside the workspace, offering its directory, and shows it after a yes', async () => {
    const dir = await outside();
    const shown = use('show_files', { files: [path.join(dir, 'shot.png')] });
    const done = await run(wire, 'ask', () => [[loadTools('show_files')], [shown], 'Shown.'], ['allow']);
    expect(done.asked).toEqual([{ rule: 'path-outside-workspace', reason: 'a path outside the workspace', command: `show_files ${path.join(dir, 'shot.png')}`, verdict: 'ask', directory: dir, subject: { kind: 'read', path: path.join(dir, 'shot.png') } }]);
    expect(done.results.get(shown.id)).toMatchObject({ error: false, text: expect.stringContaining(`- ${path.join(dir, 'shot.png')} (image,`) });
  });

  it('refuses a path outside the workspace when nobody can answer, naming the readable directories, and still shows the spill file beside it', async () => {
    const dir = await outside();
    let shown: FakeToolUse | undefined;
    const done = await run(wire, 'non-interactive', (spill) => {
      shown = use('show_files', { files: [path.join(dir, 'shot.png'), path.join(spill, 'after.png')] });
      return [[loadTools('show_files')], [shown], 'Shown what I could.'];
    });
    expect(done.asked).toEqual([]);
    const result = done.results.get(shown!.id)!;
    expect(result.error).toBe(false);
    expect(result.text).toContain(`Shown to the user in the chat, images in a grid:\n- ${path.join(done.spill, 'after.png')} (image,`);
    expect(result.text).toContain(`Not shown:\n- ${path.join(dir, 'shot.png')}: denied: \`show_files ${path.join(dir, 'shot.png')}\` uses a path outside the workspace`);
    expect(result.text).toContain('nobody can answer here');
    expect(result.text).toContain('Geno may read only in these directories in this session:');
  });
});
