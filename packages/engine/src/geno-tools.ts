import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GENO_TOOLS } from './geno-tools.generated.js';

/** The doc's two Subagents sections; a run keeps the one that matches its tools, under a plain heading. */
const SUBAGENT_SECTIONS = {
  on: '## Subagents when the run offers the `agent` tool\n',
  off: '## Subagents when the run offers no `agent` tool\n',
} as const;

export type GenoToolsShape = { readonly subagents: boolean };

/** docs/geno-tools.md as one run's model reads it: the subagent rows say what that run's `agent` tool can do, or that there is none. */
export function renderGenoTools({ subagents }: GenoToolsShape): string {
  const [keep, drop] = subagents ? [SUBAGENT_SECTIONS.on, SUBAGENT_SECTIONS.off] : [SUBAGENT_SECTIONS.off, SUBAGENT_SECTIONS.on];
  return GENO_TOOLS.split(/^(?=## )/m)
    .filter((section) => !section.startsWith(drop))
    .map((section) => (section.startsWith(keep) ? `## Subagents\n${section.slice(keep.length)}` : section))
    .join('');
}

/**
 * Writes the run's rendering of docs/geno-tools.md, embedded in the bundle, to `<home>` when it is missing or stale, and
 * returns its real path for the read tools. Each rendering has its own file, so runs with and without subagents never
 * rewrite each other's. The rename keeps a concurrent session from reading half a file.
 */
export async function writeGenoTools(home: string, shape: GenoToolsShape): Promise<string> {
  const text = renderGenoTools(shape);
  const file = path.join(home, shape.subagents ? 'geno-tools-subagents.md' : 'geno-tools.md');
  if ((await readFile(file, 'utf8').catch(() => undefined)) !== text) {
    await mkdir(home, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, text);
    await rename(temp, file);
  }
  return realpath(file);
}
