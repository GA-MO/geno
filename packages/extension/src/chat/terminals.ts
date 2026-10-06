import type * as vscode from 'vscode';
import { z } from 'zod';
import {
  appendOutput,
  pickTerminal,
  redactSecrets,
  TERMINAL_LIMITS,
  terminalCommand,
  type CapturedCommand,
  type ReadTerminalRequest,
  type ReadTerminalResponse,
  type TerminalSummary,
} from '@g-code/core';

export const readTerminalRequest = z.object({
  sessionId: z.string(),
  terminal: z.string().optional(),
  commands: z.number().int().min(1).max(TERMINAL_LIMITS.maxCommands),
}) satisfies z.ZodType<ReadTerminalRequest>;

/** The part of `vscode.window` the recorder reads. */
export type TerminalWindow = Pick<typeof vscode.window, 'terminals' | 'activeTerminal' | 'onDidStartTerminalShellExecution' | 'onDidEndTerminalShellExecution' | 'onDidCloseTerminal'>;

type Recorded = { readonly execution: vscode.TerminalShellExecution; command: CapturedCommand };

const pathOf = (uri: vscode.Uri | undefined): string | undefined => (uri === undefined ? undefined : uri.scheme === 'file' ? uri.fsPath : uri.toString());

/**
 * The latest commands of each terminal, from shell integration's start and end events, as they ran since the
 * extension activated. Each terminal keeps TERMINAL_LIMITS.kept commands and each command the end of its raw output;
 * a read cleans, redacts and caps them, so nothing raw leaves here.
 */
export class TerminalRecorder implements vscode.Disposable {
  private readonly recorded = new Map<vscode.Terminal, Recorded[]>();
  private readonly listeners: readonly vscode.Disposable[];

  constructor(private readonly window: TerminalWindow) {
    this.listeners = [
      window.onDidStartTerminalShellExecution(({ terminal, execution }) => this.started(terminal, execution)),
      window.onDidEndTerminalShellExecution(({ terminal, execution, exitCode }) => this.ended(terminal, execution, exitCode)),
      window.onDidCloseTerminal((terminal) => this.recorded.delete(terminal)),
    ];
  }

  private started(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution): void {
    const entry: Recorded = {
      execution,
      command: { commandLine: execution.commandLine.value, cwd: pathOf(execution.cwd), exit: { state: 'running' }, output: { text: '', droppedLines: 0 } },
    };
    const kept = [...(this.recorded.get(terminal) ?? []), entry].slice(-TERMINAL_LIMITS.kept);
    this.recorded.set(terminal, kept);
    // read() returns only what is written after its first call, so it starts here, before the command prints.
    void (async () => {
      for await (const chunk of execution.read()) entry.command = { ...entry.command, output: appendOutput(entry.command.output, chunk) };
    })().catch(() => undefined);
  }

  /** A command that started before the extension activated has no start here, and no output to show, so it is not kept. */
  private ended(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution, exitCode: number | undefined): void {
    const entry = this.recorded.get(terminal)?.findLast((recorded) => recorded.execution === execution);
    if (entry === undefined) return;
    entry.command = {
      ...entry.command,
      commandLine: execution.commandLine.value === '' ? entry.command.commandLine : execution.commandLine.value,
      cwd: pathOf(execution.cwd) ?? entry.command.cwd,
      exit: { state: 'ended', code: exitCode ?? null },
    };
  }

  read({ terminal, commands }: Omit<ReadTerminalRequest, 'sessionId'>): ReadTerminalResponse {
    const open = this.window.terminals;
    const summaries: TerminalSummary[] = open.map((t, i) => {
      const count = this.recorded.get(t)?.length ?? 0;
      return { index: i + 1, name: redactSecrets(t.name), active: t === this.window.activeTerminal, shellIntegration: t.shellIntegration !== undefined || count > 0, commands: count };
    });
    if (open.length === 0) return { terminals: [], read: { kind: 'no-terminal' } };
    const picked = pickTerminal(summaries, terminal);
    if (picked === undefined) return { terminals: summaries, read: terminal === undefined ? { kind: 'no-terminal' } : { kind: 'not-found', asked: terminal } };
    if (!picked.shellIntegration) return { terminals: summaries, read: { kind: 'no-shell-integration', terminal: picked } };
    const recorded = this.recorded.get(open[picked.index - 1]!) ?? [];
    return { terminals: summaries, read: { kind: 'commands', terminal: picked, commands: recorded.slice(-commands).map((entry) => terminalCommand(entry.command)) } };
  }

  dispose(): void {
    for (const listener of this.listeners) listener.dispose();
    this.recorded.clear();
  }
}
