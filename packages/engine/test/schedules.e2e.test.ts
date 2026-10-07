import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  localZone,
  nextOccurrence,
  SCHEDULE_ACT_METHOD,
  SCHEDULED_RUN_NOTE,
  SCHEDULES_CAPABILITY,
  SCHEDULES_METHOD,
  SCHEDULES_UPDATE_METHOD,
  TASK_UPDATE_METHOD,
  TASKS_CAPABILITY,
  type ScheduleRun,
  type SchedulesResponse,
  type ScheduleView,
  type TaskUpdate,
  type TurnEvent,
} from '@g-code/core';
import type { Io } from '../src/command.js';
import { scheduleFile, type Clock } from '../src/schedules.js';
import { engineShared, gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore, type Store } from '../src/store.js';
import { answer, fakeTransport, httpError, loadTools, offeredTools, toolCall, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 15_000 });

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const LIMITS = { maxTurns: 10, maxCostUsd: 1 };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Wednesday 7 October 2026, 08:00 UTC: far from any clock change in the zones the tests run in.
const T0 = Date.parse('2026-10-07T08:00:00Z');

/** A clock the test moves by hand; a move fires every timer it passes, in order, and a timer already due fires at once. */
class FakeClock implements Clock {
  private readonly timers = new Set<{ readonly at: number; readonly run: () => void }>();
  constructor(private t: number) {}
  now = () => this.t;
  setTimer = (run: () => void, ms: number) => {
    if (ms <= 0) {
      const due = setImmediate(run);
      return () => clearImmediate(due);
    }
    const timer = { at: this.t + ms, run };
    this.timers.add(timer);
    return () => void this.timers.delete(timer);
  };
  /** Whether a look armed its timer, so a move cannot pass a look still reading the file. */
  armed(): boolean {
    return this.timers.size > 0;
  }
  advance(ms: number): void {
    this.t += ms;
    for (const timer of [...this.timers].filter((x) => x.at <= this.t).toSorted((a, b) => a.at - b.at)) {
      this.timers.delete(timer);
      timer.run();
    }
  }
}

