import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { open as openFile, stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type * as vscode from 'vscode';
import { BACKEND_ENV_CAPABILITY, DIAGNOSTICS_CAPABILITY, EDITOR_ACTIONS_CAPABILITY, MEMORY_CAPABILITY, READ_TERMINAL_CAPABILITY, SCHEDULES_CAPABILITY, SPINOFF_CAPABILITY, TASKS_CAPABILITY, UNSAVED_BUFFERS_CAPABILITY, WIDGET_CAPABILITY } from '@g-code/core';

const RESTART_DELAY_MS = 1000;
/** How long a new engine process may take to listen. */
const START_TIMEOUT_MS = 20_000;
/** macOS caps a socket path at 104 bytes. */
const SOCKET_PATH_MAX = 103;

/** The ACP connection to the engine process, and the folder it serves. */
export type Connection = { readonly agent: acp.ClientContext; readonly socket: Socket; readonly cwd: string };

/** `env` is added to VS Code's own environment for the engine, and may hold the API key, so it is never logged. */
export type EngineSettings = { readonly cliPath: string; readonly cwd: string; readonly env: Readonly<Record<string, string>> };

/** The parts of VS Code's environment that change what the engine does, beside the settings' own variables. */
const ENGINE_INHERITS = /^(GCODE_|CLAUDE_CONFIG_DIR$|HOME$)/;

/**
 * Where the engine for these settings listens. Windows of one folder with the same model, key and engine build share
 * one engine, and a window that reloads finds it again. Changed settings name another, which the old one's windows
 * leave, so it ends once its turns do. The key goes in only as part of a hash.
 */
export function socketPathOf({ cliPath, cwd, env }: EngineSettings, inherited: NodeJS.ProcessEnv = process.env, dir = tmpdir()): string {
  const outer = Object.entries(inherited)
    .filter(([name]) => ENGINE_INHERITS.test(name))
    .toSorted(([a], [b]) => a.localeCompare(b));
  const own = Object.entries(env).toSorted(([a], [b]) => a.localeCompare(b));
  const hash = createHash('sha256').update(JSON.stringify({ cliPath, cwd, own, outer })).digest('hex').slice(0, 16);
  const socket = path.join(dir, `gcode-${hash}.sock`);
  return socket.length <= SOCKET_PATH_MAX ? socket : path.join('/tmp', `gcode-${hash}.sock`);
}

const dial = (socket: string): Promise<Socket | undefined> =>
  new Promise((resolve) => {
    const connection = createConnection(socket);
    connection.once('connect', () => resolve(connection));
    connection.once('error', () => resolve(undefined));
  });

/**
 * Keeps one connection to the engine process for this window's folder: the one already running, or one it starts
 * as a process of its own, which outlives the window so its turns go on through a reload. The engine's stderr goes
 * to a log beside its socket, which the output channel follows. `client` registers the handlers the engine calls.
 */
export class Engine implements vscode.Disposable {
  private current: Promise<Connection> | undefined;
  private disposed = false;
  private generation = 0;
  private following: ReturnType<typeof setInterval> | undefined;

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
    const settings = await this.settings();
    const { cwd } = settings;
    const socketPath = socketPathOf(settings);
    const log = `${socketPath.slice(0, -'.sock'.length)}.log`;
    const socket = (await dial(socketPath)) ?? (await this.launch(settings, socketPath, log));
    const generation = ++this.generation;
    void this.follow(log);
    socket.on('close', () => {
      this.output.appendLine('engine: connection closed');
      // A connection that is already replaced must not clear its successor.
      if (generation !== this.generation) return;
      this.current = undefined;
      if (!this.disposed) setTimeout(() => void this.restart(), RESTART_DELAY_MS);
    });
    socket.on('error', (error) => this.output.appendLine(`engine: ${error.message}`));
    const stream = acp.ndJsonStream(Writable.toWeb(socket) as WritableStream<Uint8Array>, Readable.toWeb(socket) as ReadableStream<Uint8Array>);
    const { agent } = this.client().connect(stream);
    await agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        session: { notices: {} },
        // ask_user's questions arrive as form elicitations, and remember's as permission requests shown as memory cards.
        elicitation: { form: {} },
        // Children are announced with subagent_update, and their own updates stream under their session ids.
        subagents: {},
        _meta: { [DIAGNOSTICS_CAPABILITY]: true, [UNSAVED_BUFFERS_CAPABILITY]: true, [MEMORY_CAPABILITY]: true, [WIDGET_CAPABILITY]: true, [TASKS_CAPABILITY]: true, [BACKEND_ENV_CAPABILITY]: true, [EDITOR_ACTIONS_CAPABILITY]: true, [READ_TERMINAL_CAPABILITY]: true, [SPINOFF_CAPABILITY]: true, [SCHEDULES_CAPABILITY]: true },
      },
      clientInfo: { name: 'g-code', version: '0.0.0' },
    });
    return { agent, socket, cwd };
  }

  /** Starts the engine process on its own, so it outlives this window, and connects once it listens. */
  private async launch({ cliPath, cwd, env }: EngineSettings, socketPath: string, log: string): Promise<Socket> {
    this.output.appendLine(`engine: ${cliPath} serve --socket ${socketPath} in ${cwd}`);
    const stderr = openSync(log, 'a');
    let exited: string | undefined;
    try {
      // VS Code's own runtime runs the engine, so it needs no node on PATH.
      const child = spawn(process.execPath, [cliPath, 'serve', '--socket', socketPath], {
        cwd,
        env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
        detached: true,
        stdio: ['ignore', 'ignore', stderr],
      });
      child.on('error', (error) => (exited = error.message));
      child.on('exit', (code, signal) => (exited = `exited with ${signal ?? `code ${code}`}`));
      child.unref();
    } finally {
      closeSync(stderr);
    }
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      const socket = await dial(socketPath);
      if (socket !== undefined) return socket;
      // Another window's engine may win the socket; this one then exits at once, and the dial finds the winner.
      if (Date.now() > deadline) throw new Error(`the engine did not start${exited === undefined ? '' : `: it ${exited}`}; see ${log}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Copies what the engine writes to its log into the output channel from now on. */
  private async follow(log: string): Promise<void> {
    clearInterval(this.following);
    let offset = await stat(log).then((s) => s.size, () => 0);
    this.following = setInterval(() => {
      void (async () => {
        const size = await stat(log).then((s) => s.size, () => offset);
        if (size <= offset) return;
        const file = await openFile(log, 'r');
        try {
          const { buffer, bytesRead } = await file.read(Buffer.alloc(size - offset), 0, size - offset, offset);
          offset += bytesRead;
          this.output.append(buffer.subarray(0, bytesRead).toString('utf8'));
        } finally {
          await file.close();
        }
      })().catch(() => {});
    }, 500);
  }

  private async restart(): Promise<void> {
    if (this.disposed || this.current !== undefined) return;
    await this.connection().catch((error: unknown) => this.output.appendLine(`engine: restart failed: ${String(error)}`));
  }

  /** Leaves the engine, so the next connection is to the one the current settings and key name. */
  reset(): void {
    void this.current?.then(({ socket }) => socket.destroy(), () => {});
  }

  /** Leaves the engine; its turns go on, and it exits once none runs and no window is connected. */
  dispose(): void {
    this.disposed = true;
    clearInterval(this.following);
    void this.current?.then(({ socket }) => socket.destroy(), () => {});
  }
}
