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
 * The rows of docs/geno-tools.md a pstack skill needs most, appended to its `skill` result: the system prompt's pointer
 * to the file alone went unread (ISSUES.md P-08).
 */
export function pstackMap(file: string, { subagents }: GenoToolsShape): string {
  return [
    `Geno runs this pstack skill with its own tools. The whole mapping is in ${file}; the rows that matter most:`,
    '- Skill, or a /command such as /pstack:how: skill with { "name": "pstack:how" }.',
    '- ToolSearch: tool_search, to load a tool listed by name only.',
    subagents
      ? '- Agent or Task: agent with { "agent": "<name>", "task": "<everything it needs>" }; subagent_type is agent and prompt is task. There is no model parameter.'
      : '- Agent or Task: not available in this run. Do the work yourself in one pass, and say in your reply that a panel ran as one model.',
    '- TaskCreate, TaskUpdate or TodoWrite: todo, with the whole list each time.',
    '- AskUserQuestion: ask in plain text at the end of your reply and end your turn. In a non-interactive run nobody answers, so choose the default, say which, and go on.',
    '- Write: edit with create: true and the whole content.',
    '- Bash with run_in_background, Monitor: bash with run_in_background, then monitor with a pattern.',
  ].join('\n');
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
