import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { changesCourse, steerEvent, DEFAULT_EFFORT_POLICY, EFFORT_POLICIES, holdsTurnOpen, loopStep, nextSeq, nextToolBatch, openWaitOf, withTurnEffort, type ApprovalRecord, type AssistantTurn, type EffortPolicy, type DoneReason, type InterruptedTool, type Run, type Sha256, type StreamMarks, type ToolResultEvent, type ToolStatus, type TurnEvent, type Waiter, type Waiting } from '@g-code/core';
import { attachmentsDir, loadAttachments } from './attachments.js';
import { EXIT_CODES, formatRetry, formatUsage, formatWait, resumeSession, startSession, totalOf, type OpenSession } from './chat.js';
import { UsageError, type Io } from './command.js';
import { EngineError } from './errors.js';
import { DISK_FILES, type Files } from './files.js';
import type { ToolInputDraft } from './gateway.js';
import { arrivalEvents, type Arrival } from './inbox.js';
import { appendEvent } from './sessions.js';
import { isMissing, type Store } from './store.js';
import { describeCall, runTool, type Executors, type ToolContext } from './tools/index.js';
import { settle, spillFile } from './tools/spill.js';
import type { SteerInbox } from './steer.js';
import type { Wake } from './waits.js';

export type Mode = {
  readonly tools: readonly Tool[];
  readonly executors: Executors;
  /** Undefined keeps the gateway's default prompt. */
  readonly system?: string;
  /** Real paths the read tools may see outside the workspace, read-only. */
  readonly readRoots?: readonly string[];
  /** An event to log before each model call, such as a checkpoint. */
  readonly beforeCall?: (events: readonly TurnEvent[]) => Promise<TurnEvent>;
  /** How each call's effort follows from the session's; undefined uses the default policy. */
  readonly effortPolicy?: EffortPolicy;
  /** A tool call the user typed, such as `@explore`: logged in place of the first model call, and the run ends once its tools ran. */
  readonly issued?: AssistantTurn;
  /** What reached the session from outside the loop since the last call: taken at the one safe point, before each model call. */
  readonly arrivals?: () => readonly Arrival[];
};

/**
 * `countFrom` counts the limits from an earlier event than this run's first: a woken turn shares the limits of the
 * user's prompt that started the background work.
 */
export type Limits = { readonly maxTurns: number; readonly maxCostUsd: number; readonly countFrom?: number | undefined };

/** How a run shows what it does as it happens. */
export type Watcher = {
  text(delta: string): void;
  /** A tool use about to run, with its one-line description. */
  toolStart(use: ToolUseBlock, title: string): void;
  /** That tool use finished; its result is logged once every tool of the batch has run. */
  toolEnd(use: ToolUseBlock, status: ToolStatus): void;
  /** Every event, as it is appended to the session log. */
  logged(event: TurnEvent): void;
  /** A tool call the model is still writing. */
  toolInput?(draft: ToolInputDraft): void;
  /** A model call waits offline or for a rate limit, or its next try moved; null once it goes out. */
  waiting?(wait: Waiting | null): void;
};

/**
 * Where a run reads and writes files and shows its progress: disk and the terminal, or an editor over ACP. `wake` is
 * the editor's Retry now, which cuts a wait short.
 * `waiter` names the engine process in the waits it logs, so another engine can take them up once it is gone.
 * `steers` is the run's door for steers: what a background child still owes it, and the end that sends what the run
 * did not take to the next turn. The steers themselves arrive through `Mode.arrivals`.
 */
