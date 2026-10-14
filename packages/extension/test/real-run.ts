import { existsSync, readdirSync } from 'node:fs';

/** A directory that keeps one folder per real-model run, named `<prefix><run number>`. */
export type RunFolders = readonly [dir: string, prefix: string];

/**
 * The run GCODE_REAL_RUN names, else the number after every run already kept in `places`, so a run never overwrites an
 * archived one. A number, because scripts/real-usecases/archive.mjs indexes the run as Number(run).
 */
export function realRunLabel(named: string | undefined, places: readonly RunFolders[]): string {
  if (named) return named;
  let last = 0;
  for (const [dir, prefix] of places) {
    if (!existsSync(dir)) continue;
    const pattern = new RegExp(`^${prefix}(\\d+)$`);
    for (const name of readdirSync(dir)) {
      const run = pattern.exec(name)?.[1];
      if (run !== undefined) last = Math.max(last, Number(run));
    }
  }
  return String(last + 1);
}
