import { describe, expect, it } from 'vitest';
import { asSessionId, loopStep, noticeTexts, replayMessages, type Run, type Session, type TurnEvent } from '../src/index.js';

const at = '2026-10-28T00:00:01.000Z';
const session: Session = { id: asSessionId('s1'), createdAt: at, workspace: '/ws', provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' };
const usage = { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 };
const run: Run = { firstSeq: 1, maxTurns: 200, maxCostUsd: 10, checkChanges: true };

/** A session written as the engine logs it: a prompt, then the model's calls and their results. */
function log() {
  const events: TurnEvent[] = [{ kind: 'session-start', session }, { kind: 'user', seq: 1, at, content: 'Use icons on the buttons.' }];
  let seq = 1;
  const call = (name: string, result: Partial<Extract<TurnEvent, { kind: 'tool-result' }>> = {}) => {
    const id = `t${seq + 1}`;
    events.push({ kind: 'assistant', seq: ++seq, at, content: [{ type: 'tool_use', id, name, input: {}, caller: { type: 'direct' } }], stopReason: 'tool_use', usage, costUsd: 0, latencyMs: 1, model: 'm' });
    events.push({ kind: 'tool-result', seq: ++seq, at, toolUseId: id, name, status: 'ok', output: 'ok', ...result });
  };
  const builder = {
    events,
    edit: (file = '/ws/index.html') => (call('edit', { change: { id: `c${seq}`, path: file, hunks: [] } }), builder),
    call: (name: string) => (call(name), builder),
    end: () => (events.push({ kind: 'assistant', seq: ++seq, at, content: [{ type: 'text', text: 'Done.', citations: null }], stopReason: 'end_turn', usage, costUsd: 0, latencyMs: 1, model: 'm' }), builder),
    remind: () => {
      const step = loopStep(events, run);
      if (step.kind === 'remind-check') events.push({ kind: 'notice', seq: ++seq, at, unchecked: step.unchecked });
      return step;
    },
  };
  return builder;
}

describe('the check reminder', () => {
  it('names the changed files once when the model ends right after changing them, then lets it go on', () => {
    const s = log().edit('/ws/index.html').edit('/ws/sw.js').end();
    expect(s.remind()).toEqual({ kind: 'remind-check', unchecked: { files: ['/ws/index.html', '/ws/sw.js'] } });
    expect(loopStep(s.events, run)).toEqual({ kind: 'call-model' });
    const notice = s.events.at(-1)!;
    expect(notice.kind === 'notice' && noticeTexts(notice).join('\n')).toMatch(/after changing index\.html, sw\.js, and nothing ran or opened the result since/);
    s.edit().end();
    expect(loopStep(s.events, run), 'once a run').toEqual({ kind: 'done', reason: 'end_turn' });
  });

  it('goes to the model as the next user message, so the request does not end on its own answer', () => {
    const s = log().edit().end();
    s.remind();
    const last = replayMessages(s.events).at(-1)!;
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain('nothing ran or opened the result since');
  });

  it('stays quiet when a command, the browser or a dev server ran after the last change', () => {
    for (const name of ['bash', 'check', 'mcp__browser__take_screenshot', 'preview_start', 'agent']) {
      expect(loopStep(log().edit().call(name).end().events, run), name).toEqual({ kind: 'done', reason: 'end_turn' });
    }
  });

  it('stays quiet when nothing changed, or in a run that does not check changes', () => {
    expect(loopStep(log().call('read').end().events, run)).toEqual({ kind: 'done', reason: 'end_turn' });
    expect(loopStep(log().edit().end().events, { ...run, checkChanges: undefined })).toEqual({ kind: 'done', reason: 'end_turn' });
  });

  it('reminds again after a change made since an earlier check', () => {
    expect(log().edit().call('bash').edit().end().remind().kind).toBe('remind-check');
  });
});
