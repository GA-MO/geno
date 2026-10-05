import { describe, expect, it } from 'vitest';
import { asSessionId, inScope, summarizeSession, titleFrom, titleOf, type Session, type SessionSummary, type TurnEvent } from '../src/index.js';

const session: Session = {
  id: asSessionId('s1'),
  createdAt: '2026-10-01T00:00:00.000Z',
  workspace: '/Users/me/project',
  provider: 'modelstudio',
  model: 'qwen3.8-flash',
  effort: 'medium',
};
const start: TurnEvent = { kind: 'session-start', session };
const user = (seq: number, content: string): TurnEvent => ({ kind: 'user', seq, at: `2026-10-01T00:00:0${seq}.000Z`, content });
const answer = (seq: number, costUsd: number | null): TurnEvent => ({
  kind: 'assistant',
  seq,
  at: `2026-10-01T00:00:0${seq}.000Z`,
  content: [],
  stopReason: 'end_turn',
  usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
  costUsd,
  latencyMs: 1,
  model: 'qwen3.8-flash',
});

const summary = (fields: Partial<SessionSummary>): SessionSummary => ({
  id: asSessionId('s'),
  workspace: '/Users/me/project',
  title: 't',
  createdAt: '',
  updatedAt: '',
  turns: 1,
  costUsd: 0,
  ...fields,
});

describe('session history', () => {
  it('titles a session by its first prompt on one line, cut to fit, until the user names it', () => {
    expect(titleOf([start])).toBeUndefined();
    expect(titleOf([start, user(1, '  Fix\n the   parser  '), user(2, 'and more')])).toBe('Fix the parser');
    expect(titleOf([start, user(1, 'Fix it'), { kind: 'title', seq: 2, at: '', title: 'Parser' }, { kind: 'title', seq: 3, at: '', title: 'Parser fix' }])).toBe('Parser fix');
    const long = titleFrom('word '.repeat(40));
    expect(long).toHaveLength(80);
    expect(long.endsWith('…')).toBe(true);
  });

  it('summarizes prompts, cost and the last activity, with an unknown price making the cost unknown', () => {
    expect(summarizeSession(session, [start, user(1, 'a'), answer(2, 0.25), user(3, 'b'), answer(4, 0.5)])).toEqual({
      id: 's1',
      workspace: '/Users/me/project',
      title: 'a',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:04.000Z',
      turns: 2,
      costUsd: 0.75,
    });
    expect(summarizeSession(session, [start, user(1, 'a'), answer(2, null), answer(3, 0.5)]).costUsd).toBeNull();
    expect(summarizeSession(session, [start])).toMatchObject({ title: 'New chat', turns: 0, updatedAt: session.createdAt });
  });

  it('shows a project its own sessions, temporary or not, and leaves temporary and unprompted ones out of every project', () => {
    const temp = ['/private/var/folders', '/tmp'];
    const project = { kind: 'project', workspace: '/tmp/clone' } as const;
    expect(inScope(summary({ workspace: '/tmp/clone' }), project, temp)).toBe(true);
    expect(inScope(summary({ workspace: '/tmp/clone-2' }), project, temp)).toBe(false);
    expect(inScope(summary({ workspace: '/tmp/clone', turns: 0 }), project, temp)).toBe(false);
    expect(inScope(summary({ workspace: '/Users/me/project' }), { kind: 'all' }, temp)).toBe(true);
    expect(inScope(summary({ workspace: '/tmp/clone' }), { kind: 'all' }, temp)).toBe(false);
    expect(inScope(summary({ workspace: '/private/var/folders/xy/T/gcode-ext-1/workspace' }), { kind: 'all' }, temp)).toBe(false);
    expect(inScope(summary({ workspace: '/tmpfiles/project' }), { kind: 'all' }, temp)).toBe(true);
  });
});
