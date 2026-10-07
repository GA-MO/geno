import { z } from 'zod';
import {
  parseScheduleTask,
  SCHEDULE_TASK_TOOL,
  scheduleListText,
  taskLine,
  updatedTask,
  type ScheduleChange,
  type ScheduleDraft,
  type ScheduledTask,
  type ScheduleToolInput,
} from '@g-code/core';
import { executor, ToolError, type Executor } from './context.js';

/** The workspace's tasks as the scheduler keeps them, and the user's yes to a change, which no mode or classifier gives. */
export type ScheduleTools = {
  readonly list: () => Promise<readonly ScheduledTask[]>;
  readonly create: (draft: ScheduleDraft) => Promise<ScheduledTask>;
  readonly update: (id: string, change: (task: ScheduledTask) => ScheduledTask) => Promise<ScheduledTask>;
  readonly remove: (id: string) => Promise<ScheduledTask>;
  readonly approve: (change: ScheduleChange, signal: AbortSignal) => Promise<boolean>;
  readonly now: () => number;
  readonly zone: () => string;
};

const DECLINED = 'The user declined. Nothing changed; do not propose it again unless they ask.';

function taskNamed(tasks: readonly ScheduledTask[], id: string): ScheduledTask {
  const task = tasks.find((t) => t.id === id);
  if (task !== undefined) return task;
  throw new ToolError(tasks.length === 0 ? `no scheduled task ${id}; this workspace has none` : `no scheduled task ${id}; list them with action list`);
}

const describeInput = (input: ScheduleToolInput): string =>
  input.action === 'create' ? `${SCHEDULE_TASK_TOOL} create ${input.draft.title}` : input.action === 'list' ? `${SCHEDULE_TASK_TOOL} list` : `${SCHEDULE_TASK_TOOL} ${input.action} ${input.id}`;

export function scheduleExecutor(tools: ScheduleTools): Executor {
  const input = z.unknown().transform((raw, ctx) => {
    const parsed = parseScheduleTask(raw, tools.now(), tools.zone());
    if (parsed.ok) return parsed.value;
    ctx.addIssue({ code: 'custom', message: parsed.problem });
    return z.NEVER;
  });
  const line = (task: ScheduledTask) => taskLine(task, tools.zone(), tools.now());
  return executor({
    input,
    describe: describeInput,
    async run(request, ctx) {
      switch (request.action) {
        case 'list':
          return scheduleListText(await tools.list(), tools.zone(), tools.now());
        case 'create': {
          if (!(await tools.approve({ kind: 'create', draft: request.draft }, ctx.signal))) return DECLINED;
          const task = await tools.create(request.draft);
          return `Scheduled ${task.id} ${line(task)}. The user sees it in Tasks under Scheduled, and each run shows there as a session of its own.`;
        }
        case 'update': {
          const task = taskNamed(await tools.list(), request.id);
          const next = updatedTask(task, request, tools.now());
          if (!next.ok) throw new ToolError(next.problem);
          if (!(await tools.approve({ kind: 'update', task, next: next.value }, ctx.signal))) return DECLINED;
          const changed = await tools.update(task.id, (current) => {
            const again = updatedTask(current, request, tools.now());
            if (!again.ok) throw new ToolError(again.problem);
            return again.value;
          });
          return `Changed ${changed.id}: ${line(changed)}.`;
        }
        case 'delete': {
          const task = taskNamed(await tools.list(), request.id);
          if (!(await tools.approve({ kind: 'delete', task }, ctx.signal))) return DECLINED;
          await tools.remove(task.id);
          return `Deleted ${task.id} "${task.title}". Its past runs stay in History.`;
        }
      }
    },
  });
}
