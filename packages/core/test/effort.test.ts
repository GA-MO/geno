import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  asSessionId,
  buildRequest,
  checkHeadline,
  commandStatusLine,
  EFFORT_POLICIES,
  EFFORTS,
  effortFor,
  reportsFailure,
  sessionEffortOf,
  SYSTEM_PROMPT,
  turnKindOf,
  withTurnEffort,
  type Effort,
  type EffortPolicy,
  type Session,
  type ToolStatus,
  type TurnEvent,
} from '../src/index.js';

const session: Session = { id: asSessionId('s1'), createdAt: '2026-10-06T00:00:00.000Z', workspace: '/tmp/ws', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' };
const at = '2026-10-06T00:00:01.000Z';
const start: TurnEvent = { kind: 'session-start', session };
const user = (seq: number): TurnEvent => ({ kind: 'user', seq, at, content: 'fix the counter' });
const bash = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'bash', input: { command: 'npx tsc --noEmit' }, caller: { type: 'direct' } });
const assistant = (seq: number, content: ContentBlock[], stopReason: 'tool_use' | 'end_turn' | 'pause_turn' = 'tool_use'): TurnEvent => ({
  kind: 'assistant',
  seq,
  at,
  content,
  stopReason,
  usage: { input: 10, cacheRead: 2000, cacheWrite: 300, output: 50 },
  costUsd: 0.001,
  latencyMs: 1,
  model: 'qwen3.8-flash',
});
const result = (seq: number, toolUseId: string, output: string, status: ToolStatus = 'ok'): TurnEvent => ({ kind: 'tool-result', seq, at, toolUseId, name: 'bash', status, output });
const checkpoint = (seq: number): TurnEvent => ({ kind: 'checkpoint', seq, at, sessionId: asSessionId('s1'), turnSeq: seq + 1, sha: 'abc', files: [], label: 'before' });

const afterPrompt: TurnEvent[] = [start, user(1), checkpoint(2)];
const afterTools: TurnEvent[] = [start, user(1), assistant(2, [bash('t1'), bash('t2')]), result(3, 't1', 'ok\n[exit code 0]'), result(4, 't2', 'a.ts\n[exit code 0]')];
const afterFailure: TurnEvent[] = [start, user(1), assistant(2, [bash('t1'), bash('t2')]), result(3, 't1', 'ok\n[exit code 0]'), result(4, 't2', 'a.ts(3,1): error TS2322\n[exit code 2]')];

const STEPPED: EffortPolicy = { prompt: 0, 'after-tools': -1, 'after-failure': 0 };

describe('turnKindOf', () => {
  it('names the first call of a prompt, even past a checkpoint logged before it', () => {
    expect(turnKindOf(afterPrompt)).toBe('prompt');
  });

  it('names a follow-up after tool results that all succeeded', () => {
    expect(turnKindOf(afterTools)).toBe('after-tools');
  });

  it('names a follow-up after any result of the batch failed, wherever it sits in the batch', () => {
    expect(turnKindOf(afterFailure)).toBe('after-failure');
    const failedFirst: TurnEvent[] = [start, user(1), assistant(2, [bash('t1'), bash('t2')]), result(3, 't1', '[exit code 1]'), result(4, 't2', '[exit code 0]')];
    expect(turnKindOf(failedFirst)).toBe('after-failure');
  });

  it('counts an errored or denied tool as a failure', () => {
    for (const status of ['error', 'denied'] as const) {
      expect(turnKindOf([start, user(1), assistant(2, [bash('t1')]), result(3, 't1', 'refused', status)])).toBe('after-failure');
    }
  });

  it('looks only at the newest batch, so an older failure the model already saw does not count', () => {
    const recovered: TurnEvent[] = [...afterFailure, assistant(5, [bash('t3')]), result(6, 't3', '[exit code 0]')];
    expect(turnKindOf(recovered)).toBe('after-tools');
  });

  it('names a continuation after a paused turn as a follow-up', () => {
    expect(turnKindOf([start, user(1), assistant(2, [], 'pause_turn')])).toBe('after-tools');
  });

  it('names a new prompt after a finished answer as a prompt', () => {
    expect(turnKindOf([...afterTools, assistant(5, [], 'end_turn'), user(6)])).toBe('prompt');
  });

  it('reads a spilled result by its tail and head', () => {
    const spilled = (head: string, tail: string): TurnEvent => ({ kind: 'tool-result', seq: 3, at, toolUseId: 't1', name: 'bash', status: 'ok', spill: { path: '/s', bytes: 9000, head, tail } });
    expect(turnKindOf([start, user(1), assistant(2, [bash('t1')]), spilled('lots', 'more\n[exit code 1]')])).toBe('after-failure');
    expect(turnKindOf([start, user(1), assistant(2, [bash('t1')]), spilled('Edited a.ts.\n\ncheck `tsc` failed (exit 2)', 'x')])).toBe('after-failure');
    expect(turnKindOf([start, user(1), assistant(2, [bash('t1')]), spilled('lots', 'more\n[exit code 0]')])).toBe('after-tools');
  });
});

