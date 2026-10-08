import { z } from 'zod';
import { childEndWords, childrenOf, jobEndText, jobOutputText, taskRefOf, workListText, type ChildEnd, type EndedJobState, type JobId, type WakeId, type WorkRow } from '@g-code/core';
import { NO_BACKGROUND, type SessionBackground } from './background.js';
import { executor, ToolError, type Executor, type ToolContext } from './context.js';
import type { StartChild } from './skill.js';
import type { SessionWakes } from './wake.js';

/** The run's subagents: `stop` for task_stop, and `start` for a `context: fork` skill. */
export type SessionChildren = { stop(childId: string): Promise<string> | undefined; readonly start: StartChild };

export type SessionWork = {
  readonly background: SessionBackground | undefined;
  readonly wakes: SessionWakes | undefined;
  readonly children: SessionChildren | undefined;
};

const UNKNOWN_ID = "takes a bg-N background command, a wake-N monitor, wake-up or PR watch, or a subagent's session id; list_agents lists them";

async function stopJob({ background }: SessionWork, id: JobId): Promise<string> {
  if (background === undefined) throw new ToolError(NO_BACKGROUND);
  const { jobs, sessionId } = background;
  const job = jobs.job(sessionId, id);
  if (job.state.status !== 'running') throw new ToolError(`${id} is not running: it ${jobEndText(job.state as EndedJobState)}.`);
  const ended = await jobs.stop(sessionId, id, 'model');
  return `Stopped background command ${id} (\`${ended.command}\`). ${jobOutputText(id, ended.outputFile, jobs.tail(sessionId, id))}`;
}

async function stopWake({ wakes }: SessionWork, id: WakeId, ctx: ToolContext): Promise<string> {
  const stopped = wakes?.registry.stop(wakes.sessionId, id);
  if (stopped === undefined) throw new ToolError(`no monitor, wake-up or PR watch ${id} is pending in this session; it may have fired or ended already`);
  switch (stopped.kind) {
    case 'schedule':
      // Logged, so that an engine that starts after this one arms nothing for it.
      await ctx.logNote?.({ kind: 'wake', at: new Date().toISOString(), note: { kind: 'stopped', id } });
      return `Cancelled wake-up ${id}. It will not wake you.`;
    case 'monitor':
      return `Stopped monitor ${id} on ${stopped.job}. ${
        stopped.ownsJob ? `The command it started, ${stopped.job}, is stopping too.` : `${stopped.job} keeps running; stop it with task_stop too if you no longer need it.`
      }`;
    case 'pr':
      return `Stopped the watch of PR #${stopped.pr}'s checks (${id}). It will not wake you.`;
  }
}

async function stopChild({ children, wakes }: SessionWork, id: string, ctx: ToolContext): Promise<string> {
  const stopping = children?.stop(id) ?? wakes?.registry.stopChild(wakes.sessionId, id);
  if (stopping !== undefined) return stopping;
  const known = childrenOf(ctx.events()).find((child) => child.child === id);
  if (known === undefined) throw new ToolError(`no subagent ${id} of this session; task_stop ${UNKNOWN_ID}`);
  if (known.status.kind !== 'running') throw new ToolError(`${known.role} subagent ${id} is not running: it ended (${childEndWords(known.status as ChildEnd)}).`);
  throw new ToolError(`${known.role} subagent ${id} runs as a blocking call, which ends with its report; only a background subagent can be stopped`);
}

/** task_stop and list_agents: the model's controls over the session's background work. */
export function workExecutors(work: SessionWork): { readonly task_stop: Executor; readonly list_agents: Executor } {
  return {
    task_stop: executor({
      input: z.strictObject({ id: z.string().trim().min(1) }),
      describe: ({ id }) => `task_stop ${id}`,
      async run({ id }, ctx) {
        const ref = taskRefOf(id);
        if (ref === undefined) throw new ToolError(`${id} is not an id task_stop knows: it ${UNKNOWN_ID}`);
        if (ref.kind === 'job') return stopJob(work, ref.id);
        return ref.kind === 'wake' ? stopWake(work, ref.id, ctx) : stopChild(work, ref.id, ctx);
      },
    }),
    list_agents: executor({
      input: z.strictObject({}),
      describe: () => 'list_agents',
      // It reads the log and the engine's registries and changes nothing.
      concurrent: () => true,
      async run(_input, ctx) {
        const { background, wakes } = work;
        const children = childrenOf(ctx.events()).map(
          (child): WorkRow => ({ kind: 'child', id: child.child, role: child.role, status: child.status, model: child.model, turns: child.turns, costUsd: child.costUsd, startedAt: Date.parse(child.at) }),
        );
        const jobs = (background === undefined ? [] : background.jobs.jobs(background.sessionId)).map(
          (job): WorkRow => ({ kind: 'job', id: job.id, command: job.command, state: job.state, startedAt: job.startedAt, outputFile: job.outputFile }),
        );
        const pending = wakes === undefined ? [] : wakes.registry.pending(wakes.sessionId);
        return workListText([...children, ...jobs, ...pending], Date.now());
      },
    }),
  };
}
