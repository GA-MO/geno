import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type * as vscode from 'vscode';
import { DIAGNOSTICS_CAPABILITY } from '@g-code/core';

const RESTART_DELAY_MS = 1000;

/** A running `gcode serve --stdio` and the ACP connection to it. */
export type Connection = { readonly agent: acp.ClientContext; readonly child: ChildProcess };

export type EngineSettings = { readonly cliPath: string; readonly cwd: string };

/**
 * Keeps one engine child process: started on first use, restarted after it exits, its stderr shown in the
 * output channel. `client` registers the handlers the engine calls back into.
 */
export class Engine implements vscode.Disposable {
  private current: Promise<Connection> | undefined;
  private disposed = false;
  private generation = 0;

  constructor(
    private readonly settings: () => EngineSettings,
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
    const { cliPath, cwd } = this.settings();
    this.output.appendLine(`engine: node ${cliPath} serve --stdio in ${cwd}`);
    const child = spawn('node', [cliPath, 'serve', '--stdio'], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
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
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, _meta: { [DIAGNOSTICS_CAPABILITY]: true } },
      clientInfo: { name: 'g-code', version: '0.0.0' },
    });
    return { agent, child };
  }

  private async restart(): Promise<void> {
    if (this.disposed || this.current !== undefined) return;
    await this.connection().catch((error: unknown) => this.output.appendLine(`engine: restart failed: ${String(error)}`));
  }

  dispose(): void {
    this.disposed = true;
    void this.current?.then(({ child }) => child.kill(), () => {});
  }
}