describe('reportsFailure', () => {
  it('recognises the status line bash writes, and only a failing one', () => {
    expect(reportsFailure(`out\n${commandStatusLine(0, undefined)}`)).toBe(false);
    expect(reportsFailure(`out\n${commandStatusLine(1, undefined)}`)).toBe(true);
    expect(reportsFailure(`out\n${commandStatusLine(null, undefined)}`)).toBe(true);
    expect(reportsFailure(`out\n${commandStatusLine(null, 30)}`)).toBe(true);
  });

  it('recognises the headline a check writes, alone or after an edit, and only a failing one', () => {
    expect(reportsFailure(checkHeadline('npx tsc --noEmit', 0, false))).toBe(false);
    expect(reportsFailure(`Edited a.ts.\n\n${checkHeadline('npx tsc --noEmit', 0, false)}`)).toBe(false);
    expect(reportsFailure(`Edited a.ts.\n\n${checkHeadline('npx tsc --noEmit', 2, false)}\na.ts(1,1): error`)).toBe(true);
    expect(reportsFailure(checkHeadline('pnpm test', null, true))).toBe(true);
  });

  it('ignores plain output', () => {
    expect(reportsFailure('Edited a.ts.')).toBe(false);
    expect(reportsFailure('exit code 1 appears mid-sentence here')).toBe(false);
  });
});

describe('effortFor', () => {
  it('keeps the session effort for a step of zero', () => {
    for (const base of EFFORTS) expect(effortFor(base, 0)).toBe(base);
  });

  it('steps down from the session effort and stops at the lowest level', () => {
    const steppedDown: Record<Effort, Effort> = { low: 'low', medium: 'low', high: 'medium', xhigh: 'high', max: 'xhigh' };
    for (const base of EFFORTS) expect(effortFor(base, -1)).toBe(steppedDown[base]);
    expect(effortFor('high', -2)).toBe('low');
  });
});

describe('the effort policy table', () => {
  it('has a flat policy that is today: every turn at the session effort', () => {
    expect(EFFORT_POLICIES.flat).toEqual({ prompt: 0, 'after-tools': 0, 'after-failure': 0 });
  });

  it('never raises a turn above the session effort under any shipped policy', () => {
    for (const policy of Object.values(EFFORT_POLICIES)) {
      for (const base of EFFORTS) {
        for (const step of Object.values(policy)) expect(EFFORTS.indexOf(effortFor(base, step))).toBeLessThanOrEqual(EFFORTS.indexOf(base));
      }
    }
  });

  it('gives the turn the effort its kind looks up', () => {
    expect(withTurnEffort(session, afterPrompt, STEPPED).effort).toBe('medium');
    expect(withTurnEffort(session, afterTools, STEPPED).effort).toBe('low');
    expect(withTurnEffort(session, afterFailure, STEPPED).effort).toBe('medium');
  });

  it('steps from the newest effort the user set during the session, not the one it started with', () => {
    const set = (seq: number, effort: Effort): TurnEvent => ({ kind: 'effort', seq, at, effort });
    const events: TurnEvent[] = [start, set(1, 'low'), set(2, 'max'), user(3), assistant(4, [bash('t1')]), result(5, 't1', '[exit code 0]')];
    expect(sessionEffortOf(session, events)).toBe('max');
    expect(sessionEffortOf(session, [start])).toBe('medium');
    expect(withTurnEffort(session, events.slice(0, 4), STEPPED).effort).toBe('max');
    expect(withTurnEffort(session, events, STEPPED).effort).toBe('xhigh');
    expect(turnKindOf([...events, set(6, 'low')])).toBe('after-tools');
  });

  it('under the flat policy builds the very request it built before the table existed', () => {
    for (const events of [afterPrompt, afterTools, afterFailure]) {
      expect(JSON.stringify(buildRequest(withTurnEffort(session, events, EFFORT_POLICIES.flat), events))).toBe(JSON.stringify(buildRequest(session, events)));
    }
  });
});

describe('request bytes under a stepped policy', () => {
  const tools = [{ name: 'bash', description: 'Run a command.', input_schema: { type: 'object' as const, properties: {} } }];
  const bytes = (events: readonly TurnEvent[], policy: EffortPolicy) => {
    const { output_config, ...rest } = buildRequest(withTurnEffort(session, events, policy), events, tools);
    return { output_config, rest: JSON.stringify(rest), system: JSON.stringify(rest.system), tools: JSON.stringify(rest.tools) };
  };

  it('changes only output_config: the system prompt, tools and messages, the cached prefix, stay byte-identical', () => {
    const flat = bytes(afterTools, EFFORT_POLICIES.flat);
    const stepped = bytes(afterTools, STEPPED);
    expect(flat.output_config).toEqual({ effort: 'medium' });
    expect(stepped.output_config).toEqual({ effort: 'low' });
    expect(stepped.rest).toBe(flat.rest);
    expect(stepped.system).toBe(JSON.stringify([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]));
  });

  it('keeps the tools and system prompt of one turn byte-identical in the next, across a change of effort', () => {
    const first = buildRequest(withTurnEffort(session, afterPrompt, STEPPED), afterPrompt, tools);
    const next = buildRequest(withTurnEffort(session, afterTools, STEPPED), afterTools, tools);
    expect([first.output_config, next.output_config]).toEqual([{ effort: 'medium' }, { effort: 'low' }]);
    expect(JSON.stringify(next.tools)).toBe(JSON.stringify(first.tools));
    expect(JSON.stringify(next.system)).toBe(JSON.stringify(first.system));
  });
});
