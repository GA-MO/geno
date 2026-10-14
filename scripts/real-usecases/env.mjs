import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** A later round keeps its runs apart from the first campaign's: GCODE_CAMPAIGN_SCRATCH=scratchpad/fixes-r1. */
export const SCRATCH = path.resolve(REPO, process.env.GCODE_CAMPAIGN_SCRATCH ?? 'scratchpad/real-usecases');
/** The checkout whose engine the cases run, so a before run can use the base commit's engine with this runner. */
export const ENGINE = path.resolve(process.env.GCODE_CAMPAIGN_ENGINE ?? REPO);
export const HOME = path.join(SCRATCH, 'home');
/** One run's own HOME (home.mjs); its GCODE_HOME is `.gcode` inside it. The first campaign's runs shared HOME above. */
export const runHome = (id, run) => path.join(SCRATCH, 'homes', `${id}-r${run}`);
export const sessionsOf = (id, run) => (existsSync(runHome(id, run)) ? path.join(runHome(id, run), '.gcode', 'sessions') : path.join(HOME, 'sessions'));
export const FIXTURES = path.join(REPO, 'scripts/real-usecases/fixtures');

/** The main checkout's .env: a worktree has none, and the key must never be copied or printed. */
export function mainCheckoutEnvFile() {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' }).trim();
  return path.join(path.resolve(REPO, common), '..', '.env');
}

/** Each provider's credential variables, as packages/core/src/providers.ts names them, for the providers the campaign uses. */
const PROVIDER_VARS = {
  anthropic: ['ANTHROPIC_API_KEY', 'GCODE_ANTHROPIC_BASE_URL'],
  modelstudio: ['DASHSCOPE_API_KEY', 'DASHSCOPE_BASE_URL'],
  openrouter: ['OPENROUTER_API_KEY', 'GCODE_OPENROUTER_BASE_URL'],
};

/**
 * The engine's environment for a run: the .env, with only the chat provider's credentials, as a user who set up one
 * provider has. A second provider's key in the .env once hid an Auto classifier that ignored the chat provider.
 */
export function campaignEnv(extra = {}) {
  const fromFile = parseEnv(readFileSync(process.env.GCODE_ENV_FILE ?? mainCheckoutEnvFile(), 'utf8'));
  const env = { ...process.env, ...fromFile, GCODE_HOME: HOME, ...extra };
  const provider = env.GCODE_PROVIDER;
  for (const [name, vars] of Object.entries(PROVIDER_VARS)) if (name !== provider) for (const v of vars) delete env[v];
  return env;
}
