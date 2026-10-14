import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { realRunLabel } from './real-run.js';

describe('realRunLabel', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'real-run-'));
  const shots = path.join(root, 'shots');
  const scratch = path.join(root, 'scratch');
  const panel = path.join(root, 'B-panel');
  const places = [[shots, 'r'], [scratch, 'layer-b-r'], [panel, '']] as const;

  it('starts at 1 when no run was kept', () => {
    expect(realRunLabel(undefined, places)).toBe('1');
  });

  it('takes the number after the highest run in any of the places, so archived shots stay', () => {
    for (const dir of [path.join(shots, 'r1'), path.join(shots, 'r2'), path.join(scratch, 'layer-b-r4'), path.join(scratch, 'layer-b-rx'), path.join(scratch, 'r9'), path.join(panel, '3')]) mkdirSync(dir, { recursive: true });
    expect(realRunLabel(undefined, places)).toBe('5');
    expect(realRunLabel('', places)).toBe('5');
  });

  it('keeps the run GCODE_REAL_RUN names', () => {
    expect(realRunLabel('2', places)).toBe('2');
  });
});
