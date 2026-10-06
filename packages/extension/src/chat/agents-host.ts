import { execFile, spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { findExecutable } from '../executables.js';
import {
  agentOf,
  agentReducer,
  EXTERNAL_AGENTS,
  firstLink,
  linkLabel,
  shownOutput,
  type AgentEvent,
  type AgentId,
  type AgentState,
  type AgentsFromView,
  type AgentsToView,
  type CheckResult,
  type ExternalAgent,
} from './agents-model.js';

const STATUS_TIMEOUT_MS = 30_000;

type Running = { readonly child: ChildProcess; raw: string; link: string | undefined; cancelled: boolean };

/**
 * The extension's half of the Agents section. It finds each external agent's CLI and runs only that CLI's own
 * commands, without a shell. Geno never reads the CLI's credentials: the page sees the output, redacted, and the
 * sign-in address stays here until the user asks to open it.
 */
export class AgentsHost implements vscode.Disposable {
  private readonly states = new Map<AgentId, AgentState>(EXTERNAL_AGENTS.map((agent) => [agent.id, { kind: 'checking' }]));
  private readonly running = new Map<AgentId, Running>();
  private readonly installers = new Map<vscode.Terminal, ExternalAgent>();
  private readonly closing: vscode.Disposable;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly post: (message: AgentsToView) => void,
  ) {
    this.closing = vscode.window.onDidCloseTerminal((terminal) => {
      const agent = this.installers.get(terminal);
      if (agent === undefined) return;
      this.installers.delete(terminal);
      void this.check(agent);
    });
  }

  /** Runs the official installer in a terminal of its own, in front of the user, and checks again when it closes. */
  private install(agent: ExternalAgent): void {
    if (this.states.get(agent.id)?.kind !== 'missing') return;
    this.dispatch(agent, { type: 'install' });
    const terminal = vscode.window.createTerminal({ name: `Install ${agent.label} CLI` });
    this.installers.set(terminal, agent);
    terminal.show();
    terminal.sendText(agent.install.command);
    this.output.appendLine(`agents: opened a terminal to install ${agent.label}'s CLI: ${agent.install.command}`);
  }

  private dispatch(agent: ExternalAgent, event: AgentEvent): void {
    const next = agentReducer(this.states.get(agent.id)!, event);
    this.states.set(agent.id, next);
    this.post({ type: 'agent', id: agent.id, state: next });
  }

  private async check(agent: ExternalAgent): Promise<void> {
    if (this.running.has(agent.id)) return;
    this.dispatch(agent, { type: 'check' });
    this.dispatch(agent, { type: 'checked', result: await probe(agent) });
  }

  private run(agent: ExternalAgent, action: keyof ExternalAgent['commands']): void {
    const state = this.states.get(agent.id)!;
    if (this.running.has(agent.id) || !('cli' in state)) return;
    this.dispatch(agent, { type: 'start', action });
    if (this.states.get(agent.id) === state) return;
    this.output.appendLine(`agents: running ${agent.label}'s ${[path.basename(state.cli.path), ...agent.commands[action]].join(' ')}`);
    const child = spawn(state.cli.path, agent.commands[action], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
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

  readonly handlers: { readonly [K in AgentsFromView['type']]: (message: Extract<AgentsFromView, { type: K }>) => void } = {
    'agents-check': () => {
      for (const agent of EXTERNAL_AGENTS) void this.check(agent);
    },
    'agents-run': ({ id, action }) => {
      const agent = agentOf(id);
      if (agent !== undefined && Object.hasOwn(agent.commands, action)) this.run(agent, action);
    },
    'agents-install': ({ id }) => {
      const agent = agentOf(id);
      if (agent !== undefined) this.install(agent);
    },
    'agents-cancel': ({ id }) => {
      const agent = agentOf(id);
      if (agent !== undefined) this.cancel(agent);
    },
    'agents-open': ({ id, target }) => {
      const agent = agentOf(id);
      if (agent !== undefined) void this.open(agent, target).catch((error: unknown) => this.output.appendLine(`agents: ${String(error)}`));
    },
  };

  dispose(): void {
    this.closing.dispose();
    for (const job of this.running.values()) {
      job.cancelled = true;
      job.child.kill();
    }
  }
}

/** Finds the agent's CLI and asks it for its version and account. */
async function probe(agent: ExternalAgent): Promise<CheckResult> {
  const dirs = agent.homeDirs.map((dir) => path.join(os.homedir(), dir));
  let found: string | undefined;
  for (const name of agent.binaries) found ??= await findExecutable(name, process.env, dirs);
  if (found === undefined) return { kind: 'missing' };
  const cli = found;
  return new Promise((resolve) => {
    // No browser on a status check, should the CLI decide it needs one.
    execFile(cli, agent.status, { env: { ...process.env, NO_OPEN_BROWSER: '1' }, timeout: STATUS_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout, stderr) => {
      const report = agent.parseStatus(stdout);
      if (report !== undefined) return resolve({ kind: 'found', path: cli, report });
      const text = error === null ? `${agent.label}'s CLI printed a status Geno cannot read.` : `${agent.label}'s status check failed: ${error.killed ? 'timed out' : error.message.split('\n')[0]}`;
      resolve({ kind: 'failed', path: cli, text: shownOutput(text), output: shownOutput(`${stdout}${stderr}`) });
    });
  });
}
