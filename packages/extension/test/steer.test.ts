import type * as acp from '@agentclientprotocol/sdk';
import { asSessionId, childReport, parentMessage, STEER_META } from '@g-code/core';
import { describe, expect, it } from 'vitest';
import type { Connection } from '../src/chat/engine.js';
import { shownSteps } from '../src/chat/fold.js';
import type { Action, Transcript } from '../src/chat/messages.js';
import { railOf } from '../src/chat/rail.js';
import { SteerHost, steerActionOf, type SteerLink } from '../src/chat/steer-host.js';
import { fieldStatus, followupAtTurnEnd, followupSteered, pillOf, sendNowOf, steerLook, type Followup, type SteerToView } from '../src/chat/steer-model.js';
import { childOf, emptyTranscript, reduce } from '../src/chat/transcript.js';

const run = (actions: readonly Action[], start: Transcript = emptyTranscript('qwen3.8-flash')): Transcript => actions.reduce(reduce, start);

const chunk = (text: string, mark?: unknown): acp.SessionUpdate => ({
  sessionUpdate: 'user_message_chunk',
  content: { type: 'text', text },
  ...(mark === undefined ? {} : { _meta: { [STEER_META]: mark } }),
});

const steer = (text: string, seq: number, from: 'user' | 'parent' | 'child' = 'user'): Action => steerActionOf(chunk(text, { seq, from }))!;

const T0 = 1_000_000;
const turn: Action[] = [
  { type: 'turn-start', id: 't1', at: T0, prompt: 'Wait for the build' },
  { type: 'text', text: 'Waiting.' },
  { type: 'tool', id: 'tu_wait', at: T0 + 10, name: 'bash', target: 'until [ -f release ]', toolKind: 'execute', status: 'running' },
];

describe('a steer in the transcript', () => {
  it('lands between the tool step before it and the model text after it', () => {
    const t = run([...turn, { type: 'tool', id: 'tu_wait', at: T0 + 20, status: 'completed' }, steer('also check b.ts', 7), { type: 'text', text: 'Checked both.' }]);
    const steps = railOf(t.turns[0]!);
    expect(steps.map((s) => s.kind)).toEqual(['text', 'calls', 'steer', 'text']);
    const landed = steps[2]!;
    expect(landed.kind === 'steer' && landed.block.shown).toEqual({ from: 'user', text: 'also check b.ts' });
    expect(t.turns, 'a delivered steer is no new turn').toHaveLength(1);
  });

  it('keeps one block per seq, so a replay that live updates repeat shows it once', () => {
    const t = run([...turn, steer('once', 3), steer('once', 3)]);
    expect(t.turns[0]!.blocks.filter((b) => b.kind === 'steer')).toHaveLength(1);
  });

  it('shows the thinking step after a steer, which the next model call answers', () => {
    const t = run([...turn, { type: 'tool', id: 'tu_wait', at: T0 + 20, status: 'completed' }, steer('and b.ts', 4)]);
    expect(railOf(t.turns[0]!).map((s) => s.kind).at(-1)).toBe('thinking');
  });

  it('stays in view when a compact turn folds its work', () => {
    const t = run([
      ...turn,
      { type: 'tool', id: 'tu_wait', at: T0 + 20, status: 'completed' },
      steer('and b.ts', 4),
      { type: 'tool', id: 'tu_read', at: T0 + 30, name: 'read', target: 'b.ts', toolKind: 'read', status: 'completed' },
      { type: 'text', text: 'Done.' },
      { type: 'turn-end', at: T0 + 40, status: 'done', usage: undefined },
    ]);
    expect(shownSteps(t.turns[0]!, 'compact', false).map((s) => s.kind)).toEqual(['fold', 'steer', 'text']);
  });

  it("goes into a child's own turn when it comes under the child's session id", () => {
    const t = run([
      ...turn,
      { type: 'tool', id: 'tu_agent', at: T0 + 10, name: 'agent', target: 'explore: alpha', toolKind: 'other', status: 'running' },
      { type: 'child-start', id: 'c1', toolId: 'tu_agent', role: 'explore', task: 'find alpha', model: 'qwen3.8-flash', at: T0 + 20 },
      { type: 'child', id: 'c1', action: steer(parentMessage('look in src only'), 2, 'parent') as Extract<Action, { type: 'steer' }> },
    ]);
    expect(t.turns[0]!.blocks.some((b) => b.kind === 'steer'), "the parent's rail stays as it was").toBe(false);
    expect(childOf(t, 'c1')!.turn.blocks).toEqual([{ kind: 'steer', id: 'steer:2', seq: 2, shown: { from: 'parent', text: 'look in src only' } }]);
  });
});

