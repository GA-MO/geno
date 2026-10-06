import { z } from 'zod';
import {
  isJobId,
  MONITOR_DEFAULT_S,
  MONITOR_MAX_S,
  SCHEDULE_MAX_S,
  SCHEDULE_MIN_S,
  type ApprovalRecord,
  type JobId,
  type Waiter,
  type WakeNote,
} from '@g-code/core';
import type { Wakes } from '../wakes.js';
import type { SessionBackground } from './background.js';
import { executor, optional, ToolError, type Executor, type ToolContext } from './context.js';

/** What wakes this session later, for the tools that ask to be woken. */
export type SessionWakes = {
  readonly registry: Wakes;
  readonly sessionId: string;
  /** This engine process, named in a wake-up's record so that another engine takes it up only once this one is gone. */
  readonly waiter: Waiter;
};

/** Starts a command in the background under bash's approval and sandbox. */
export type StartCommand = (command: string, description: string | undefined, ctx: ToolContext) => Promise<{ readonly job: JobId; readonly text: string; readonly approval: ApprovalRecord | undefined }>;

export const NO_WAKES =
  'nothing would wake this session: auto-wake is off in the settings, or this run ends when its call does. Wait in this turn with bash_output instead, or tell the user what to check later.';

const withApproval = (text: string, approval: ApprovalRecord | undefined) => (approval === undefined ? text : { text, approval });

export function wakeExecutors(wakes: SessionWakes | undefined, background: SessionBackground | undefined, startCommand: StartCommand): { readonly monitor: Executor; readonly schedule_wakeup: Executor } {
  const own = (): SessionWakes => {
    if (wakes === undefined || background === undefined) throw new ToolError(NO_WAKES);
    return wakes;
  };
  return {
    monitor: executor({
      input: z.strictObject({
        command: optional(z.string().min(1)),
        background_job_id: optional(z.string().min(1)),
        pattern: z.string().min(1),
        timeout_s: optional(z.number().int().positive().max(MONITOR_MAX_S)),
        description: optional(z.string()),
      }),
      describe: ({ command, background_job_id, pattern }) => `monitor ${command ?? background_job_id ?? ''} for /${pattern}/`,
      async run({ command, background_job_id, pattern, timeout_s = MONITOR_DEFAULT_S, description }, ctx) {
        const { registry, sessionId } = own();
        if ((command === undefined) === (background_job_id === undefined)) throw new ToolError('give command or background_job_id, one of the two');
        let regex: RegExp;
        try {
          regex = new RegExp(pattern);
        } catch (error) {
          throw new ToolError(`pattern is not a JavaScript regular expression: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (background_job_id !== undefined && !isJobId(background_job_id)) throw new ToolError(`no background command ${background_job_id} in this session`);
        const started = command === undefined ? undefined : await startCommand(command, description, ctx);
        const job = started?.job ?? (background_job_id as JobId);
        const head = started === undefined ? '' : `${started.text}\n`;
        const id = registry.nextId(sessionId, ctx.events());
        const watched = registry.monitor(sessionId, { id, job, pattern: regex, toolUseId: ctx.toolUseId ?? `toolu_gcode_${id}`, timeoutMs: timeout_s * 1000, ownsJob: started !== undefined });
        if (watched.kind === 'matched') return withApproval(`${head}${job} already printed a matching line, so nothing was set up to wait for:\n${watched.line}`, started?.approval);
        if (watched.kind === 'ended') return withApproval(`${head}${job} already ended, so nothing was set up to wait for. Read its output with bash_output.`, started?.approval);
        return withApproval(
          `${head}Monitoring ${job} for /${pattern}/ as ${id}, for up to ${timeout_s}s. End your turn now: Geno wakes you with the line when one matches, or when ${job} ends.`,
          started?.approval,
        );
      },
    }),
    schedule_wakeup: executor({
      input: z.strictObject({ delay_s: z.number().int().min(SCHEDULE_MIN_S).max(SCHEDULE_MAX_S), reason: z.string().trim().min(1) }),
      describe: ({ delay_s, reason }) => `schedule_wakeup in ${delay_s}s: ${reason}`,
      async run({ delay_s, reason }, ctx) {
        const { registry, sessionId, waiter } = own();
        if (ctx.logNote === undefined) throw new ToolError('a wake-up can be scheduled only inside an agent run');
        const id = registry.nextId(sessionId, ctx.events());
        const dueAt = Date.now() + delay_s * 1000;
        const note: Extract<WakeNote, { kind: 'scheduled' }> = { kind: 'scheduled', id, toolUseId: ctx.toolUseId ?? `toolu_gcode_${id}`, dueAt, reason, by: waiter };
        await ctx.logNote({ kind: 'wake', at: new Date().toISOString(), note });
        registry.schedule(sessionId, note);
        return `Scheduled wake-up ${id} for ${new Date(dueAt).toISOString()}, ${delay_s}s from now. End your turn now: Geno wakes you then with: ${reason}`;
      },
    }),
  };
}
