import { denialFor, type ApprovalMode, type CommandScope, type Denial, type ExternalRuleId, type SessionMode, type Verdicts } from './approval.js';

/**
 * External ACP agents as backends (U15, U33). Geno is the ACP client toward the agent and stays the ACP server toward
 * its panel. Everything here is data and pure functions; the engine does the I/O.
 */

export const EXTERNAL_BACKEND_IDS = ['cursor', 'claude-code'] as const;
export type ExternalBackendId = (typeof EXTERNAL_BACKEND_IDS)[number];
/** `geno` is Geno's own loop. */
export type BackendId = 'geno' | ExternalBackendId;
export const isExternalBackendId = (raw: unknown): raw is ExternalBackendId => (EXTERNAL_BACKEND_IDS as readonly unknown[]).includes(raw);

/** Geno's sandbox around an agent's process. */
export type BackendSandbox = {
  /** The network hosts it needs, measured with `initialize` and `session/new`. */
  readonly hosts: readonly string[];
  /** Paths under home it writes its state to. Its own config and permission files stay read-only. */
  readonly writableHome: readonly string[];
  /** Arguments, before `args`, that turn its own sandbox off: macOS refuses a second Seatbelt profile inside Geno's. */
  readonly args: readonly string[];
};

/** One row of the backend registry. */
export type ExternalBackend = {
  readonly id: ExternalBackendId;
  readonly label: string;
  /** What the cost slot says when the agent sends no usage: the user's plan pays. */
  readonly plan: string;
  /** The `@` mention and the subagent definition that run a task on it. */
  readonly mention: string;
  /** Names its ACP command goes by, tried in order on PATH and in the folders installers use. */
  readonly binaries: readonly string[];
  /** Arguments that start its ACP server. */
  readonly args: readonly string[];
  /** The variable that carries the user's API key, when the user chose one; undefined when it takes none from Geno. */
  readonly keyEnv: string | undefined;
  /** How to get it when no binary is found. Geno installs nothing. */
  readonly install: string;
  /** Undefined when it has not been shown to run inside Geno's sandbox, so it runs in its lane without one. */
  readonly sandbox: BackendSandbox | undefined;
};

export const EXTERNAL_BACKENDS: Readonly<Record<ExternalBackendId, ExternalBackend>> = {
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    plan: 'Cursor plan',
    mention: 'cursor',
    binaries: ['agent', 'cursor-agent'],
    args: ['acp'],
    keyEnv: 'CURSOR_API_KEY',
    install: 'Install Cursor’s CLI from Geno’s settings, Agents section.',
    sandbox: {
      hosts: ['*.cursor.sh'],
      writableHome: [
        '.cursor/projects',
        '.cursor/acp-sessions',
        '.cursor/ai-tracking',
        '.cursor/plans',
        '.cursor/agents',
        '.cursor/workers',
        '.cursor/statsig-cache.json',
        '.cursor/agent-cli-state.json',
      ],
      args: ['--sandbox', 'disabled'],
    },
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    plan: 'Claude plan',
    mention: 'claude-code',
    binaries: ['claude-agent-acp', 'claude-code-acp'],
    args: [],
    keyEnv: 'ANTHROPIC_API_KEY',
    install: 'Claude Code speaks ACP through its adapter: npm install -g @agentclientprotocol/claude-agent-acp',
    sandbox: undefined,
  },
};

/** What the engine found for a backend: the command it runs, or why it cannot. */
export type BackendAvailability =
  | { readonly kind: 'ready'; readonly path: string }
  | { readonly kind: 'missing'; readonly reason: string };

/** A backend as the panel's picker lists it. */
export type BackendInfo = {
  readonly id: ExternalBackendId;
  readonly label: string;
  readonly plan: string;
  readonly availability: BackendAvailability;
};

/** The external agent a session runs on, fixed when the session starts. A session without one runs Geno's own loop. */
export type BackendBinding = { readonly id: ExternalBackendId };

/**
 * One agent process's session, as the log records it: where it ran and whether the agent can load it again after
 * the engine restarts. `lane` is the lane the agent's cwd is, null when the session's own workspace is already a lane.
 */
export type BackendStart = {
  readonly agentSessionId: string;
  readonly lane: string | null;
  readonly sandboxed: boolean;
  readonly loadable: boolean;
};

// ---------------------------------------------------------------------------------------------------------------
// Translated events: how an agent's tool call reads in Geno's log and panel.

