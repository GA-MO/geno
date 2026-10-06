import path from 'node:path';
import { parseArgs } from 'node:util';
import { isLaneBase, LANE_CONFLICT_REASONS, type LaneChange, type LaneRecord } from '@g-code/core';
import { singleId, UsageError, type Command, type Io } from './command.js';
import { tail } from './process.js';
import { homeOf, type Store } from './store.js';
import {
  applyLane,
  approveSetup,
  cloneDeps,
  copyIncluded,
  createLane,
  discardLane,
  isSetupApproved,
  laneRepoOf,
  listLanes,
  requireLane,
  runSetup,
  setupSource,
  sweepLanes,
  writeLaneChanges,
  type DepsReport,
  type LaneRepo,
} from './lanes.js';

const WORKSPACE = { workspace: { type: 'string' } } as const;

const repoFor = (io: Io, workspace: string | undefined): Promise<LaneRepo> => laneRepoOf(path.resolve(io.cwd, workspace ?? '.'));

const DEPS_LINES: { [K in DepsReport['kind']]: (report: Extract<DepsReport, { kind: K }>) => string } = {
  cloned: (r) => `node_modules: cloned ${r.folders.length} folder${r.folders.length === 1 ? '' : 's'} copy-on-write in ${(r.ms / 1000).toFixed(1)}s`,
  none: () => 'node_modules: none in the main checkout',
  unsupported: (r) => `node_modules: not cloned, copy-on-write needs macOS, not ${r.platform}`,
  failed: (r) => `node_modules: clone of ${r.folder} failed: ${r.detail}`,
};
const depsLine = (report: DepsReport): string => (DEPS_LINES[report.kind] as (r: DepsReport) => string)(report);

async function setUp(io: Io, store: Store, repo: LaneRepo, lane: LaneRecord, approveFlag: boolean): Promise<void> {
  const source = await setupSource(repo.main);
  if (source === undefined) return io.out('setup: none configured');
  const app = homeOf(store);
  let approved = await isSetupApproved(app, repo.main, source.commands);
  if (!approved) {
    const question = `Run these setup commands from ${source.file} outside the sandbox, now and for every new lane of ${repo.main}?\n${source.commands.map((c) => `  ${c}`).join('\n')}`;
    approved = approveFlag || (await io.confirm(question));
    if (!approved) return io.out(`setup: not run; approve the commands in ${source.file} with --approve-setup`);
    await approveSetup(app, repo.main, source.commands);
  }
  const run = await runSetup(repo, lane, source.commands, io.env, io.interrupts());
  if (run.kind === 'ran') return io.out(`setup: ran ${run.count} command${run.count === 1 ? '' : 's'} from ${source.file}`);
  io.out(`setup: \`${run.command}\` failed`);
  io.out(tail(run.output));
}

const laneNew: Command = async (args, { io, store }) => {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { ...WORKSPACE, from: { type: 'string', default: 'head' }, 'approve-setup': { type: 'boolean', default: false } },
  });
  if (!isLaneBase(values.from)) throw new UsageError('--from must be head or main');
  const repo = await repoFor(io, values.workspace);
  const lane = await createLane(repo, singleId(positionals, 'lane'), values.from);
  io.out(`lane: ${lane.name}`);
  io.out(`path: ${lane.path}`);
  io.out(`branch: ${lane.branch} from ${lane.base.from} ${lane.base.commit.slice(0, 12)}`);
  const copied = await copyIncluded(repo, lane);
  io.out(`copied: ${copied.length === 0 ? 'nothing' : copied.join(', ')} from .worktreeinclude`);
  io.out(depsLine(await cloneDeps(repo, lane)));
  await setUp(io, store, repo, lane, values['approve-setup']);
  return 0;
};

const laneList: Command = async (args, { io }) => {
  const { values } = parseArgs({ args, strict: true, options: { ...WORKSPACE, json: { type: 'boolean', default: false } } });
  const lanes = await listLanes(await repoFor(io, values.workspace));
  if (values.json) {
    io.out(JSON.stringify(lanes));
    return 0;
  }
  if (lanes.length === 0) io.out('no lanes');
  for (const lane of lanes) {
    io.out(`${lane.name}  ${lane.status}  ${lane.branch}  from ${lane.base.from} ${lane.base.commit.slice(0, 12)}  session ${lane.session ?? 'none'}  ${lane.path}`);
  }
  return 0;
};

function changeLine({ change, after, baseHash }: LaneChange): string {
  const added = change.hunks.reduce((n, hunk) => n + hunk.newText.split('\n').length - (hunk.newText.endsWith('\n') ? 1 : 0), 0);
  const removed = change.hunks.reduce((n, hunk) => n + hunk.lineCount, 0);
  const kind = after === null ? 'deleted' : baseHash === null ? 'added' : 'changed';
  return `  ${kind} ${change.path} (+${added} -${removed}, ${change.hunks.length} hunk${change.hunks.length === 1 ? '' : 's'})`;
}

const laneApply: Command = async (args, { io }) => {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { ...WORKSPACE, 'dry-run': { type: 'boolean', default: false } } });
  const repo = await repoFor(io, values.workspace);
  const lane = await requireLane(repo, singleId(positionals, 'lane'));
  const result = await applyLane(repo, lane);
  if (result.kind === 'conflicts') {
    io.out(`conflicts: ${result.conflicts.length}; nothing was applied`);
    for (const conflict of result.conflicts) io.out(`  ${conflict.path}: ${LANE_CONFLICT_REASONS[conflict.reason]}`);
    return 1;
  }
  if (!values['dry-run']) await writeLaneChanges(repo, result.changes);
  io.out(`${values['dry-run'] ? 'would apply' : 'applied'}: ${result.changes.length} file${result.changes.length === 1 ? '' : 's'} to ${repo.main}, for review`);
  for (const change of result.changes) io.out(changeLine(change));
  return 0;
};

const laneDiscard: Command = async (args, { io }) => {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { ...WORKSPACE, 'discard-changes': { type: 'boolean', default: false } } });
  const repo = await repoFor(io, values.workspace);
  const lane = await requireLane(repo, singleId(positionals, 'lane'));
  await discardLane(repo, lane, values['discard-changes']);
  io.out(`discarded: ${lane.name}`);
  return 0;
};

const laneSweep: Command = async (args, { io }) => {
  const { values } = parseArgs({ args, strict: true, options: WORKSPACE });
  const { removed, kept } = await sweepLanes(await repoFor(io, values.workspace));
  io.out(`swept: ${removed.length === 0 ? 'none' : removed.join(', ')}`);
  if (kept.length > 0) io.out(`kept, with changes: ${kept.join(', ')}`);
  return 0;
};

export const laneCommands: Record<string, Command> = { new: laneNew, list: laneList, apply: laneApply, discard: laneDiscard, sweep: laneSweep };
