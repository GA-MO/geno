import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { loopStep, nextSeq, type ApprovalRecord, type DoneReason, type Run, type Sha256, type ToolResultEvent, type ToolStatus, type TurnEvent } from '@g-code/core';
import { attachmentsDir, loadAttachments } from './attachments.js';
import { EXIT_CODES, formatRetry, formatUsage, resumeSession, startSession, totalOf, type OpenSession } from './chat.js';
import { UsageError, type Io } from './command.js';
import { EngineError } from './errors.js';
import { DISK_FILES, type Files } from './files.js';
import { appendEvent } from './sessions.js';
import { isMissing, type Store } from './store.js';
import { describeCall, runTool, type Executors, type ToolContext } from './tools/index.js';
import { settle, spillFile } from './tools/spill.js';

export type Mode = {
  readonly tools: readonly Tool[];
  readonly executors: Executors;
  /** Undefined keeps the gateway's default prompt. */
  readonly system?: string;
  /** Real paths the read tools may see outside the workspace, read-only. */
  readonly readRoots?: readonly string[];
  /** An event to log before each model call, such as a checkpoint. */
  readonly beforeCall?: (events: readonly TurnEvent[]) => Promise<TurnEvent>;
};

export type Limits = { readonly maxTurns: number; readonly maxCostUsd: number };

/** How a run shows what it does as it happens. */
export type Watcher = {
  text(delta: string): void;
  /** A tool use about to run, with its one-line description. */
  toolStart(use: ToolUseBlock, title: string): void;
  /** That tool use finished; its result is logged once every tool of the batch has run. */
  toolEnd(use: ToolUseBlock, status: ToolStatus): void;
  /** Every event, as it is appended to the session log. */
  logged(event: TurnEvent): void;
};

/** Where a run reads and writes files and shows its progress: disk and the terminal, or an editor over ACP. */
export type Surface = { readonly files: Files; readonly watcher: Watcher };

const CLASSIFIED: Readonly<Record<ApprovalRecord['verdict'], string>> = { allow: 'allowed', deny: 'denied' };

export function terminalSurface(io: Io): Surface {
  let midLine = false;
  return {
    files: DISK_FILES,
    watcher: {
      text(delta) {
        midLine = true;
        io.write(delta);
      },
      toolStart: (_use, title) => io.out(`> ${title}`),
      toolEnd: () => {},
      logged(event) {
        if (midLine) io.write('\n');
        midLine = false;
        const approval = event.kind === 'tool-result' ? event.approval : undefined;
        if (approval?.decidedBy === 'classifier') io.out(`  auto: the classifier ${CLASSIFIED[approval.verdict]} it: ${approval.classifier?.reason}`);
      },
    },
  };
}

export type DriveResult = {
  readonly reason: DoneReason;
  readonly exitCode: number;
  readonly events: readonly TurnEvent[];
  readonly run: Run;
};

const DONE_EXIT: Record<DoneReason, number> = { end_turn: 0, 'max-turns': 3, budget: 3, refusal: 1, error: 1 };

type Limit = Extract<DoneReason, 'max-turns' | 'budget'>;

const LIMIT_MESSAGES: Record<Limit, (run: Run, spentUsd: number) => string> = {
  'max-turns': (run) => `stopped after ${run.maxTurns} model calls (--max-turns ${run.maxTurns})`,
  budget: (run, spent) => `stopped at an estimated $${spent.toFixed(6)}, past --max-cost ${run.maxCostUsd}`,
};

const isLimit = (reason: DoneReason): reason is Limit => Object.hasOwn(LIMIT_MESSAGES, reason);