export const ACP_TOOL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'] as const;
export type AcpToolKind = (typeof ACP_TOOL_KINDS)[number];
export const acpToolKindOf = (raw: unknown): AcpToolKind => ((ACP_TOOL_KINDS as readonly unknown[]).includes(raw) ? (raw as AcpToolKind) : 'other');

/** What a call may touch, which decides its permission row. */
export type ExternalAccess = 'read' | 'write' | 'command' | 'other';

/** The panel's tool kinds, which pick a step's icon and the dino's pose. */
export type ShownToolKind = 'read' | 'search' | 'edit' | 'execute' | 'other';

/** `tool` is the Geno tool name the step is logged and titled as, so steps, IN/OUT boxes and poses work unchanged. */
export type ExternalToolStep = { readonly tool: 'read' | 'edit' | 'grep' | 'bash' | 'fetch' | 'think' | 'tool'; readonly shown: ShownToolKind; readonly access: ExternalAccess };

export const EXTERNAL_TOOL_STEPS: Readonly<Record<AcpToolKind, ExternalToolStep>> = {
  read: { tool: 'read', shown: 'read', access: 'read' },
  search: { tool: 'grep', shown: 'search', access: 'read' },
  think: { tool: 'think', shown: 'other', access: 'read' },
  edit: { tool: 'edit', shown: 'edit', access: 'write' },
  delete: { tool: 'edit', shown: 'edit', access: 'write' },
  move: { tool: 'edit', shown: 'edit', access: 'write' },
  execute: { tool: 'bash', shown: 'execute', access: 'command' },
  fetch: { tool: 'fetch', shown: 'other', access: 'other' },
  switch_mode: { tool: 'tool', shown: 'other', access: 'other' },
  other: { tool: 'tool', shown: 'other', access: 'other' },
};

/** An agent's tool call as ACP sends it, the fields Geno reads. */
export type ExternalCall = {
  readonly kind: AcpToolKind;
  readonly title: string;
  readonly rawInput: unknown;
  /** Absolute paths. */
  readonly locations: readonly string[];
};

const relativeTo = (workspace: string, file: string): string => {
  const root = workspace.endsWith('/') ? workspace : `${workspace}/`;
  return file.startsWith(root) ? file.slice(root.length) : file;
};

const commandOf = (raw: unknown): string | undefined => {
  const command = (raw as { readonly command?: unknown } | null | undefined)?.command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.every((word) => typeof word === 'string')) return command.join(' ');
  return undefined;
};

const pathOf = (call: ExternalCall, workspace: string): string => {
  const located = call.locations[0];
  if (located !== undefined) return relativeTo(workspace, located);
  const raw = (call.rawInput as { readonly path?: unknown; readonly file_path?: unknown } | null | undefined) ?? {};
  const named = typeof raw.path === 'string' ? raw.path : typeof raw.file_path === 'string' ? raw.file_path : undefined;
  return named === undefined ? call.title : relativeTo(workspace, named);
};

/**
 * The Geno tool use a call is logged as. The input has the shape of Geno's own tool, so a replay titles it as the
 * live step did; the agent's own title and arguments ride along for the record.
 */
export function externalToolUse(call: ExternalCall, workspace: string): { readonly name: ExternalToolStep['tool']; readonly input: Record<string, unknown> } {
  const step = EXTERNAL_TOOL_STEPS[call.kind];
  const input = ((): Record<string, unknown> => {
    switch (step.tool) {
      case 'read':
      case 'edit':
        return { path: pathOf(call, workspace) };
      case 'grep':
        return { pattern: call.title === '' ? 'search' : call.title };
      case 'bash':
        return { command: commandOf(call.rawInput) ?? call.title };
      default:
        return { title: call.title };
    }
  })();
  return { name: step.tool, input };
}

/** The step's title, `<tool> <target>`, as the panel splits it. */
export function externalTitle(use: { readonly name: string; readonly input: Record<string, unknown> }): string {
  const target = use.input['path'] ?? use.input['command'] ?? use.input['title'] ?? (use.input['pattern'] === undefined ? undefined : JSON.stringify(use.input['pattern']));
  return typeof target === 'string' && target !== '' ? `${use.name} ${target}` : use.name;
}

// ---------------------------------------------------------------------------------------------------------------
// Permissions: an agent's `session/request_permission` through Geno's approval modes.

