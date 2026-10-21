import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import type { ContentBlock, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import * as acp from '@agentclientprotocol/sdk';
import {
  accessOf,
  acpToolKindOf,
  agentModeFor,
  classifierInputOf,
  EXTERNAL_BACKENDS,
  externalAnswer,
  externalDenialFor,
  externalTitle,
  externalToolUse,
  MODEL_CONFIG_ID,
  modelNameOf,
  nextSeq,
  ZERO_USAGE,
  type AgentSetup,
  type ApprovalRecord,
  type BackendBinding,
  type DoneReason,
  type ExternalBackend,
  type ExternalCall,
  type SessionMode,
  type ToolStatus,
  type TurnEvent,
} from '@g-code/core';
import type { Io } from './command.js';
import type { Surface } from './drive.js';
import { EngineError } from './errors.js';
import { laneFor } from './lane-hooks.js';
import { bindSession, laneAt, laneRepoOf, requireLane } from './lanes.js';
import { exitText, findBackend, openAgentSession, probeDir, startAgent, type AgentProcess, type AgentSession } from './backends.js';
import { appendEvent, type SessionLog } from './sessions.js';
import type { Store } from './store.js';
import { settle, type Approval } from './tools/agent.js';

/** One Geno session's agent: its process, the session that runs its turns once one has, and what it offers. */
type Link = {
  readonly process: AgentProcess;
  /** What the sandbox lets it write beyond its temp folder. */
  readonly writable: readonly string[];
  /** Undefined until the first turn opens it in the lane; the setup until then comes from a probe session. */
  session: AgentSession | undefined;
  setup: AgentSetup;
  /** The model and agent mode last set on `session`. */
  model: string | undefined;
  mode: string | undefined;
};

/** How the engine gets what the user chose for an agent, such as its API key; undefined when nobody can say. */
export type KeyOf = (backend: ExternalBackend) => Promise<string | undefined>;

/** An agent's tool call id as Geno logs and shows it; Cursor's ids can hold a newline, which a step's id must not. */
export const genoCallId = (id: string): string => (/^[\w.:-]+$/.test(id) ? id : `ext_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`);

/** Waiting this long after a cancel for the agent to end its turn, before its process is killed. */
export const CANCEL_GRACE_MS = 5000;
const EXIT_WAIT_MS = 1000;

const lastOf = <K extends TurnEvent['kind']>(events: readonly TurnEvent[], kind: K) => events.findLast((e): e is Extract<TurnEvent, { kind: K }> => e.kind === kind);

/** The model an external session last chose, logged, or undefined for the agent's default. */
export const chosenModelOf = (events: readonly TurnEvent[]): string | undefined => lastOf(events, 'backend-model')?.model;

/**
 * Every external agent the engine runs, one per Geno session, kept across turns: an agent's own conversation lives in
 * its process. A process that died is started again on the session's next turn.
 */
export class ExternalAgents {
  private readonly links = new Map<string, Link>();
  private readonly starting = new Map<string, Promise<Link>>();

  constructor(private readonly io: Io) {}

  /** The running link of a session, if its process is alive. */
  live(sessionId: string): Link | undefined {
    const link = this.links.get(sessionId);
    return link !== undefined && !link.process.dead() ? link : undefined;
  }

  /**
   * The session's agent, started when it is not running. A new process reads what the agent offers from a probe
   * session in an empty folder, so a picker can list its models before the first prompt names a lane.
   */
  async ensure(sessionId: string, binding: BackendBinding, keyOf: KeyOf, writable: readonly string[] = []): Promise<Link> {
    const running = this.live(sessionId);
    // A sandbox's rules are fixed when it starts, so an agent started before its lane was known starts again with it.
    const covered = (link: Link) => !link.process.sandboxed || writable.every((p) => link.writable.includes(p));
    if (running !== undefined && covered(running)) return running;
    if (running !== undefined) this.close(sessionId);
    const pending = this.starting.get(sessionId);
    if (pending !== undefined) return pending;
    const start = (async () => {
      const backend = EXTERNAL_BACKENDS[binding.id];
      const found = await findBackend(backend, this.io.env);
      if (found.kind === 'missing') throw new EngineError(found.reason);
      const probe = await probeDir();
      const process = await startAgent({
        backend,
        command: found.path,
        cwd: probe,
        tempDir: probe,
        env: this.io.env,
        key: await keyOf(backend).catch(() => undefined),
        sandbox: this.io.env['GCODE_BACKEND_SANDBOX'] !== 'off',
        writable,
        err: this.io.err,
      });
      try {
        const probed = await openAgentSession(process, probe, undefined);
        const link: Link = { process, writable, session: undefined, setup: probed.setup, model: probed.setup.models?.current, mode: probed.setup.modes?.current };
        this.links.set(sessionId, link);
        void process.exited.then(() => {
          if (this.links.get(sessionId) === link) this.links.delete(sessionId);
        });
        return link;
      } catch (error) {
        process.kill();
        throw error;
      }
    })();
    this.starting.set(sessionId, start);
    try {
      return await start;
    } finally {
      this.starting.delete(sessionId);
    }
  }

  /** What the session's agent offers, as last seen. */
  setupOf(sessionId: string): AgentSetup | undefined {
    return this.links.get(sessionId)?.setup;
  }

  /** Switches the running agent to `model`, if it runs; the log holds the choice for one that starts later. */
  async setModel(sessionId: string, model: string): Promise<void> {
    const link = this.live(sessionId);
    if (link?.session === undefined) return;
    await applyModel(link, model);
  }

  /** Puts the running agent in the mode a Geno mode asks for. */
  async setMode(sessionId: string, mode: SessionMode): Promise<void> {
    const link = this.live(sessionId);
    if (link?.session === undefined) return;
    await applyMode(link, mode);
  }

  close(sessionId: string): void {
    this.links.get(sessionId)?.process.kill();
    this.links.delete(sessionId);
  }

  closeAll(): void {
    for (const link of this.links.values()) link.process.kill();
    this.links.clear();
  }
}

async function applyModel(link: Link, model: string): Promise<void> {
  const models = link.setup.models;
  if (link.session === undefined || models === undefined || link.model === model) return;
  const sessionId = link.session.id;
  const { source } = models;
  if (source.kind === 'config') await link.process.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: source.configId, value: model });
  else if (source.kind === 'models') await link.process.agent.request('session/set_model', { sessionId, modelId: model });
  else await link.process.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: model });
  link.model = model;
}

