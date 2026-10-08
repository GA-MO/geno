import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import {
  agentSetupOf,
  credentialPlaces,
  EXTERNAL_BACKEND_IDS,
  EXTERNAL_BACKENDS,
  type AgentSetup,
  type AskConfig,
  type BackendAvailability,
  type BackendInfo,
  type ExternalBackend,
  type SessionSetupShape,
} from '@g-code/core';
import { childEnv, type Env } from './child-env.js';
import { EngineError } from './errors.js';

const HOMEBREW_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

const executable = (file: string): Promise<boolean> => access(file, constants.X_OK).then(() => true, () => false);

/**
 * The agent's command: on PATH, then in `~/.local/bin`, where Cursor's installer puts it, then Homebrew's folders, then
 * npm's global bin folders, where an adapter such as claude-agent-acp lands. npm itself is not run.
 */
export async function findBackend(backend: ExternalBackend, env: Env): Promise<BackendAvailability> {
  const home = env['HOME'] || homedir();
  const npm = [env['NPM_CONFIG_PREFIX'], env['npm_config_prefix']].flatMap((prefix) => (prefix ? [path.join(prefix, 'bin')] : []));
  const dirs = [
    ...(env['PATH'] ?? '').split(path.delimiter).filter(Boolean),
    path.join(home, '.local/bin'),
    ...HOMEBREW_DIRS,
    ...npm,
    ...(env['NVM_BIN'] ? [env['NVM_BIN']] : []),
    path.join(home, '.npm-global/bin'),
  ];
  for (const name of backend.binaries) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (await executable(candidate)) return { kind: 'ready', path: candidate };
    }
  }
  return { kind: 'missing', reason: `${backend.label} needs ${backend.binaries.map((b) => `\`${b}\``).join(' or ')}, which is not installed. ${backend.install}` };
}

export async function backendInfos(env: Env): Promise<BackendInfo[]> {
  return Promise.all(
    EXTERNAL_BACKEND_IDS.map(async (id) => {
      const backend = EXTERNAL_BACKENDS[id];
      return { id, label: backend.label, plan: backend.plan, availability: await findBackend(backend, env) };
    }),
  );
}

/** What the agent's process routes to the turn that runs now; between turns nothing is routed. */
export type AgentHandlers = {
  update(update: acp.SessionUpdate): void;
  permission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
};

export type AgentExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stderr: string };

/** One running agent process and its ACP connection. */
export type AgentProcess = {
  readonly backend: ExternalBackend;
  readonly agent: acp.ClientContext;
  readonly initialized: acp.InitializeResponse;
  readonly sandboxed: boolean;
  /** Settles when the process exits, for whatever reason. */
  readonly exited: Promise<AgentExit>;
  /** True once the process has exited. */
  dead(): boolean;
  route(sessionId: string, handlers: AgentHandlers | undefined): void;
  kill(): void;
};

const STDERR_LIMIT = 4000;
const INITIALIZE_TIMEOUT_MS = 60_000;

/**
 * Where the sandbox host is: beside this module, built or in source. In VS Code the engine's runtime is the editor's
 * Electron helper, which runs a script as Node only when ELECTRON_RUN_AS_NODE says so.
 */
function sandboxHost(): { readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> } {
  const here = fileURLToPath(import.meta.url);
  const extension = path.extname(here);
  const host = path.join(path.dirname(here), `sandbox-host${extension}`);
  const env = process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' };
  return extension === '.ts' ? { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), host], env } : { command: process.execPath, args: [host], env };
}

const shellQuote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/** Geno's sandbox around the agent: writes to the lane, the temp folder and the agent's own state; reads of keys denied. */
async function sandboxSpec(backend: ExternalBackend, command: string, cwd: string, tempDir: string, writable: readonly string[], env: Env) {
  const sandbox = backend.sandbox!;
  const home = env['HOME'] || homedir();
  const real = async (p: string) => realpath(p).catch(() => p);
  for (const dir of sandbox.writableSystem) await mkdir(dir, { recursive: true });
  return {
    command,
    hosts: [...sandbox.hosts],
    writable: [await real(cwd), await real(tempDir), ...(await Promise.all(writable.map(real))), ...sandbox.writableHome.map((p) => path.join(home, p)), ...(await Promise.all(sandbox.writableSystem.map(real)))],
    denyRead: credentialPlaces(home),
    readable: [await real(cwd)],
  };
}

export type StartOptions = {
  readonly backend: ExternalBackend;
  readonly command: string;
  /** Where the process starts; each agent session names its own cwd. */
  readonly cwd: string;
  /** The agent's own temp folder, its TMPDIR; the only temp space a sandboxed agent may write. */
  readonly tempDir: string;
  readonly env: Env;
  /** The user's key for the agent, when one was chosen. */
  readonly key: string | undefined;
  readonly sandbox: boolean;
  /** More places the sandboxed agent may write, such as the lane's part of the shared git folder. */
  readonly writable: readonly string[];
  readonly err: (line: string) => void;
};

/**
 * A home for the agent that is the user's own, every entry linked in, except the ask config, which Geno writes. Only
 * the names of the entries are read. Its own state files land in the overlay or, through the links, where they were.
 */
export async function overlayHome(realHome: string, into: string, ask: AskConfig): Promise<string> {
  const home = await mkdtemp(path.join(into, 'home-'));
  const fill = async (real: string, dir: string, parts: readonly string[]): Promise<void> => {
    const [head, ...tail] = parts;
    for (const name of await readdir(real).catch(() => [])) if (name !== head) await symlink(path.join(real, name), path.join(dir, name));
    if (tail.length === 0) return;
    await mkdir(path.join(dir, head!));
    await fill(path.join(real, head!), path.join(dir, head!), tail);
  };
  await fill(realHome, home, ask.file.split('/'));
  await writeFile(path.join(home, ask.file), `${JSON.stringify(ask.config, null, 2)}\n`);
  return home;
}

/** Starts the agent and initializes it. Its capabilities decide everything later; nothing about it is assumed. */
export async function startAgent(options: StartOptions): Promise<AgentProcess> {
  const { backend } = options;
  const sandboxed = options.sandbox && backend.sandbox !== undefined;
  const args = [...(sandboxed ? backend.sandbox!.args : []), ...backend.args];
  const realHome = options.env['HOME'] || homedir();
  const home = backend.ask === undefined ? undefined : await overlayHome(realHome, options.tempDir, backend.ask);
  const env = childEnv(options.env, {
    ...(home === undefined ? {} : { HOME: home }),
    TMPDIR: options.tempDir,
    NO_OPEN_BROWSER: '1',
    ...(backend.keyEnv !== undefined && options.key !== undefined ? { [backend.keyEnv]: options.key } : {}),
  });
  let child: ChildProcess;
  if (sandboxed) {
    const host = sandboxHost();
    const spec = await sandboxSpec(backend, [options.command, ...args].map(shellQuote).join(' '), options.cwd, options.tempDir, options.writable, options.env);
    // The overlay sits in the temp folder, which is writable; through its links the agent reaches only what the spec allows.
    child = spawn(host.command, [...host.args, Buffer.from(JSON.stringify(spec)).toString('base64')], { cwd: options.cwd, env: { ...env, ...host.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    child = spawn(options.command, args, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT);
  });
  let isDead = false;
  const exited = new Promise<AgentExit>((resolve) => {
    child.on('error', (error) => {
      stderr += `\n${error.message}`;
    });
    child.on('close', (code, signal) => {
      isDead = true;
      resolve({ code, signal, stderr });
    });
  });
  const routes = new Map<string, AgentHandlers>();
  const app = acp
    .client({ name: 'gcode' })
    .onNotification(acp.methods.client.session.update, ({ params }) => routes.get(params.sessionId)?.update(params.update))
    .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
      const handlers = routes.get(params.sessionId);
      // A request with no turn to answer it, such as one that arrives after a cancel, is cancelled.
      return handlers === undefined ? { outcome: { outcome: 'cancelled' } } : handlers.permission(params);
    });
  const connection = app.connect(acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
  void exited.then(() => connection.close(new EngineError(`${backend.label} stopped`)));
  // SIGTERM first: the sandbox host kills the agent's whole process group on it, which a SIGKILL would skip.
  const kill = () => {
    if (isDead) return;
    child.kill(sandboxed ? 'SIGTERM' : 'SIGKILL');
    if (sandboxed) setTimeout(() => !isDead && child.kill('SIGKILL'), 2000).unref();
  };
  try {
    const initialized = await Promise.race([
      connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        // The agent reads, writes and runs commands itself, in its lane; Geno lends it no editor buffers or terminal.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'gcode', version: '0.0.0' },
      }),
      exited.then((exit) => Promise.reject(new EngineError(exitText(backend, exit)))),
      new Promise<never>((_, reject) => setTimeout(() => reject(new EngineError(`${backend.label} did not answer initialize within ${INITIALIZE_TIMEOUT_MS / 1000}s`)), INITIALIZE_TIMEOUT_MS).unref()),
    ]);
    options.err(`backend: ${backend.id} pid ${child.pid}${sandboxed ? ' in Geno’s sandbox' : ''}, protocol ${initialized.protocolVersion}, loadSession ${initialized.agentCapabilities?.loadSession === true}`);
    return {
      backend,
      agent: connection.agent,
      initialized,
      sandboxed,
      exited,
      dead: () => isDead,
      route: (sessionId, handlers) => (handlers === undefined ? routes.delete(sessionId) : routes.set(sessionId, handlers)),
      kill,
    };
  } catch (error) {
    // A process that dies at start closes the stream before its exit lands; wait a moment so the error says why.
    const exit = await Promise.race([exited, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1000).unref())]);
    kill();
    throw exit === undefined ? error : new EngineError(exitText(backend, exit));
  }
}

/** Why the agent's process ended, with the end of what it printed, as a turn's error says it. */
export function exitText(backend: ExternalBackend, exit: AgentExit): string {
  const how = exit.signal !== null ? `was killed (${exit.signal})` : `exited with code ${exit.code}`;
  const tail = exit.stderr.trim().split('\n').slice(-5).join('\n');
  return `${backend.label} stopped: its process ${how}${tail === '' ? '' : `:\n${tail}`}`;
}

/** An agent session: the id the agent gave it and what `session/new` or `session/load` said it offers. */
export type AgentSession = { readonly id: string; readonly setup: AgentSetup; readonly loaded: boolean };

/** Opens a session at `cwd`: loads `resume` when the agent can, otherwise starts a new one. */
export async function openAgentSession(agent: AgentProcess, cwd: string, resume: string | undefined): Promise<AgentSession> {
  const canLoad = agent.initialized.agentCapabilities?.loadSession === true;
  if (resume !== undefined && canLoad) {
    // A load replays the agent's history as updates. Nothing routes them yet, so the turn does not log it twice.
    try {
      const loaded = await agent.agent.request(acp.methods.agent.session.load, { sessionId: resume, cwd, mcpServers: [] });
      return { id: resume, setup: agentSetupOf(loaded as SessionSetupShape), loaded: true };
    } catch {
      // The agent no longer has it; a new one follows.
    }
  }
  const created = await agent.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
  return { id: created.sessionId, setup: agentSetupOf(created as SessionSetupShape), loaded: false };
}

/** An empty folder for a session that only reads what the agent offers, so it starts nowhere near the user's files. */
export const probeDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'gcode-backend-'));
