import { describe, expect, it } from 'vitest';
import { sessionAllowances, type TurnEvent } from '../src/index.js';

const result = (seq: number, fields: Record<string, unknown>): TurnEvent => ({ kind: 'tool-result', seq, at: '', toolUseId: `tu_${seq}`, name: 'mcp__fake__echo', status: 'ok', output: 'ok', ...fields }) as unknown as TurnEvent;
const record = (fields: Record<string, unknown>) => ({ mode: 'ask', rule: 'mcp-read-only', reason: 'r', command: 'mcp__fake__echo', decidedBy: 'user', verdict: 'allow', ...fields });
const everything = (from: number): TurnEvent[] => [
  result(from, { approval: record({ kept: 'session' }) }),
  result(from + 1, { name: 'read', allows: [{ kind: 'host', host: 'approved.example' }, { kind: 'directory', path: '/notes' }] }),
  result(from + 2, { name: 'schedule_task', allows: [{ kind: 'schedule' }] }),
];
const none = { tools: new Set(), hosts: new Set(), directories: new Set(), schedule: false };

describe('sessionAllowances', () => {
  it('reads every kind of allowance from the results of the session', () => {
    expect(sessionAllowances(everything(1))).toEqual({ tools: new Set(['mcp__fake__echo']), hosts: new Set(['approved.example']), directories: new Set(['/notes']), schedule: true });
  });

  it('counts a tool only for a yes of the user that outlives the call, on an MCP rule', () => {
    const answers = [record({}), record({ kept: 'session', verdict: 'deny' }), record({ kept: 'session', decidedBy: 'hook' }), record({ kept: 'session', decidedBy: 'classifier' }), record({ kept: 'workspace', rule: 'browser-risky-tool' })];
    expect(sessionAllowances(answers.map((approval, i) => result(i + 1, { approval })))).toEqual(none);
  });

  it("leaves out the turns a fork copied from its source, and reads the fork's own", () => {
    const head = { kind: 'session-start', session: {}, fork: { sessionId: 'source', turnSeq: 1, title: 'Source' } } as unknown as TurnEvent;
    const copied = [{ kind: 'user', seq: 1, at: '', content: 'first' } as unknown as TurnEvent, ...everything(2)];
    expect(sessionAllowances([head, ...copied])).toEqual(none);
    const own = [{ kind: 'user', seq: 5, at: '', content: 'go on' } as unknown as TurnEvent, ...everything(6)];
    expect(sessionAllowances([head, ...copied, ...own]).schedule).toBe(true);
  });
});
