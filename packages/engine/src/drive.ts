import { homedir } from 'node:os';
import path from 'node:path';
import type { Tool, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { capUsd, type Session, type UsdCap } from '@g-code/core';
import { budgetReminder, compactionStuck, spillLimitOf, lastCallDue, toldLastCall, REPORT_TOOL, capabilitiesOf, answerEvent, changesCourse, steerEvent, stoppedAnswers, DEFAULT_EFFORT_POLICY, EFFORT_POLICIES, holdsTurnOpen, loopStep, nextSeq, nextToolBatch, autoCompaction, type CompactPlan, type CompactTrigger, type DiskState, openWaitOf, withTurnEffort, type ApprovalRecord, type AssistantTurn, type EffortPolicy, type DoneReason, type InterruptedTool, type Notice, type Run, type Sha256, type StreamMarks, type ToolResultEvent, type ToolStatus, type TurnEvent, type Waiter, type Waiting, type TodoList, toolText, type PromptDecision, type CallProgress, finishedResponding, lastAssistantText, lastResponseText, modelEndedTurn, stopHookActive, stopMayContinue, TODO_TOOL, todoReminder } from '@g-code/core';
import { attachmentsDir, loadAttachments } from './attachments.js';
import { compactAtOf, compactContext } from './compact.js';
import { EXIT_CODES, formatRetry, formatUsage, formatWait, resumeSession, startSession, totalOf, type OpenSession } from './chat.js';
import { UsageError, type Io } from './command.js';
import { changedOnDisk } from './file-tracker.js';
import { DISK_FILES, type Files } from './files.js';
import type { ToolInputDraft } from './gateway.js';
import { arrivalEvents, type Arrival } from './inbox.js';
import { appendEvent } from './sessions.js';
import { snapshotKeeper } from './snapshots.js';
import type { Store } from './store.js';
import { credentialPlacesOf, displayPath } from './tools/context.js';
import { workspaceDir } from './workspace.js';
import type { PreToolStep, RanCall, StopHook, ToolHookSaid, ToolHooks } from './hooks.js';
import { describeCall, PermissionRerun, runTool, type Executor, type Executors, type ToolContext, type ToolRun } from './tools/index.js';
import { settle, spillFile } from './tools/spill.js';
import type { SteerInbox } from './steer.js';
import type { Wake } from './waits.js';

export type Mode = {
  readonly tools: readonly Tool[];
  readonly executors: Executors;
  /** Undefined keeps the gateway's default prompt. */
  readonly system?: string;
  /** The one tool each model call must make, such as a schema step's structured_output. */
  readonly forced?: string;
  /** Real paths the read tools may see outside the workspace, read-only. */
  readonly readRoots?: readonly string[];
  /** An event to log before each model call, such as a checkpoint. */
  readonly beforeCall?: (events: readonly TurnEvent[]) => Promise<TurnEvent>;
  /** How each call's effort follows from the session's; undefined uses the default policy. */
  readonly effortPolicy?: EffortPolicy;
  /**
   * Calls the user issued, in place of the model: `@explore`'s one call, or a workflow's rounds. Asked at each point
   * the model would be called, it answers with the turn to log, or undefined to end the run.
   */
  readonly director?: Director;
  /** What reached the session from outside the loop since the last call: taken at the one safe point, before each model call. */
  readonly arrivals?: () => readonly Arrival[];
  /** What the model must be told at the safe point, such as a mode switch or a memory change; undefined when it knows. */
  readonly notice?: (events: readonly TurnEvent[]) => Promise<Notice | undefined>;
  /** What to log after a compaction, such as SessionStart's `compact` hook output. */
  readonly afterCompact?: () => Promise<TurnEvent | undefined>;
  /** A subagent's run, which hands its report back through the report tool (`handback.ts`). */
  readonly handback?: true | undefined;
  /** The user's tool event hooks: every call's PreToolUse verdict, settled before the first call of a turn runs, and the after-tool events. */
  readonly toolHooks?: ToolHooks | undefined;
  /** The user's UserPromptSubmit hooks, on the prompt this run answers: they may block it or add to it. */
  readonly promptSubmitted?: ((prompt: string) => Promise<PromptDecision>) | undefined;
  /** The user's Stop hooks as the session's own model ends its turn, or SubagentStop as a subagent's does: they may keep it going. */
  readonly stop?: StopHook | undefined;
};

export type Director = (events: readonly TurnEvent[]) => AssistantTurn | undefined | Promise<AssistantTurn | undefined>;

/** One turn the user issued, such as `@explore <question>`: the run ends once its tools ran. */
export function issuedOnce(turn: AssistantTurn): Director {
  let left: AssistantTurn | undefined = turn;
  return () => {
    const next = left;
    left = undefined;
    return next;
  };
}

/**
 * `countFrom` counts the limits from an earlier event than this run's first: a woken turn shares the limits of the
 * user's prompt that started the background work.
 */
export type Limits = { readonly maxTurns: number; readonly maxCostUsd: number; readonly countFrom?: number | undefined };

/** A run's limits before its model is known: a cost cap a user set, or a default that scales to the model (`capUsd`). */
export type LimitsSpec = Omit<Limits, 'maxCostUsd'> & { readonly maxCostUsd: UsdCap };

/** The limits of a run on this session's model. */
export const limitsOn = (spec: LimitsSpec, { provider, model }: Pick<Session, 'provider' | 'model'>): Limits => ({ ...spec, maxCostUsd: capUsd(spec.maxCostUsd, provider, model) });

/** How a run shows what it does as it happens. */
export type Watcher = {
  text(delta: string): void;
  /** A tool use about to run, with its one-line description. */
  toolStart(use: ToolUseBlock, title: string): void;
  /**
   * That tool use finished; its result is logged once every tool of the batch has run. A todo call's list comes
   * along, so the user sees it while a slower call of the same batch still runs.
   */
  toolEnd(use: ToolUseBlock, status: ToolStatus, todo?: TodoList): void;
  /** A tool use that will never run, such as one the user stopped before it started; its error result is logged next. */
  toolSkipped?(use: ToolUseBlock, title: string): void;
  /** Every event, as it is appended to the session log. */
  logged(event: TurnEvent): void;
  /** A tool call the model is still writing. */
  toolInput?(draft: ToolInputDraft): void;
  /** A model call waits offline or for a rate limit, or its next try moved; null once it goes out. */
  waiting?(wait: Waiting | null): void;
  /** A try of a model call as it streams, a few times a second; live status that the log never keeps. */
  progress?(progress: CallProgress): void;
  /** The context is being summarized before the next model call; the compaction is logged when it is done. */
  compacting?(): void;
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

export async function openForPrompt(
  io: Io,
  store: Store,
  flags: { readonly session?: string | undefined; readonly workspace?: string | undefined; readonly effort?: string | undefined },
  prompt: string,
  noun: string,
): Promise<OpenSession> {
  let opened: OpenSession;
  if (flags.session === undefined) {
    if (prompt === '') throw new UsageError(`a ${noun} is required to start a session`);
    const workspace = await workspaceDir(io.cwd, flags.workspace ?? '.');
    opened = await startSession(store, io, { workspace, provider: undefined, model: undefined, effort: flags.effort });
  } else {
    if (flags.workspace !== undefined) throw new UsageError('--workspace is fixed when a session starts; drop it with --session');
    if (flags.effort !== undefined) throw new UsageError('--effort is fixed when a session starts; drop it with --session');
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
  const run: Run = { firstSeq: limits.countFrom ?? nextSeq(events), maxTurns: limits.maxTurns, maxCostUsd: limits.maxCostUsd, handback: mode.handback, ...(mode.forced === undefined && mode.tools.some((tool) => tool.name === TODO_TOOL) ? { todo: true as const } : {}) };
  if (prompt !== '') {
    await record({ kind: 'user', seq: nextSeq(events), at: new Date().toISOString(), content: prompt });
    await submitted(events, mode, record, io);
  } else if (isTyped(events.at(-1))) {
    // The editor logged the prompt with its attachments before the run.
    await submitted(events, mode, record, io);
  } else {
    // A woken turn may start at its limits already; the loop then ends it with the limit's message.
    const step = loopStep(events, run);
    if (step.kind === 'done' && !isLimit(step.reason)) throw new UsageError('the session has nothing left to answer; pass a question');
  }

  const signal = io.interrupts();
  const snapshot = snapshotKeeper(store);
  const ctx: ToolContext = {
    workspace: await workspaceDir(io.cwd, session.workspace),
    spillDir: path.join(store.spillDir, session.id),
    spillChars: capabilitiesOf(session.provider, session.model).spillChars,
    readRoots: mode.readRoots ?? [],
    credentialPlaces: await credentialPlacesOf(io.env['HOME'] || homedir()),
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

  // A hook's question goes to the user before the call's own checks, which then take the yes as a hook's allow.
  const asking = (step: Extract<PreToolStep, { kind: 'ask' }>): Executors => {
    const own = mode.executors[step.use.name];
    if (own === undefined) return mode.executors;
    const run: Executor['run'] = async (raw, toolCtx) => {
      const approval = await mode.toolHooks!.confirm(step.question, toolCtx);
      const reply = await own.run(raw, { ...toolCtx, hookAllowed: true });
      return typeof reply === 'string' ? { text: reply, approval } : { ...reply, approval: reply.approval ?? approval };
    };
    return { ...mode.executors, [step.use.name]: { ...own, run } };
  };
  // A PermissionRequest hook's allow with updatedInput runs the call again with that input, the allow answering its
  // cards, so the hook is asked once per call. `ran` is the call as it ran, for the after-tool hooks.
  const callOf = async (step: PreToolStep | undefined, use: ToolUseBlock, toolCtx: ToolContext): Promise<ToolRun & { readonly ran: ToolUseBlock }> => {
    if (step?.kind === 'refuse') return { status: 'denied', text: toolText(use.name, step.text), approval: step.approval, ran: use };
    const executors = step?.kind === 'ask' ? asking(step) : mode.executors;
    const asked: ToolContext = { ...(step?.kind === 'run' && step.allowed ? { ...toolCtx, hookAllowed: true } : toolCtx), permissionRequest: mode.toolHooks?.permissionAsk(use) };
    try {
      return { ...(await runTool(use, asked, executors)), ran: use };
    } catch (error) {
      if (!(error instanceof PermissionRerun)) throw error;
      const rewritten: ToolUseBlock = { ...use, input: error.input };
      return { ...(await runTool(rewritten, { ...asked, permissionRequest: async () => ({ kind: 'allow' }) }, executors)), ran: rewritten };
    }
  };

  // Batch by batch (see ToolBatch): an edit or command runs alone, after every call before it and before every call after.
  // Returns the calls the user interrupted while they ran, timed up to the interruption, or undefined when all ran.
  const runTools = async (toolUses: readonly ToolUseBlock[]): Promise<InterruptedTool[] | undefined> => {
    const firstSeq = nextSeq(events);
    const running = new Map<number, Omit<InterruptedTool, 'endAt'>>();
    const results: ToolResultEvent[] = [];
    let steps: readonly PreToolStep[] | undefined;
    const hooks = mode.toolHooks;
    // What each call's after-tool hooks said, and the batch's, logged after the results.
    const after: ToolHookSaid[] = [];
    const ran: RanCall[] = [];
    // The call as it runs: a hook's updatedInput replaces the model's input, which the log keeps as the model sent it.
    const useAt = (i: number): ToolUseBlock => {
      const step = steps?.[i];
      return step === undefined || step.kind === 'refuse' ? toolUses[i]! : step.use;
    };
    // A call a hook asks about waits for the user, and a refused one runs nothing, so neither runs beside others.
    const concurrentAt = (i: number): boolean => (steps?.[i] === undefined || steps[i]!.kind === 'run') && concurrent(useAt(i));
    const runOne = async (i: number, toolCtx: ToolContext) => {
      const use = useAt(i);
      const seq = firstSeq + i;
      const started = { toolUseId: use.id, name: use.name, startAt: Date.now() };
      running.set(i, started);
      watcher.toolStart(use, describeCall(use, mode.executors));
      const { status, text, change, approval, images, widget, editorAction, todo, loaded, spinoff, chapter, shown, file, ran: asRan } = await callOf(steps?.[i], use, toolCtx);
      watcher.toolEnd(use, status, todo);
      if (hooks !== undefined) {
        // After Geno's own check, which the edit's result already holds, and before the call after it starts.
        ran[i] = { use: asRan, status, text, durationMs: Date.now() - started.startAt };
        after[i] = await hooks.after(ran[i]!);
      }
      const output = await settle(text, spillFile(ctx.spillDir, seq, use.name), spillLimitOf(use.name, ctx.spillChars));
      const timing = { startAt: started.startAt, endAt: Date.now() };
      running.delete(i);
      results[i] = { kind: 'tool-result', seq, at: new Date().toISOString(), toolUseId: use.id, name: use.name, status, change, approval, images, widget, editorAction, todo, loaded, spinoff, chapter, shown, file, ...output, timing };
    };
    const work = (async () => {
      // PreToolUse fires for every call of the turn before the first one runs, as Claude Code's does (T-LOOP-01).
      steps = await hooks?.decide(toolUses, (use) => describeCall(use, mode.executors));
      for (let start = 0; start < toolUses.length; ) {
        const batch = nextToolBatch(toolUses.length, start, concurrentAt);
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
        // After the user turns a call down, the turn's later calls do not start; loopStep answers them.
        if (results.some((result) => result?.status === 'rejected')) break;
        start = batch.end;
      }
      const batch = hooks === undefined ? undefined : await hooks.batch(ran.filter((call) => call !== undefined));
      return { results, said: [...toolUses.flatMap((_use, i) => [steps?.[i]?.said, after[i]]), batch] };
    })();
    const outcome = await unlessAborted(work, signal);
    if (outcome !== ABORTED) {
      for (const result of outcome.results) if (result !== undefined) await record(result);
      for (const said of outcome.said) if (said?.context !== undefined) await record({ ...said.context, seq: nextSeq(events) });
      const stop = outcome.said.find((said) => said?.stop !== undefined)?.stop;
      if (stop !== undefined) {
        const message = `A ${stop.by} hook stopped the turn: ${stop.reason}`;
        await record({ kind: 'error', seq: nextSeq(events), at: new Date().toISOString(), error: 'blocked', message });
        io.err(`blocked: ${message}`);
      }
      return undefined;
    }
    // Calls that finished keep their results; the rest are answered as stopped, so no later run runs them again.
    const now = Date.now();
    const finished = [...results];
    const cut = [...running.values()].map((tool): InterruptedTool => ({ ...tool, endAt: now }));
    const started = new Set(cut.map((tool) => tool.toolUseId));
    const answers = stoppedAnswers(toolUses, (id) => started.has(id));
    const at = new Date(now).toISOString();
    for (const [i, use] of toolUses.entries()) {
      if (finished[i] === undefined && !started.has(use.id)) watcher.toolSkipped?.(use, describeCall(use, mode.executors));
      await record(finished[i] ?? answerEvent(answers[i]!, 0, at));
    }
    return cut;
  };

  const loaded = new Map<Sha256, string>();
  const compactAt = compactAtOf(io.env, session);
  // True when a compaction was logged; a failed or empty one leaves the context as it was.
  const compact = async (trigger: CompactTrigger, plan?: CompactPlan): Promise<boolean> => {
    watcher.compacting?.();
    const outcome = await compactContext(gateway, session, events, {
      trigger,
      plan,
      compactAt,
      stored: await loadAttachments(ctx.attachmentsDir, events, loaded),
      signal,
      onRetry: (retry) => io.err(formatRetry(retry)),
    });
    if (outcome.kind === 'compacted') {
      const event = await record(outcome.event);
      io.err(`compact (${trigger}): ${event.tokensBefore} -> about ${event.tokensAfter} tokens`);
      const told = await mode.afterCompact?.();
      if (told !== undefined) await record(told);
      return true;
    }
    if (outcome.kind === 'failed' && !signal.aborted) io.err(`compact: ${outcome.message}`);
    return false;
  };
  let saidStuck = false;
  const callModel = async (): Promise<void> => {
    const due = autoCompaction(events, compactAt);
    if (due !== undefined) await compact('auto', due);
    else if (!saidStuck && compactionStuck(events, compactAt)) {
      saidStuck = true;
      io.err(`compact: the context passed the ${compactAt}-token threshold, but the system prompt, the tools and the newest turns hold most of it, so a summary would not bring it under; Geno compacts once a summary would halve the context.`);
    }
    const startAt = Date.now();
    let marks: StreamMarks | undefined;
    // A wait the log ends in was left by an engine that stopped mid-wait; this call takes it up.
    const left = openWaitOf(events);
    let lastWait = left;
    if (mode.beforeCall !== undefined) await record(await mode.beforeCall(events));
    // The last call a limit allows must answer: a child's goes to its report, any other run's with the tools off. A child
    // whose model refuses a forced tool answers with the tools off too, and its last text is its report.
    const last = mode.forced === undefined && lastCallDue(events, run);
    const reportForced = last && run.handback === true && capabilitiesOf(session.provider, session.model).forcesTool && mode.tools.some((tool) => tool.name === REPORT_TOOL);
    const forced = mode.forced ?? (reportForced ? REPORT_TOOL : undefined);
    const send = async () => gateway.turn({
      snapshot,
      session: withTurnEffort(session, events, mode.effortPolicy ?? EFFORT_POLICIES[DEFAULT_EFFORT_POLICY]),
      events,
      tools: mode.tools,
      stored: await loadAttachments(ctx.attachmentsDir, events, loaded),
      ...(mode.system === undefined ? {} : { system: mode.system }),
      ...(forced === undefined ? {} : { forced }),
      ...(last && forced === undefined ? { toolsOff: true } : {}),
      signal,
      onText: (delta) => watcher.text(delta),
      onToolInput: (draft) => watcher.toolInput?.(draft),
      onProgress: (progress) => watcher.progress?.(progress),
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
    let result = await send();
    // A request the provider refused as too long compacts once and goes again once.
    if (result.kind === 'error' && result.error === 'overflow' && (await compact('overflow'))) result = await send();
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
  const verified = new Map<string, DiskState>();
  // The one safe point: whatever reached the session from outside the loop, a background command's end or a steer, is
  // logged after the last tool results and before the model next sees the log, with a note for each file the model
  // read that changed on disk, a notice of a mode switch or a memory change, the todo list when it has gone stale, and
  // the budget reminder when the run's limits are near. True when anything arrived; a note or a notice alone does not
  // hold back the model call.
  const deliver = async (): Promise<boolean> => {
    for (const { path, now, excerpt } of await changedOnDisk(events, verified)) {
      await record({ kind: 'file-changed', seq: 0, at: new Date().toISOString(), path, shown: displayPath(ctx, path), now, ...(excerpt === undefined ? {} : { excerpt }) });
    }
    const settings = await mode.notice?.(events);
    const budget = budgetReminder(events, run);
    const lastCall = lastCallDue(events, run);
    const last = mode.forced === undefined && lastCall && !toldLastCall(events, run);
    // Asking for a todo call is moot on a call that cannot make one.
    const todo = mode.forced === undefined && !lastCall && mode.tools.some((tool) => tool.name === TODO_TOOL) ? todoReminder(events) : undefined;
    const notice =
      budget === undefined && !last && todo === undefined
        ? settings
        : { ...settings, ...(todo === undefined ? {} : { todo }), ...(budget === undefined ? {} : { budget }), ...(last ? { last: true as const } : {}) };
    if (notice !== undefined) await record({ kind: 'notice', seq: nextSeq(events), at: new Date().toISOString(), ...notice });
    const arrived = mode.arrivals?.() ?? [];
    for (const arrival of arrived) {
      if (arrival.kind !== 'steer') for (const event of arrivalEvents(arrival)) await record(event);
      else arrival.settle({ kind: 'delivered', seq: (await record(steerEvent(arrival.steer, 0, new Date().toISOString()))).seq });
    }
    return arrived.length > 0;
  };
  // Stop, as the model ends its turn: a hook's block keeps the turn going once in a row, its reason the model's next
  // message. A subagent's SubagentStop fires after its report too, which is its final response.
  const stopKeepsGoing = async (): Promise<boolean> => {
    const hook = mode.stop;
    if (hook === undefined) return false;
    const subagent = hook.event === 'SubagentStop';
    if (!(subagent ? finishedResponding(events, run) : modelEndedTurn(events, run))) return false;
    const decision = await hook.decide({ stop_hook_active: stopHookActive(events, run), last_assistant_message: subagent ? lastResponseText(events) : lastAssistantText(events) });
    if (decision.kind === 'end') {
      if (decision.reason !== undefined) io.err(`${hook.event} hook: ${decision.reason}`);
      return false;
    }
    if (!stopMayContinue(events, run)) {
      io.err(`${hook.event} hook blocked the end of the turn again, and the model called no tool since its last block, so the turn ends here`);
      return false;
    }
    await record({ kind: 'hook-context', seq: nextSeq(events), at: new Date().toISOString(), event: hook.event, notes: decision.notes });
    return true;
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
    if (step.kind === 'done' && held === undefined) {
      if (step.reason === 'end_turn' && (await stopKeepsGoing())) continue;
      return end(step.reason);
    }
    if (step.kind === 'call-model' && mode.director !== undefined) {
      const issued = await mode.director(events);
      if (issued === undefined) return end('end_turn');
      // Text the user's side issues, such as a workflow's closing report, reaches a live viewer as a model's would.
      for (const block of issued.content) if (block.type === 'text') watcher.text(block.text);
      await record({ kind: 'assistant', seq: nextSeq(events), at: new Date().toISOString(), ...issued, issuedBy: 'user' });
    } else if (step.kind === 'call-model' || held !== undefined) {
      // A delivery changed the log, so the loop looks at it again, and a limit still applies.
      if (!(await deliver()) && step.kind === 'call-model') await callModel();
    } else if (step.kind === 'run-tools') {
      const interrupted = await runTools(step.toolUses);
      if (interrupted !== undefined) {
        await record({ kind: 'error', seq: nextSeq(events), at: new Date().toISOString(), error: 'abort', message: 'interrupted by the user', tools: interrupted });
        io.err('abort: interrupted by the user');
      }
    } else if (step.kind === 'nudge') {
      await record({ kind: 'report-nudge', seq: nextSeq(events), at: new Date().toISOString(), ...(step.empty === true ? { empty: true as const } : {}) });
    } else if (step.kind === 'remind-todo') {
      await record({ kind: 'notice', seq: nextSeq(events), at: new Date().toISOString(), todo: step.todo });
    } else if (step.kind === 'answer-tools') {
      const at = new Date().toISOString();
      for (const answer of step.answers) {
        watcher.toolSkipped?.(answer.use, describeCall(answer.use, mode.executors));
        await record(answerEvent(answer, 0, at));
      }
    }
  }
}

/** A prompt the user typed, as opposed to a steer, a wake or anything else the engine logs as a user message. */
const isTyped = (event: TurnEvent | undefined): event is Extract<TurnEvent, { kind: 'user' }> => event?.kind === 'user' && event.from === undefined && event.steer !== true;

/**
 * UserPromptSubmit on the prompt the log ends with. A block is logged as the turn's error, so the prompt never reaches
 * the model and the user reads why; the hooks' notes follow the prompt, so a resumed session sends the same bytes.
 */
async function submitted(events: readonly TurnEvent[], mode: Mode, record: (event: TurnEvent) => Promise<unknown>, io: Io): Promise<void> {
  const prompt = events.at(-1);
  if (mode.promptSubmitted === undefined || !isTyped(prompt)) return;
  const decision = await mode.promptSubmitted(prompt.content);
  const at = new Date().toISOString();
  if (decision.kind === 'block') {
    const message = `A UserPromptSubmit hook blocked this prompt, so the model did not see it: ${decision.reason}`;
    await record({ kind: 'error', seq: nextSeq(events), at, error: 'blocked', message });
    io.err(`blocked: ${message}`);
  } else if (decision.notes.length > 0) {
    await record({ kind: 'hook-context', seq: nextSeq(events), at, event: 'UserPromptSubmit', notes: decision.notes });
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
  } else if (reason === 'error' && last?.kind !== 'error') {
    // The newest turn's stop ended the run, even when the answer to a call it cut short was logged after it.
    const turn = events.findLast((e) => e.kind === 'assistant');
    if (turn?.kind === 'assistant' && turn.stopReason === 'end_turn') io.err('error: the model ended its turn twice with no text and no tool call, so this run has no answer');
    else if (turn?.kind === 'assistant') io.err(`error: the model stopped with ${turn.stopReason ?? 'no stop reason'}`);
  }
  io.out(`usage: ${formatUsage(total.usage, total.costUsd)} turns=${total.turns}`);
  const final = events.at(-1);
  return final?.kind === 'error' ? EXIT_CODES[final.error] : DONE_EXIT[reason];
}
