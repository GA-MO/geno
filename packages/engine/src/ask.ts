import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  loopStep,
  nextSeq,
  TOOL_DEFINITIONS,
  type DoneReason,
  type Run,
  type ToolResultEvent,
  type TurnEvent,
} from '@g-code/core';
import { EXIT_CODES, formatUsage, resumeSession, startSession, totalOf, type OpenSession } from './chat.js';
import { UsageError, type Command, type Io } from './command.js';
import { EngineError } from './errors.js';
import { appendEvent } from './sessions.js';
import { isMissing } from './store.js';
import { describeCall, runTool, type ToolContext } from './tools/index.js';
import { settle, spillFile } from './tools/spill.js';

const DONE_EXIT: Record<DoneReason, number> = { end_turn: 0, 'max-turns': 3, budget: 3, refusal: 1, error: 1 };

type Limit = Extract<DoneReason, 'max-turns' | 'budget'>;

const LIMIT_MESSAGES: Record<Limit, (run: Run, spentUsd: number) => string> = {
  'max-turns': (run) => `stopped after ${run.maxTurns} model calls (--max-turns ${run.maxTurns})`,
  budget: (run, spent) => `stopped at an estimated $${spent.toFixed(6)}, past --max-cost ${run.maxCostUsd}`,
};

const isLimit = (reason: DoneReason): reason is Limit => Object.hasOwn(LIMIT_MESSAGES, reason);

function positiveNumber(flag: string, raw: string, integer: boolean): number {
  const value = Number(raw);
  if (!(value > 0) || (integer && !Number.isInteger(value))) {
    throw new UsageError(`--${flag} must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return value;
}

async function workspaceDir(cwd: string, raw: string): Promise<string> {
  try {
    const real = await realpath(path.resolve(cwd, raw));
    if ((await stat(real)).isDirectory()) return real;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  throw new EngineError(`workspace ${raw} is not a directory`);
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

export const ask: Command = async (args, { io, store }) => {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      session: { type: 'string' },
      workspace: { type: 'string' },
      'max-turns': { type: 'string', default: '25' },
      'max-cost': { type: 'string', default: '0.40' },
    },
  });
  const question = positionals.join(' ').trim();
  const maxTurns = positiveNumber('max-turns', values['max-turns'], true);
  const maxCostUsd = positiveNumber('max-cost', values['max-cost'], false);

  let opened: OpenSession;
  if (values.session === undefined) {
    if (question === '') throw new UsageError('a question is required to start a session');
    const workspace = await workspaceDir(io.cwd, values.workspace ?? '.');
    opened = await startSession(store, io, { workspace, provider: undefined, model: undefined, effort: undefined });
  } else {
    if (values.workspace !== undefined) throw new UsageError('--workspace is fixed when a session starts; drop it with --session');
    opened = await resumeSession(store, io, values.session);
  }
  const { log, gateway } = opened;
  const { session, file } = log;
  io.out(`session: ${session.id}`);

  const events: TurnEvent[] = [...log.events];
  const record = async (event: TurnEvent) => {
    events.push(event);
    await appendEvent(file, event);
  };
  const run: Run = { firstSeq: nextSeq(events), maxTurns, maxCostUsd };
  if (question !== '') {
    await record({ kind: 'user', seq: nextSeq(events), at: new Date().toISOString(), content: question });
  } else if (loopStep(events, run).kind === 'done') {
    throw new UsageError('the session has nothing left to answer; pass a question');
  }

  const signal = io.interrupts();
  const ctx: ToolContext = {
    workspace: await workspaceDir(io.cwd, session.workspace),
    spillDir: path.join(store.spillDir, session.id),
    rg: io.env['GCODE_RG'] || 'rg',
    signal,
  };

  const runTools = async (toolUses: readonly ToolUseBlock[]): Promise<boolean> => {
    for (const use of toolUses) io.out(`> ${describeCall(use)}`);
    const firstSeq = nextSeq(events);
    const results = await unlessAborted(
      Promise.all(
        toolUses.map(async (use, i): Promise<ToolResultEvent> => {
          const seq = firstSeq + i;
          const { status, text } = await runTool(use, ctx);
          const output = await settle(text, spillFile(ctx.spillDir, seq, use.name));
          return { kind: 'tool-result', seq, at: new Date().toISOString(), toolUseId: use.id, name: use.name, status, ...output };
        }),
      ),
      signal,
    );
    if (results === ABORTED) return false;
    for (const result of results) await record(result);
    return true;
  };

  const callModel = async (): Promise<void> => {
    let streamed = false;
    const result = await gateway.turn({
      session,
      events,
      tools: TOOL_DEFINITIONS,
      signal,
      onText: (delta) => {
        streamed = true;
        io.write(delta);
      },
    });
    if (streamed) io.write('\n');
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
    if (step.kind === 'done') return finish(io, events, run, step.reason, record);
    if (step.kind === 'call-model') await callModel();
    else if (!(await runTools(step.toolUses))) {
      await record({ kind: 'error', seq: nextSeq(events), at: new Date().toISOString(), error: 'abort', message: 'interrupted by the user' });
      io.err('abort: interrupted by the user');
    }
  }
};

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
