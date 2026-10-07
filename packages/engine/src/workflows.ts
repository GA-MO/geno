import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  absorbOutcomes,
  cancelWorkflow,
  closingTurn,
  mergeWorkflows,
  nextRound,
  parseWorkflow,
  parseWorkflowCommand,
  startWorkflow,
  WORKFLOW_DIRS,
  WORKFLOW_LIMITS,
  WORKFLOW_TOOL,
  workflowList,
  workflowPreview,
  workflowRefusal,
  workflowTurn,
  ZERO_USAGE,
  type AgentDefinition,
  type ApprovalMode,
  type AssistantTurn,
  type Rates,
  type Session,
  type WorkflowPreview,
  type TurnEvent,
  type WorkflowRun,
  type WorkflowSource,
  type WorkflowSpec,
} from '@g-code/core';
import type { Homes } from './commands.js';
import type { Director } from './drive.js';
import { readIfFile, shownPath, sortedEntries } from './project-context.js';
import { ToolError } from './tools/context.js';
import type { WorkflowTools } from './tools/workflow.js';

/** Each problem names its file; a file that cannot be used is reported and skipped, never thrown. */
export type WorkflowScan = { readonly specs: readonly WorkflowSpec[]; readonly problems: readonly string[] };

const FOLDERS: readonly { readonly source: WorkflowSource; readonly dir: (workspace: string, homes: Homes) => string }[] = [
  { source: 'workspace', dir: (workspace) => path.join(workspace, WORKFLOW_DIRS.workspace) },
  { source: 'global', dir: (_, homes) => path.join(homes.app, WORKFLOW_DIRS.global) },
];

/** The workspace's workflows, then Geno's home's; the first of a name wins. */
export async function loadWorkflows(workspace: string, homes: Homes): Promise<WorkflowScan> {
  const problems: string[] = [];
  const groups: WorkflowSpec[][] = [];
  for (const folder of FOLDERS) {
    const specs: WorkflowSpec[] = [];
    for (const entry of await sortedEntries(folder.dir(workspace, homes))) {
      if (!entry.name.endsWith('.json')) continue;
      const file = path.join(folder.dir(workspace, homes), entry.name);
      const shown = shownPath(workspace, file);
      const text = await readIfFile(file);
      if (text === undefined) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (error) {
        problems.push(`${shown}: not JSON: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const parsed = parseWorkflow(raw, { name: entry.name.slice(0, -'.json'.length), source: folder.source, path: shown });
      if (parsed.ok) specs.push(parsed.value);
      else problems.push(`${shown}: ${parsed.problem}`);
    }
    groups.push(specs);
  }
  return { specs: mergeWorkflows(groups), problems };
}

/** A workflow session's model calls are the rounds it issues, one per round and one to close, so its turn cap never binds first. */
export const WORKFLOW_TURNS = WORKFLOW_LIMITS.units + 2;

export type WorkflowDriver = {
  /** Asked at each point a model would be called: the next round, the closing report, then nothing. */
  readonly director: Director;
  /**
   * The run as the session's log leaves it once its turn is over. A run its turn left unfinished was cancelled, or
   * failed when the turn ended by itself.
   */
  finish(events: readonly TurnEvent[], cancelled: boolean): WorkflowRun;
};

/**
 * A workflow run as the director of its session's turn: each round's calls are logged as the user's own, the loop
 * runs them as it runs any tool calls, and the next round reads what they reported from the log.
 */
export function workflowDriver(spec: WorkflowSpec, input: string, agents: readonly AgentDefinition[], model: string, changed: (run: WorkflowRun, sessionId: string) => void): WorkflowDriver {
  let run = startWorkflow(spec, input);
  let closed = false;
  const sessionOf = (events: readonly TurnEvent[]) => (events[0]?.kind === 'session-start' ? events[0].session.id : '');
  return {
    director(events) {
      if (closed) return undefined;
      const round = nextRound(absorbOutcomes(run, events), agents);
      run = round.run;
      changed(run, sessionOf(events));
      if (round.calls.length > 0) return workflowTurn(round.calls, model);
      closed = true;
      return closingTurn(run, model);
    },
    finish(events, cancelled) {
      const stop = cancelled ? { kind: 'cancelled' as const } : { kind: 'step-failed' as const, unit: 'the run', reason: 'its session ended before the run did' };
      run = cancelWorkflow(absorbOutcomes(run, events), stop);
      changed(run, sessionOf(events));
      return run;
    },
  };
}

/** `/workflow <name> [input]` as the user's own `workflow` call, as `@explore` is the user's own `agent` call. */
export function workflowCommandCall(logged: TurnEvent | undefined, session: Session): AssistantTurn | undefined {
  if (logged?.kind !== 'user' || logged.command?.name !== WORKFLOW_TOOL) return undefined;
  const { name, input } = parseWorkflowCommand(logged.command.args);
  const use: ToolUseBlock = {
    type: 'tool_use',
    id: `toolu_gcode_${randomUUID().replaceAll('-', '')}`,
    name: WORKFLOW_TOOL,
    input: name === undefined ? {} : { name, ...(input === '' ? {} : { input }) },
    caller: { type: 'direct' },
  };
  return { content: [use], stopReason: 'tool_use', usage: ZERO_USAGE, costUsd: 0, latencyMs: 0, model: session.model };
}

/** What the workflow tool needs of the session that starts a run, and of the engine that runs it. */
export type WorkflowHost = {
  readonly workspace: string;
  readonly homes: Homes;
  readonly model: string;
  readonly rates: (model: string) => Rates | undefined;
  readonly mode: () => ApprovalMode;
  readonly agents: () => Promise<readonly AgentDefinition[]>;
  readonly approve: (preview: WorkflowPreview, signal: AbortSignal) => Promise<boolean>;
  readonly run: (spec: WorkflowSpec, input: string, agents: readonly AgentDefinition[], toolUseId: string) => Promise<{ readonly sessionId: string }>;
};

export function workflowTools(host: WorkflowHost): WorkflowTools {
  const named = async (name: string) => {
    const scan = await loadWorkflows(host.workspace, host.homes);
    const spec = scan.specs.find((s) => s.name === name);
    if (spec !== undefined) return spec;
    const broken = scan.problems.find((problem) => problem.includes(`${name}.json:`));
    throw new ToolError(broken ?? `no workflow ${name}; ${scan.specs.length === 0 ? 'this workspace has none' : `the workflows are ${scan.specs.map((s) => s.name).join(', ')}`}`);
  };
  return {
    list: async () => {
      const scan = await loadWorkflows(host.workspace, host.homes);
      return workflowList(scan.specs, scan.problems);
    },
    prepare: async (name, input) => {
      const spec = await named(name);
      const agents = await host.agents();
      const refusal = workflowRefusal(spec, agents, host.mode());
      if (refusal !== undefined) throw new ToolError(`workflow ${name} cannot run here: ${refusal}`);
      return { preview: workflowPreview(spec, input, agents, { model: host.model, rates: host.rates }), start: (toolUseId) => host.run(spec, input, agents, toolUseId) };
    },
    approve: host.approve,
  };
}
