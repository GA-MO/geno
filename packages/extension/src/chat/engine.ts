import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type * as vscode from 'vscode';
import { DIAGNOSTICS_CAPABILITY, MEMORY_CAPABILITY, UNSAVED_BUFFERS_CAPABILITY } from '@g-code/core';

const RESTART_DELAY_MS = 1000;

/** A running `gcode serve --stdio`, the ACP connection to it, and the folder it serves. */
export type Connection = { readonly agent: acp.ClientContext; readonly child: ChildProcess; readonly cwd: string };

/** `env` is added to VS Code's own environment for the engine, and may hold the API key, so it is never logged. */
export type EngineSettings = { readonly cliPath: string; readonly cwd: string; readonly env: Readonly<Record<string, string>> };

/**
 * Keeps one engine child process: started on first use, restarted after it exits, its stderr shown in the
 * output channel. `client` registers the handlers the engine calls back into.
 */
export class Engine implements vscode.Disposable {
  private current: Promise<Connection> | undefined;
  private disposed = false;
  private generation = 0;

  constructor(
    private readonly settings: () => Promise<EngineSettings>,
    private readonly client: () => acp.ClientApp,
    private readonly output: vscode.OutputChannel,
  ) {}

  connection(): Promise<Connection> {
    this.current ??= this.start().catch((error: unknown) => {
      this.current = undefined;
      throw error;
    });
    return this.current;
  }

  private async start(): Promise<Connection> {
    const { cliPath, cwd, env } = await this.settings();
    this.output.appendLine(`engine: ${cliPath} serve --stdio in ${cwd}`);
    // VS Code's own runtime runs the engine, so it needs no node on PATH.
    const child = spawn(process.execPath, [cliPath, 'serve', '--stdio'], {
      cwd,
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const generation = ++this.generation;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => this.output.append(chunk));
    child.on('error', (error) => this.output.appendLine(`engine: ${error.message}`));
    child.on('exit', (code, signal) => {
      this.output.appendLine(`engine: exited with ${signal ?? `code ${code}`}`);
      // A process that is already replaced must not clear its successor.
      if (generation !== this.generation) return;
      this.current = undefined;
      if (!this.disposed) setTimeout(() => void this.restart(), RESTART_DELAY_MS);
    });
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const { agent } = this.client().connect(stream);
    await agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        session: { notices: {} },
        // ask_user's questions arrive as form elicitations, and remember's as permission requests shown as memory cards.
        elicitation: { form: {} },
        _meta: { [DIAGNOSTICS_CAPABILITY]: true, [UNSAVED_BUFFERS_CAPABILITY]: true, [MEMORY_CAPABILITY]: true },
      },
      clientInfo: { name: 'g-code', version: '0.0.0' },
    });
    return { agent, child, cwd };
  }

  private async restart(): Promise<void> {
    if (this.disposed || this.current !== undefined) return;
    await this.connection().catch((error: unknown) => this.output.appendLine(`engine: restart failed: ${String(error)}`));
  }

  /** Stops the running engine, so the next one starts with the current settings and key. */
  reset(): void {
    void this.current?.then(({ child }) => child.kill(), () => {});
  }

  dispose(): void {
    this.disposed = true;
    void this.current?.then(({ child }) => child.kill(), () => {});
  }
}