/**
 * The permission table. Ask asks the user about everything the agent asks about. Auto lets the classifier decide
 * what Geno's own rules do not settle, and reads inside the workspace run. Plan refuses everything but reads.
 */
export const EXTERNAL_RULES: Readonly<Record<ExternalAccess, { readonly rule: ExternalRuleId; readonly reason: string; readonly verdicts: Verdicts }>> = {
  read: { rule: 'external-read', reason: 'an external agent reading inside the workspace', verdicts: { plan: 'allow', ask: 'ask', auto: 'allow', 'non-interactive': 'allow' } },
  write: { rule: 'external-write', reason: 'an external agent changing files', verdicts: { plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'deny' } },
  command: { rule: 'external-command', reason: 'an external agent running a command', verdicts: { plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'deny' } },
  other: { rule: 'external-other', reason: 'an external agent’s tool', verdicts: { plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'deny' } },
};

const inside = (workspace: string, file: string): boolean => file === workspace || file.startsWith(workspace.endsWith('/') ? workspace : `${workspace}/`);

/** What a permission request touches: a read anywhere but the workspace counts as other. */
export function accessOf(call: ExternalCall, workspace: string): ExternalAccess {
  const { access } = EXTERNAL_TOOL_STEPS[call.kind];
  if (access === 'read' && !call.locations.every((file) => inside(workspace, file))) return 'other';
  return access;
}

/**
 * What settles one permission request before anyone is asked, or undefined when it may run. A command in Auto goes
 * through Geno's own command rules first, so `rm -rf` outside the workspace still asks and a safe command runs.
 */
export function externalDenialFor(call: ExternalCall, scope: CommandScope, mode: ApprovalMode): Denial | undefined {
  const access = accessOf(call, scope.workspace);
  const { rule, reason, verdicts } = EXTERNAL_RULES[access];
  const verdict = verdicts[mode];
  const use = externalToolUse(call, scope.workspace);
  const shown = externalTitle(use);
  if (access === 'command' && mode === 'auto') {
    const command = String(use.input['command']);
    return denialFor(command, scope, mode);
  }
  if (verdict === 'allow') return undefined;
  return { rule, reason, command: shown, verdict };
}

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
export type AgentPermissionOption = { readonly optionId: string; readonly kind: PermissionOptionKind | string };

/**
 * The option Geno answers with, or undefined to cancel the request. Geno never picks an `_always` option: it would
 * change the agent's own saved permissions, which outlive the lane and are not Geno's to change.
 */
export function externalAnswer(options: readonly AgentPermissionOption[], verdict: 'allow' | 'deny'): string | undefined {
  const once = (kind: PermissionOptionKind) => options.find((option) => option.kind === kind)?.optionId;
  if (verdict === 'allow') return once('allow_once') ?? once('reject_once');
  return once('reject_once');
}

// ---------------------------------------------------------------------------------------------------------------
// Models and modes, feature-detected from `session/new`.

export type ExternalChoice = { readonly id: string; readonly name: string };

/**
 * Where the agent lists its models: a session config option of category `model`, ACP's `models` field, or, as in
 * Cursor 2026.01, its modes.
 */
export type ModelSource = { readonly kind: 'config'; readonly configId: string } | { readonly kind: 'models' } | { readonly kind: 'modes' };

export type AgentModels = { readonly source: ModelSource; readonly current: string; readonly available: readonly ExternalChoice[] };

/** The agent's own approval modes, which Geno sets from its mode: Plan to the agent's plan, Ask and Auto to its build mode. */
export type AgentModes = {
  readonly source: { readonly kind: 'config'; readonly configId: string } | { readonly kind: 'modes' };
  readonly current: string;
  readonly plan: string | undefined;
  readonly build: string | undefined;
};

export type AgentSetup = { readonly models: AgentModels | undefined; readonly modes: AgentModes | undefined };

type SelectOption = { readonly value: string; readonly name: string } | { readonly group?: string; readonly options: readonly { readonly value: string; readonly name: string }[] };

/** The parts of a `session/new` result Geno reads, as loose as the agents send them. */
export type SessionSetupShape = {
  readonly modes?: { readonly currentModeId: string; readonly availableModes: readonly { readonly id: string; readonly name: string }[] } | null | undefined;
  readonly models?: { readonly currentModelId: string; readonly availableModels: readonly { readonly modelId: string; readonly name: string }[] } | null | undefined;
  readonly configOptions?: readonly { readonly id: string; readonly category?: string | null; readonly type: string; readonly currentValue?: unknown; readonly options?: readonly SelectOption[] }[] | null | undefined;
};

