import { chmodSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asSessionId, hashText, MAX_TRACKED_BYTES, type DiskState, type FileStamp, type TurnEvent } from '@g-code/core';
import { changedOnDisk, diskStat, stampOf } from '../src/file-tracker.js';

const at = '2026-10-08T00:00:01.000Z';
const start: TurnEvent = {
  kind: 'session-start',
  session: { id: asSessionId('s-1'), createdAt: at, workspace: '/ws', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' },
};
const readOf = (file: FileStamp, seq = 1): TurnEvent => ({ kind: 'tool-result', seq, at, toolUseId: `tu_${seq}`, name: 'read', status: 'ok', output: 'x', file });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A file the model read: its log so far, and its path. */
async function read(text: string): Promise<{ readonly file: string; readonly events: TurnEvent[] }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'gcode-tracker-'));
  dirs.push(dir);
  const file = path.join(dir, 'a.ts');
  writeFileSync(file, text);
  const before = await diskStat(file);
  const stamp = stampOf(file, readFileSync(file, 'utf8'), before);
  if (stamp === undefined) throw new Error('the read was not stamped');
  return { file, events: [start, readOf(stamp)] };
}

const later = (file: string, seconds: number) => {
  const when = new Date(Date.now() + seconds * 1000);
  utimesSync(file, when, when);
};

describe('changedOnDisk', () => {
  it('finds nothing while the files are as the model read them', async () => {
    const { events } = await read('export const a = 1;\n');
    expect(await changedOnDisk(events, new Map())).toEqual([]);
  });

  it('reports a file whose text changed, with how the disk has it now', async () => {
    const { file, events } = await read('export const a = 1;\n');
    writeFileSync(file, 'export const a = 2; // the user\n');
    const info = await diskStat(file);
    const now: DiskState = { hash: hashText('export const a = 2; // the user\n')!, size: info!.size, mtimeMs: info!.mtimeMs };
    expect(await changedOnDisk(events, new Map())).toEqual([{ path: file, now, excerpt: '1\texport const a = 2; // the user' }]);
  });

  it('reports a change that keeps the size', async () => {
    const { file, events } = await read('export const a = 1;\n');
    writeFileSync(file, 'export const a = 2;\n');
    later(file, 5);
    expect((await changedOnDisk(events, new Map())).map((change) => change.path)).toEqual([file]);
  });

  it('reports a deleted file as gone', async () => {
    const { file, events } = await read('export const a = 1;\n');
    rmSync(file);
    expect(await changedOnDisk(events, new Map())).toEqual([{ path: file, now: null }]);
  });

  it('reports a file grown too large to hash as gone from tracking, without reading it', async () => {
    const { file, events } = await read('export const a = 1;\n');
    writeFileSync(file, 'x'.repeat(MAX_TRACKED_BYTES + 1));
    chmodSync(file, 0o000);
    expect(await changedOnDisk(events, new Map())).toEqual([{ path: file, now: null }]);
  });

  it('does not read a file whose size and change time are as the model read it', async () => {
    const { file, events } = await read('export const a = 1;\n');
    chmodSync(file, 0o000);
    expect(await changedOnDisk(events, new Map())).toEqual([]);
  });

  it('finds no change in a file saved again with the same text, and reads it once to know', async () => {
    const { file, events } = await read('export const a = 1;\n');
    later(file, 5);
    const verified = new Map<string, DiskState>();
    expect(await changedOnDisk(events, verified)).toEqual([]);
    chmodSync(file, 0o000);
    expect(await changedOnDisk(events, verified), 'the second look trusts the first').toEqual([]);
  });

  it('does not stamp a file too large to track', async () => {
    const { file } = await read('export const a = 1;\n');
    writeFileSync(file, 'x'.repeat(MAX_TRACKED_BYTES + 1));
    expect(stampOf(file, readFileSync(file, 'utf8'), await diskStat(file))).toBeUndefined();
  });
});
