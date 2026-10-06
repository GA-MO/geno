import { describe, expect, it } from 'vitest';
import { commandStepOf, PREVIEW_LINES } from '../src/chat/command-step.js';
import type { Action, ToolBlock } from '../src/chat/messages.js';
import { emptyTranscript, reduce } from '../src/chat/transcript.js';

const LONG_COMMAND = `du -sh ${Array.from({ length: 30 }, (_, i) => `packages/p${i}/node_modules`).join(' ')} 2>/dev/null | sort -h | tail -n 20`;

/** A bash call as the transcript keeps it, from its start and, when `end` is given, its result. */
function bash(start: { readonly target: string; readonly description?: string }, end?: { readonly output: string; readonly status?: 'completed' | 'failed' }): ToolBlock {
  const actions: Action[] = [
    { type: 'turn-start', id: 't1', at: 1000, prompt: 'p' },
    { type: 'tool', id: 'b1', at: 2000, name: 'bash', toolKind: 'execute', status: 'running', ...start },
    ...(end === undefined ? [] : [{ type: 'tool', id: 'b1', at: 3000, status: end.status ?? 'completed', output: end.output } satisfies Action]),
  ];
  return actions.reduce(reduce, emptyTranscript('qwen3.8-flash')).turns[0]!.blocks[0] as ToolBlock;
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('a command step', () => {
  it('titles the step with the call’s description on one line, and keeps the command whole', () => {
    const step = commandStepOf(bash({ target: LONG_COMMAND, description: '  Show disk usage\n of each package  ' }), false);
    expect(step).toEqual({ title: 'Show disk usage of each package', command: LONG_COMMAND, output: undefined, truncated: false, lines: 0, status: 'running' });
  });

  it('falls back to a plain title without a description, by whether the command still runs', () => {
    expect(commandStepOf(bash({ target: 'ls' }), false).title).toBe('Running a command');
    expect(commandStepOf(bash({ target: 'ls', description: '   ' }, { output: 'a.ts\n[exit code 0]' }), false).title).toBe('Ran a command');
  });

  it('cuts a description too long for a title', () => {
    const title = commandStepOf(bash({ target: 'ls', description: 'word '.repeat(40) }), false).title;
    expect(title).toHaveLength(100);
    expect(title.endsWith('word…')).toBe(true);
  });

  it('previews the first lines of the output, without a clean exit line, and shows them all once expanded', () => {
    const tool = bash({ target: 'ls', description: 'List the files' }, { output: `${lines(9)}\n[exit code 0]\n` });
    expect(commandStepOf(tool, false)).toMatchObject({ output: lines(PREVIEW_LINES).split('\n'), truncated: true, lines: 9, status: 'completed' });
    expect(commandStepOf(tool, true)).toMatchObject({ output: lines(9).split('\n'), truncated: false, lines: 9 });
  });

  it('keeps a failing exit line, and shows a short output whole', () => {
    const step = commandStepOf(bash({ target: 'false' }, { output: 'nope\n[exit code 1]\n', status: 'failed' }), false);
    expect(step).toMatchObject({ output: ['nope', '[exit code 1]'], truncated: false, lines: 2, status: 'failed' });
  });

  it('has no output lines for a command that printed nothing', () => {
    expect(commandStepOf(bash({ target: 'true' }, { output: '[exit code 0]' }), false)).toMatchObject({ output: [], truncated: false, lines: 0 });
  });
});