async function applyMode(link: Link, mode: SessionMode): Promise<void> {
  const modes = link.setup.modes;
  const wanted = agentModeFor(modes, mode);
  if (link.session === undefined || modes === undefined || wanted === undefined || link.mode === wanted) return;
  const sessionId = link.session.id;
  if (modes.source.kind === 'config') await link.process.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: modes.source.configId, value: wanted });
  else await link.process.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: wanted });
  link.mode = wanted;
}

/** The composer's model menu for an external session, as an ACP select config option. */
export function modelConfigOptions(setup: AgentSetup | undefined, chosen: string | undefined): acp.SessionConfigOption[] {
  const models = setup?.models;
  if (models === undefined || models.available.length === 0) return [];
  return [
    {
      id: MODEL_CONFIG_ID,
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: chosen ?? models.current,
      options: models.available.map(({ id, name }) => ({ value: id, name })),
    },
  ];
}

/** Where the agent works: the session's own lane, or a lane made for it on its first turn and kept after. */
async function laneOf(io: Io, store: Store, log: SessionLog, prompt: string): Promise<{ readonly cwd: string; readonly lane: string | null; readonly writable: readonly string[] }> {
  const { workspace } = log.session;
  const home = io.env['HOME'] || homedir();
  const own = await laneAt(workspace, home);
  if (own !== undefined) return { cwd: workspace, lane: null, writable: [workspace, ...own.gitWritable] };
  let repo;
  try {
    repo = await laneRepoOf(workspace);
  } catch (error) {
    throw new EngineError(`${EXTERNAL_BACKENDS[log.session.backend!.id].label} runs in a lane, and lanes need a git checkout: ${error instanceof Error ? error.message : String(error)}`);
  }
  const earlier = lastOf(log.events, 'backend-start')?.lane ?? null;
  const record = earlier !== null ? await requireLane(repo, earlier) : await laneFor(repo, prompt, store, io);
  const bound = await laneAt(record.path, home);
  if (bound === undefined) throw new EngineError(`lane ${record.name} is not a lane checkout`);
  await bindSession(bound, log.session.id);
  return { cwd: record.path, lane: record.name, writable: [record.path, ...bound.gitWritable] };
}

