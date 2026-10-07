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

  it('keeps a failing exit line once, at the end, and shows a short output whole', () => {
    const step = commandStepOf(bash({ target: 'false' }, { output: 'Exit code 1\nnope\n[exit code 1]\n', status: 'failed' }), false);
    expect(step).toMatchObject({ output: ['nope', '[exit code 1]'], truncated: false, lines: 2, status: 'failed' });
  });

  it('shows a background command by its job: the newest lines of its output, Stop while it runs, and how it ended', () => {
    const started = bash({ target: 'pnpm dev', description: 'Start the dev server' }, { output: 'Started background command bg-1. It keeps running.' });
    const at = (job: Action & { type: 'background' }) => reduce({ model: 'm', turns: [{ id: 't1', prompt: 'p', blocks: [started], status: 'done', startedAt: 0, endedAt: 1, usage: undefined }] }, job).turns[0]!.blocks[0] as ToolBlock;
    const running = at({ type: 'background', toolId: 'b1', job: { id: 'bg-1', state: { status: 'running' }, tail: lines(6) } });
    expect(commandStepOf(running, false)).toMatchObject({
      output: ['line 3', 'line 4', 'line 5', 'line 6'],
      truncated: true,
      lines: 6,
      job: { id: 'bg-1', running: true, line: 'Running in background as bg-1', tone: 'running' },
    });
    const stopping = at({ type: 'background', toolId: 'b1', job: { id: 'bg-1', state: { status: 'running', ending: { kind: 'stop', by: 'user' } }, tail: '' } });
    expect(commandStepOf(stopping, false)).toMatchObject({ output: [], job: { running: true, line: 'Stopping bg-1…' } });
    const exited = at({ type: 'background', toolId: 'b1', job: { id: 'bg-1', state: { status: 'exited', exitCode: 1, signal: null }, tail: 'boom' } });
    expect(commandStepOf(exited, false).job).toMatchObject({ running: false, line: 'bg-1 exited with code 1', tone: 'failed' });
    const stopped = at({ type: 'background', toolId: 'b1', job: { id: 'bg-1', state: { status: 'stopped', by: 'user' }, tail: '' } });
    expect(commandStepOf(stopped, false).job).toMatchObject({ running: false, line: 'bg-1 was stopped by the user', tone: 'stopped' });
  });

  it('shows a dev server by its name, its command line and the address it serves', () => {
    const actions: Action[] = [
      { type: 'turn-start', id: 't1', at: 1000, prompt: 'p' },
      { type: 'tool', id: 'p1', at: 2000, name: 'preview_start', toolKind: 'other', status: 'running', target: 'web' },
      { type: 'background', toolId: 'p1', job: { id: 'bg-1', state: { status: 'running' }, tail: 'ready on http://localhost:3000', command: 'pnpm dev', preview: { name: 'web', url: 'http://localhost:3000' } } },
    ];
    const tool = actions.reduce(reduce, emptyTranscript('m')).turns[0]!.blocks[0] as ToolBlock;
    expect(commandStepOf(tool, false)).toMatchObject({
      title: 'Dev server web',
      command: 'pnpm dev',
      output: ['ready on http://localhost:3000'],
      job: { id: 'bg-1', running: true, line: 'Serving http://localhost:3000 as bg-1' },
    });
  });

  it('finds the step of a background command in an earlier turn, and ignores one it does not have', () => {
    const actions: Action[] = [
      { type: 'turn-start', id: 't1', at: 1000, prompt: 'start it' },
      { type: 'tool', id: 'b1', at: 2000, name: 'bash', toolKind: 'execute', status: 'completed', target: 'pnpm dev' },
      { type: 'turn-end', at: 3000, status: 'done', usage: undefined },
      { type: 'turn-start', id: 't2', at: 4000, prompt: 'and now?' },
      { type: 'background', toolId: 'b1', job: { id: 'bg-1', state: { status: 'running' }, tail: 'ready' } },
    ];
    const transcript = actions.reduce(reduce, emptyTranscript('m'));
    expect((transcript.turns[0]!.blocks[0] as ToolBlock).background).toEqual({ id: 'bg-1', state: { status: 'running' }, tail: 'ready' });
    expect(transcript.turns[1]!.blocks).toEqual([]);
    expect(reduce(transcript, { type: 'background', toolId: 'nope', job: { id: 'bg-9', state: { status: 'running' }, tail: '' } })).toBe(transcript);
  });

  it('has no output lines for a command that printed nothing', () => {
    expect(commandStepOf(bash({ target: 'true' }, { output: '[exit code 0]' }), false)).toMatchObject({ output: [], truncated: false, lines: 0 });
  });
});
