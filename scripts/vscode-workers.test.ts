import { describe, expect, it } from 'vitest';
import { DEFAULT_VSCODE_WORKERS, vscodeWorkers } from './vscode-workers.js';

describe('vscodeWorkers', () => {
  it('uses the fallback when GCODE_VSCODE_WORKERS is unset or empty', () => {
    expect(vscodeWorkers({}, 3)).toBe(3);
    expect(vscodeWorkers({ GCODE_VSCODE_WORKERS: '' }, 3)).toBe(3);
    expect(vscodeWorkers({})).toBe(DEFAULT_VSCODE_WORKERS);
  });

  it('takes a whole number from GCODE_VSCODE_WORKERS', () => {
    expect(vscodeWorkers({ GCODE_VSCODE_WORKERS: '1' }, 3)).toBe(1);
    expect(vscodeWorkers({ GCODE_VSCODE_WORKERS: '4' }, 3)).toBe(4);
  });

  it('refuses a value that is not a whole number of at least 1', () => {
    for (const raw of ['0', '-2', '2.5', 'two', ' ']) expect(() => vscodeWorkers({ GCODE_VSCODE_WORKERS: raw }, 3)).toThrow(/GCODE_VSCODE_WORKERS/);
  });
});