export function positiveNumber(flag: string, raw: string, integer: boolean): number {
  const value = Number(raw);
  if (!(value > 0) || (integer && !Number.isInteger(value))) {
    throw new UsageError(`--${flag} must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return value;
}

export async function workspaceDir(cwd: string, raw: string): Promise<string> {
  try {
    const real = await realpath(path.resolve(cwd, raw));
    if ((await stat(real)).isDirectory()) return real;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  throw new EngineError(`workspace ${raw} is not a directory`);
}

export async function openForPrompt(
  io: Io,
  store: Store,
  flags: { readonly session?: string | undefined; readonly workspace?: string | undefined },
  prompt: string,
  noun: string,
): Promise<OpenSession> {
  let opened: OpenSession;
  if (flags.session === undefined) {
    if (prompt === '') throw new UsageError(`a ${noun} is required to start a session`);
    const workspace = await workspaceDir(io.cwd, flags.workspace ?? '.');
    opened = await startSession(store, io, { workspace, provider: undefined, model: undefined, effort: undefined });
  } else {
    if (flags.workspace !== undefined) throw new UsageError('--workspace is fixed when a session starts; drop it with --session');
    opened = await resumeSession(store, io, flags.session);
  }
  io.out(`session: ${opened.log.session.id}`);
  return opened;
}

const ABORTED = Symbol('aborted');

function unlessAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  // The race settles on the abort; a tool that rejects afterwards must not surface as an unhandled rejection.
  work.catch(() => {});
  return Promise.race([
    work,
    new Promise<typeof ABORTED>((resolve) => {
      if (signal.aborted) resolve(ABORTED);
      else signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
    }),
  ]);
}

/**
 * Runs the tool loop on an open session until the model ends its turn or a limit stops it. `prompt` is
 * logged first; an empty one resumes whatever the session left unanswered.
 */
export async function drive(
  io: Io,
  store: Store,
  opened: OpenSession,
  prompt: string,
  limits: Limits,
  mode: Mode,
  surface: Surface = terminalSurface(io),
): Promise<DriveResult> {
  const { log, gateway } = opened;
  const { session, file } = log;
  const { watcher } = surface;
  const events: TurnEvent[] = [...log.events];
  const record = async (event: TurnEvent) => {
    events.push(event);
    await appendEvent(file, event);
    watcher.logged(event);
  };
  const run: Run = { firstSeq: nextSeq(events), ...limits };
  if (prompt !== '') {
    await record({ kind: 'user', seq: nextSeq(events), at: new Date().toISOString(), content: prompt });
  } else if (loopStep(events, run).kind === 'done') {
    throw new UsageError('the session has nothing left to answer; pass a question');
  }

  const signal = io.interrupts();
  const ctx: ToolContext = {
    workspace: await workspaceDir(io.cwd, session.workspace),
    spillDir: path.join(store.spillDir, session.id),
    readRoots: mode.readRoots ?? [],
    attachmentsDir: attachmentsDir(store, session.id),
    rg: io.env['GCODE_RG'] || 'rg',
    signal,
    files: surface.files,
    events: () => events,
  };

  // One at a time: two edits to one file in a turn must see each other's result.
  const runTools = async (toolUses: readonly ToolUseBlock[]): Promise<boolean> => {
    const firstSeq = nextSeq(events);
    const work = (async () => {
      const results: ToolResultEvent[] = [];
      for (const [i, use] of toolUses.entries()) {
        const seq = firstSeq + i;
        watcher.toolStart(use, describeCall(use, mode.executors));
        const { status, text, change, approval, images } = await runTool(use, ctx, mode.executors);
        watcher.toolEnd(use, status);
        const output = await settle(text, spillFile(ctx.spillDir, seq, use.name));
        results.push({ kind: 'tool-result', seq, at: new Date().toISOString(), toolUseId: use.id, name: use.name, status, change, approval, images, ...output });
      }
      return results;
    })();
    const results = await unlessAborted(work, signal);
    if (results === ABORTED) return false;
    for (const result of results) await record(result);
    return true;
  };

  const loaded = new Map<Sha256, string>();
  const callModel = async (): Promise<void> => {
    if (mode.beforeCall !== undefined) await record(await mode.beforeCall(events));
    const result = await gateway.turn({
      session,
      events,
      tools: mode.tools,
      stored: await loadAttachments(ctx.attachmentsDir, events, loaded),
      ...(mode.system === undefined ? {} : { system: mode.system }),
      signal,
      onText: (delta) => watcher.text(delta),
      onRetry: async (retry) => {
        await record({ kind: 'retry', seq: nextSeq(events), at: new Date().toISOString(), ...retry });
        io.err(formatRetry(retry));
      },
    });
    const at = new Date().toISOString();
    if (result.kind === 'error') {
      await record({ kind: 'error', seq: nextSeq(events), at, error: result.error, message: result.message });
      io.err(`${result.error}: ${result.message}`);
      return;
    }
    await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn });
  };

  for (;;) {
    const step = loopStep(events, run);
    if (step.kind === 'done') {
      const exitCode = await finish(io, events, run, step.reason, record);
      return { reason: step.reason, exitCode, events, run };
    }
    if (step.kind === 'call-model') await callModel();
    else if (!(await runTools(step.toolUses))) {
      await record({ kind: 'error', seq: nextSeq(events), at: new Date().toISOString(), error: 'abort', message: 'interrupted by the user' });
      io.err('abort: interrupted by the user');
    }
  }
}

async function finish(
  io: Io,
  events: readonly TurnEvent[],
  run: Run,
  reason: DoneReason,
  record: (event: TurnEvent) => Promise<void>,
): Promise<number> {
  const thisRun = events.filter((e) => e.kind !== 'session-start' && e.seq >= run.firstSeq);
  const total = totalOf(thisRun);
  const last = events.at(-1);
  if (isLimit(reason) && !(last?.kind === 'error' && last.error === reason)) {
    const message = LIMIT_MESSAGES[reason](run, total.costUsd ?? 0);
    await record({ kind: 'error', seq: nextSeq(events), at: new Date().toISOString(), error: reason, message });
    io.err(`${reason}: ${message}`);
  } else if (reason === 'error' && last?.kind === 'assistant') {
    io.err(`error: the model stopped with ${last.stopReason ?? 'no stop reason'}`);
  }
  io.out(`usage: ${formatUsage(total.usage, total.costUsd)} turns=${total.turns}`);
  const final = events.at(-1);
  return final?.kind === 'error' ? EXIT_CODES[final.error] : DONE_EXIT[reason];
}
