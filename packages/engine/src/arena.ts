import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { z } from 'zod';
import {
  AGENT_TOOL,
  arenaSettled,
  arenaStep,
  costPreview,
  EFFORTS,
  laneLetter,
  laneNameFor,
  parseLaneName,
  parseRanking,
  passingLanes,
  rankingTask,
  SEED_IDS,
  summarizeSession,
  trivialRanking,
  variantPrompt,
  variantsFor,
  ZERO_USAGE,
  type ArenaDiff,
  type ArenaEvent,
  type ArenaId,
  type ArenaReview,
  type ArenaRun,
  type ArenaSize,
  type AssistantTurn,
  type LaneCheck,
  type LaneEnd,
  type LaneRecord,
  type Session,
  type VariantSpec,
  type Variety,
} from '@g-code/core';
import { runAgent, workspaceConfig } from './agent.js';
import { openSessionLog, startSession } from './chat.js';
import { checkCommand } from './check-command.js';
import { childEnv } from './child-env.js';
import type { Io } from './command.js';
import { EngineError } from './errors.js';
import { listSessions } from './history.js';
import { laneFor, takenLaneNames } from './lane-hooks.js';
import { laneChanges, laneDiffText, requireLane, type LaneRepo } from './lanes.js';
import { tail } from './process.js';
import { openSandbox, sandboxPolicy } from './sandbox.js';
import { homeOf, isMissing, StoreError, type Store } from './store.js';
import { CHECK_TIMEOUT_MS, NON_INTERACTIVE } from './tools/agent.js';

/**
 * How one lane's session runs: as a background turn of the engine over ACP, or in-process for an eval. It resolves once
 * the session exists, and `ended` once its turn is over.
 */
export type LaneRunner = (lane: LaneRecord, variant: VariantSpec, prompt: string) => Promise<{ readonly sessionId: string; readonly ended: Promise<LaneEnd> }>;

export type ArenaDeps = {
  readonly repo: LaneRepo;
  readonly store: Store;
  readonly io: Io;
  readonly runLane: LaneRunner;
  /** The check to run in each lane; undefined uses the workspace's `.gcode.json` `check`. */
  readonly check: string | undefined;
  /** Each step of the run, after it is saved. */
  readonly onUpdate: (run: ArenaRun) => void;
};

/** The review child's caps, which the cost preview counts in full. */
export const REVIEW_LIMITS = { maxTurns: 8, maxCostUsd: 0.05 };

const variantSchema = z.strictObject({ seed: z.enum(SEED_IDS as [string, ...string[]]).default('plain'), model: z.string().min(1).nullable().default(null), effort: z.enum(EFFORTS).nullable().default(null) });
const arenaConfigSchema = z.strictObject({
  variety: z.enum(['seeds', 'effort', 'models']).optional(),
  models: z.array(z.string().min(1)).optional(),
  variants: z.array(variantSchema).optional(),
});

