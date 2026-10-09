// Writes the skeleton of an example page (docs/examples/<case>.md) from an archived real-model run: the prompt, the
// mode, each model turn's text and tool calls in order, the diff summary, cost and time, and the link to the run.
// The prose is then edited by hand, so an existing page is kept unless --force is given.
// usage: pnpm tsx scripts/run-to-example.ts [--force] docs/results/real-usecases/runs/<case>/<run>...
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assistantTurns, portable, portableValue, readRun, REPO, RUNS, workspacesOf, type ArchivedRun, type Conversation } from './real-usecases/archived-run.js';

const EXAMPLES = path.join(REPO, 'docs/examples');

const MODES: Readonly<Record<string, string>> = {
  'non-interactive': 'Non-interactive (`gcode agent --non-interactive`): nobody can answer a question, so anything that needs approval is refused.',
  ask: 'Ask, in the VS Code panel: Geno asks before a risky command.',
  plan: 'Plan: Geno reads and plans, and cannot edit.',
  auto: 'Auto: a classifier judges risky commands.',
};

const oneLine = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A tool call as the panel titles it: the tool and its main argument. */
function callTitle(name: string, input: Record<string, unknown>): string {
  const target = input['path'] ?? input['pattern'] ?? input['command'] ?? input['directory'] ?? input['url'] ?? input['agent'] ?? input['query'] ?? '';
  return `\`${name}${target === '' ? '' : ` ${oneLine(String(target), 70)}`}\``;
}

/** One line per model turn: what it said first, then the calls it made, with any that did not succeed marked. */
function walkthrough(conversation: Conversation, workspaces: readonly string[]): string[] {
  const results = new Map(conversation.events.filter((e) => e.kind === 'tool-result').map((e) => [e.toolUseId as string, e]));
  return assistantTurns(conversation).map((turn, i) => {
    const blocks = portableValue(turn.content as any[], workspaces);
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    const calls = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => {
        const result = results.get(b.id);
        const approval = result?.approval?.decidedBy === 'user' ? ` (asked; the user chose ${result.approval.verdict})` : '';
        const status = result !== undefined && result.status !== 'ok' ? ` (${result.status})` : '';
        return `${callTitle(b.name, b.input ?? {})}${approval}${status}`;
      });
    const said = text.trim() === '' ? '' : `"${oneLine(text)}"`;
    return `${i + 1}. ${[said, calls.length === 0 ? '' : `${said === '' ? 'Calls' : 'then calls'} ${calls.join(', ')}`].filter(Boolean).join(' ')}`;
  });
}

/** Each file the diff touches with its added and removed lines. */
function diffSummary(diff: string | undefined): string {
  if (diff === undefined) return 'This step has no diff of its own; the panel run keeps one diff for all its steps.';
  const files = diff.split(/^diff --git /m).slice(1).map((part) => {
    const name = /^a\/(\S+)/.exec(part)?.[1] ?? '?';
    const lines = part.split('\n');
    const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    return `\`${name}\` +${added} −${removed}`;
  });
  return files.length === 0 ? 'No file changed.' : files.join(', ');
}

function seconds(conversation: Conversation): number {
  const times = conversation.events.flatMap((e) => (typeof e.at === 'string' ? [Date.parse(e.at)] : []));
  const start = Date.parse(conversation.events.find((e) => e.kind === 'user')?.at ?? '') || Math.min(...times);
  return Math.round((Math.max(...times) - start) / 1000);
}

export function pageOf(run: ArchivedRun): string {
  const index = JSON.parse(readFileSync(path.join(RUNS, 'index.json'), 'utf8')) as { dir: string; costUsd: number; modelCalls: number; passed: boolean; goodExample: boolean }[];
  const entry = index.find((e) => e.dir === path.relative(path.dirname(RUNS), run.dir).split(path.sep).join('/'));
  const workspaces = workspacesOf(run);
  const [main, ...others] = run.conversations;
  const prompts: string[] = run.layer === 'A' ? run.spec.prompts.map((p: { prompt: string }) => p.prompt) : main!.events.filter((e) => e.kind === 'user').map((e) => e.content);
  const link = path.relative(EXAMPLES, run.dir).split(path.sep).join('/');
  const subagents = others.map((child) => [`Subagent \`${child.id.slice(0, 8)}\` (task: "${oneLine(portable(child.opening, workspaces), 120)}"):`, '', ...walkthrough(child, workspaces), '']);
  return [
    `# ${run.caseId}, run ${run.run}`,
    '',
    `**Task.** TODO: the task in one line.`,
    '',
    '**Prompt**, as the user typed it:',
    '',
    ...prompts.map((p) => `> ${p.replace(/\n/g, '\n> ')}`),
    '',
    `**Mode.** ${MODES[run.spec.mode ?? 'non-interactive'] ?? run.spec.mode}`,
    '',
    '## What Geno did',
    '',
    ...walkthrough(main!, workspaces),
    '',
    ...subagents.flat(),
    '## Result',
    '',
    diffSummary(run.diff),
    '',
    `Every check passed: ${entry?.passed === true ? 'yes' : 'no'}. Cost $${(entry?.costUsd ?? 0).toFixed(4)} for ${entry?.modelCalls ?? '?'} model calls on qwen3.8-flash, ${seconds(main!)} s from the prompt to the last event.`,
    '',
    `The full run, with the session log, the transcript and every check: [${run.rel.replace(/^docs\//, '')}](${link}/).`,
    '',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  mkdirSync(EXAMPLES, { recursive: true });
  for (const dir of args.filter((a) => a !== '--force')) {
    const run = readRun(dir);
    const file = path.join(EXAMPLES, `${run.caseId}.md`);
    if (existsSync(file) && !force) {
      console.log(`${path.relative(REPO, file)} exists; kept (--force writes it again)`);
      continue;
    }
    writeFileSync(file, pageOf(run));
    console.log(`${path.relative(REPO, file)} from ${run.rel}`);
  }
}
