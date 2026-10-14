import type * as acp from '@agentclientprotocol/sdk';
import { ALERT_META, APPROVAL_META, TURN_ERROR_META } from '@g-code/core';
import { describe, expect, it } from 'vitest';
import type { Action } from '../src/chat/messages.js';
import { actionOf } from '../src/chat/session-updates.js';
import { emptyTranscript, reduce } from '../src/chat/transcript.js';

type Record = { readonly mode: string; readonly rule: string; readonly reason: string; readonly command: string; readonly decidedBy: string; readonly verdict: string } & { readonly [key: string]: unknown };

const closing = (approval: Record, output = 'text for the model'): Extract<acp.SessionUpdate, { sessionUpdate: 'tool_call_update' }> => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: 'tu',
  status: 'failed',
  content: [{ type: 'content', content: { type: 'text', text: output } }],
  _meta: { [APPROVAL_META]: approval },
});

const RM = { mode: 'ask', rule: 'rm-rf-in-workspace', reason: 'rm -rf of a path inside the workspace', command: 'rm -rf build' } as const;

describe("a turn's error", () => {
  const chunk = (error: string, message: string): acp.SessionUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\n[${error}] ${message}` }, _meta: { [TURN_ERROR_META]: { error, message } } });

  it('is an error the panel words itself, not text with the engine tag', () => {
    expect(actionOf(chunk('max-turns', 'stopped after 6 model calls (--max-turns 6)'), 1)).toEqual({ type: 'error', message: 'stopped after 6 model calls (--max-turns 6)', error: 'max-turns' });
  });

  it("is nothing for the user's own stop, which the turn's end already says", () => {
    expect(actionOf(chunk('abort', 'interrupted by the user'), 1)).toBeUndefined();
  });
});

describe('an alert', () => {
  const TEXT = "Auto mode's classifier is not working (DASHSCOPE_API_KEY is not set), so commands it would judge ask you instead.";

  it('stays in the turn after the output that clears a passing notice', () => {
    const alert = actionOf({ sessionUpdate: 'notice', severity: 'warning', title: TEXT, _meta: { [ALERT_META]: true } }, 1);
    expect(alert).toEqual({ type: 'alert', text: TEXT });
    const actions: Action[] = [
      { type: 'turn-start', id: 't0', at: 0, prompt: 'Build it.' },
      alert!,
      { type: 'tool', id: 'tu1', at: 2, name: 'bash', status: 'running' },
      { type: 'text', text: 'Done.' },
    ];
    const turn = actions.reduce(reduce, emptyTranscript('m')).turns[0]!;
    expect(turn.blocks.filter((block) => block.kind === 'alert')).toEqual([{ kind: 'alert', id: expect.any(String), text: TEXT }]);
  });
});

describe('a refused call', () => {
  it.each([
    ['the user', { ...RM, decidedBy: 'user', verdict: 'deny' }, { by: 'you', reason: 'It did not run, and Geno waits for you.' }],
    ['the user, with a comment', { ...RM, decidedBy: 'user', verdict: 'deny', comment: 'Delete dist instead.' }, { by: 'you', reason: 'It did not run. You told Geno: Delete dist instead.' }],
    ['Auto', { ...RM, mode: 'auto', decidedBy: 'classifier', verdict: 'deny', classifier: { verdict: 'deny', reason: 'it deletes files the user did not name' } }, { by: 'auto', reason: 'It deletes files the user did not name.' }],
    [
      "the user's own rule",
      { mode: 'ask', rule: 'workspace-deny', reason: 'the workspace rule that denies `Bash(git push --force:*)`, which the user set in .g-code/settings.json', command: 'git push --force', decidedBy: 'rule', verdict: 'deny' },
      { by: 'rule', rule: 'Bash(git push --force:*)', reason: 'Your rule in .g-code/settings.json blocks it.' },
    ],
    [
      'a rule nobody could answer',
      { mode: 'non-interactive', rule: 'web-remote-url', reason: 'fetching a page from another host', command: 'fetch https://example.com/', decidedBy: 'rule', verdict: 'deny' },
      { by: 'rule', reason: 'Fetching a page from another host needs your approval, and nobody could answer.' },
    ],
    ['a hook', { ...RM, rule: 'hook-deny', decidedBy: 'hook', verdict: 'deny', message: 'builds are cleaned by CI' }, { by: 'hook', reason: 'Builds are cleaned by CI.' }],
  ] as const)('by %s reads as denied, with who refused it and why in plain words', (_who, approval, denial) => {
    const action = actionOf(closing(approval), 1);
    expect(action).toMatchObject({ type: 'tool', status: 'denied', output: 'text for the model', denial });
    expect(action).not.toHaveProperty('auto');
  });

  it('that Auto allowed reads as completed, with the classifier reason and no denial', () => {
    const action = actionOf({ ...closing({ ...RM, mode: 'auto', decidedBy: 'classifier', verdict: 'allow', classifier: { verdict: 'allow', reason: 'it removes build output' } }), status: 'completed' }, 1);
    expect(action).toMatchObject({ type: 'tool', status: 'completed', auto: { reason: 'it removes build output' } });
    expect(action).not.toHaveProperty('denial');
  });

  it('stays denied when the plain end of the call arrives after the update that refused it', () => {
    const steps: Action[] = [
      { type: 'turn-start', id: 't', at: 0, prompt: 'p' },
      { type: 'tool', id: 'tu', at: 1, name: 'bash', target: 'rm -rf build', toolKind: 'execute', status: 'running' },
      actionOf(closing({ ...RM, decidedBy: 'user', verdict: 'deny' }), 2)!,
      { type: 'tool', id: 'tu', at: 3, status: 'failed' },
    ];
    const tool = steps.reduce(reduce, emptyTranscript('m')).turns[0]!.blocks[0]!;
    expect(tool).toMatchObject({ kind: 'tool', status: 'denied', denial: { by: 'you' } });
  });
});
