// Runs the engine's CLI from source with the campaign's GCODE_HOME and the main checkout's provider env.
// usage: node scripts/real-usecases/gcode.mjs [--cwd <dir>] <gcode args...>
import { spawnSync } from 'node:child_process';
import { campaignEnv, REPO } from './env.mjs';

const args = process.argv.slice(2);
let cwd = process.cwd();
if (args[0] === '--cwd') {
  cwd = args[1];
  args.splice(0, 2);
}
const result = spawnSync(`${REPO}/node_modules/.bin/tsx`, [`${REPO}/packages/engine/src/cli.ts`, ...args], { cwd, env: campaignEnv(), stdio: 'inherit' });
process.exitCode = result.status ?? 1;