async function until(done: () => boolean | Promise<boolean>, step: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${step}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type Body = { readonly system?: unknown; readonly tools?: readonly { readonly name: string; readonly description?: string }[]; readonly messages: { readonly role: string; readonly content: unknown }[] };
type Script = (n: number, body: Body) => Reply | Promise<Reply>;

/** One scripted model per conversation, picked by a marker in its first message. A request for no marker is recorded, never answered. */
function models(scripts: Readonly<Record<string, Script>>) {
  const requests = new Map<string, Body[]>(Object.keys(scripts).map((marker) => [marker, []]));
  const strays: Body[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    const marker = Object.keys(scripts).find((m) => JSON.stringify(body.messages[0]).includes(m));
    if (marker === undefined) {
      strays.push(body);
      throw new Error('no fake model for this request');
    }
    const seen = requests.get(marker)!;
    seen.push(body);
    return fakeTransport([await scripts[marker]!(seen.length - 1, body)]).fetch(input, init);
  };
  return { fetch, requests: (marker: string) => requests.get(marker)!, strays };
}

async function fixture() {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const alpha = 1;\n' } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = {
    GCODE_HOME: home,
    HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-fake',
    DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  return { workspace, env, store: openStore(env) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

type Heard = { readonly updates: acp.SessionNotification[]; readonly tasks: TaskUpdate[]; readonly schedules: SchedulesResponse[]; readonly permissions: acp.RequestPermissionRequest[] };

type Window = {
  readonly ctx: acp.ClientContext;
  readonly sessionId: string;
  prompt(text: string): Promise<acp.PromptResponse>;
  /** What the engine said back to the window's session since the last call. */
  said(): string;
  list(): Promise<SchedulesResponse>;
  act(id: string, action: 'run' | 'pause' | 'resume' | 'delete'): Promise<SchedulesResponse>;
};

/**
 * An engine for the fixture's folder, on `clock`, and one editor window that shows Tasks and scheduled tasks, with
 * `scenario` run while it stays connected. `answers` picks each permission card's option, in order.
 */
async function serve<T>(at: Fixture, clock: FakeClock, fetch: typeof globalThis.fetch, scenario: (window: Window, heard: Heard) => Promise<T>, answers: string[] = []): Promise<{ result: T; heard: Heard }> {
  const io: Io = { env: at.env, cwd: at.workspace, out: () => {}, err: (line) => void (process.env['GCODE_TEST_LOG'] && console.error(line)), write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch };
  const heard: Heard = { updates: [], tasks: [], schedules: [], permissions: [] };
  const client = acp
    .client({ name: 'test-editor' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      heard.permissions.push(params);
      return { outcome: { outcome: 'selected', optionId: answers.shift() ?? params.options.find((o) => o.kind === 'allow_once')!.optionId } };
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => void heard.updates.push(params))
    .onNotification(TASK_UPDATE_METHOD, (raw) => raw as TaskUpdate, ({ params }) => void heard.tasks.push(params))
    .onNotification(SCHEDULES_UPDATE_METHOD, (raw) => raw as SchedulesResponse, ({ params }) => void heard.schedules.push(params));
  const shared = engineShared(io, { clock });
  const result = await client.connectWith(gcodeAgent(io, at.store, LIMITS, undefined, shared), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { _meta: { [TASKS_CAPABILITY]: true, [SCHEDULES_CAPABILITY]: true } },
    });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: at.workspace, mcpServers: [] });
    let read = 0;
    const window: Window = {
      ctx,
      sessionId,
      prompt: (text) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] }),
      said() {
        const text = heard.updates
          .slice(read)
          .flatMap(({ sessionId: id, update }) => (id === sessionId && update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []))
          .join('');
        read = heard.updates.length;
        return text;
      },
      list: () => ctx.request<SchedulesResponse>(SCHEDULES_METHOD, { cwd: at.workspace }),
      act: (id, action) => ctx.request<SchedulesResponse>(SCHEDULE_ACT_METHOD, { cwd: at.workspace, id, action }),
    };
    const outcome = await scenario(window, heard);
    await shared.jobs.kill('engine-exit', 'all');
    return outcome;
  });
  return { result, heard };
}

const logOf = async (store: Store, sessionId: string): Promise<TurnEvent[]> => [...(await readSessionLog(sessionFile(store, sessionId as never))).events];
const ranOf = (task: ScheduleView | undefined) => (task?.runs ?? []).filter((r): r is Extract<ScheduleRun, { kind: 'ran' }> => r.kind === 'ran');
const named = (list: SchedulesResponse, title: string) => list.tasks.find((t) => t.title === title);
const ended = async (window: Window, title: string) => ranOf(named(await window.list(), title)).at(-1)?.end != null;