describe('reading a steer chunk', () => {
  it('takes only chunks the engine marked, as a turn-starting prompt is not one', () => {
    expect(steerActionOf(chunk('Wait for the build'))).toBeUndefined();
    expect(steerActionOf(chunk('x', { seq: 'one', from: 'user' }))).toBeUndefined();
    expect(steerActionOf({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' }, _meta: { [STEER_META]: { seq: 1, from: 'user' } } })).toBeUndefined();
  });

  it("unwraps a parent's message from its fence and names the child that reported back", () => {
    expect(steer(parentMessage('only src/'), 1, 'parent')).toEqual({ type: 'steer', seq: 1, shown: { from: 'parent', text: 'only src/' } });
    const report = childReport('explore', asSessionId('c1'), { kind: 'done' }, 'alpha is in a.ts');
    expect(steer(report, 2, 'child')).toEqual({ type: 'steer', seq: 2, shown: { from: 'child', agent: 'explore' } });
  });

  it('draws the user as a bubble, the parent as a labelled message, and a report as a muted note', () => {
    expect(steerLook({ from: 'user', text: 'b too' })).toEqual({ kind: 'bubble', label: 'Sent mid-turn', text: 'b too' });
    expect(steerLook({ from: 'parent', text: 'src only' })).toEqual({ kind: 'message', label: 'Message from the parent agent', text: 'src only' });
    expect(steerLook({ from: 'child', agent: 'explore' })).toEqual({ kind: 'note', label: 'explore reported back', text: undefined });
    expect(steerLook({ from: 'child', agent: undefined }).label).toBe('A subagent reported back');
  });
});

describe("the composer's follow-up", () => {
  const queued: Followup = { text: 'and b.ts', attachments: [], state: 'queued' };
  const steering: Followup = { ...queued, state: 'steering' };
  const image = { kind: 'image', name: 'a.png', mimeType: 'image/png', data: '' } as unknown as Followup['attachments'][number];

  it('sends a queued one when the turn finishes, and gives it back after a stop or a failure', () => {
    expect(followupAtTurnEnd(queued, 'done')).toEqual({ next: undefined, effect: 'send' });
    expect(followupAtTurnEnd(queued, 'stopped')).toEqual({ next: undefined, effect: 'restore' });
    expect(followupAtTurnEnd(queued, 'failed')).toEqual({ next: undefined, effect: 'restore' });
  });

  it('never sends a steer again at the turn end: the engine runs it as the next turn, and the host shows that', () => {
    expect(followupAtTurnEnd(steering, 'done')).toEqual({ next: steering, effect: 'none' });
    expect(followupAtTurnEnd(steering, 'stopped')).toEqual({ next: steering, effect: 'none' });
  });

  it('clears once the steer landed or became the next turn, and queues a refused one while the turn runs', () => {
    expect(followupSteered(steering, { kind: 'delivered' }, true)).toEqual({ next: undefined, effect: 'none' });
    expect(followupSteered(steering, { kind: 'next-turn' }, false)).toEqual({ next: undefined, effect: 'none' });
    expect(followupSteered(steering, { kind: 'failed', message: 'x' }, true)).toEqual({ next: queued, effect: 'none' });
    expect(followupSteered(steering, { kind: 'failed', message: 'x' }, false)).toEqual({ next: undefined, effect: 'restore' });
    expect(followupSteered(queued, { kind: 'delivered' }, true), 'a result for no steer changes nothing').toEqual({ next: queued, effect: 'none' });
  });

  it('labels the pill with which applies', () => {
    expect(pillOf(queued)).toMatchObject({ state: 'queued', label: 'Queued', title: 'Sends when the turn finishes' });
    expect(pillOf(steering)).toMatchObject({ state: 'steering', label: 'Sending now' });
    expect(pillOf(undefined)).toBeUndefined();
  });

  it('offers Send now only during a turn, for the queued follow-up first, and holds back attachments and mentions with the reason', () => {
    const draft = { text: 'and b.ts', extras: 0 };
    expect(sendNowOf(false, undefined, draft)).toEqual({ kind: 'hidden' });
    expect(sendNowOf(true, undefined, { text: '', extras: 0 })).toEqual({ kind: 'hidden' });
    expect(sendNowOf(true, undefined, draft)).toEqual({ kind: 'ready', steers: 'draft' });
    expect(sendNowOf(true, queued, draft)).toEqual({ kind: 'ready', steers: 'queued' });
    expect(sendNowOf(true, steering, { text: '', extras: 0 })).toEqual({ kind: 'hidden' });
    expect(sendNowOf(true, steering, draft), 'one follow-up at a time').toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/^One message at a time/) });
    expect(sendNowOf(true, undefined, { text: 'and this', extras: 1 }).kind).toBe('blocked');
    const blocked = sendNowOf(true, { ...queued, attachments: [image] }, { text: '', extras: 0 });
    expect(blocked.kind === 'blocked' && blocked.reason).toMatch(/Attachments and @ mentions go with the next turn/);
  });

  it("words a field's result, a finished subagent included however the engine refuses it", () => {
    expect(fieldStatus({ kind: 'delivered' }, 'explore')).toEqual({ tone: 'ok', text: 'Delivered at its next tool round' });
    expect(fieldStatus({ kind: 'failed', message: 'Invalid request: the subagent already finished' }, 'explore')).toEqual({ tone: 'failed', text: 'explore already finished' });
    expect(fieldStatus({ kind: 'failed', message: 'Invalid params: no session c1' }, 'explore').text).toBe('explore already finished');
    expect(fieldStatus({ kind: 'failed', message: 'Invalid params: the steer has no text' }, 'explore').text).toBe('the steer has no text');
  });
});

