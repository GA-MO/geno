import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { llamaServerArgs, type TabServerState } from '@g-code/core/tab';

export type TabServerPlan =
  | { readonly kind: 'off' }
  | { readonly kind: 'on'; readonly endpoint: string; readonly model: string; readonly binary: string | undefined };

const READY_TIMEOUT_MS = 120_000;
const POLL_MS = 250;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** llama-server answers /health with 200 once the model is loaded, and 503 while it loads. */
export async function healthy(endpoint: string): Promise<boolean> {
  try {
    return (await fetch(new URL('/health', endpoint), { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

/** The port to start a server on, or undefined when the endpoint is not on this machine. */
function localPort(endpoint: string): number | undefined {
  const url = new URL(endpoint);
  if (!LOOPBACK_HOSTS.has(url.hostname)) return undefined;
  return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
}

type Owned = { readonly child: ChildProcess };

/**
 * Converges llama-server on the latest plan, whatever ran before: a server already answering at the endpoint is
 * adopted and left running, and only a server this class started is ever stopped.
 */
export class TabServer {
  private current: TabServerState = { kind: 'off' };
  private planKey = JSON.stringify({ kind: 'off' });
  private generation = 0;
  private owned: Owned | undefined;

  constructor(
    private readonly onChange: (state: TabServerState) => void,
    private readonly log: (line: string) => void,
  ) {}

  get state(): TabServerState {
    return this.current;
  }

  async apply(plan: TabServerPlan): Promise<void> {
    const key = JSON.stringify(plan);
    // Applying the plan already in force is a no-op, so a start in progress is not restarted.
    if (key === this.planKey && this.current.kind !== 'failed') return;
    this.planKey = key;
    const generation = ++this.generation;
    this.stop();
    if (plan.kind === 'off') return this.set({ kind: 'off' });
    this.set({ kind: 'starting' });
    if (await healthy(plan.endpoint)) return this.settle(generation, { kind: 'ready', owned: false });
    const failed = (reason: string) => this.settle(generation, { kind: 'failed', reason });
    const port = localPort(plan.endpoint);
    if (port === undefined) return failed(`nothing answers at ${plan.endpoint}`);
    if (!(await access(plan.model).then(() => true, () => false))) return failed(`no Tab model at ${plan.model}`);
    if (plan.binary === undefined) return failed('llama-server is not in /opt/homebrew/bin, /usr/local/bin or on PATH');
    if (generation === this.generation) await this.start(plan.binary, plan.model, port, plan.endpoint);
  }

  private async start(binary: string, model: string, port: number, endpoint: string): Promise<void> {
    this.log(`tab server: starting ${binary} on port ${port}`);
    const child = spawn(binary, llamaServerArgs(model, port), { stdio: ['ignore', 'ignore', 'pipe'] });
    const owned: Owned = { child };
    this.owned = owned;
    let tail = '';
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (tail = (tail + chunk).slice(-2000)));
    const ended = (how: string) => {
      if (this.owned !== owned) return;
      this.owned = undefined;
      this.log(`tab server: llama-server ${how}; its last output:\n${tail}`);
      this.set({ kind: 'failed', reason: `llama-server ${how}` });
    };
    child.on('error', (error) => ended(`could not start: ${error.message}`));
    child.on('exit', (code, signal) => ended(`exited with ${signal ?? `code ${code}`}`));
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (this.owned === owned) {
      if (await healthy(endpoint)) {
        if (this.owned === owned) this.set({ kind: 'ready', owned: true });
        return;
      }
      if (Date.now() > deadline) {
        this.stop();
        return this.set({ kind: 'failed', reason: `llama-server was not ready within ${READY_TIMEOUT_MS / 1000} s` });
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  private stop(): void {
    const owned = this.owned;
    this.owned = undefined;
    owned?.child.kill('SIGTERM');
  }

  private settle(generation: number, state: TabServerState): void {
    if (generation === this.generation) this.set(state);
  }

  private set(state: TabServerState): void {
    this.current = state;
    this.onChange(state);
  }

  dispose(): void {
    this.generation++;
    this.stop();
  }
}
