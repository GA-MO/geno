import { run } from '../src/run.js';

/** The ripgrep the tool tests run: GCODE_RG when set, else rg on PATH. */
export const rgCommand = (): string => process.env['GCODE_RG'] || 'rg';

export type CliOptions = {
  readonly cwd?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Called with each streamed chunk, with the controller behind the interrupt signal. */
  readonly onWrite?: (text: string, interrupt: AbortController) => void;
};

export async function runCli(argv: string[], env: Record<string, string>, options: CliOptions = {}) {
  const { cwd = process.cwd(), fetch, onWrite } = options;
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
    err: (line) => stderr.push(line),
    write: (text) => {
      partial += text;
      onWrite?.(text, interrupt);
    },
    interrupts: () => interrupt.signal,
    ...(fetch === undefined ? {} : { fetch }),
  });
  return { code, stdout: [...stdout, ...(partial ? [partial] : [])].join('\n'), stderr: stderr.join('\n') };
}
