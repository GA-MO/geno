import { renderEnvironment, type TurnEvent } from '@g-code/core';
import { run } from '../src/run.js';

/** The ripgrep the tool tests run: GCODE_RG when set, else rg on PATH. */
export const rgCommand = (): string => process.env['GCODE_RG'] || 'rg';

export type CliOptions = {
  readonly cwd?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Called with each streamed chunk, with the controller behind the interrupt signal. */
  readonly onWrite?: (text: string, interrupt: AbortController) => void;
  /** Called with each stderr line, with the controller behind the interrupt signal. */
  readonly onErr?: (line: string, interrupt: AbortController) => void;
  /** Answers the agent's approval questions; every question is refused when absent. */
  readonly confirm?: (question: string) => boolean;
};

export async function runCli(argv: string[], env: Record<string, string>, options: CliOptions = {}) {
  const { cwd = process.cwd(), fetch, onWrite, onErr, confirm = () => false } = options;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const interrupt = new AbortController();
  let partial = '';
  const code = await run(argv, {
    env,
    cwd,
    out: (line) => {
      stdout.push(partial + line);
      partial = '';
    },
    err: (line) => {
      stderr.push(line);
      onErr?.(line, interrupt);
    },
    write: (text) => {
      partial += text;
      onWrite?.(text, interrupt);
    },
    interrupts: () => interrupt.signal,
    confirm: async (question) => confirm(question),
    ...(fetch === undefined ? {} : { fetch }),
  });
  return { code, stdout: [...stdout, ...(partial ? [partial] : [])].join('\n'), stderr: stderr.join('\n') };
}

/** The environment block that opens a session's first message, as the model reads it; the log must record one. */
export function environmentBlock(events: readonly TurnEvent[]): { readonly type: 'text'; readonly text: string } {
  const head = events[0];
  if (head?.kind !== 'session-start' || head.environment === undefined) throw new Error('the log records no environment');
  return { type: 'text', text: renderEnvironment(head.environment, head.session) };
}
