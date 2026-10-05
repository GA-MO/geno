import { setTimeout as sleep } from 'node:timers/promises';
import { describeServerState, nextServerState, restartDelayMs, type McpServerConfig, type McpServerEvent, type McpServerState } from '@g-code/core';
import type { Env } from '../child-env.js';
import { ToolError } from '../tools/context.js';
import { connectMcp, McpConnectError, type McpCallResult, type McpConnection } from './connection.js';

/** One server of a session: the state machine of core's nextServerState, driven by real connections. */
export class McpServerHandle {
  #state: McpServerState;
  #connection: McpConnection | undefined;
  /** The start or restart in flight, which a call waits for. */
  #pending: Promise<void> = Promise.resolve();

  constructor(
    readonly config: McpServerConfig,
    trusted: boolean,
    disabled: boolean,
    private readonly env: Env,
    private readonly workspace: string,
  ) {
    this.#state = disabled ? { status: 'disabled', trusted } : trusted ? { status: 'stopped' } : { status: 'untrusted' };
  }

  get state(): McpServerState {
    return this.#state;
  }

  get tools() {
    return this.#state.status === 'ready' ? (this.#connection?.tools ?? []) : [];
  }

  get connection(): McpConnection | undefined {
    return this.#state.status === 'ready' ? this.#connection : undefined;
  }

  #apply(event: McpServerEvent): void {
    this.#state = nextServerState(this.#state, event);
  }

  trust(): void {
    this.#apply({ type: 'trusted' });
  }

  enable(): void {
    this.#apply({ type: 'enable' });
  }

  /** Stops the server, if it runs, and keeps it from starting until enabled. */
  async disable(): Promise<void> {
    const connection = this.#connection;
    this.#connection = undefined;
    this.#apply({ type: 'disable' });
    await connection?.close();
  }

  /** Starts a stopped server and waits for a start in flight. An untrusted or disabled server never gets past here. */
  ready(): Promise<void> {
    if (this.#state.status === 'stopped') {
      this.#apply({ type: 'start' });
      this.#pending = this.#connect();
    }
    return this.#pending;
  }

  #connect(): Promise<void> {
    return (async () => {
      try {
        const connection = await connectMcp(this.config, { env: this.env, workspace: this.workspace, onLost: (reason) => this.#lost(reason) });
        if (this.#state.status !== 'starting') {
          await connection.close();
          return;
        }
        this.#connection = connection;
        this.#apply({ type: 'connected' });
      } catch (error) {
        const needsSignIn = error instanceof McpConnectError && error.needsSignIn;
        this.#apply({ type: 'connect-failed', reason: error instanceof Error ? error.message : String(error), needsSignIn });
      }
    })();
  }

  #lost(reason: string): void {
    this.#connection = undefined;
    this.#apply({ type: 'crashed', reason });
    const state = this.#state;
    if (state.status !== 'starting') return;
    this.#pending = sleep(restartDelayMs(state.restarts)).then(() => (this.#state === state ? this.#connect() : undefined));
  }

  async call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    await this.ready();
    const connection = this.connection;
    if (connection === undefined) throw new ToolError(`the MCP server ${this.config.name} is ${describeServerState(this.#state)}`);
    try {
      return await connection.call(tool, args, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ToolError(`the MCP server ${this.config.name} failed the call: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async stop(): Promise<void> {
    const connection = this.#connection;
    this.#connection = undefined;
    this.#apply({ type: 'stop' });
    await connection?.close();
  }
}
