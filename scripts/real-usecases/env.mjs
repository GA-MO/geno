import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** A later round keeps its runs apart from the first campaign's: GCODE_CAMPAIGN_SCRATCH=scratchpad/fixes-r1. */
export const SCRATCH = path.resolve(REPO, process.env.GCODE_CAMPAIGN_SCRATCH ?? 'scratchpad/real-usecases');
/** The checkout whose engine the cases run, so a before run can use the base commit's engine with this runner. */
export const ENGINE = path.resolve(process.env.GCODE_CAMPAIGN_ENGINE ?? REPO);
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