export type Surface = {
  readonly files: Files;
  readonly watcher: Watcher;
  readonly wake?: Wake | undefined;
  readonly waiter?: Waiter | undefined;
  readonly steers?: SteerInbox | undefined;
  /** The engine wakes the session when background work reports, so a turn the model ends need not wait for it. */
  readonly wakeLater?: boolean | undefined;
};

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
  // Subagents log beside the loop while their tool runs, so writes take turns and each takes its number as it is written.
  let writing = Promise.resolve();
  const record = <E extends TurnEvent>(event: E): Promise<E> => {
    const written = writing.then(async () => {
      const numbered = event.kind === 'session-start' ? event : ({ ...event, seq: nextSeq(events) } as E);
      events.push(numbered);
      await appendEvent(file, numbered);
      watcher.logged(numbered);
      return numbered;
    });
    writing = written.then(
      () => {},
      () => {},
    );
    return written;
  };
  const run: Run = { firstSeq: limits.countFrom ?? nextSeq(events), maxTurns: limits.maxTurns, maxCostUsd: limits.maxCostUsd };
  if (prompt !== '') {
    await record({ kind: 'user', seq: nextSeq(events), at: new Date().toISOString(), content: prompt });
  } else {
    // A woken turn may start at its limits already; the loop then ends it with the limit's message.
    const step = loopStep(events, run);
    if (step.kind === 'done' && !isLimit(step.reason)) throw new UsageError('the session has nothing left to answer; pass a question');
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
    earlierCalls: async () => {},
    logNote: async (note) => {
      await record({ ...note, seq: 0 } as TurnEvent);
    },
  };

  const concurrent = (use: ToolUseBlock): boolean => Object.hasOwn(mode.executors, use.name) && mode.executors[use.name]!.concurrent?.(use.input) === true;

  // Batch by batch (see ToolBatch): an edit or command runs alone, after every call before it and before every call after.
  // Returns the tools of a batch the user interrupted, timed up to the interruption, or undefined when all ran.
  const runTools = async (toolUses: readonly ToolUseBlock[]): Promise<InterruptedTool[] | undefined> => {
    const firstSeq = nextSeq(events);
    const ran = new Map<number, InterruptedTool>();
    const running = new Map<number, Omit<InterruptedTool, 'endAt'>>();
    const results: ToolResultEvent[] = [];
    const runOne = async (i: number, toolCtx: ToolContext) => {
      const use = toolUses[i]!;
      const seq = firstSeq + i;
      const started = { toolUseId: use.id, name: use.name, startAt: Date.now() };
      running.set(i, started);
      watcher.toolStart(use, describeCall(use, mode.executors));
      const { status, text, change, approval, images, widget, editorAction, todo } = await runTool(use, toolCtx, mode.executors);
      watcher.toolEnd(use, status);
      const output = await settle(text, spillFile(ctx.spillDir, seq, use.name));
      const timing = { startAt: started.startAt, endAt: Date.now() };
      ran.set(i, { ...started, ...timing });
      running.delete(i);
      results[i] = { kind: 'tool-result', seq, at: new Date().toISOString(), toolUseId: use.id, name: use.name, status, change, approval, images, widget, editorAction, todo, ...output, timing };
    };
    const work = (async () => {
      for (let start = 0; start < toolUses.length; ) {
        const batch = nextToolBatch(toolUses.length, start, (i) => concurrent(toolUses[i]!));
        const calls: Promise<void>[] = [];
        let earlier: Promise<void> = Promise.resolve();
        for (let i = batch.start; i < batch.end; i++) {
          const before = earlier;
          const call = runOne(i, { ...ctx, toolUseId: toolUses[i]!.id, earlierCalls: () => before });
          calls.push(call);
          earlier = call.then(
            () => before,
            () => before,
          );
        }
        await Promise.all(calls);
        start = batch.end;
      }
      return results;
    })();
    const outcome = await unlessAborted(work, signal);
    if (outcome === ABORTED) {
      const now = Date.now();
      const cut = [...running].map(([i, tool]): [number, InterruptedTool] => [i, { ...tool, endAt: now }]);
      return [...ran, ...cut].sort(([a], [b]) => a - b).map(([, tool]) => tool);
    }
    for (const result of outcome) await record(result);
    return undefined;
  };

  let issued = mode.issued;
  const loaded = new Map<Sha256, string>();
  const callModel = async (): Promise<void> => {
    const startAt = Date.now();
    let marks: StreamMarks | undefined;
    // A wait the log ends in was left by an engine that stopped mid-wait; this call takes it up.
    const left = openWaitOf(events);
    let lastWait = left;
    if (mode.beforeCall !== undefined) await record(await mode.beforeCall(events));
    const result = await gateway.turn({
      session: withTurnEffort(session, events, mode.effortPolicy ?? EFFORT_POLICIES[DEFAULT_EFFORT_POLICY]),
      events,
      tools: mode.tools,
      stored: await loadAttachments(ctx.attachmentsDir, events, loaded),
      ...(mode.system === undefined ? {} : { system: mode.system }),
      signal,
      onText: (delta) => watcher.text(delta),
      onToolInput: (draft) => watcher.toolInput?.(draft),
      onMarks: (streamed) => {
        marks = streamed;
      },
      onRetry: async (retry) => {
        await record({ kind: 'retry', seq: nextSeq(events), at: new Date().toISOString(), ...retry });
        io.err(formatRetry(retry));
      },
      waiting: left,
      wake: surface.wake,
      onWait: async (wait) => {
        if (wait !== null && changesCourse(lastWait, wait)) {
          await record({ kind: 'wait', seq: nextSeq(events), at: new Date().toISOString(), wait, ...(surface.waiter === undefined ? {} : { by: surface.waiter }) });
          io.err(formatWait(wait, Date.now()));
        }
        lastWait = wait ?? undefined;
        watcher.waiting?.(wait);
      },
    });
    const at = new Date().toISOString();
    const timing = marks === undefined ? {} : { timing: { startAt, ...marks } };
    if (result.kind === 'error') {
      await record({ kind: 'error', seq: nextSeq(events), at, error: result.error, message: result.message, ...timing });
      io.err(`${result.error}: ${result.message}`);
      return;
    }
    await record({ kind: 'assistant', seq: nextSeq(events), at, ...result.turn, ...timing });
  };

  const inbox = surface.steers;
  // The one safe point: whatever reached the session from outside the loop, a background command's end or a steer, is
  // logged after the last tool results and before the model next sees the log. True when anything was.
  const deliver = async (): Promise<boolean> => {
    const arrived = mode.arrivals?.() ?? [];
    for (const arrival of arrived) {
      if (arrival.kind !== 'steer') for (const event of arrivalEvents(arrival)) await record(event);
      else arrival.settle({ kind: 'delivered', seq: (await record(steerEvent(arrival.steer, 0, new Date().toISOString()))).seq });
    }
    return arrived.length > 0;
  };
  const end = async (reason: DoneReason): Promise<DriveResult> => {
    inbox?.close();
    const exitCode = await finish(io, events, run, reason, record);
    return { reason, exitCode, events, run };
  };

  for (;;) {
    const step = loopStep(events, run);
    // Where nothing wakes the session later, a turn the model ended stays open while a background child owes its
    // report: it waits, then takes what arrived.
    const held = step.kind === 'done' && step.reason === 'end_turn' && inbox !== undefined && surface.wakeLater !== true && holdsTurnOpen(inbox.owed, inbox.reports()) ? inbox : undefined;
    if (held !== undefined) {
      await held.arrival(signal);
      if (signal.aborted) {
        await record({ kind: 'error', seq: nextSeq(events), at: new Date().toISOString(), error: 'abort', message: 'interrupted by the user' });
        continue;
      }
    }
    if (step.kind === 'done' && held === undefined) return end(step.reason);
    if (step.kind === 'call-model' && issued !== undefined) {
      await record({ kind: 'assistant', seq: nextSeq(events), at: new Date().toISOString(), ...issued, issuedBy: 'user' });
      issued = undefined;
    } else if (step.kind === 'call-model' && mode.issued !== undefined) return end('end_turn');
    else if (step.kind === 'call-model' || held !== undefined) {
      // A delivery changed the log, so the loop looks at it again, and a limit still applies.
      if (!(await deliver()) && step.kind === 'call-model') await callModel();
    } else if (step.kind === 'run-tools') {
      const interrupted = await runTools(step.toolUses);
      if (interrupted !== undefined) {
        await record({ kind: 'error', seq: nextSeq(events), at: new Date().toISOString(), error: 'abort', message: 'interrupted by the user', tools: interrupted });
        io.err('abort: interrupted by the user');
      }
    }
  }
}

async function finish(
  io: Io,
  events: readonly TurnEvent[],
  run: Run,
  reason: DoneReason,
  record: (event: TurnEvent) => Promise<unknown>,
): Promise<number> {
  const thisRun = events.filter((e) => e.kind !== 'session-start' && e.seq !== undefined && e.seq >= run.firstSeq);
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