describe('gcode serve: scheduled tasks', () => {
  it('runs a task made with /schedule when it comes due, read-only in a session of its own, listed in Tasks', async () => {
    const at = await fixture();
    const clock = new FakeClock(T0);
    const model = models({ '[sched-a]': () => answer('The repository holds a.ts, which exports alpha.', usage) });
    const { result, heard } = await serve(at, clock, model.fetch, async (window) => {
      const reply = await window.prompt('/schedule in 1h [sched-a] summarize the repository');
      const said = window.said();
      const before = await window.list();
      await until(() => clock.armed(), 'the scheduler to arm its timer');
      clock.advance(HOUR - MINUTE);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const early = model.requests('[sched-a]').length;
      clock.advance(MINUTE);
      await until(() => ended(window, '[sched-a] summarize the repository'), 'the run to end');
      return { reply, said, before, early, after: await window.list() };
    });

    expect(result.reply.stopReason).toBe('end_turn');
    expect(result.said).toMatch(/^Scheduled sch_[0-9a-f]{6} "\[sched-a\] summarize the repository": Once, .* read-only, up to \$0\.05 and 20 model calls a run\. It is in Tasks under Scheduled/);
    expect(result.before.tasks).toHaveLength(1);
    const made = result.before.tasks[0]!;
    expect(made).toMatchObject({ edits: false, paused: false, createdBy: { kind: 'user' }, budget: { maxCostUsd: 0.05, maxTurns: 20 }, nextAt: T0 + HOUR, runs: [] });
    expect(result.early, 'nothing runs before it is due').toBe(0);
    expect(model.requests('[sched-a]'), 'one model call for the one run').toHaveLength(1);

    const task = result.after.tasks[0]!;
    const [run] = ranOf(task);
    expect(run).toMatchObject({ dueAt: T0 + HOUR, trigger: 'schedule', workspace: at.workspace, lane: null, by: process.pid, end: { kind: 'done', costUsd: expect.any(Number) } });
    expect(task.nextAt, 'a one-shot task has no run left').toBeNull();

    const events = await logOf(at.store, run!.sessionId);
    expect(events.find((e) => e.kind === 'mode')).toMatchObject({ mode: 'plan' });
    expect(events.find((e) => e.kind === 'user')).toMatchObject({ content: '[sched-a] summarize the repository' });
    const body = model.requests('[sched-a]')[0]!;
    expect(JSON.stringify(body.system)).toContain(SCHEDULED_RUN_NOTE);
    expect(JSON.stringify(body.system)).toContain('You are in Plan mode');
    expect(offeredTools(body), 'read-only, and a run schedules nothing itself').not.toContain('edit');
    expect(offeredTools(body)).not.toContain('schedule_task');
    expect(offeredTools(body)).not.toContain('ask_user');

    const runTask = heard.tasks.filter((u) => u.task.sessionId === run!.sessionId);
    expect(runTask[0]?.task).toMatchObject({ title: '[sched-a] summarize the repository', status: 'running', lane: null });
    expect(runTask.at(-1), 'the run ends with the usual notice').toMatchObject({ task: { status: 'done' }, notice: 'done' });
    expect(heard.schedules.at(-1)?.tasks[0]?.runs.at(-1)).toMatchObject({ kind: 'ran', end: { kind: 'done' } });
  });

  it('stops a run at its budget: the turn limit, or the cost', async () => {
    const at = await fixture();
    const clock = new FakeClock(T0);
    const big = { input: 200_000, cacheRead: 0, cacheWrite: 0 };
    let reads = 0;
    const read = () => ({ id: `tu_r${reads++}`, name: 'read', input: { path: 'a.ts' } });
    const model = models({
      '[sched-turns]': () => toolCall('Reading again.', [read()], usage),
      '[sched-cost]': () => toolCall('Reading again.', [read()], big),
    });
    const { result } = await serve(at, clock, model.fetch, async (window) => {
      await window.prompt('/schedule in 1h --max-turns 3 [sched-turns] read a.ts until told to stop');
      await window.prompt('/schedule in 1h --max-cost 0.05 [sched-cost] read a.ts until told to stop');
      await until(() => clock.armed(), 'the scheduler to arm its timer');
      clock.advance(HOUR);
      await until(async () => (await window.list()).tasks.every((t) => ranOf(t).at(-1)?.end != null), 'both runs to end');
      return window.list();
    });

    expect(model.requests('[sched-turns]'), 'three model calls, as many as the budget allows').toHaveLength(3);
    expect(ranOf(named(result, '[sched-turns] read a.ts until told to stop'))[0]?.end).toMatchObject({ kind: 'max-turns', message: expect.stringContaining('stopped after 3 model calls') });
    // Each call costs about $0.03, so the second passes $0.05 and nothing follows it.
    expect(model.requests('[sched-cost]')).toHaveLength(2);
    const costEnd = ranOf(named(result, '[sched-cost] read a.ts until told to stop'))[0]?.end;
    expect(costEnd).toMatchObject({ kind: 'budget', message: expect.stringContaining('past --max-cost 0.05') });
    expect(costEnd?.costUsd).toBeGreaterThan(0.05);
    expect(costEnd?.costUsd).toBeLessThan(0.08);
  });

  it('ends a run failed when the model refused, stopped at its output limit, or answered a call with an error', async () => {
    const at = await fixture();
    const clock = new FakeClock(T0);
    const model = models({
      '[sched-refuse]': () => answer('I will not.', usage, { stopReason: 'refusal' }),
      '[sched-long]': () => answer('And then', usage, { stopReason: 'max_tokens' }),
      '[sched-400]': () => httpError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: unexpected tool_use_id' } }),
    });
    const TITLES = ['[sched-refuse] say no', '[sched-long] write at length', '[sched-400] send a bad request'];
    const { result } = await serve(at, clock, model.fetch, async (window) => {
      for (const title of TITLES) await window.prompt(`/schedule in 1h ${title}`);
      await until(() => clock.armed(), 'the scheduler to arm its timer');
      clock.advance(HOUR);
      await until(async () => (await window.list()).tasks.every((t) => ranOf(t).at(-1)?.end != null), 'the runs to end');
      return window.list();
    });
    expect(TITLES.map((title) => ranOf(named(result, title))[0]?.end?.kind)).toEqual(['failed', 'failed', 'failed']);
  });

  it('runs a missed run once when the engine starts within the grace window, and records one past it as missed', async () => {
    const at = await fixture();
    const zone = localZone();
    const first = new FakeClock(T0);
    const offline = models({});
    await serve(at, first, offline.fetch, async (window) => {
      await window.prompt('/schedule in 1h [sched-late] check the build');
      await window.prompt('/schedule in 3h [sched-soon] check the deploy');
      await window.prompt('/schedule cron "*/30 * * * *" [sched-often] look at the queue');
    });
    // The engine is gone for three hours and ten minutes; then a new one starts on the same home.
    const restart = T0 + 3 * HOUR + 10 * MINUTE;
    const second = new FakeClock(restart);
    const model = models({
      '[sched-soon]': () => answer('The deploy is fine.', usage),
      '[sched-often]': () => answer('The queue is empty.', usage),
    });
    const { result } = await serve(at, second, model.fetch, async (window) => {
      await until(async () => {
        const list = await window.list();
        return ['[sched-soon] check the deploy', '[sched-often] look at the queue'].every((title) => ranOf(named(list, title)).at(-1)?.end != null);
      }, 'the catch-up runs to end');
      return window.list();
    });

    const late = named(result, '[sched-late] check the build')!;
    expect(late.runs, 'past the grace window: recorded, not run').toEqual([{ kind: 'missed', at: restart, from: T0 + HOUR, to: T0 + HOUR, count: 1, why: 'off' }]);
    expect(offline.strays.length + model.strays.length).toBe(0);

    const soon = named(result, '[sched-soon] check the deploy')!;
    expect(soon.runs).toEqual([expect.objectContaining({ kind: 'ran', dueAt: T0 + 3 * HOUR, trigger: 'catch-up', end: expect.objectContaining({ kind: 'done' }) })]);
    expect(model.requests('[sched-soon]')).toHaveLength(1);

    const often = named(result, '[sched-often] look at the queue')!;
    const latest = [...Array(8).keys()].reduce<number>((due, i) => {
      const next = nextOccurrence(often.when, due, zone)!;
      return next <= restart ? next : due;
    }, T0);
    expect(model.requests('[sched-often]'), 'six runs were due; one runs').toHaveLength(1);
    expect(often.runs).toEqual([
      expect.objectContaining({ kind: 'missed', count: 5, why: 'off' }),
      expect.objectContaining({ kind: 'ran', dueAt: latest, trigger: 'catch-up' }),
    ]);
    expect(often.nextAt).toBe(nextOccurrence(often.when, latest, zone));
  });

  it('ends a run that an engine which is gone left open, and takes over its lock, so the task runs again when next due', async () => {
    const at = await fixture();
    const first = new FakeClock(T0);
    await serve(at, first, models({}).fetch, async (window) => {
      await window.prompt('/schedule cron "*/30 * * * *" [sched-left] look at the queue');
      await until(() => first.armed(), 'the first engine to finish its look');
    });
    // The engine died during the 08:30 run: the file holds it open, by a pid that no longer runs, and that engine's lock.
    const gone = spawnSync('true').pid;
    const file = scheduleFile(at.env.GCODE_HOME, at.workspace);
    const saved = JSON.parse(await readFile(file, 'utf8')) as { tasks: { since: number; runs: unknown[] }[] };
    const open = { kind: 'ran', dueAt: T0 + 30 * MINUTE, trigger: 'schedule', startedAt: T0 + 30 * MINUTE, sessionId: 'sess-gone', workspace: at.workspace, lane: null, by: gone, end: null };
    saved.tasks[0]!.since = T0 + 30 * MINUTE;
    saved.tasks[0]!.runs = [open];
    await writeFile(file, JSON.stringify(saved));
    await writeFile(`${file}.lock`, String(gone));

    const restart = T0 + 65 * MINUTE;
    const model = models({ '[sched-left]': () => answer('The queue is empty.', usage) });
    const { result } = await serve(at, new FakeClock(restart), model.fetch, async (window) => {
      await until(async () => ranOf(named(await window.list(), '[sched-left] look at the queue')).length === 2 && (await ended(window, '[sched-left] look at the queue')), 'the next run ends');
      return window.list();
    });

    expect(ranOf(named(result, '[sched-left] look at the queue'))).toEqual([
      { ...open, end: { kind: 'failed', at: restart, costUsd: null, message: 'Geno stopped before the run ended' } },
      expect.objectContaining({ dueAt: T0 + 60 * MINUTE, trigger: 'catch-up', by: process.pid, end: expect.objectContaining({ kind: 'done' }) }),
    ]);
    expect(model.requests('[sched-left]')).toHaveLength(1);
  });

  it('starts a due run once when two engines keep the same workspace\'s tasks, as a main checkout\'s window and a lane\'s do', async () => {
    const at = await fixture();
    const first = new FakeClock(T0);
    const second = new FakeClock(T0);
    const model = models({ '[sched-two]': () => answer('The queue is empty.', usage) });
    const { result } = await serve(at, first, model.fetch, async (window) => {
      await window.prompt('/schedule in 1h [sched-two] look at the queue');
      return (
        await serve(at, second, model.fetch, async (other) => {
          await until(() => first.armed() && second.armed(), 'both engines to arm their timers');
          first.advance(HOUR);
          second.advance(HOUR);
          await until(() => ended(other, '[sched-two] look at the queue'), 'the run to end');
          await new Promise((resolve) => setTimeout(resolve, 300));
          return other.list();
        })
      ).result;
    });

    expect(model.requests('[sched-two]'), 'one run, not one per engine').toHaveLength(1);
    expect(ranOf(named(result, '[sched-two] look at the queue'))).toHaveLength(1);
  });

  it('runs a task another engine added, once that engine is gone', async () => {
    const at = await fixture();
    const lane = new FakeClock(T0);
    const main = new FakeClock(T0);
    const model = models({ '[sched-added]': () => answer('The queue is empty.', usage) });
    const { result } = await serve(at, lane, model.fetch, async (window) => {
      await until(() => lane.armed(), 'the lane window\'s engine to look');
      await serve(at, main, model.fetch, async (other) => {
        await other.prompt('/schedule in 1h [sched-added] look at the queue');
        await until(() => main.armed(), 'the main window\'s engine to finish its look');
      });
      lane.advance(MINUTE);
      await until(async () => (await window.list()).tasks.length === 1 && lane.armed(), 'the lane window\'s engine to look again');
      lane.advance(HOUR);
      await until(() => ended(window, '[sched-added] look at the queue'), 'the run to end');
      return window.list();
    });

    expect(model.requests('[sched-added]')).toHaveLength(1);
    expect(ranOf(named(result, '[sched-added] look at the queue'))).toEqual([expect.objectContaining({ dueAt: T0 + HOUR, end: expect.objectContaining({ kind: 'done' }) })]);
  });

  it('looks at a workspace with no scheduled tasks without writing anything to the app home, at connect and each minute after', async () => {
    const at = await fixture();
    const dir = path.dirname(scheduleFile(at.env.GCODE_HOME, at.workspace));
    const clock = new FakeClock(T0);
    const seen = new Set<string>();
    const now = clock.now;
    clock.now = () => {
      if (existsSync(dir)) for (const name of readdirSync(dir)) seen.add(name);
      return now();
    };
    const { result } = await serve(at, clock, models({}).fetch, async () => {
      await until(() => clock.armed(), 'the look at connect');
      const atConnect = existsSync(dir);
      clock.advance(MINUTE);
      await until(() => clock.armed(), 'the look a minute later');
      return { atConnect, aMinuteLater: existsSync(dir) };
    });

    expect(result, 'no schedules folder appears').toEqual({ atConnect: false, aMinuteLater: false });
    expect([...seen], 'no lock file exists while a look reads the clock').toEqual([]);
  });

  it('asks the user before the model schedules anything, never the classifier, and takes "Allow for this chat" for the rest', async () => {
    const at = await fixture();
    const clock = new FakeClock(T0);
    const create = (id: string, prompt: string) => ({ id, name: 'schedule_task', input: { action: 'create', title: 'Review main', prompt, when: 'weekdays at 9:00' } });
    const model = models({
      '[chat]': (n, body) => {
        if (n === 0) return toolCall('Loading the tool.', [loadTools('schedule_task')], usage);
        if (n === 1) return toolCall('Scheduling it.', [create('tu_c1', '/review main')], usage);
        if (n === 2) return toolCall('Asking again.', [create('tu_c2', '/review main')], usage);
        if (n === 3) {
          const created = /Scheduled (sch_[0-9a-f]{6})/.exec(JSON.stringify(body.messages.at(-1)))![1]!;
          return toolCall('Pausing it.', [{ id: 'tu_p', name: 'schedule_task', input: { action: 'update', id: created, paused: true } }, { id: 'tu_l', name: 'schedule_task', input: { action: 'list' } }], usage);
        }
        return answer('Done: Review main is scheduled and paused.', usage);
      },
    });
    const { result, heard } = await serve(
      at,
      clock,
      model.fetch,
      async (window) => {
        await window.ctx.request(acp.methods.agent.session.setMode, { sessionId: window.sessionId, modeId: 'auto' });
        await window.prompt('[chat] review main every weekday at 9');
        return { list: await window.list(), sessionId: window.sessionId };
      },
      ['reject', 'allow-session'],
    );

    const results = (await logOf(at.store, result.sessionId)).filter((e) => e.kind === 'tool-result');
    const textOf = (id: string) => {
      const found = results.find((e) => e.kind === 'tool-result' && e.toolUseId === id);
      return found?.kind === 'tool-result' && 'output' in found ? found.output : '';
    };
    expect(heard.permissions, 'one card per change until the user allowed them for the chat').toHaveLength(2);
    expect(heard.permissions[0]!.toolCall.title).toMatch(/^Schedule "Review main": Weekdays at 09:00 \(next .*\), read-only, up to \$0\.05 and 20 model calls a run\?$/);
    expect(heard.permissions[0]!.options.map((o) => o.optionId)).toEqual(['allow', 'allow-session', 'reject']);
    expect(textOf('tu_c1')).toMatch(/^The user declined/);
    expect(textOf('tu_c2')).toMatch(/^Scheduled sch_/);
    expect(textOf('tu_p')).toMatch(/^Changed sch_.*\(paused\)/);
    expect(textOf('tu_l')).toMatch(/^- sch_[0-9a-f]{6} "Review main": Weekdays at 09:00 \(paused\)/);
    expect(model.strays, 'Auto mode never asked the classifier').toHaveLength(0);
    expect(result.list.tasks).toHaveLength(1);
    expect(result.list.tasks[0]).toMatchObject({ title: 'Review main', paused: true, createdBy: { kind: 'model' }, when: { kind: 'cron', expr: '0 9 * * 1-5' }, nextAt: null });
  });

  it('runs a task now without moving its schedule, and pauses, resumes and deletes it from the Tasks list', async () => {
    const at = await fixture();
    const clock = new FakeClock(T0);
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const model = models({ '[sched-b]': async () => (await released, answer('All quiet.', usage)) });
    const { result } = await serve(at, clock, model.fetch, async (window) => {
      await window.prompt('/schedule in 2h [sched-b] look around');
      const id = (await window.list()).tasks[0]!.id;
      await window.act(id, 'run');
      await until(() => model.requests('[sched-b]').length === 1, 'Run now to call the model');
      const twice = await window.act(id, 'run').then(
        () => 'ran twice',
        (error: unknown) => (error as Error).message,
      );
      release();
      await until(() => ended(window, '[sched-b] look around'), 'Run now to end');
      const afterRun = (await window.list()).tasks[0]!;
      const paused = (await window.act(id, 'pause')).tasks[0]!;
      clock.advance(2 * HOUR + MINUTE);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const whilePaused = model.requests('[sched-b]').length;
      const resumed = (await window.act(id, 'resume')).tasks[0]!;
      const deleted = await window.act(id, 'delete');
      const unknown = await window.act(id, 'run').catch((error: unknown) => (error as Error).message);
      return { afterRun, twice, paused, whilePaused, resumed, deleted, unknown };
    });

    expect(ranOf(result.afterRun)).toEqual([expect.objectContaining({ trigger: 'now', dueAt: T0, end: expect.objectContaining({ kind: 'done' }) })]);
    expect(result.afterRun.nextAt, 'Run now leaves the schedule as it was').toBe(T0 + 2 * HOUR);
    expect(result.twice).toMatch(/sch_[0-9a-f]{6} is running already/);
    expect(result.paused).toMatchObject({ paused: true, nextAt: null });
    expect(result.whilePaused, 'a paused task does not run when due').toBe(1);
    expect(result.resumed, 'a resume does not run what came due while paused').toMatchObject({ paused: false, nextAt: null, since: T0 + 2 * HOUR + MINUTE });
    expect(result.deleted.tasks).toEqual([]);
    expect(result.unknown).toMatch(/no scheduled task sch_[0-9a-f]{6}; this workspace has none/);
  });

  it('runs a task that makes edits in its own lane, in Auto', async () => {
    const at = await fixture();
    const clock = new FakeClock(T0);
    const model = models({ '[sched-e]': () => answer('Nothing to fix.', usage) });
    const { result } = await serve(at, clock, model.fetch, async (window) => {
      await window.prompt('/schedule in 1h --edits [sched-e] fix any lint errors');
      await until(() => clock.armed(), 'the scheduler to arm its timer');
      clock.advance(HOUR);
      await until(() => ended(window, '[sched-e] fix any lint errors'), 'the lane run to end');
      return window.list();
    });

    const [run] = ranOf(result.tasks[0]);
    expect(run?.lane).toMatch(/^sched-e-fix-any-lint-errors/);
    expect(run?.workspace).toBe(path.join(at.workspace, '.geno', 'worktrees', run!.lane!));
    const events = await logOf(at.store, run!.sessionId);
    expect(events.find((e) => e.kind === 'mode')).toMatchObject({ mode: 'auto' });
    expect(offeredTools(model.requests('[sched-e]')[0]!)).toContain('edit');
  });
});
