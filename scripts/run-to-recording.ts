// Turns an archived real-model run into a recording the shared fake model replays by turn, with the workspace it
// started from, so a test runs the real engine against the model's recorded answers with no network and no cost.
// usage: pnpm tsx scripts/run-to-recording.ts docs/results/real-usecases/runs/<case>/<run>...
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FILES as PANEL_FILES } from '../packages/extension/test/suite/real-model-fixture.js';
import { turnKey } from '../packages/engine/test/request-normal.js';
import { assistantTurns, portable, portableValue, readRun, REPO, workspacesOf, type ArchivedRun, type LogEvent } from './real-usecases/archived-run.js';
import { FIXTURES } from './real-usecases/fixtures.mjs';

export const RECORDINGS = path.join(REPO, 'packages/engine/test/recordings/real');

/** What a model turn of the log answers with, as the fake model's `say` and `call` turns write it. */
function answerOf(turn: LogEvent, workspaces: readonly string[]) {
  const blocks = turn.content as { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
  const text = portable(blocks.flatMap((b) => (b.type === 'text' ? [b.text ?? ''] : [])).join(''), workspaces);
  const uses = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id!, name: b.name!, input: portableValue(b.input, workspaces) }));
  return uses.length === 0 ? { kind: 'say', text, stop: 'end_turn' } : { kind: 'call', text, uses, cutOff: false };
}

/** The files the run's workspace started with, as the campaign's runner wrote them. */
function startingFiles(run: ArchivedRun): Record<string, string> {
  if (run.layer === 'B') return { ...PANEL_FILES };
  const fixture = run.spec.fixture;
  if (run.spec.sibling != null || fixture.setup != null) throw new Error(`${run.caseId} needs a sibling repository or a setup step, which a recording does not carry yet`);
  const files: Record<string, string> = {};
  for (const [rel, text] of Object.entries(FIXTURES[fixture.name] as Record<string, string>)) files[rel === '_dot_env' ? '.env' : rel] = text;
  if (Object.keys(run.spec.settings ?? {}).length > 0) {
    files['.g-code/settings.json'] = `${JSON.stringify({ ...JSON.parse(files['.g-code/settings.json'] ?? '{}'), ...run.spec.settings }, null, 2)}\n`;
  }
  files['.gitignore'] = 'node_modules/\n';
  return files;
}

/** The prompts the user sent, in order: the case's for a Layer A run, the main chat's user messages for a panel step. */
function promptsOf(run: ArchivedRun): string[] {
  if (run.layer === 'A') return run.spec.prompts.map((p: { prompt: string }) => p.prompt);
  return run.conversations[0]!.events.filter((e) => e.kind === 'user' && typeof e.content === 'string').map((e) => e.content as string);
}

export function recordingOf(run: ArchivedRun) {
  const workspaces = workspacesOf(run);
  const entries = run.conversations.flatMap((conversation) => {
    const opening = portable(conversation.opening, workspaces);
    return assistantTurns(conversation).map((turn, i) => ({
      key: turnKey(opening, i),
      wire: 'anthropic',
      asks: `${conversation.subagent ? 'subagent' : 'user'} turn ${i}: ${opening.slice(0, 120)}`,
      answer: answerOf(turn, workspaces),
    }));
  });
  return {
    keyBy: 'turn',
    refresh: `pnpm tsx scripts/run-to-recording.ts ${run.rel}`,
    run: {
      source: run.rel,
      case: run.caseId,
      layer: run.layer,
      mode: run.spec.mode ?? 'non-interactive',
      prompts: promptsOf(run),
      files: startingFiles(run),
    },
    entries,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) throw new Error('usage: pnpm tsx scripts/run-to-recording.ts docs/results/real-usecases/runs/<case>/<run>...');
  mkdirSync(RECORDINGS, { recursive: true });
  for (const dir of dirs) {
    const run = readRun(dir);
    const recording = recordingOf(run);
    const file = path.join(RECORDINGS, `${run.caseId}.json`);
    writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);
    console.log(`${path.relative(REPO, file)}: ${recording.entries.length} turns from ${run.rel}`);
  }
}
