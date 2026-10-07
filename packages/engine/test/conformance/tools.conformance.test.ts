import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesOf } from '@g-code/core';
import { twoColorPng } from '../../../core/test/png.js';
import type { FakeToolUse } from '../fake-transport.js';
import { call, closeServers, say, scripted, WIRES, type SeenResult, type Wire } from './scripted.js';

afterEach(closeServers);

const A_TS = { 'a.ts': 'export const a = 1;\n' };

const COMMANDS = { failing: 'cat missing.txt', passing: 'cat a.ts' } as const;

/** Runs one non-interactive turn in which the model calls bash with `command`, and returns the result it got back. */
async function bashResult(wire: Wire, command: string): Promise<SeenResult> {
  const { workspace, cli, seen } = await scripted(wire, [call('', [{ id: 'tu_bash', name: 'bash', input: { command } }]), say('Done.')]);
  expect((await cli(['agent', '--workspace', workspace, '--non-interactive', 'Run it.'])).code).toBe(0);
  return seen()[1]!.results[0]!;
}

let ids = 0;
const use = (name: string, input: unknown): FakeToolUse => ({ id: `tu_tool_${ids++}`, name, input });

/**
 * One non-interactive turn in a workspace holding `files`, in which the model makes each batch of calls `turns` gives
 * for the workspace's path, in order. `prepare` runs before the turn, for a file a string cannot hold.
 */
