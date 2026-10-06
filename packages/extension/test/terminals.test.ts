import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { TERMINAL_LIMITS } from '@g-code/core';
import { TerminalRecorder, type TerminalWindow } from '../src/chat/terminals.js';

const FAKE_KEY = `ghp_${'F4ke'.repeat(9)}`;

type Listener<T> = (event: T) => void;

/** A stand-in for vscode.window that fires shell integration events as VS Code does. */
function fakeWindow() {
  const start: Listener<vscode.TerminalShellExecutionStartEvent>[] = [];
  const end: Listener<vscode.TerminalShellExecutionEndEvent>[] = [];
  const close: Listener<vscode.Terminal>[] = [];
  const on =
    <T>(list: Listener<T>[]) =>
    (listener: Listener<T>) => {
      list.push(listener);
      return { dispose: () => list.splice(list.indexOf(listener), 1) };
    };
  const state = { terminals: [] as vscode.Terminal[], activeTerminal: undefined as vscode.Terminal | undefined };
  const window = {
    get terminals() {
      return state.terminals;
    },
    get activeTerminal() {
      return state.activeTerminal;
    },
    onDidStartTerminalShellExecution: on(start),
    onDidEndTerminalShellExecution: on(end),
    onDidCloseTerminal: on(close),
  } as unknown as TerminalWindow;

  const terminal = (name: string, integrated = true): vscode.Terminal => {
    const t = { name, shellIntegration: integrated ? {} : undefined } as unknown as vscode.Terminal;
    state.terminals.push(t);
    state.activeTerminal = t;
    return t;
  };

  /** Starts a command: the start event fires and its output streams through read(); `hang` keeps the stream open. */
  function begin(t: vscode.Terminal, commandLine: string, chunks: readonly string[], { cwd = '/ws' as string | null, hang = false } = {}) {
    let done!: () => void;
    const drained = new Promise<void>((resolve) => (done = resolve));
    const execution = {
      commandLine: { value: commandLine, isTrusted: true, confidence: 2 },
      cwd: cwd === null ? undefined : { scheme: 'file', fsPath: cwd, toString: () => `file://${cwd}` },
      async *read() {
        for (const chunk of chunks) yield chunk;
        done();
        if (hang) await new Promise(() => {});
      },
    } as unknown as vscode.TerminalShellExecution;
    for (const listener of start) listener({ terminal: t, shellIntegration: t.shellIntegration!, execution });
    return { execution, drained };
  }

  /** Runs a command to its end, as begin starts it. */
  async function run(t: vscode.Terminal, commandLine: string, chunks: readonly string[], exitCode: number | undefined) {
    const { execution, drained } = begin(t, commandLine, chunks);
    await drained;
    for (const listener of end) listener({ terminal: t, shellIntegration: t.shellIntegration!, execution, exitCode });
  }

  const closeTerminal = (t: vscode.Terminal) => {
    state.terminals = state.terminals.filter((other) => other !== t);
    for (const listener of close) listener(t);
  };
  return { window, terminal, begin, run, closeTerminal, listeners: () => start.length + end.length + close.length };
}

describe('TerminalRecorder', () => {
  it('records each command with its folder and exit code, and reads it cleaned, redacted and capped', async () => {
    const fake = fakeWindow();
    const recorder = new TerminalRecorder(fake.window);
    const zsh = fake.terminal('zsh');
    const lines = Array.from({ length: 80 }, (_, i) => `\x1b[32mok\x1b[0m test ${i}\r\n`);
    await fake.run(zsh, `GITHUB_TOKEN=${FAKE_KEY} pnpm test`, ['\x1b]633;C\x07', ...lines, `push rejected for ${FAKE_KEY}\r\n`], 1);

    const response = recorder.read({ commands: 3 });
    expect(JSON.stringify(response), 'no secret leaves the recorder').not.toContain(FAKE_KEY);
    expect(response.read.kind).toBe('commands');
    if (response.read.kind !== 'commands') return;
    const [command] = response.read.commands;
    expect(command!.commandLine).toBe('GITHUB_TOKEN=[redacted] pnpm test');
    expect(command!.cwd).toBe('/ws');
    expect(command!.exit).toEqual({ state: 'ended', code: 1 });
    expect(command!.output.split('\n')).toHaveLength(TERMINAL_LIMITS.lines);
    expect(command!.output.split('\n').at(-1)).toBe('push rejected for [redacted]');
    expect(command!.output).not.toContain('\x1b');
    expect(command!.omittedLines).toBe(81 - TERMINAL_LIMITS.lines);
  });

  it('keeps the latest commands of each terminal, and returns the number asked for, oldest first', async () => {
    const fake = fakeWindow();
    const recorder = new TerminalRecorder(fake.window);
    const zsh = fake.terminal('zsh');
    for (let i = 1; i <= TERMINAL_LIMITS.kept + 5; i++) await fake.run(zsh, `echo ${i}`, [`${i}\r\n`], 0);
    const response = recorder.read({ commands: 2 });
    expect(response.terminals).toEqual([{ index: 1, name: 'zsh', active: true, shellIntegration: true, commands: TERMINAL_LIMITS.kept }]);
    expect(response.read.kind === 'commands' && response.read.commands.map((c) => c.commandLine)).toEqual([`echo ${TERMINAL_LIMITS.kept + 4}`, `echo ${TERMINAL_LIMITS.kept + 5}`]);
  });

  it('reads a named terminal, says which has no shell integration, and forgets a closed one', async () => {
    const fake = fakeWindow();
    const recorder = new TerminalRecorder(fake.window);
    const zsh = fake.terminal('zsh');
    await fake.run(zsh, 'pnpm build', ['done\r\n'], 0);
    const plain = fake.terminal('plain', false);

    expect(recorder.read({ commands: 3 }).read).toEqual({ kind: 'no-shell-integration', terminal: { index: 2, name: 'plain', active: true, shellIntegration: false, commands: 0 } });
    const named = recorder.read({ terminal: 'zsh', commands: 3 }).read;
    expect(named.kind === 'commands' && named.commands.map((c) => [c.commandLine, c.output])).toEqual([['pnpm build', 'done']]);
    expect(recorder.read({ terminal: 'bash', commands: 3 }).read).toEqual({ kind: 'not-found', asked: 'bash' });

    fake.closeTerminal(zsh);
    fake.closeTerminal(plain);
    expect(recorder.read({ commands: 3 })).toEqual({ terminals: [], read: { kind: 'no-terminal' } });
  });

  it('shows a command that is still running with the output so far, and one whose exit code the shell did not report', async () => {
    const fake = fakeWindow();
    const recorder = new TerminalRecorder(fake.window);
    const zsh = fake.terminal('zsh');
    await fake.run(zsh, 'exit-unknown', [], undefined);
    await fake.begin(zsh, 'pnpm dev', ['ready on http://localhost:3000\r\n'], { cwd: null, hang: true }).drained;
    const read = recorder.read({ commands: 2 }).read;
    expect(read.kind === 'commands' && read.commands).toEqual([
      { commandLine: 'exit-unknown', cwd: '/ws', exit: { state: 'ended', code: null }, output: '', omittedLines: 0 },
      { commandLine: 'pnpm dev', cwd: null, exit: { state: 'running' }, output: 'ready on http://localhost:3000', omittedLines: 0 },
    ]);
  });

  it('stops listening when disposed', () => {
    const fake = fakeWindow();
    new TerminalRecorder(fake.window).dispose();
    expect(fake.listeners()).toBe(0);
  });
});
