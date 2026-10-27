import os from 'node:os';
import path from 'node:path';

/**
 * Outside every git repository, so neither harness finds a parent repo above the workspace, and under no folder
 * name such as Library/Caches that searches skip.
 */
export const RUNS_DIR = process.env.HP_RUNS ?? path.join(os.homedir(), 'Development/hp-runs');
