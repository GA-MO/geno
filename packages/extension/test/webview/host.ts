import type { Action, FromView, Look, Modes, ToView, Transcript } from '../../src/chat/messages.js';
import { reduce } from '../../src/chat/transcript.js';

type MessageOf<K extends FromView['type']> = Extract<FromView, { type: K }>;

/** The modes the engine offers a session, as its new-session response names them. */
export const MODES: Modes = {
  current: 'ask',
  available: [
    { id: 'plan', name: 'Plan', description: 'Read the code and plan the change without changing anything.' },
    { id: 'ask', name: 'Ask', description: 'Ask before risky commands.' },
    { id: 'auto', name: 'Auto', description: 'Run safe commands on its own and let a classifier judge the rest, without asking.' },
  ],
};

export const DEFAULT_LOOK: Look = { style: 'glass', detail: 'compact', review: 'auto' };

/** What the extension posts once the page says it is ready: an empty chat in `workspace`, in Ask. */
export async function answerReady(host: FakeHost, focused: boolean): Promise<void> {
  await host.post({ type: 'roots', roots: [] });
  await host.act({ type: 'reset', transcript: host.transcript });
  await host.post({ type: 'header', header: { project: 'workspace', title: undefined, branch: undefined } });
  await host.post({ type: 'window-focus', focused });
  await host.post({ type: 'modes', modes: MODES });
  await host.post({ type: 'commands', commands: [] });
}

/**
 * The extension's side of the chat webview's postMessage protocol, played by a test: it records what the view sends,
 * keeps the transcript with the extension's own reducer, and delivers what it posts as VS Code would.
 */
export class FakeHost {
  /** Every message the view sent, in order. */
  readonly received: FromView[] = [];
  private readonly consumed = new Map<FromView['type'], number>();
  private readonly waiters = new Set<() => void>();
  private readonly handlers = new Map<FromView['type'], (message: FromView) => void | Promise<void>>();
  private readonly running = new Set<Promise<void>>();
  private failure: unknown;

  constructor(
    private readonly deliver: (message: ToView) => Promise<void>,
    public transcript: Transcript,
  ) {}

  /** Called for each message the view sends. A handler may wait for later messages, so each runs on its own. */
  receive(message: FromView): void {
    this.received.push(message);
    for (const wake of this.waiters) wake();
    const handler = this.handlers.get(message.type);
    if (handler === undefined) return;
    const run = Promise.resolve()
      .then(() => handler(message))
      .catch((error: unknown) => void (this.failure ??= error))
      .finally(() => this.running.delete(run));
    this.running.add(run);
  }

  on<K extends FromView['type']>(type: K, handler: (message: MessageOf<K>) => void | Promise<void>): void {
    this.handlers.set(type, handler as (message: FromView) => void | Promise<void>);
  }

  /** The first message of `type` not yet returned by an earlier call, waiting up to `ms` for one to arrive. */
  async next<K extends FromView['type']>(type: K, ms = 10_000): Promise<MessageOf<K>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const from = this.consumed.get(type) ?? 0;
      const index = this.received.findIndex((m, i) => i >= from && m.type === type);
      if (index !== -1) {
        this.consumed.set(type, index + 1);
        return this.received[index] as MessageOf<K>;
      }
      if (Date.now() > deadline) throw new Error(`the view sent no ${type} within ${ms}ms; it sent ${this.received.map((m) => m.type).join(', ')}`);
      await new Promise<void>((resolve) => {
        const wake = () => (this.waiters.delete(wake), clearTimeout(timer), resolve());
        const timer = setTimeout(wake, deadline - Date.now());
        this.waiters.add(wake);
      });
    }
  }

  /** Changes the transcript as the extension's dispatch does: the reducer first, then the same action to the view. */
  async act(...actions: readonly Action[]): Promise<void> {
    for (const action of actions) {
      this.transcript = reduce(this.transcript, action);
      await this.deliver(action);
    }
  }

  /** Sends a message that is not a transcript change, such as the look, the header or the modes. */
  post(message: Exclude<ToView, Action>): Promise<void> {
    return this.deliver(message);
  }

  /** Resolves once every handler has finished, and rejects with the first one that threw. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running);
    if (this.failure !== undefined) throw this.failure;
  }
}
