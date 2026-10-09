import type * as acp from '@agentclientprotocol/sdk';
import { APPROVAL_META } from '@g-code/core';
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