/** A connection whose steer requests the test answers by hand, in the order they went. */
function fakeEngine() {
  const sent: { params: acp.PromptRequest; answer: (response: acp.PromptResponse) => void; fail: (error: Error) => void }[] = [];
  const connection = {
    agent: {
      request: (_method: string, params: acp.PromptRequest) =>
        new Promise<acp.PromptResponse>((answer, fail) => sent.push({ params, answer, fail })),
    },
  } as unknown as Connection;
  return { connection, sent };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function host(running: SteerLink | undefined, connection: Connection) {
  const posted: SteerToView[] = [];
  const adopted: { text: string; response: Promise<acp.PromptResponse> }[] = [];
  const sentAsPrompt: string[] = [];
  const steers = new SteerHost({
    running: () => running,
    connection: async () => connection,
    send: async (text) => void sentAsPrompt.push(text),
    adopt: async (text, response) => void adopted.push({ text, response }),
    post: (message) => void posted.push(message),
  });
  return { steers, posted, adopted, sentAsPrompt };
}

describe('the host sending a steer', () => {
  it('marks the prompt as a steer, text only, for the running session', () => {
    const { connection, sent } = fakeEngine();
    const { steers } = host({ connection, sessionId: 's1' }, connection);
    steers.handlers.steer({ type: 'steer', target: { kind: 'chat' }, text: 'and b.ts' });
    expect(sent[0]!.params).toEqual({ sessionId: 's1', prompt: [{ type: 'text', text: 'and b.ts' }], _meta: { [STEER_META]: true } });
  });

  it('clears the pill once delivered, and the turn that took it starts no other', async () => {
    const { connection, sent } = fakeEngine();
    const link = { connection, sessionId: 's1' };
    const { steers, posted, adopted } = host(link, connection);
    steers.handlers.steer({ type: 'steer', target: { kind: 'chat' }, text: 'and b.ts' });
    sent[0]!.answer({ stopReason: 'end_turn', _meta: { [STEER_META]: { kind: 'delivered', seq: 5 } } });
    await flush();
    steers.turnEnded(link);
    expect(posted).toEqual([{ type: 'steered', target: { kind: 'chat' }, result: { kind: 'delivered' } }]);
    expect(adopted).toEqual([]);
  });

  it('turns a steer the turn ended without into the next turn, ended by the steer’s own answer, and sends nothing again', async () => {
    const { connection, sent } = fakeEngine();
    const link = { connection, sessionId: 's1' };
    const { steers, posted, adopted } = host(link, connection);
    steers.handlers.steer({ type: 'steer', target: { kind: 'chat' }, text: 'and b.ts' });
    steers.turnEnded({ connection, sessionId: 'other' });
    expect(adopted, "another turn's end leaves it").toEqual([]);
    steers.turnEnded(link);
    expect(posted).toEqual([{ type: 'steered', target: { kind: 'chat' }, result: { kind: 'next-turn' } }]);
    expect(adopted.map((a) => a.text)).toEqual(['and b.ts']);
    const end = { stopReason: 'end_turn', _meta: { [STEER_META]: { kind: 'next-turn' } } } as const;
    sent[0]!.answer(end);
    await expect(adopted[0]!.response).resolves.toEqual(end);
    expect(sent, 'the steer went once').toHaveLength(1);
    expect(posted).toHaveLength(1);
  });

  it('sends a plain prompt when no turn runs any more', () => {
    const { connection, sent } = fakeEngine();
    const { steers, posted, sentAsPrompt } = host(undefined, connection);
    steers.handlers.steer({ type: 'steer', target: { kind: 'chat' }, text: 'and b.ts' });
    expect(sentAsPrompt).toEqual(['and b.ts']);
    expect(sent).toEqual([]);
    expect(posted[0]!.result).toEqual({ kind: 'next-turn' });
  });

  it("steers a subagent or a task by its own session id, and reports a refusal to the field that sent it", async () => {
    const { connection, sent } = fakeEngine();
    const { steers, posted } = host(undefined, connection);
    steers.handlers.steer({ type: 'steer', target: { kind: 'child', id: 'c1' }, text: 'src only' });
    steers.handlers.steer({ type: 'steer', target: { kind: 'task', sessionId: 's2' }, text: 'stop at a.ts' });
    await flush();
    expect(sent.map((s) => s.params.sessionId)).toEqual(['c1', 's2']);
    sent[0]!.fail(new Error('Invalid request: the subagent already finished'));
    sent[1]!.answer({ stopReason: 'end_turn', _meta: { [STEER_META]: { kind: 'delivered', seq: 9 } } });
    await flush();
    expect(posted).toEqual([
      { type: 'steered', target: { kind: 'child', id: 'c1' }, result: { kind: 'failed', message: 'Invalid request: the subagent already finished' } },
      { type: 'steered', target: { kind: 'task', sessionId: 's2' }, result: { kind: 'delivered' } },
    ]);
  });
});
