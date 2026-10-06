import path from 'node:path';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  checkOutcomeOf,
  isLive,
  laneApplyText,
  laneNameFor,
  nextSeq,
  summarizeSession,
  type LaneInfo,
  type LaneRecord,
  type TurnEvent,
} from '@g-code/core';
import { openSessionLog, type OpenSession } from './chat.js';
import { shadowRepoFor, takeCheckpoint } from './checkpoints.js';
import type { Io } from './command.js';
import type { Watcher } from './drive.js';
import { EngineError } from './errors.js';
import type { Files } from './files.js';
import {
  applyLane,
  cloneDeps,
  copyIncluded,
  createLane,
  isSetupApproved,
  laneDiffStat,
  listLanes,
  requireLane,
  runSetup,
  setupSource,
  writeLaneChanges,
  type LaneRepo,
} from './lanes.js';
import { appendEvent } from './sessions.js';
import { homeOf, type Store } from './store.js';
import type { Tasks } from './tasks.js';

/** Each lane with what it changed, its last check, and its session's task and spend. */
export async function laneInfos(repo: LaneRepo, store: Store, io: Io, tasks: Tasks): Promise<LaneInfo[]> {
  return Promise.all(
    (await listLanes(repo)).map(async (lane): Promise<LaneInfo> => {
      const log = lane.session === null ? undefined : await openSessionLog(store, lane.session, io).catch(() => undefined);
      const summary = log === undefined ? undefined : summarizeSession(log.session, log.events);
      const task = lane.session === null ? undefined : tasks.get(lane.session);
      return {
        name: lane.name,
        path: lane.path,
        branch: lane.branch,
        status: lane.status,
        createdAt: lane.createdAt,
        diff: await laneDiffStat(lane),
        check: log === undefined ? 'none' : checkOutcomeOf(log.events),
        // A task that just started has its title before its log has the prompt.
        session: summary === undefined ? null : { id: summary.id, title: task?.title ?? summary.title, turns: summary.turns, costUsd: summary.costUsd },
        task: task?.status ?? null,
      };
    }),
  );
}

/**
 * A new lane for `prompt`, from the main checkout's HEAD, with the ignored files `.worktreeinclude` lists and a
 * copy-on-write clone of the dependencies. Setup commands run only when the user already approved them through
 * `gcode lane new`; the panel cannot ask that question outside the sandbox.
 */
export async function laneFor(repo: LaneRepo, prompt: string, store: Store, io: Io): Promise<LaneRecord> {
  const taken = new Set((await listLanes(repo)).map((lane) => lane.name as string));
  const lane = await createLane(repo, laneNameFor(prompt, taken), 'head');
  await copyIncluded(repo, lane);
  const deps = await cloneDeps(repo, lane);
  if (deps.kind === 'failed') io.err(`lane ${lane.name}: node_modules clone of ${deps.folder} failed: ${deps.detail}`);
  const setup = await setupSource(repo.main);
  if (setup !== undefined) {
    if (await isSetupApproved(homeOf(store), repo.main, setup.commands)) {
      const ran = await runSetup(repo, lane, setup.commands, io.env, io.interrupts());
      if (ran.kind === 'failed') io.err(`lane ${lane.name}: setup \`${ran.command}\` failed`);
    } else {
      io.err(`lane ${lane.name}: setup from ${setup.file} not run; approve it once with gcode lane new --approve-setup`);
    }
  }
  return lane;
}

/** Refuses to touch a lane whose session is still working in it. */
export function idleLane(lane: LaneRecord, tasks: Tasks): void {
  const task = lane.session === null ? undefined : tasks.get(lane.session);
  if (task !== undefined && isLive(task.status)) throw new EngineError(`lane ${lane.name} is still working; wait for its task or stop it first`);
}

/**
 * Applies a lane into the session's workspace, the main checkout, as one turn of the session. Each file is written
 * through `files` as an edit step, so the editor puts its hunks under review as it does an agent's edit. A checkpoint
 * before the writes lets Undo All take the apply back. A conflict writes nothing and lists every conflict.
 */
export async function applyLaneTurn(store: Store, opened: OpenSession, repo: LaneRepo, name: string, files: Files, watcher: Watcher, tasks: Tasks): Promise<void> {
  const { session, file } = opened.log;
  if (repo.main !== session.workspace) throw new EngineError(`apply lane ${name} from a chat in ${repo.main}`);
  const lane = await requireLane(repo, name);
  idleLane(lane, tasks);
  const events: TurnEvent[] = [...opened.log.events];
  const record = async (event: TurnEvent) => {
    events.push(event);
    await appendEvent(file, event);
    watcher.logged(event);
  };
  const result = await applyLane(repo, lane, files);
  const at = () => new Date().toISOString();
  if (result.kind === 'conflicts') {
    await record({ kind: 'lane-apply', seq: nextSeq(events), at: at(), lane: name, changes: [], conflicts: result.conflicts, deleted: [] });
    watcher.text(laneApplyText({ lane: name, conflicts: result.conflicts, deleted: [] }, 0));
    return;
  }
  await record(await takeCheckpoint(shadowRepoFor(store, session.workspace), session.id, events));
  let step = 0;
  const seq = nextSeq(events);
  const stepped: Files = {
    ...files,
    async write(target, text, baseHash) {
      const use: ToolUseBlock = { type: 'tool_use', id: `lane-${seq}-${step++}`, name: 'edit', input: { path: path.relative(repo.main, target) }, caller: { type: 'direct' } };
      watcher.toolStart(use, `edit ${path.relative(repo.main, target)}`);
      const written = await files.write(target, text, baseHash).catch((error: unknown) => {
        watcher.toolEnd(use, 'error');
        throw error;
      });
      watcher.toolEnd(use, written === 'written' ? 'ok' : 'error');
      return written;
    },
  };
  await writeLaneChanges(repo, result.changes, stepped);
  const written = result.changes.filter((change) => change.after !== null).map((change) => ({ ...change.change, path: path.join(repo.main, change.change.path) }));
  const deleted = result.changes.filter((change) => change.after === null).map((change) => change.change.path);
  await record({ kind: 'lane-apply', seq: nextSeq(events), at: at(), lane: name, changes: written, conflicts: [], deleted });
  watcher.text(laneApplyText({ lane: name, conflicts: [], deleted }, written.length));
}