/** `.gcode.json` `arena`: the default variety, the models the `models` variety uses, or an explicit variant list. */
async function arenaConfig(workspace: string): Promise<z.infer<typeof arenaConfigSchema>> {
  const raw = (await workspaceConfig(workspace))['arena'];
  if (raw === undefined) return {};
  const parsed = arenaConfigSchema.safeParse(raw);
  if (!parsed.success) throw new StoreError(path.join(workspace, '.gcode.json'), `arena: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function arenaVariants(workspace: string, n: ArenaSize, variety: Variety | undefined): Promise<VariantSpec[]> {
  const config = await arenaConfig(workspace);
  // A variety the user asks for by name wins over the workspace's list.
  return variantsFor(n, variety ?? config.variety ?? 'seeds', config.models ?? [], variety === undefined ? ((config.variants ?? []) as VariantSpec[]) : []);
}

/** The newest sessions this many back are what the cost preview's median reads. */
const HISTORY_SAMPLES = 50;

export async function arenaPreview(store: Store, io: Io, n: ArenaSize) {
  const sessions = await listSessions(store, io, { kind: 'all' });
  const costs = sessions.slice(0, HISTORY_SAMPLES).flatMap((s) => (s.costUsd === null ? [] : [s.costUsd]));
  return costPreview(costs, n, REVIEW_LIMITS.maxCostUsd);
}

const arenasDir = (repo: LaneRepo) => path.join(repo.common, 'geno', 'arenas');
const arenaFile = (repo: LaneRepo, id: string) => path.join(arenasDir(repo), `${id}.json`);
const ARENA_ID = /^arena-[0-9a-f]{12}$/;

async function saveArena(repo: LaneRepo, run: ArenaRun): Promise<void> {
  await mkdir(arenasDir(repo), { recursive: true });
  const file = arenaFile(repo, run.id);
  await writeFile(`${file}.tmp`, `${JSON.stringify(run, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

// Geno writes these files itself; the check only keeps a torn or foreign file from reaching the panel as a run.
const storedRun = z.looseObject({ id: z.string().regex(ARENA_ID), task: z.string(), status: z.string(), lanes: z.array(z.looseObject({ lane: z.string(), status: z.string() })) });

export async function readArena(repo: LaneRepo, id: string): Promise<ArenaRun> {
  if (!ARENA_ID.test(id)) throw new EngineError(`no arena ${id}`);
  let text: string;
  try {
    text = await readFile(arenaFile(repo, id), 'utf8');
  } catch (error) {
    if (isMissing(error)) throw new EngineError(`no arena ${id} in ${repo.main}`);
    throw error;
  }
  const parsed = storedRun.safeParse(JSON.parse(text));
  if (!parsed.success) throw new StoreError(arenaFile(repo, id), z.prettifyError(parsed.error));
  return parsed.data as unknown as ArenaRun;
}

/** Every run of the repository, newest first. */
export async function listArenas(repo: LaneRepo): Promise<ArenaRun[]> {
  let names: string[];
  try {
    names = await readdir(arenasDir(repo));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const runs = await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => readArena(repo, name.slice(0, -5)).catch(() => undefined)));
  return runs.filter((run) => run !== undefined).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Runs the project check in the lane, in the sandbox, since the code it checks is the model's. */
export async function checkLane(store: Store, io: Io, lane: LaneRecord, command: string | undefined, signal?: AbortSignal): Promise<LaneCheck> {
  const check = await checkCommand(command ?? (await workspaceConfig(lane.path)).check, lane.path, homeOf(store));
  if (check === undefined) return { outcome: 'none', tail: '' };
  const tempDir = await mkdtemp(path.join(tmpdir(), 'gcode-arena-check-'));
  const sandbox = await openSandbox(await sandboxPolicy({ store, home: io.env['HOME'] || homedir(), workspace: lane.path, tempDir }));
  try {
    const result = await sandbox.run(check.run, { cwd: lane.path, env: childEnv(io.env), timeoutMs: CHECK_TIMEOUT_MS, writable: check.writable, ...(signal === undefined ? {} : { signal }) });
    return { outcome: result.code === 0 ? 'passed' : 'failed', tail: tail(result.output, 20, 2000) };
  } finally {
    await sandbox.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** The `review` call the Arena issues as the user's own, as `@review` would, with the lanes' diffs in its task. */
export function reviewCall(task: string, session: Session): AssistantTurn {
  const use: ToolUseBlock = { type: 'tool_use', id: `toolu_gcode_${randomUUID().replaceAll('-', '')}`, name: AGENT_TOOL, input: { agent: 'review', task }, caller: { type: 'direct' } };
  return { content: [use], stopReason: 'tool_use', usage: ZERO_USAGE, costUsd: 0, latencyMs: 0, model: session.model };
}

const QUIET = (io: Io): Io => ({ ...io, out: () => {}, write: () => {} });

/** Has a `review` child rank the passing lanes, in a session of the main checkout, and returns its fenced report. */
export async function reviewArena(store: Store, io: Io, repo: LaneRepo, run: ArenaRun): Promise<ArenaReview> {
  const lanes = await Promise.all(
    passingLanes(run).map(async (lane) => {
      const record = await requireLane(repo, lane.lane);
      return { lane: lane.lane, letter: lane.letter, path: path.relative(repo.main, record.path), variant: lane.variant, check: lane.check, diff: await laneDiffText(record) };
    }),
  );
  const quiet = QUIET(io);
  const opened = await startSession(store, quiet, { workspace: repo.main, provider: undefined, model: undefined, effort: undefined });
  const call = reviewCall(rankingTask(run.task, lanes), opened.log.session);
  const result = await runAgent(quiet, store, opened, `Rank the ${lanes.length} passing lanes of best-of-${run.lanes.length}: ${run.task}`, {
    limits: REVIEW_LIMITS,
    check: undefined,
    checkAfterEdit: false,
    approval: NON_INTERACTIVE,
    issued: call,
  });
  const answered = result.events.find((e) => e.kind === 'tool-result' && e.toolUseId === (call.content[0] as ToolUseBlock).id);
  const report = answered?.kind === 'tool-result' && 'output' in answered ? answered.output : '';
  const end = result.events.findLast((e) => e.kind === 'child-end');
  return { sessionId: opened.log.session.id, report, costUsd: end?.kind === 'child-end' ? end.costUsd : null };
}

/** What a lane's session spent, in model calls and dollars, and whether its last run ended on an error. */
async function laneOutcome(store: Store, io: Io, sessionId: string): Promise<{ turns: number; costUsd: number | null; errored: boolean }> {
  const log = await openSessionLog(store, sessionId, io).catch(() => undefined);
  if (log === undefined) return { turns: 0, costUsd: null, errored: true };
  const lastPrompt = log.events.findLastIndex((e) => e.kind === 'user');
  return {
    turns: log.events.filter((e) => e.kind === 'assistant').length,
    costUsd: summarizeSession(log.session, log.events).costUsd,
    errored: log.events.slice(lastPrompt + 1).some((e) => e.kind === 'error'),
  };
}

export type StartedArena = { readonly run: ArenaRun; readonly finished: Promise<ArenaRun> };

/**
 * Starts n lanes on `task`, one per variant, and runs the rest in the background: each lane's task, then its check,
 * then the review over the passing lanes. Every step is saved under the repository's git folder and reported.
 */
export async function startArena(deps: ArenaDeps, task: string, variants: readonly VariantSpec[], preview: ArenaRun['preview']): Promise<StartedArena> {
  const { repo, store, io } = deps;
  const id = `arena-${randomUUID().replaceAll('-', '').slice(0, 12)}` as ArenaId;
  const taken = await takenLaneNames(repo);
  const slug = laneNameFor(task.slice(0, 200), taken);
  const names = variants.map((_, i) => {
    const name = parseLaneName(`${slug}-${laneLetter(i).toLowerCase()}`);
    if (name === undefined || taken.has(name)) throw new EngineError(`cannot name the lanes of ${slug}`);
    return name;
  });
  // One at a time: `git worktree add` of one repository is not safe to run in parallel.
  const records: LaneRecord[] = [];
  for (const [i, variant] of variants.entries()) records.push(await laneFor(repo, variantPrompt(task, variant), store, io, names[i]!));
  const started = await Promise.all(records.map((record, i) => deps.runLane(record, variants[i]!, variantPrompt(task, variants[i]!))));

  let run: ArenaRun = {
    id,
    task,
    workspace: repo.main,
    createdAt: new Date().toISOString(),
    preview,
    lanes: records.map((record, i) => ({
      lane: record.name,
      letter: laneLetter(i),
      sessionId: started[i]!.sessionId,
      variant: variants[i]!,
      status: 'running',
      check: null,
      turns: 0,
      costUsd: null,
      rank: null,
      reason: null,
    })),
    status: 'running',
    review: null,
    summary: null,
    winner: null,
  };
  let saving = Promise.resolve();
  const step = (event: ArenaEvent): Promise<void> => {
    run = arenaStep(run, event);
    const snapshot = run;
    saving = saving.then(async () => {
      await saveArena(repo, snapshot);
      deps.onUpdate(snapshot);
    });
    return saving;
  };
  await saveArena(repo, run);
  deps.onUpdate(run);

  const laneDone = async (i: number) => {
    const record = records[i]!;
    const ended = await started[i]!.ended.catch((): LaneEnd => 'failed');
    const { turns, costUsd, errored } = await laneOutcome(store, io, started[i]!.sessionId);
    // A turn that stops on a model or transport error still ends as end_turn over ACP; the log says it failed.
    const end: LaneEnd = ended === 'done' && errored ? 'failed' : ended;
    await step({ kind: 'lane-ended', lane: record.name, task: end, turns, costUsd });
    if (end !== 'done' && end !== 'capped') return;
    const check = await checkLane(store, io, record, deps.check).catch((error: unknown): LaneCheck => ({ outcome: 'failed', tail: `the check could not run: ${String(error)}` }));
    await step({ kind: 'lane-checked', lane: record.name, check });
  };

  const finished = (async () => {
    await Promise.all(records.map((_, i) => laneDone(i)));
    if (!arenaSettled(run)) throw new EngineError(`arena ${id} ended with lanes still running`);
    const passing = passingLanes(run);
    if (passing.length < 2) {
      await step({ kind: 'ranked', ranking: trivialRanking(passing), review: null });
      return run;
    }
    await step({ kind: 'reviewing' });
    const review = await reviewArena(store, io, repo, run).catch((error: unknown): ArenaReview => {
      io.err(`arena ${id}: the review failed: ${String(error)}`);
      return { sessionId: '', report: '', costUsd: null };
    });
    await step({ kind: 'ranked', ranking: parseRanking(review.report, passing), review });
    return run;
  })();
  return { run, finished };
}

/** The user's pick, once the run is ranked. */
export async function pickWinner(repo: LaneRepo, id: string, lane: string): Promise<ArenaRun> {
  const before = await readArena(repo, id);
  const after = arenaStep(before, { kind: 'picked', lane });
  if (after === before) throw new EngineError(`lane ${lane} cannot win arena ${id}: ${before.status === 'ranked' ? 'it did not pass' : `the run is ${before.status}`}`);
  await saveArena(repo, after);
  return after;
}

/** What the compare shows: the run, and each lane's changes since its base. */
export async function arenaCompare(repo: LaneRepo, id: string): Promise<{ run: ArenaRun; diffs: ArenaDiff[] }> {
  const run = await readArena(repo, id);
  const diffs = await Promise.all(
    run.lanes.map(async ({ lane }): Promise<ArenaDiff> => ({ lane, changes: await requireLane(repo, lane).then(laneChanges, () => []) })),
  );
  return { run, diffs };
}