async function session(
  wire: Wire,
  files: Readonly<Record<string, string>>,
  turns: (workspace: string) => readonly (readonly FakeToolUse[])[],
  prepare: (workspace: string) => Promise<void> = async () => {},
) {
  const run = await scripted(wire, [], files);
  run.more(...turns(run.workspace).map((uses) => call('', uses)), say('Done.'));
  await prepare(run.workspace);
  expect((await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', 'Go.'])).code).toBe(0);
  const byId = new Map(run.seen().flatMap((request) => request.results.map((result) => [result.id, result] as const)));
  const file = (name: string) => readFile(path.join(run.workspace, name), 'utf8');
  return { ...run, result: (u: FakeToolUse): SeenResult => byId.get(u.id)!, file };
}

describe.each(WIRES)('tools on the %s wire', (wire) => {
  it('T-TOOL-12 a non-zero exit is an error result that says the exit code first', async () => {
    const failed = await bashResult(wire, COMMANDS.failing);
    expect(failed.error).toBe(true);
    expect(failed.text).toMatch(/^Exit code 1\n.*missing\.txt.*No such file or directory\n\[exit code 1\]$/s);

    const passed = await bashResult(wire, COMMANDS.passing);
    expect(passed).toEqual({ id: 'tu_bash', error: false, text: 'export const a = 1;\n[exit code 0]' });
  });

  it("T-TOOL-07 output up to the model's spill limit comes back whole, and one character more goes to a file", async () => {
    const limit = (wire === 'anthropic' ? capabilitiesOf('modelstudio', 'qwen3.8-flash') : capabilitiesOf('openai', 'gpt-fake')).spillChars;
    const status = '\n[exit code 0]';
    const output = (chars: number) => `head -c ${chars} /dev/zero | tr '\\0' a`;

    const whole = await bashResult(wire, output(limit - status.length));
    expect(whole.text).toBe(`${'a'.repeat(limit - status.length)}${status}`);

    const spilled = await bashResult(wire, output(limit - status.length + 1));
    expect(spilled.text).toMatch(/too long to show/);
    const file = /The full text is in (\S+);/.exec(spilled.text)![1]!;
    expect(await readFile(file, 'utf8')).toBe(`${'a'.repeat(limit - status.length + 1)}${status}`);
  });

  it('T-TOOL-01 a read from line 59998 of a 60,000-line file returns its last three lines with their own numbers', async () => {
    const long = Array.from({ length: 60_000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const tail = use('read', { path: 'long.txt', start_line: 59_998, end_line: 60_002 });
    const { result } = await session(wire, { 'long.txt': long }, () => [[tail]]);
    expect(result(tail).error).toBe(false);
    expect(result(tail).text).toBe('59998\tline 59998\n59999\tline 59999\n60000\tline 60000\n[lines 59998-60000 of 60000]');
  });

  it('T-TOOL-02 a read of a directory is an error that points to list', async () => {
    const dir = use('read', { path: 'src' });
    const { result } = await session(wire, { 'src/a.ts': 'export const a = 1;\n' }, () => [[dir]]);
    expect(result(dir)).toMatchObject({ error: true, text: expect.stringMatching(/src is a directory; use list/) });
  });

  it('T-TOOL-03 a read of a PNG sends the model the image itself', async () => {
    const png = twoColorPng(4, 2, [255, 0, 0], [0, 0, 255]);
    const image = use('read', { path: 'shot.png' });
    const { result, bodies } = await session(wire, A_TS, () => [[image]], (workspace) => writeFile(path.join(workspace, 'shot.png'), png));
    expect(result(image).error).toBe(false);
    expect(JSON.stringify(bodies()[1]), 'the image bytes reach the model').toContain(png.toString('base64'));
  });

  it('T-TOOL-10 an empty file reads as empty, a missing file is an error that names the workspace root, and a notebook reads as cells', async () => {
    const notebook = JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['# Title'], metadata: {} }, { cell_type: 'code', source: ['print(1)'], outputs: [], metadata: {}, execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 });
    const empty = use('read', { path: 'empty.txt' });
    const missing = use('read', { path: 'src/nope.ts' });
    const cells = use('read', { path: 'n.ipynb' });
    const { result, workspace } = await session(wire, { 'empty.txt': '', 'n.ipynb': notebook }, () => [[empty, missing, cells]]);
    expect(result(empty)).toMatchObject({ error: false, text: expect.stringMatching(/empty/) });
    expect(result(missing).error).toBe(true);
    expect(result(missing).text).toMatch(/no such file or directory: src\/nope\.ts/);
    expect(result(missing).text, 'the hint names the root paths are relative to').toContain(workspace);
    expect(result(cells)).toMatchObject({ error: false, text: expect.stringContaining('print(1)') });
  });

  it('B/B-13 read and edit take an absolute path inside the workspace', async () => {
    let read!: FakeToolUse;
    let edit!: FakeToolUse;
    const { result, file } = await session(wire, { 'src/a.ts': 'export const a = 1;\n' }, (workspace) => {
      read = use('read', { path: path.join(workspace, 'src/a.ts') });
      edit = use('edit', { path: path.join(workspace, 'src/a.ts'), old_str: 'a = 1', new_str: 'a = 2' });
      return [[read], [edit]];
    });
    expect(result(read)).toMatchObject({ error: false, text: expect.stringContaining('export const a = 1;') });
    expect(result(edit).error).toBe(false);
    expect(await file('src/a.ts')).toBe('export const a = 2;\n');
  });

  it('T-TOOL-04 an edit whose old_str appears 10 times names the count and replace_all, and replace_all changes every one', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `export const v${i} = oldName(${i});`).join('\n') + '\n';
    const read = use('read', { path: 'names.ts' });
    const once = use('edit', { path: 'names.ts', old_str: 'oldName', new_str: 'newName' });
    const all = use('edit', { path: 'names.ts', old_str: 'oldName', new_str: 'newName', replace_all: true });
    const { result, file } = await session(wire, { 'names.ts': names }, () => [[read], [once], [all]]);
    expect(result(once).error).toBe(true);
    expect(result(once).text).toMatch(/appears 10 times/);
    expect(result(once).text).toMatch(/replace_all/);
    expect(result(all).error).toBe(false);
    expect(await file('names.ts')).toBe(names.replaceAll('oldName', 'newName'));
  });

  it('T-TOOL-11 an edit that matches nothing shows the closest text, an edit applies, and create writes a new file', async () => {
    const read = use('read', { path: 'a.ts' });
    const miss = use('edit', { path: 'a.ts', old_str: 'export const b = 1;', new_str: 'export const b = 2;' });
    const hit = use('edit', { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 2' });
    const created = use('edit', { path: 'src/new.ts', create: true, new_str: 'export const n = 1;\n' });
    const { result, file } = await session(wire, { 'a.ts': 'export const a = 1;\n' }, () => [[read], [miss], [hit], [created]]);
    expect(result(miss)).toMatchObject({ error: true, text: expect.stringMatching(/old_str does not appear in a\.ts.*closest text is lines 1-1:\n1\texport const a = 1;/s) });
    expect(result(hit).error).toBe(false);
    expect(await file('a.ts')).toBe('export const a = 2;\n');
    expect(result(created).error).toBe(false);
    expect(await file('src/new.ts')).toBe('export const n = 1;\n');
  });

  it('T-TOOL-11 B/B-15 create overwrites a file only when it was read and has not changed since', async () => {
    const unread = use('edit', { path: 'a.ts', create: true, new_str: 'export const a = 2;\n' });
    const read = use('read', { path: 'a.ts' });
    const overwrite = use('edit', { path: 'a.ts', create: true, new_str: 'export const a = 3;\n' });
    const readB = use('read', { path: 'b.ts' });
    const change = use('bash', { command: "echo '// changed' >> b.ts" });
    const stale = use('edit', { path: 'b.ts', create: true, new_str: 'export const b = 3;\n' });
    const { result, file } = await session(wire, { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' }, () => [[unread], [read], [overwrite], [readB], [change], [stale]]);
    expect(result(unread)).toMatchObject({ error: true, text: expect.stringMatching(/read a\.ts before editing it/) });
    expect(result(overwrite).error).toBe(false);
    expect(await file('a.ts')).toBe('export const a = 3;\n');
    expect(result(stale)).toMatchObject({ error: true, text: expect.stringMatching(/b\.ts changed since it was last read/) });
    expect(await file('b.ts')).toBe("export const b = 1;\n// changed\n");
  });

  it('T-TOOL-06b a command that changes directory ends with the reset line, and the next command starts at the workspace root', async () => {
    const into = use('bash', { command: 'cd sub && pwd' });
    const after = use('bash', { command: 'pwd' });
    const { result, workspace } = await session(wire, { 'sub/x.txt': 'x\n' }, () => [[into], [after]]);
    expect(result(into)).toEqual({ id: into.id, error: false, text: `${path.join(workspace, 'sub')}\nShell cwd was reset to ${workspace}\n[exit code 0]` });
    expect(result(after)).toEqual({ id: after.id, error: false, text: `${workspace}\n[exit code 0]` });
  });

  it('T-TOOL-08 a foreground command that starts with a long sleep is refused unrun, with a pointer to monitor and run_in_background', async () => {
    const slept = use('bash', { command: 'sleep 45; echo ran > ran.txt' });
    const short = use('bash', { command: 'sleep 1; cat a.ts' });
    const { result, workspace } = await session(wire, A_TS, () => [[slept], [short]]);
    expect(result(slept).error).toBe(true);
    expect(result(slept).text).toMatch(/^Blocked: sleep 45 followed by: echo ran > ran\.txt\./);
    expect(result(slept).text).toMatch(/monitor/);
    expect(result(slept).text).toMatch(/run_in_background: true/);
    expect(existsSync(path.join(workspace, 'ran.txt')), 'the command did not run').toBe(false);
    expect(result(short)).toMatchObject({ error: false, text: 'export const a = 1;\n[exit code 0]' });
  });
});
