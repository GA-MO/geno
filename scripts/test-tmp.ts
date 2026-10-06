import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Short, because VS Code puts its IPC socket under TMPDIR and macOS caps a socket path at 104 bytes.
const PREFIX = 'gct-';
const PID_FILE = 'pid';
const JUST_MADE_MS = 60_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const ownerOf = (root: string): number | undefined => {
  try {
    const pid = Number(readFileSync(path.join(root, PID_FILE), 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

/** Removes the roots of earlier runs whose process is gone, such as a run that was killed before it could clean up. */
export function sweepTestTmp(base: string): string[] {
  const swept: string[] = [];
  for (const name of readdirSync(base)) {
    if (!name.startsWith(PREFIX)) continue;
    const root = path.join(base, name);
    const owner = ownerOf(root);
    if (owner !== undefined ? alive(owner) : Date.now() - statSync(root).mtimeMs < JUST_MADE_MS) continue;
    rmSync(root, { recursive: true, force: true });
    swept.push(root);
  }
  return swept;
}

/**
 * Points TMPDIR at a folder of this run's own, so every temp dir a test, the engine or VS Code makes lands inside it,
 * and removes the folder when the run exits. Tests that forget to clean up then cost nothing past their run.
 */
export function useTestTmp(): string {
  const existing = process.env['GCODE_TEST_TMP_ROOT'];
  if (existing !== undefined) return existing;
  const base = tmpdir();
  sweepTestTmp(base);
  const root = mkdtempSync(path.join(base, PREFIX));
  writeFileSync(path.join(root, PID_FILE), String(process.pid));
  process.env['GCODE_TEST_TMP_ROOT'] = root;
  process.env['TMPDIR'] = root;
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  return root;
}
