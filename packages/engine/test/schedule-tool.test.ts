import { describe, expect, it } from 'vitest';
import type { ApprovalMode, ScheduledTask } from '@g-code/core';
import type { ToolContext } from '../src/tools/context.js';
import { scheduleExecutor, type ScheduleTools } from '../src/tools/schedule.js';

const T0 = Date.parse('2026-10-07T08:00:00Z');
const PLAN_REFUSAL = 'is not available: Plan mode is read-only; switch to Ask or Auto to make changes. Do not retry it.';

/** Tools that record every call that would change a task, over a workspace with none. */
function recording() {
  const changed: string[] = [];
  const tools: ScheduleTools = {
    list: async () => [],
    create: async (draft) => (changed.push('create'), { id: 'sch_000001', ...draft } as unknown as ScheduledTask),
    update: async (id) => (changed.push(`update ${id}`), {} as ScheduledTask),
    remove: async (id) => (changed.push(`remove ${id}`), {} as ScheduledTask),
    approve: async () => (changed.push('asked'), 'allow'),
    now: () => T0,
    zone: () => 'UTC',
  };
  return { tools, changed };
}

const ctx = { signal: new AbortController().signal, events: () => [] } as unknown as ToolContext;
const run = (mode: ApprovalMode, raw: unknown) => {
  const { tools, changed } = recording();
  const reply = scheduleExecutor(tools, () => mode)
    .run(raw, ctx)
    .then(
      (ok) => (typeof ok === 'string' ? ok : ok.text),
      (error: unknown) => `refused: ${(error as Error).message}`,
    );
  return reply.then((text) => ({ text, changed }));
};

describe('schedule_task in Plan', () => {
  it('lists, and refuses each change before it looks the task up or asks', async () => {
    expect(await run('plan', { action: 'list' })).toEqual({ text: 'No scheduled tasks in this workspace.', changed: [] });
    expect(await run('plan', { action: 'create', prompt: '/review', when: 'in 1h' })).toEqual({ text: `refused: schedule_task create ${PLAN_REFUSAL}`, changed: [] });
    expect(await run('plan', { action: 'update', id: 'sch_ffffff', paused: true }), 'an unknown id is refused as Plan, not looked up').toEqual({ text: `refused: schedule_task update ${PLAN_REFUSAL}`, changed: [] });
    expect(await run('plan', { action: 'delete', id: 'sch_ffffff' })).toEqual({ text: `refused: schedule_task delete ${PLAN_REFUSAL}`, changed: [] });
  });

  it('answers malformed input with what to fix and changes nothing', async () => {
    for (const raw of [{}, { action: 'LIST' }, { action: 'create' }, { action: 'create', prompt: '/review', when: 'someday' }, { action: 'delete' }, { action: 'delete', id: '' }, { action: ['list', 'list'] }, 'list', null]) {
      const { text, changed } = await run('plan', raw);
      expect(text, JSON.stringify(raw)).toMatch(/^refused: /);
      expect(text, JSON.stringify(raw)).not.toContain(PLAN_REFUSAL.slice(0, 20));
      expect(changed, JSON.stringify(raw)).toEqual([]);
    }
  });

  it('refuses a change the user allowed on its card while the session switched to Plan, and keeps "Allow for this chat"', async () => {
    for (const answer of ['allow', 'allow-session'] as const) {
      const { tools, changed } = recording();
      let mode: ApprovalMode = 'ask';
      const executor = scheduleExecutor({ ...tools, approve: async () => ((mode = 'plan'), answer) }, () => mode);
      const reply = await executor.run({ action: 'create', prompt: '/review', when: 'in 1h' }, ctx).then(
        (ok) => ok,
        (error: unknown) => ({ text: (error as Error).message }),
      );
      expect(reply, answer).toEqual({
        text: `schedule_task create ${PLAN_REFUSAL}`,
        ...(answer === 'allow-session' ? { status: 'error', allows: [{ kind: 'schedule' }] } : {}),
      });
      expect(changed, answer).toEqual([]);
    }
  });

  it('makes the change in Ask, after asking', async () => {
    expect(await run('ask', { action: 'create', prompt: '/review', when: 'in 1h' })).toMatchObject({ changed: ['asked', 'create'] });
  });
});
