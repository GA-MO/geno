import type { Store } from './store.js';

export type Io = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  out(line: string): void;
  err(line: string): void;
  /** Raw stdout, for streamed text that is not yet a whole line. */
  write(text: string): void;
  /** Starts listening for the user's interrupt (SIGINT) and returns a signal that fires on it. */
  interrupts(): AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
};

export type Context = { readonly io: Io; readonly store: Store };
export type Command = (args: string[], ctx: Context) => Promise<number>;

export class UsageError extends Error {}

export function checkId(rawId: string, kind: string): string {
  if (rawId === '' || /[\\/]/.test(rawId)) throw new UsageError(`invalid ${kind} id: ${rawId}`);
  return rawId;
}

export function singleId(positionals: readonly string[], kind: string): string {
  const [rawId, ...extra] = positionals;
  if (rawId === undefined || extra.length > 0) throw new UsageError(`expected exactly one ${kind} id`);
  return checkId(rawId, kind);
}
