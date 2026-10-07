/** How many VS Code integration files run at once: GCODE_VSCODE_WORKERS, else `fallback`. */
export function vscodeWorkers(env: Readonly<Record<string, string | undefined>>, fallback: number): number {
  const raw = env['GCODE_VSCODE_WORKERS'];
  if (raw === undefined || raw === '') return fallback;
  const workers = Number(raw);
  if (!Number.isInteger(workers) || workers < 1) throw new Error(`GCODE_VSCODE_WORKERS must be a whole number of at least 1, not ${JSON.stringify(raw)}`);
  return workers;
}
