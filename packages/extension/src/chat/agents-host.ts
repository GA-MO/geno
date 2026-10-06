import { execFile, spawn, type ChildProcess, type ExecFileException } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { findExecutable } from '../executables.js';
import {
  agentEnv,
  agentOf,
  agentReducer,
  checksOnFocus,
  copyText,
  EXTERNAL_AGENTS,
  firstLink,
  linkLabel,
  searchDirs,
  shownOutput,
  type AdapterFound,
  type AgentAction,
  type AgentEvent,
  type AgentId,
  type AgentState,
  type AgentsFromView,
  type AgentsToView,
  type CheckResult,
  type ExternalAgent,
} from './agents-model.js';

const STATUS_TIMEOUT_MS = 30_000;

type Executed = { readonly error: ExecFileException | null; readonly stdout: string; readonly stderr: string };

const execute = (file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<Executed> =>
  new Promise((resolve) => execFile(file, args, { env, timeout: STATUS_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));

type Running ={ readonly child: ChildProcess; raw: string; link: string | undefined; cancelled: boolean };

/** SecretStorage's name for the agent's API key, outside `ENGINE_SECRETS`, so the engine never reads it. */
export const agentKeyName = (agent: ExternalAgent): string => `gcode.agents.${agent.id}.apiKey`;

/**
 * The extension's half of the Agents section. It finds each external agent's CLI, which the user installs
 * themselves, and runs only that CLI's own commands, without a shell. Geno never downloads or installs a CLI and
 * never reads its credentials: the page sees the output, redacted, and the sign-in address stays here until the
 * user asks to open it. An API key goes from the page into SecretStorage, and from there only into the env of the
 * CLI's own processes.
 */
export class AgentsHost implements vscode.Disposable {
  private readonly states = new Map<AgentId, AgentState>(EXTERNAL_AGENTS.map((agent) => [agent.id, { kind: 'checking' }]));
  private readonly running = new Map<AgentId, Running>();
  private readonly focus: vscode.Disposable;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly post: (message: AgentsToView) => void,
    private readonly secrets: vscode.SecretStorage,
  ) {
    // The user installs the CLI in a terminal or a browser; coming back to the window is when to look again.
    this.focus = vscode.window.onDidChangeWindowState((window) => {
      if (!window.focused) return;
      for (const agent of EXTERNAL_AGENTS) if (checksOnFocus(agent, this.states.get(agent.id)!)) void this.check(agent);
    });
  }

  private dispatch(agent: ExternalAgent, event: AgentEvent): AgentState {
    const next = agentReducer(this.states.get(agent.id)!, event);
    this.states.set(agent.id, next);
    this.post({ type: 'agent', id: agent.id, state: next });
    return next;
  }

  private async check(agent: ExternalAgent): Promise<void> {
    if (this.running.has(agent.id) || this.dispatch(agent, { type: 'check' }).kind !== 'checking') return;
    this.dispatch(agent, { type: 'checked', result: await this.probe(agent) });
  }

  /** Finds the agent's CLI and its adapter, and asks the CLI for its version and account. */
  private async probe(agent: ExternalAgent): Promise<CheckResult> {
    const node = agent.npmGlobal ? await findExecutable('node', process.env) : undefined;
    const dirs = searchDirs(agent, process.env, os.homedir(), node === undefined ? undefined : path.dirname(node));
    const first = async (names: readonly string[]) => {
      for (const name of names) {
        const found = await findExecutable(name, process.env, dirs);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    const cli = await first(agent.binaries);
    if (cli === undefined) return { kind: 'missing' };
    const adapterPath = agent.adapter.kind === 'built-in' ? undefined : await first(agent.adapter.binaries);
    const adapter: AdapterFound = agent.adapter.kind === 'built-in' ? { kind: 'built-in' } : adapterPath === undefined ? { kind: 'missing' } : { kind: 'found', path: adapterPath };
    const key = await this.secrets.get(agentKeyName(agent));
    const env = agentEnv(agent, process.env, key, agent.statusEnv);
    const version = agent.version === undefined ? undefined : agent.version.parse((await execute(cli, agent.version.args, env)).stdout);
    const { error, stdout, stderr } = await execute(cli, agent.status, env);
    const report = agent.parseStatus(stdout);
    if (report !== undefined) return { kind: 'found', path: cli, adapter, report: { ...report, version: report.version ?? version }, apiKey: key !== undefined };
    const text = error === null ? `${agent.label}'s CLI printed a status Geno cannot read.` : `${agent.label}'s status check failed: ${error.killed ? 'timed out' : error.message.split('\n')[0]}`;
    return { kind: 'failed', path: cli, adapter, text: shownOutput(text), output: shownOutput(`${stdout}${stderr}`) };
  }

  private async run(agent: ExternalAgent, action: AgentAction): Promise<void> {
    const way = agent.actions[action];
    if (this.running.has(agent.id) || way.kind !== 'run') return;
    const key = await this.secrets.get(agentKeyName(agent));
    const before = this.states.get(agent.id)!;
    const next = this.dispatch(agent, { type: 'start', action });
    if (next === before || !('cli' in next)) return;
    this.output.appendLine(`agents: running ${agent.label}'s ${[path.basename(next.cli.path), ...way.args].join(' ')}`);
    const child = spawn(next.cli.path, way.args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: agentEnv(agent, process.env, key) });
    const job: Running = { child, raw: '', link: undefined, cancelled: false };
    this.running.set(agent.id, job);
    const take = (chunk: string) => {
      job.raw += chunk;
      job.link ??= firstLink(job.raw);
      const link = job.link === undefined ? undefined : linkLabel(job.link);
      this.dispatch(agent, { type: 'output', output: shownOutput(job.raw), ...(link === undefined ? {} : { link }) });
    };
    child.stdout!.setEncoding('utf8').on('data', take);
    child.stderr!.setEncoding('utf8').on('data', take);
    let ended = false;
    const end = (code: number | null) => {
      if (ended) return;
      ended = true;
      this.running.delete(agent.id);
      this.output.appendLine(`agents: ${agent.label} ${action} ended: ${job.cancelled ? 'cancelled' : `exit ${code}`}`);
      this.dispatch(agent, { type: 'exit', code, cancelled: job.cancelled });
      void this.check(agent);
    };
    child.on('error', (error) => {
      take(`${error.message}\n`);
      end(null);
    });
    child.on('close', end);
  }

  private cancel(agent: ExternalAgent): void {
    const job = this.running.get(agent.id);
    if (job === undefined) return;
    job.cancelled = true;
    job.child.kill();
  }

  private async open(agent: ExternalAgent, target: 'sign-in' | 'install'): Promise<void> {
    const href = target === 'install' ? agent.install.url : this.running.get(agent.id)?.link;
    if (href === undefined || !href.startsWith('https://')) return;
    await vscode.env.openExternal(vscode.Uri.parse(href, true));
  }

  private async setKey(agent: ExternalAgent, key: string | undefined): Promise<void> {
    if (this.running.has(agent.id)) return;
    if (key === undefined) await this.secrets.delete(agentKeyName(agent));
    else await this.secrets.store(agentKeyName(agent), key);
    this.output.appendLine(`agents: ${key === undefined ? 'removed' : 'stored'} ${agent.label}'s API key`);
    await this.check(agent);
  }

  private act(id: string, effect: (agent: ExternalAgent) => unknown): void {
    const agent = agentOf(id);
    if (agent === undefined) return;
    void Promise.resolve()
      .then(() => effect(agent))
      .catch((error: unknown) => this.output.appendLine(`agents: ${error instanceof Error ? error.message : String(error)}`));
  }

  readonly handlers: { readonly [K in AgentsFromView['type']]: (message: Extract<AgentsFromView, { type: K }>) => void } = {
    'agents-check': () => {
      for (const agent of EXTERNAL_AGENTS) void this.check(agent);
    },
    'agents-run': ({ id, action }) => this.act(id, (agent) => Object.hasOwn(agent.actions, action) && this.run(agent, action)),
    'agents-cancel': ({ id }) => this.act(id, (agent) => this.cancel(agent)),
    'agents-copy': ({ id, what }) =>
      this.act(id, (agent) => {
        const text = copyText(agent, what);
        return text !== undefined && vscode.env.clipboard.writeText(text);
      }),
    'agents-key': ({ id, key }) => this.act(id, (agent) => typeof key === 'string' && key.trim() !== '' && this.setKey(agent, key.trim())),
    'agents-remove-key': ({ id }) => this.act(id, (agent) => this.setKey(agent, undefined)),
    'agents-open': ({ id, target }) => this.act(id, (agent) => (target === 'install' || target === 'sign-in') && this.open(agent, target)),
  };

  dispose(): void {
    this.focus.dispose();
    for (const job of this.running.values()) {
      job.cancelled = true;
      job.child.kill();
    }
  }
}