export type ExternalTurnOptions = {
  readonly io: Io;
  readonly store: Store;
  readonly log: SessionLog;
  readonly prompt: string;
  readonly approval: Approval;
  readonly surface: Surface;
  readonly signal: AbortSignal;
  readonly agents: ExternalAgents;
  readonly keyOf: KeyOf;
};

export type ExternalTurnResult = { readonly reason: DoneReason; readonly events: readonly TurnEvent[] };

const textOf = (content: readonly acp.ToolCallContent[] | null | undefined): string =>
  (content ?? [])
    .flatMap((c) => {
      if (c.type === 'content' && c.content.type === 'text') return [c.content.text];
      if (c.type === 'diff') return [`edited ${c.path}`];
      return [];
    })
    .join('\n');

const TOOL_END: Readonly<Record<'completed' | 'failed', ToolStatus>> = { completed: 'ok', failed: 'error' };

/**
 * One turn on an external agent. Its updates become Geno's own log events, so the panel, the replay, tasks and
 * history read it as any turn: text and each tool call as an `assistant` event, each call's end as a `tool-result`.
 */
export async function runExternalTurn(options: ExternalTurnOptions): Promise<ExternalTurnResult> {
  const { io, store, log, prompt, approval, surface, signal, agents } = options;
  const binding = log.session.backend!;
  const backend = EXTERNAL_BACKENDS[binding.id];
  const { watcher } = surface;
  const events: TurnEvent[] = [...log.events];
  const append = async (event: TurnEvent) => {
    await appendEvent(log.file, event);
    events.push(event);
    watcher.logged(event);
  };
  const at = () => new Date().toISOString();
  const stamp = { seq: () => nextSeq(events), at };

  if (prompt !== '') await append({ kind: 'user', seq: stamp.seq(), at: at(), content: prompt });
  const fail = async (error: 'transport' | 'abort', message: string): Promise<ExternalTurnResult> => {
    await append({ kind: 'error', seq: stamp.seq(), at: at(), error, message });
    return { reason: error === 'abort' ? 'end_turn' : 'error', events };
  };

  let place;
  let link: Link;
  try {
    place = await laneOf(io, store, { ...log, events }, prompt);
    link = await agents.ensure(log.session.id, binding, options.keyOf, place.writable);
    const previous = lastOf(events, 'backend-start');
    if (link.session === undefined) {
      const resume = previous?.loadable === true && previous.lane === place.lane ? previous.agentSessionId : undefined;
      link.session = await openAgentSession(link.process, place.cwd, resume);
      link.setup = link.session.setup;
      link.model = link.setup.models?.current;
      link.mode = link.setup.modes?.current;
      await append({
        kind: 'backend-start',
        seq: stamp.seq(),
        at: at(),
        agentSessionId: link.session.id,
        lane: place.lane,
        sandboxed: link.process.sandboxed,
        loadable: link.process.initialized.agentCapabilities?.loadSession === true,
      });
      if (previous !== undefined && !link.session.loaded) watcher.text(`[${backend.label} could not take up its earlier session, so this turn starts a new one in the same lane.]\n\n`);
    }
    const chosen = chosenModelOf(events);
    if (chosen !== undefined) await applyModel(link, chosen);
    if (approval.kind === 'interactive') await applyMode(link, approval.mode());
  } catch (error) {
    return fail('transport', error instanceof Error ? error.message : String(error));
  }
  const session = link.session!;
  const cwd = place.cwd;
  const modelName = () => modelNameOf(link.setup.models, link.model ?? link.setup.models?.current ?? backend.label);
  const scope = { workspace: cwd, tempDir: io.env['TMPDIR'] || tmpdir(), home: io.env['HOME'] || homedir() };

  // The turn's text since the last tool call, logged with the next call or at the end.
  let text = '';
  let started = Date.now();
  let reportedCostUsd: number | null = null;
  const calls = new Map<string, { use: ToolUseBlock; call: ExternalCall; output: string; approval?: ApprovalRecord; ended: boolean }>();
  let logging = Promise.resolve();
  const serial = (work: () => Promise<void>) => {
    logging = logging.then(work, work).catch((error: unknown) => io.err(`backend: could not log: ${String(error)}`));
    return logging;
  };
  const assistant = (content: ContentBlock[], final: boolean): TurnEvent => ({
    kind: 'assistant',
    seq: stamp.seq(),
    at: at(),
    content,
    stopReason: final ? 'end_turn' : 'tool_use',
    usage: ZERO_USAGE,
    costUsd: final ? reportedCostUsd : reportedCostUsd === null ? null : 0,
    latencyMs: Date.now() - started,
    model: modelName(),
  });

  const callOf = (update: { readonly kind?: string | null; readonly title?: string | null; readonly rawInput?: unknown; readonly locations?: readonly { readonly path: string }[] | null }): ExternalCall => ({
    kind: acpToolKindOf(update.kind),
    title: update.title ?? '',
    rawInput: update.rawInput,
    locations: (update.locations ?? []).map((l) => l.path),
  });

  const startCall = async (toolCallId: string, call: ExternalCall) => {
    if (calls.has(toolCallId)) return;
    const { name, input } = externalToolUse(call, cwd);
    const use: ToolUseBlock = { type: 'tool_use', id: genoCallId(toolCallId), name, input, caller: { type: 'direct' } };
    calls.set(toolCallId, { use, call, output: '', ended: false });
    const content: ContentBlock[] = [...(text === '' ? [] : [{ type: 'text' as const, text, citations: null }]), use];
    text = '';
    await append(assistant(content, false));
    started = Date.now();
    watcher.toolStart(use, externalTitle({ name, input }));
  };

  const endCall = async (toolCallId: string, status: ToolStatus) => {
    const call = calls.get(toolCallId);
    if (call === undefined || call.ended) return;
    call.ended = true;
    if (call.approval?.verdict === 'deny') status = 'denied';
    watcher.toolEnd(call.use, status);
    await append({
      kind: 'tool-result',
      seq: stamp.seq(),
      at: at(),
      toolUseId: call.use.id,
      name: call.use.name,
      status,
      output: call.output === '' ? (status === 'ok' ? 'done' : 'failed') : call.output,
      ...(call.approval === undefined ? {} : { approval: call.approval }),
    });
  };

  const UPDATES: { readonly [K in acp.SessionUpdate['sessionUpdate']]?: (update: Extract<acp.SessionUpdate, { sessionUpdate: K }>) => Promise<void> | void } = {
    agent_message_chunk: ({ content }) => {
      if (content.type !== 'text') return;
      text += content.text;
      watcher.text(content.text);
    },
    tool_call: async (update) => {
      await startCall(update.toolCallId, callOf(update));
      const call = calls.get(update.toolCallId)!;
      call.output = textOf(update.content) || call.output;
      if (update.status === 'completed' || update.status === 'failed') await endCall(update.toolCallId, TOOL_END[update.status]);
    },
    tool_call_update: async (update) => {
      if (!calls.has(update.toolCallId)) await startCall(update.toolCallId, callOf(update));
      const call = calls.get(update.toolCallId)!;
      const output = textOf(update.content);
      if (output !== '') call.output = output;
      if (update.status === 'completed' || update.status === 'failed') await endCall(update.toolCallId, TOOL_END[update.status]);
    },
    usage_update: ({ used, size, cost }) => {
      io.err(`backend: ${backend.id} usage_update used=${used} size=${size}${cost == null ? '' : ` cost=${cost.amount} ${cost.currency}`}`);
      if (cost != null && cost.currency.toUpperCase() === 'USD') reportedCostUsd = cost.amount;
    },
    config_option_update: ({ configOptions }) => {
      const model = configOptions.find((o) => o.category === 'model');
      if (model !== undefined && model.type === 'select') link.model = String(model.currentValue);
    },
  };

  const permission = async (request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> => {
    await serial(() => startCall(request.toolCall.toolCallId, callOf(request.toolCall)));
    const known = calls.get(request.toolCall.toolCallId)!;
    const asked = request.toolCall;
    const call: ExternalCall = {
      kind: asked.kind == null ? known.call.kind : acpToolKindOf(asked.kind),
      title: asked.title ?? known.call.title,
      rawInput: asked.rawInput ?? known.call.rawInput,
      locations: asked.locations == null ? known.call.locations : asked.locations.map((l) => l.path),
    };
    const mode = approval.kind === 'interactive' ? approval.mode() : 'non-interactive';
    const denial = externalDenialFor(call, scope, mode);
    let verdict: 'allow' | 'deny' = 'allow';
    if (denial !== undefined) {
      const { name, input } = externalToolUse(call, cwd);
      const command = String(input['command'] ?? externalTitle({ name, input }));
      const access = accessOf(call, cwd);
      const record = await settle(
        approval,
        mode,
        denial,
        () => ({
          ...classifierInputOf(events, command, denial),
          ...(access === 'command' ? {} : { mcp: { server: backend.label, tool: call.kind, arguments: JSON.stringify(call.rawInput ?? { title: call.title }) } }),
        }),
        { signal, events: () => events },
      );
      known.approval = record;
      verdict = record.verdict;
    }
    if (signal.aborted) return { outcome: { outcome: 'cancelled' } };
    const optionId = externalAnswer(request.options, verdict);
    if (verdict === 'deny' || optionId === undefined) known.output = `denied: ${known.approval?.decidedBy === 'classifier' ? `the safety classifier refused it: ${known.approval.classifier?.reason}` : 'refused'}`;
    return optionId === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId } };
  };

  link.process.route(session.id, {
    update: (update) => {
      const handle = UPDATES[update.sessionUpdate] as ((u: acp.SessionUpdate) => Promise<void> | void) | undefined;
      if (handle !== undefined) void serial(async () => handle(update));
    },
    permission,
  });

  const onAbort = () => void link.process.agent.notify(acp.methods.agent.session.cancel, { sessionId: session.id }).catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  let killTimer: NodeJS.Timeout | undefined;
  const killed = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => {
      killTimer = setTimeout(() => {
        link.process.kill();
        reject(new EngineError(`${backend.label} did not stop within ${CANCEL_GRACE_MS / 1000}s of the cancel, so Geno ended its process`));
      }, CANCEL_GRACE_MS);
    }, { once: true });
  });
  try {
    if (signal.aborted) onAbort();
    const response = await Promise.race([
      link.process.agent.request(acp.methods.agent.session.prompt, { sessionId: session.id, prompt: [{ type: 'text', text: prompt === '' ? (lastOf(events, 'user')?.content ?? '') : prompt }] }),
      link.process.exited.then((exit) => Promise.reject(new EngineError(exitText(backend, exit)))),
      killed,
    ]);
    await serial(async () => {});
    if (response.usage != null) io.err(`backend: ${backend.id} prompt usage ${JSON.stringify(response.usage)}`);
    for (const id of calls.keys()) await endCall(id, 'error');
    if (response.stopReason === 'cancelled' || signal.aborted) {
      if (text !== '') await append(assistant([{ type: 'text', text, citations: null }], true));
      return fail('abort', 'the user stopped the turn');
    }
    await append(assistant(text === '' ? [] : [{ type: 'text', text, citations: null }], true));
    if (response.stopReason === 'refusal') return { reason: 'refusal', events };
    if (response.stopReason === 'max_turn_requests' || response.stopReason === 'max_tokens') return { reason: 'max-turns', events };
    return { reason: 'end_turn', events };
  } catch (error) {
    await serial(async () => {});
    for (const id of calls.keys()) await endCall(id, 'error');
    if (text !== '') await append(assistant([{ type: 'text', text, citations: null }], true));
    // The connection can close a moment before the process is reaped; its exit says more than the closed stream.
    const exit = await Promise.race([link.process.exited, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), EXIT_WAIT_MS).unref())]);
    agents.close(log.session.id);
    const message = exit !== undefined ? exitText(backend, exit) : error instanceof Error ? error.message : String(error);
    return fail(signal.aborted ? 'abort' : 'transport', message);
  } finally {
    clearTimeout(killTimer);
    signal.removeEventListener('abort', onAbort);
    link.process.route(session.id, undefined);
  }
}