const flatOptions = (options: readonly SelectOption[] | undefined): ExternalChoice[] =>
  (options ?? []).flatMap((option) => ('options' in option ? option.options : [option])).map(({ value, name }) => ({ id: value, name }));

const BUILD_MODES = ['agent', 'code', 'default', 'build'] as const;

const modesOfChoices = (current: string, ids: readonly string[]) => ({
  current,
  plan: ids.includes('plan') ? 'plan' : undefined,
  build: BUILD_MODES.find((id) => ids.includes(id)),
});

export function agentSetupOf(result: SessionSetupShape): AgentSetup {
  const selects = (result.configOptions ?? []).filter((option) => option.type === 'select');
  const modelOption = selects.find((option) => option.category === 'model');
  const modeOption = selects.find((option) => option.category === 'mode');
  const modeIds = (result.modes?.availableModes ?? []).map((mode) => mode.id);
  // An agent with no other model list and no plan mode puts its models in its modes, as Cursor 2026.01 did.
  const modesAreModels = modelOption === undefined && result.models == null && result.modes != null && !modeIds.includes('plan');
  const models: AgentModels | undefined =
    modelOption !== undefined
      ? { source: { kind: 'config', configId: modelOption.id }, current: String(modelOption.currentValue ?? ''), available: flatOptions(modelOption.options) }
      : result.models != null
        ? { source: { kind: 'models' }, current: result.models.currentModelId, available: result.models.availableModels.map(({ modelId, name }) => ({ id: modelId, name })) }
        : modesAreModels && result.modes != null
          ? { source: { kind: 'modes' }, current: result.modes.currentModeId, available: result.modes.availableModes.map(({ id, name }) => ({ id, name })) }
          : undefined;
  const modes: AgentModes | undefined =
    modeOption !== undefined
      ? { source: { kind: 'config', configId: modeOption.id }, ...modesOfChoices(String(modeOption.currentValue ?? ''), flatOptions(modeOption.options).map((c) => c.id)) }
      : result.modes != null && !modesAreModels
        ? { source: { kind: 'modes' }, ...modesOfChoices(result.modes.currentModeId, modeIds) }
        : undefined;
  return { models, modes };
}

/** The agent mode a Geno mode asks for; undefined leaves the agent's mode alone. */
export const agentModeFor = (modes: AgentModes | undefined, mode: SessionMode): string | undefined => (mode === 'plan' ? modes?.plan : modes?.build);

/** The model's name as the agent lists it, or its id. */
export const modelNameOf = (models: AgentModels | undefined, id: string): string => models?.available.find((choice) => choice.id === id)?.name ?? id;

// ---------------------------------------------------------------------------------------------------------------
// ACP between the engine and the panel.

/** Key in `session/new` params' `_meta`: `{ id }`, the backend the new session runs on. In its response: `BackendShown`. */
export const BACKEND_META = 'gcode/backend';

/**
 * What a session/new, load or resume response says of its backend, absent for Geno's own loop. `lane` is the lane the
 * agent works in, null until its first turn makes one; a `session_info_update` carries it again then, under the same key.
 */
export type BackendShown = { readonly id: ExternalBackendId; readonly label: string; readonly plan: string; readonly lane: string | null };

export const backendShown = (id: ExternalBackendId, lane: string | null = null): BackendShown => ({ id, label: EXTERNAL_BACKENDS[id].label, plan: EXTERNAL_BACKENDS[id].plan, lane });

/** Extension method: the backend registry with what the engine found for each. */
export const BACKENDS_METHOD = '_gcode/backends';
export type BackendsResponse = { readonly backends: readonly BackendInfo[] };

/** Extension method, sent by the engine before it starts an agent: the variables the user chose for it, such as an API key. */
export const BACKEND_ENV_METHOD = '_gcode/backendEnv';
/** Key in the client capabilities' `_meta`, true when the client answers BACKEND_ENV_METHOD. */
export const BACKEND_ENV_CAPABILITY = 'gcode/backendEnv';
export type BackendEnvRequest = { readonly backend: ExternalBackendId };
/** Only the backend's `keyEnv` is taken from it; anything else is dropped. */
export type BackendEnvResponse = { readonly env: Readonly<Record<string, string>> };

/** The session config option an external session lists its models in, for the composer's model menu. */
export const MODEL_CONFIG_ID = 'model';
