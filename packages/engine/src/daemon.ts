import { chmod, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { LIMIT_FLAGS, limitsOf } from './agent.js';
import { UsageError, type Command, type Io } from './command.js';
import type { Limits } from './drive.js';
import { browserLauncherOf } from './mcp/browser.js';
import { mcpSessions } from './mcp/sessions.js';
import { engineShared, gcodeAgent } from './serve.js';
import { guardStdout } from './stdout-guard.js';
import type { Store } from './store.js';

/** How long the process waits, with no editor connected and no turn running, before it exits. */
export const IDLE_EXIT_MS = 10_000;

/** Whether something answers on `socket`; a file left by a process that died answers nothing. */
const answers = (socket: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createConnection(socket);
    probe.once('connect', () => (probe.destroy(), resolve(true)));
    probe.once('error', () => resolve(false));
  });

async function listen(server: Server, socket: string): Promise<void> {
  const attempt = () =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => (server.off('error', reject), resolve()));
    });
  try {
    await attempt();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || (await answers(socket))) throw error;
    await rm(socket, { force: true });
    await attempt();
  }
  // Only the user may drive the engine, which holds their keys.
  await chmod(socket, 0o600);
}

/**
 * The engine as a process of its own on a Unix socket, which editor windows connect to and come back to after a
 * reload. Every connection shares the sessions, so a turn goes on while no window is connected. The process exits
 * once no editor is connected and no turn runs for `idleMs`. Another process already on the socket wins: this one
 * exits with 0, and the editor connects to that one.
 */
export async function serveSocket(io: Io, store: Store, limits: Limits, socket: string, idleMs = IDLE_EXIT_MS): Promise<number> {
  const mcp = mcpSessions(store, io.env, io.err, browserLauncherOf(io.env));
  const shared = engineShared(io);
  // A crash cannot wait for a grace period; a command or an external agent left running would outlive the engine that owns it.
  const killJobs = () => (shared.jobs.killAllNow(), shared.externals.closeAll());
  process.once('exit', killJobs);
  const open = new Set<Socket>();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const watchIdle = () => {
    const isIdle = open.size === 0 && !shared.tasks.anyLive();
    if (!isIdle) {
      clearTimeout(idle);
      idle = undefined;
    } else idle ??= setTimeout(stop, idleMs);
  };
  shared.tasks.onChange(watchIdle);
  const server = createServer((connection) => {
    open.add(connection);
    watchIdle();
    const stream = acp.ndJsonStream(Writable.toWeb(connection) as WritableStream<Uint8Array>, Readable.toWeb(connection) as ReadableStream<Uint8Array>);
    const agent = gcodeAgent(io, store, limits, mcp, shared).connect(stream);
    const closed = () => {
      if (!open.delete(connection)) return;
      agent.close();
      watchIdle();
    };
    connection.on('close', closed);
    connection.on('error', closed);
    void agent.closed.then(() => connection.destroy());
  });
  try {
    await listen(server, socket);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      io.err(`gcode serve: another engine already serves ${socket}`);
      return 0;
    }
    throw error;
  }
  io.err(`gcode serve: ACP v${acp.PROTOCOL_VERSION} on ${socket}, sessions in ${store.sessionsDir}`);
  watchIdle();
  await stopped;
  io.err('gcode serve: idle, exiting');
  server.close();
  await shared.jobs.kill('engine-exit', 'all');
  shared.externals.closeAll();
  process.off('exit', killJobs);
  await mcp.stopAll();
  await rm(socket, { force: true });
  return 0;
}

/**
 * `gcode serve --stdio` serves one editor on stdin and stdout and ends with it, as Zed runs an agent. `gcode serve
 * --socket <path>` is the engine process editor windows share and come back to.
 */
export const serve: Command = async (args, { io, store }) => {
  const { values } = parseArgs({
    args,
    strict: true,
    options: { stdio: { type: 'boolean', default: false }, socket: { type: 'string' }, 'idle-ms': { type: 'string' }, ...LIMIT_FLAGS },
  });
  if (values.stdio === (values.socket !== undefined)) throw new UsageError('serve needs one transport: --stdio, or --socket <path>');
  // Everything the engine prints goes to stderr: stdout carries the protocol on stdio, and a socket engine has no terminal.
  const quiet: Io = { ...io, out: io.err, write: () => {} };
  if (values.socket !== undefined) {
    const idle = values['idle-ms'] === undefined ? IDLE_EXIT_MS : Number(values['idle-ms']);
    if (!Number.isInteger(idle) || idle < 0) throw new UsageError('--idle-ms must be a whole number of milliseconds');
    return serveSocket(quiet, store, limitsOf(values), values.socket, idle);
  }
  const stream = acp.ndJsonStream(guardStdout(), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  const mcp = mcpSessions(store, io.env, quiet.err, browserLauncherOf(io.env));
  const shared = engineShared(quiet);
  process.once('exit', () => (shared.jobs.killAllNow(), shared.externals.closeAll()));
  const connection = gcodeAgent(quiet, store, limitsOf(values), mcp, shared).connect(stream);
  quiet.err(`gcode serve: ACP v${acp.PROTOCOL_VERSION} on stdio, sessions in ${store.sessionsDir}`);
  await connection.closed;
  await shared.jobs.kill('engine-exit', 'all');
  shared.externals.closeAll();
  await mcp.stopAll();
  return 0;
};
