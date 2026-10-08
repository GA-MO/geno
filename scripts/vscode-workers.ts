/**
 * How many VS Code windows a run keeps open, and so how many integration files run at once. One: a 16 GB Mac ran
 * out of memory and panicked during runs with two pooled windows. docs/testing.md has the runs.
 */
export const DEFAULT_VSCODE_WORKERS = 1;

/** GCODE_VSCODE_WORKERS, else `fallback`. */
export function vscodeWorkers(env: Readonly<Record<string, string | undefined>>, fallback = DEFAULT_VSCODE_WORKERS): number {
  const raw = env['GCODE_VSCODE_WORKERS'];
  if (raw === undefined || raw === '') return fallback;
  const workers = Number(raw);
  if (!Number.isInteger(workers) || workers < 1) throw new Error(`GCODE_VSCODE_WORKERS must be a whole number of at least 1, not ${JSON.stringify(raw)}`);
  return workers;
}
