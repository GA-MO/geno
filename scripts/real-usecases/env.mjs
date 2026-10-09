import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SCRATCH = path.join(REPO, 'scratchpad/real-usecases');
export const HOME = path.join(SCRATCH, 'home');
export const FIXTURES = path.join(REPO, 'scripts/real-usecases/fixtures');

/** The main checkout's .env: a worktree has none, and the key must never be copied or printed. */
export function mainCheckoutEnvFile() {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' }).trim();
  return path.join(path.resolve(REPO, common), '..', '.env');
}

export function campaignEnv(extra = {}) {
  const fromFile = parseEnv(readFileSync(process.env.GCODE_ENV_FILE ?? mainCheckoutEnvFile(), 'utf8'));
  return { ...process.env, ...fromFile, GCODE_HOME: HOME, ...extra };
}
