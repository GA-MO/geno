import { createHash } from 'node:crypto';
import type { Tool, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ApprovalMode } from './approval.js';
import { reportBody } from './fence.js';
import type { Parsed } from './ask-user.js';
import type { Rates } from './cost.js';
import { costAt } from './cost.js';
import { formatUsd as usd } from './spend-view.js';
import type { WorkflowProgress, WorkflowStatus } from './workflow-progress.js';
import { ZERO_USAGE, type AssistantTurn, type TurnEvent } from './session.js';
import { AGENT_TOOL, childEndWords, DEFAULT_CHILD_CAPS, findAgent, isReadOnly, type AgentDefinition, type ChildCaps, type ChildEnd } from './subagent.js';

/**
 * Workflows: a small JSON file that runs subagents in a fixed order, such as review, then fix, then verify. The file
 * is data, never code, so a run is a pure function of the file, its input and what each step reported: the same
 * reports give the same steps, with the same tasks and caps. A step reaches files or the network only through the
 * subagent it starts. Before a run, the user sees what each step may spend and the total cap, and confirms.
 */

export const WORKFLOW_TOOL = 'workflow';
/** The check a gate issues; it is the agent tools' own `check`, so it runs where and how the session's check runs. */
export const WORKFLOW_CHECK_TOOL = 'check';

/** In the client capabilities' `_meta`: the client shows a workflow's preview card and its progress in Tasks. */
export const WORKFLOWS_CAPABILITY = 'gcode/workflows';
/** On the permission request that asks to run a workflow: its `WorkflowPreview`. */
export const WORKFLOW_META = 'gcode/workflow';

/** Relative to the workspace, then to Geno's home; a workspace file shadows a global one of the same name. */
export const WORKFLOW_DIRS = { workspace: '.g-code/workflows', global: 'workflows' } as const;
export type WorkflowSource = keyof typeof WORKFLOW_DIRS;

export const WORKFLOW_LIMITS = {
  /** The most a whole run may be capped at, in US dollars. */
  totalUsd: 5,
  stepUsd: 1,
  stepTurns: 100,
  branches: 8,
  pipelineItems: 10,
  /** Agent calls and checks in a run, counting a pipeline at its most items. */
  units: 40,
  prompt: 20_000,
} as const;

export const DEFAULT_WORKFLOW_CAP_USD = 0.5;
export const DEFAULT_PIPELINE_ITEMS = 5;

/** What the estimate takes one model call to be: about Geno's first request with tools, and a short answer. */
export const ESTIMATE_CALL = { input: 7_000, output: 400 } as const;
/** The model calls the estimate takes one step to make, at most its turn cap. */
export const ESTIMATE_CALLS = 6;

const NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const isWorkflowName = (raw: string): boolean => NAME.test(raw);

export const FIELD_TYPES = ['string', 'number', 'boolean', 'string[]'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
/** The JSON object a step's report ends with, field by field. */
export type OutputSchema = Readonly<Record<string, FieldType>>;
export type FieldValue = string | number | boolean | readonly string[];

export type Ref =
  | { readonly kind: 'input' }
  | { readonly kind: 'item' }
  | { readonly kind: 'previous' }
  | { readonly kind: 'step'; readonly step: string }
  | { readonly kind: 'field'; readonly step: string; readonly field: string };

export type TemplatePart = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'ref'; readonly ref: Ref };
export type Template = readonly TemplatePart[];

export type AgentStep = {
  readonly kind: 'agent';
  readonly id: string;
  readonly role: string;
  readonly prompt: Template;
  readonly model: string | undefined;
  /** The run's lane the step works in, by the name the file gives it; undefined works in the main checkout. */
  readonly lane: string | undefined;
  readonly maxCostUsd: number | undefined;
  readonly maxTurns: number | undefined;
  readonly schema: OutputSchema | undefined;
};

export type ItemSource =
  | { readonly kind: 'list'; readonly items: readonly string[] }
  | { readonly kind: 'from'; readonly step: string; readonly field: string; readonly max: number };

export type GateTest =
  | { readonly kind: 'check' }
  | { readonly kind: 'field'; readonly step: string; readonly field: string; readonly equals: string | number | boolean };

export type WorkflowNode =
  | AgentStep
  | { readonly kind: 'parallel'; readonly id: string; readonly branches: readonly AgentStep[] }
  /** Each item goes through every stage in turn; one stage runs for all items at once. */
  | { readonly kind: 'pipeline'; readonly id: string; readonly items: ItemSource; readonly stages: readonly AgentStep[] }
  | { readonly kind: 'gate'; readonly id: string; readonly test: GateTest };

export type WorkflowSpec = {
  readonly name: string;
  readonly description: string;
  /** What the text after the name means, shown in the preview; undefined when the workflow takes none. */
  readonly input: string | undefined;
  readonly maxCostUsd: number;
  readonly steps: readonly WorkflowNode[];
  readonly source: WorkflowSource;
  /** Shown to the user: relative to the workspace for a workspace file. */
  readonly path: string;
};

const fail = (problem: string): { ok: false; problem: string } => ({ ok: false, problem });

type Raw = Readonly<Record<string, unknown>>;
const isRecord = (raw: unknown): raw is Raw => typeof raw === 'object' && raw !== null && !Array.isArray(raw);

const REF = /\{\{\s*([^{}]*?)\s*\}\}/g;

function parseRef(text: string): Ref | undefined {
  if (text === 'input' || text === 'item' || text === 'previous') return { kind: text };
  const [step, field, ...rest] = text.split('.');
  if (step === undefined || !NAME.test(step) || rest.length > 0) return undefined;
  if (field === undefined) return { kind: 'step', step };
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ? { kind: 'field', step, field } : undefined;
}

export function parseTemplate(text: string): Parsed<Template> {
  const parts: TemplatePart[] = [];
  let at = 0;
  for (const match of text.matchAll(REF)) {
    const ref = parseRef(match[1]!);
    if (ref === undefined) return fail(`{{${match[1]}}} names nothing: use {{input}}, {{item}}, {{previous}}, {{<step>}} or {{<step>.<field>}}`);
    if (match.index > at) parts.push({ kind: 'text', text: text.slice(at, match.index) });
    parts.push({ kind: 'ref', ref });
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push({ kind: 'text', text: text.slice(at) });
  return { ok: true, value: parts };
}

const STEP_FIELDS = ['id', 'role', 'prompt', 'model', 'lane', 'maxCostUsd', 'maxTurns', 'schema'] as const;
const TOP_FIELDS = ['description', 'input', 'maxCostUsd', 'steps'] as const;

function positive(raw: unknown, what: string, max: number, integer: boolean): Parsed<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'number' || !(raw > 0) || raw > max || (integer && !Number.isInteger(raw))) return fail(`${what} must be a ${integer ? 'whole number' : 'number'} above 0 and at most ${max}`);
  return { ok: true, value: raw };
}

function parseSchema(raw: unknown, where: string): Parsed<OutputSchema | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isRecord(raw) || Object.keys(raw).length === 0) return fail(`${where}: schema must be an object of fields, such as {"pass": "boolean"}`);
  for (const [field, type] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) return fail(`${where}: schema field "${field}" must be a plain name`);
    if (!(FIELD_TYPES as readonly unknown[]).includes(type)) return fail(`${where}: schema field "${field}" must be one of ${FIELD_TYPES.join(', ')}`);
  }
  return { ok: true, value: raw as OutputSchema };
}

/** Ids a step without one gets: its role, then `<role>-2`, and so on, so a file that names none still reads well. */
class Ids {
  private readonly taken = new Set<string>();
  private readonly counts = new Map<string, number>();

  claim(raw: unknown, fallback: string, where: string): Parsed<string> {
    if (raw !== undefined) {
      if (typeof raw !== 'string' || !NAME.test(raw)) return fail(`${where}: id must be lowercase letters, digits, - and _, such as "fix"`);
      if (this.taken.has(raw) || raw === 'input' || raw === 'item' || raw === 'previous') return fail(`${where}: id "${raw}" is used twice or reserved`);
      this.taken.add(raw);
      return { ok: true, value: raw };
    }
    let n = this.counts.get(fallback) ?? 1;
    let id = n === 1 ? fallback : `${fallback}-${n}`;
    while (this.taken.has(id)) id = `${fallback}-${++n}`;
    this.counts.set(fallback, n + 1);
    this.taken.add(id);
    return { ok: true, value: id };
  }
}

function parseAgentStep(raw: Raw, ids: Ids, where: string): Parsed<AgentStep> {
  const extra = Object.keys(raw).find((key) => !(STEP_FIELDS as readonly string[]).includes(key));
  if (extra !== undefined) return fail(`${where}: unknown field "${extra}"`);
  const role = raw['role'];
  if (typeof role !== 'string' || role.trim() === '') return fail(`${where}: role must name a subagent, such as "review" or "worker"`);
  const prompt = Array.isArray(raw['prompt']) && raw['prompt'].every((line) => typeof line === 'string') ? raw['prompt'].join('\n') : raw['prompt'];
  if (typeof prompt !== 'string' || prompt.trim() === '') return fail(`${where}: prompt must be text, or a list of lines`);
  if (prompt.length > WORKFLOW_LIMITS.prompt) return fail(`${where}: prompt is over ${WORKFLOW_LIMITS.prompt} characters`);
  for (const key of ['model', 'lane'] as const) {
    const value = raw[key];
    if (value !== undefined && (typeof value !== 'string' || (key === 'lane' ? !NAME.test(value) : value.trim() === ''))) {
      return fail(`${where}: ${key} must be ${key === 'lane' ? 'a short name, such as "fix"' : 'a model name'}`);
    }
  }
  const template = parseTemplate(prompt);
  if (!template.ok) return fail(`${where}: ${template.problem}`);
  const cost = positive(raw['maxCostUsd'], `${where}: maxCostUsd`, WORKFLOW_LIMITS.stepUsd, false);
  if (!cost.ok) return cost;
  const turns = positive(raw['maxTurns'], `${where}: maxTurns`, WORKFLOW_LIMITS.stepTurns, true);
  if (!turns.ok) return turns;
  const schema = parseSchema(raw['schema'], where);
  if (!schema.ok) return schema;
  const id = ids.claim(raw['id'], role.replace(/[^a-z0-9_-]/g, '-').replace(/^-+/, '') || 'step', where);
  if (!id.ok) return id;
  return {
    ok: true,
    value: {
      kind: 'agent',
      id: id.value,
      role,
      prompt: template.value,
      model: raw['model'] as string | undefined,
      lane: raw['lane'] as string | undefined,
      maxCostUsd: cost.value,
      maxTurns: turns.value,
      schema: schema.value,
    },
  };
}

function parseSteps(raws: readonly unknown[], ids: Ids, where: string): Parsed<AgentStep[]> {
  const steps: AgentStep[] = [];
  for (const [i, raw] of raws.entries()) {
    if (!isRecord(raw)) return fail(`${where} ${i + 1}: must be an object with a role and a prompt`);
    const step = parseAgentStep(raw, ids, `${where} ${i + 1}`);
    if (!step.ok) return step;
    steps.push(step.value);
  }
  return { ok: true, value: steps };
}

/** `step.field`, as gates and pipelines name a field of an earlier step's output. */
function fieldPath(raw: unknown): { step: string; field: string } | undefined {
  if (typeof raw !== 'string') return undefined;
  const ref = parseRef(raw);
  return ref?.kind === 'field' ? { step: ref.step, field: ref.field } : undefined;
}

function parseNode(raw: unknown, ids: Ids, where: string): Parsed<WorkflowNode> {
  if (!isRecord(raw)) return fail(`${where}: must be an object`);
  if ('role' in raw) return parseAgentStep(raw, ids, where);
  const own = (key: string, allowed: readonly string[]) => Object.keys(raw).find((k) => k !== key && !allowed.includes(k));
  if ('parallel' in raw) {
    const extra = own('parallel', ['id']);
    if (extra !== undefined) return fail(`${where}: unknown field "${extra}"`);
    const list = raw['parallel'];
    if (!Array.isArray(list) || list.length < 2 || list.length > WORKFLOW_LIMITS.branches) return fail(`${where}: parallel takes 2 to ${WORKFLOW_LIMITS.branches} steps`);
    const id = ids.claim(raw['id'], 'parallel', where);
    if (!id.ok) return id;
    const branches = parseSteps(list, ids, `${where}, branch`);
    if (!branches.ok) return branches;
    return { ok: true, value: { kind: 'parallel', id: id.value, branches: branches.value } };
  }
  if ('pipeline' in raw) {
    const extra = own('pipeline', ['id']);
    if (extra !== undefined) return fail(`${where}: unknown field "${extra}"`);
    const body = raw['pipeline'];
    if (!isRecord(body)) return fail(`${where}: pipeline takes {"items": ..., "stages": [...]}`);
    const bad = Object.keys(body).find((k) => k !== 'items' && k !== 'stages' && k !== 'maxItems');
    if (bad !== undefined) return fail(`${where}: unknown pipeline field "${bad}"`);
    const id = ids.claim(raw['id'], 'pipeline', where);
    if (!id.ok) return id;
    const rawItems = body['items'];
    let items: ItemSource;
    if (Array.isArray(rawItems)) {
      if (rawItems.length === 0 || rawItems.length > WORKFLOW_LIMITS.pipelineItems || !rawItems.every((item) => typeof item === 'string' && item.trim() !== '')) {
        return fail(`${where}: pipeline items must be 1 to ${WORKFLOW_LIMITS.pipelineItems} lines of text`);
      }
      items = { kind: 'list', items: rawItems as string[] };
    } else {
      const from = fieldPath(rawItems);
      if (from === undefined) return fail(`${where}: pipeline items must be a list, or "<step>.<field>" naming a string[] field of an earlier step`);
      const max = positive(body['maxItems'], `${where}: maxItems`, WORKFLOW_LIMITS.pipelineItems, true);
      if (!max.ok) return max;
      items = { kind: 'from', ...from, max: max.value ?? DEFAULT_PIPELINE_ITEMS };
    }
    const stages = Array.isArray(body['stages']) && body['stages'].length > 0 ? parseSteps(body['stages'], ids, `${where}, stage`) : fail(`${where}: pipeline needs at least one stage`);
    if (!stages.ok) return stages;
    return { ok: true, value: { kind: 'pipeline', id: id.value, items, stages: stages.value } };
  }
  if ('gate' in raw) {
    const extra = own('gate', ['id']);
    if (extra !== undefined) return fail(`${where}: unknown field "${extra}"`);
    const id = ids.claim(raw['id'], 'gate', where);
    if (!id.ok) return id;
    const gate = raw['gate'];
    if (gate === 'check') return { ok: true, value: { kind: 'gate', id: id.value, test: { kind: 'check' } } };
    const path = isRecord(gate) ? fieldPath(gate['field']) : undefined;
    const equals = isRecord(gate) ? gate['equals'] : undefined;
    if (path === undefined || !['string', 'number', 'boolean'].includes(typeof equals) || Object.keys(gate as Raw).some((k) => k !== 'field' && k !== 'equals')) {
      return fail(`${where}: gate is "check", or {"field": "<step>.<field>", "equals": <value>}`);
    }
    return { ok: true, value: { kind: 'gate', id: id.value, test: { kind: 'field', ...path, equals: equals as string | number | boolean } } };
  }
  return fail(`${where}: a step has a role, or is a parallel, a pipeline or a gate`);
}

/** What each node makes known to the nodes after it: a step's report, and its fields' types. */
type Known = Map<string, OutputSchema | undefined>;

function checkTemplate(template: Template, known: Known, where: string, stage: { first: boolean } | undefined): string | undefined {
  for (const part of template) {
    if (part.kind !== 'ref') continue;
    const { ref } = part;
    if ((ref.kind === 'item' || ref.kind === 'previous') && stage === undefined) return `${where}: {{${ref.kind}}} works only in a pipeline's stages`;
    if (ref.kind === 'previous' && stage?.first === true) return `${where}: {{previous}} works from a pipeline's second stage on`;
    if (ref.kind === 'step' && !known.has(ref.step)) return `${where}: {{${ref.step}}} names no earlier step`;
    if (ref.kind === 'field' && known.get(ref.step)?.[ref.field] === undefined) return `${where}: {{${ref.step}.${ref.field}}} names no field of an earlier step's schema`;
  }
  return undefined;
}

/** The refs a file may make, checked once: each names an earlier step, and each field is in that step's schema. */
function checkRefs(steps: readonly WorkflowNode[]): string | undefined {
  const known: Known = new Map();
  for (const node of steps) {
    switch (node.kind) {
      case 'agent': {
        const problem = checkTemplate(node.prompt, known, `step ${node.id}`, undefined);
        if (problem !== undefined) return problem;
        known.set(node.id, node.schema);
        break;
      }
      case 'parallel': {
        for (const branch of node.branches) {
          const problem = checkTemplate(branch.prompt, known, `step ${branch.id}`, undefined);
          if (problem !== undefined) return problem;
        }
        for (const branch of node.branches) known.set(branch.id, branch.schema);
        known.set(node.id, undefined);
        break;
      }
      case 'pipeline': {
        if (node.items.kind === 'from' && known.get(node.items.step)?.[node.items.field] !== 'string[]') {
          return `step ${node.id}: items "${node.items.step}.${node.items.field}" must be a string[] field of an earlier step's schema`;
        }
        for (const [i, stage] of node.stages.entries()) {
          const problem = checkTemplate(stage.prompt, known, `step ${stage.id}`, { first: i === 0 });
          if (problem !== undefined) return problem;
        }
        known.set(node.id, undefined);
        break;
      }
      case 'gate': {
        const { test } = node;
        if (test.kind !== 'field') break;
        const type = known.get(test.step)?.[test.field];
        if (type === undefined) return `step ${node.id}: "${test.step}.${test.field}" names no field of an earlier step's schema`;
        if (type !== typeof test.equals) return `step ${node.id}: "${test.step}.${test.field}" is a ${type}, so equals must be one`;
        break;
      }
    }
  }
  return undefined;
}

const itemCount = (items: ItemSource): number => (items.kind === 'list' ? items.items.length : items.max);

/** Agent calls and checks in a run, with each pipeline at its most items. */
export function unitCount(steps: readonly WorkflowNode[]): number {
  const COUNT: { readonly [K in WorkflowNode['kind']]: (node: Extract<WorkflowNode, { kind: K }>) => number } = {
    agent: () => 1,
    parallel: (node) => node.branches.length,
    pipeline: (node) => itemCount(node.items) * node.stages.length,
    gate: (node) => (node.test.kind === 'check' ? 1 : 0),
  };
  return steps.reduce((sum, node) => sum + (COUNT[node.kind] as (n: WorkflowNode) => number)(node), 0);
}

/** A workflow file, read as data; every problem names where it is, and nothing runs. */
export function parseWorkflow(raw: unknown, origin: { readonly name: string; readonly source: WorkflowSource; readonly path: string }): Parsed<WorkflowSpec> {
  if (!NAME.test(origin.name)) return fail(`the file name must be lowercase letters, digits, - and _, such as review-fix-verify.json`);
  if (!isRecord(raw)) return fail('must be a JSON object with steps');
  const extra = Object.keys(raw).find((key) => !(TOP_FIELDS as readonly string[]).includes(key));
  if (extra !== undefined) return fail(`unknown field "${extra}"`);
  const description = raw['description'];
  if (typeof description !== 'string' || description.trim() === '') return fail('description must say in a line what the workflow does');
  const input = raw['input'];
  if (input !== undefined && (typeof input !== 'string' || input.trim() === '')) return fail('input must say what the text after the name means');
  const cap = positive(raw['maxCostUsd'], 'maxCostUsd', WORKFLOW_LIMITS.totalUsd, false);
  if (!cap.ok) return cap;
  const rawSteps = raw['steps'];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return fail('steps must list at least one step');
  const ids = new Ids();
  const steps: WorkflowNode[] = [];
  for (const [i, rawStep] of rawSteps.entries()) {
    const node = parseNode(rawStep, ids, `step ${i + 1}`);
    if (!node.ok) return node;
    steps.push(node.value);
  }
  const problem = checkRefs(steps);
  if (problem !== undefined) return fail(problem);
  if (!steps.some((node) => node.kind !== 'gate')) return fail('steps must run at least one agent');
  const units = unitCount(steps);
  if (units > WORKFLOW_LIMITS.units) return fail(`runs up to ${units} steps, over the ${WORKFLOW_LIMITS.units} a workflow may`);
  return {
    ok: true,
    value: { name: origin.name, description: description.trim(), input: typeof input === 'string' ? input.trim() : undefined, maxCostUsd: cap.value ?? DEFAULT_WORKFLOW_CAP_USD, steps, source: origin.source, path: origin.path },
  };
}

/** The first workflow of each name wins, workspace before global. */
export function mergeWorkflows(groups: readonly (readonly WorkflowSpec[])[]): WorkflowSpec[] {
  const byName = new Map<string, WorkflowSpec>();
  for (const spec of groups.flat()) if (!byName.has(spec.name)) byName.set(spec.name, spec);
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

const agentSteps = (node: WorkflowNode): readonly AgentStep[] =>
  node.kind === 'agent' ? [node] : node.kind === 'parallel' ? node.branches : node.kind === 'pipeline' ? node.stages : [];

/** What a step runs with: its own caps and model, else its role's, else a child's defaults. */
export function stepCaps(step: AgentStep, role: AgentDefinition | undefined): ChildCaps {
  return { maxTurns: step.maxTurns ?? role?.maxTurns ?? DEFAULT_CHILD_CAPS.maxTurns, maxCostUsd: step.maxCostUsd ?? role?.maxCostUsd ?? DEFAULT_CHILD_CAPS.maxCostUsd };
}

/**
 * Why the workflow cannot run in this session, before anything is spent: a role the session has no agent for, or a
 * writer in Plan mode. Writers side by side are safe: those of the main checkout, and those of one lane, take turns.
 */
export function workflowRefusal(spec: WorkflowSpec, agents: readonly AgentDefinition[], mode: ApprovalMode): string | undefined {
  for (const node of spec.steps) {
    for (const step of agentSteps(node)) {
      const role = findAgent(agents, step.role);
      if (role === undefined) return `step ${step.id} names the role "${step.role}", and the subagents are ${agents.map((a) => a.name).join(', ')}`;
      if (role.backend !== undefined) return `step ${step.id}'s role ${step.role} runs on an external agent, which a workflow cannot cap`;
      if (!isReadOnly(role) && mode === 'plan') return `step ${step.id} uses ${step.role}, which changes files, and Plan mode changes nothing; switch to Ask or Auto`;
    }
  }
  return undefined;
}

export type PreviewRow = {
  readonly id: string;
  readonly kind: 'agent' | 'check' | 'gate';
  /** "review", "fix × up to 5", "check". */
  readonly label: string;
  readonly role: string | undefined;
  /** The model the step runs on; empty for a gate. */
  readonly model: string;
  readonly lane: string | undefined;
  readonly readOnly: boolean;
  /** How many times the step runs; for a pipeline over an earlier step's list, its most. */
  readonly count: number;
  readonly dynamic: boolean;
  readonly caps: ChildCaps | undefined;
  /** For one run of the step; null when the model has no price. */
  readonly estimateUsd: number | null;
};

export type WorkflowPreview = {
  readonly name: string;
  readonly description: string;
  readonly input: string;
  readonly path: string;
  readonly rows: readonly PreviewRow[];
  /** Every run at the estimate; null when a step's model has no price. */
  readonly estimateUsd: number | null;
  /** Every run at its cost cap. */
  readonly worstUsd: number;
  readonly capUsd: number;
  /** The first step the total cap would stop before, were every step to spend its whole cap; undefined when it never would. */
  readonly stopsBefore: string | undefined;
  /** Models with no known price, whose cost caps cannot hold. */
  readonly unpriced: readonly string[];
  /** The earlier run this one resumes, and the units its journal replays before the first that runs. */
  readonly resume?: { readonly run: string; readonly replays: readonly string[] } | undefined;
};

const round6 = (usd: number): number => Math.round(usd * 1e6) / 1e6;

/**
 * What a run may cost, step by step, before it runs. A step's estimate is its model's price for `ESTIMATE_CALLS`
 * calls of `ESTIMATE_CALL` tokens, held to its caps; its cap is the most it can spend.
 */
export function workflowPreview(
  spec: WorkflowSpec,
  input: string,
  agents: readonly AgentDefinition[],
  session: { readonly model: string; readonly rates: (model: string) => Rates | undefined },
): WorkflowPreview {
  const rows: PreviewRow[] = [];
  const unpriced = new Set<string>();
  const agentRow = (step: AgentStep, count: number, dynamic: boolean): PreviewRow => {
    const role = findAgent(agents, step.role);
    const caps = stepCaps(step, role);
    const model = step.model ?? role?.model ?? session.model;
    const call = costAt(session.rates(model), { ...ZERO_USAGE, ...ESTIMATE_CALL });
    if (call === null) unpriced.add(model);
    const label = count === 1 && !dynamic ? step.id : `${step.id} × ${dynamic ? 'up to ' : ''}${count}`;
    const estimateUsd = call === null ? null : round6(Math.min(caps.maxCostUsd, Math.min(caps.maxTurns, ESTIMATE_CALLS) * call));
    return { id: step.id, kind: 'agent', label, role: step.role, model, lane: step.lane, readOnly: role === undefined || isReadOnly(role), count, dynamic, caps, estimateUsd };
  };
  for (const node of spec.steps) {
    if (node.kind === 'gate') {
      const label = node.test.kind === 'check' ? 'check' : `${node.test.step}.${node.test.field} is ${JSON.stringify(node.test.equals)}`;
      rows.push({ id: node.id, kind: node.test.kind === 'check' ? 'check' : 'gate', label, role: undefined, model: '', lane: undefined, readOnly: true, count: 1, dynamic: false, caps: undefined, estimateUsd: 0 });
    } else if (node.kind === 'pipeline') {
      for (const stage of node.stages) rows.push(agentRow(stage, itemCount(node.items), node.items.kind === 'from'));
    } else {
      for (const step of agentSteps(node)) rows.push(agentRow(step, 1, false));
    }
  }
  let worst = 0;
  let stopsBefore: string | undefined;
  for (const row of rows) {
    const each = row.caps?.maxCostUsd ?? 0;
    if (stopsBefore === undefined && worst + each * row.count > spec.maxCostUsd + 1e-9) stopsBefore = row.label;
    worst += each * row.count;
  }
  const estimates = rows.map((row) => (row.estimateUsd === null ? null : row.estimateUsd * row.count));
  return {
    name: spec.name,
    description: spec.description,
    input,
    path: spec.path,
    rows,
    estimateUsd: estimates.includes(null) ? null : round6(estimates.reduce<number>((sum, usd) => sum + usd!, 0)),
    worstUsd: round6(worst),
    capUsd: spec.maxCostUsd,
    stopsBefore,
    unpriced: [...unpriced],
  };
}

/** The preview in one line, as the approval card's question and as a client with no card reads it. */
export function previewQuestion(preview: WorkflowPreview): string {
  const steps = preview.rows.filter((row) => row.kind !== 'gate');
  const about = preview.estimateUsd === null ? 'cost unknown' : `about ${usd(preview.estimateUsd)}`;
  const worst = Math.min(preview.worstUsd, preview.capUsd);
  const { resume } = preview;
  const verb = resume === undefined ? 'Run' : 'Resume';
  const from = resume === undefined ? '' : ` from run ${resume.run}`;
  const replays = resume === undefined ? '' : `, ${resume.replays.length} replayed with no model call`;
  return `${verb} workflow ${preview.name}${from}: ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}${replays}, ${about}, at most ${usd(worst)} (cap ${usd(preview.capUsd)})?`;
}

export const WORKFLOW_REASON = 'A workflow starts subagents in the background, and each one spends up to its cap.';


export type UnitStatus = 'running' | 'done' | 'replayed' | 'failed' | 'capped' | 'cancelled' | 'passed';

/** One agent call or check the run issued, in issue order. */
export type WorkflowUnit = {
  /** 1-based, and the unit's tool call id is `unitToolId(index)`. */
  readonly index: number;
  readonly node: number;
  readonly kind: 'agent' | 'check';
  readonly step: string;
  /** "fix", "fix #2", "check". */
  readonly label: string;
  readonly role: string | undefined;
  readonly caps: ChildCaps | undefined;
  readonly status: UnitStatus;
  readonly costUsd: number | null;
  readonly turns: number;
  readonly sessionId: string | undefined;
  /** Why it failed or stopped, in words. */
  readonly note: string | undefined;
  /** What a resumed run's journal finds the unit's result by; undefined for a check or a step in a lane, which never replay. */
  readonly key: string | undefined;
  /** Its report once it ended done or replayed, which the run's journal keeps. */
  readonly report: string | undefined;
  /** It ended done with nothing in its report. */
  readonly empty: boolean;
};

export type WorkflowStop =
  | { readonly kind: 'total-cap'; readonly before: string; readonly needUsd: number; readonly leftUsd: number }
  | { readonly kind: 'step-cap'; readonly unit: string; readonly cap: 'turns' | 'cost' }
  | { readonly kind: 'step-failed'; readonly unit: string; readonly reason: string }
  | { readonly kind: 'gate'; readonly unit: string; readonly why: string }
  | { readonly kind: 'cancelled' };


export type StepOutput = { readonly report: string; readonly fields: Readonly<Record<string, FieldValue>> | undefined };

type PipelineItem = { readonly item: string; readonly last: StepOutput | undefined };

export type WorkflowRun = {
  readonly spec: WorkflowSpec;
  readonly input: string;
  readonly status: WorkflowStatus;
  readonly stop: WorkflowStop | undefined;
  /** The node that runs, or runs next, and the stage of a pipeline node. */
  readonly at: { readonly node: number; readonly stage: number };
  /** The running pipeline's items, once its first stage starts. */
  readonly items: readonly PipelineItem[] | undefined;
  readonly outputs: Readonly<Record<string, StepOutput>>;
  readonly units: readonly WorkflowUnit[];
  /** The earlier run whose journal this one replays. */
  readonly resumes: string | undefined;
};

export const startWorkflow = (spec: WorkflowSpec, input: string, resumes?: string): WorkflowRun => ({
  spec,
  input,
  resumes,
  status: 'running',
  stop: undefined,
  at: { node: 0, stage: 0 },
  items: undefined,
  outputs: {},
  units: [],
});

export const workflowSpent = (run: WorkflowRun): number => run.units.reduce((sum, unit) => sum + (unit.costUsd ?? 0), 0);

export const unitToolId = (index: number): string => `toolu_gcode_wf_${index}`;

export type UnitCall =
  | { readonly kind: 'agent'; readonly index: number; readonly role: string; readonly task: string; readonly model: string | undefined; readonly lane: string | undefined; readonly caps: ChildCaps }
  | { readonly kind: 'check'; readonly index: number };

/**
 * What a journal finds an agent call's result by: its task, caps, role and model, so an edit to any of them runs the
 * step again. A step in a lane has none, since its edits live in the earlier run's lane, which a resumed run does not work in.
 */
export function unitKey(step: { readonly task: string; readonly caps: ChildCaps; readonly role: string; readonly model: string | undefined; readonly lane: string | undefined }): string | undefined {
  if (step.lane !== undefined) return undefined;
  const material = JSON.stringify([step.task, step.caps.maxTurns, step.caps.maxCostUsd, step.role, step.model ?? null]);
  return `sha256:${createHash('sha256').update(material).digest('hex')}`;
}

const fieldText = (value: FieldValue): string => (typeof value === 'string' ? value : JSON.stringify(value));

function render(template: Template, run: WorkflowRun, item: PipelineItem | undefined): string {
  const REF_TEXT: { readonly [K in Ref['kind']]: (ref: Extract<Ref, { kind: K }>) => string } = {
    input: () => run.input,
    item: () => item?.item ?? '',
    previous: () => item?.last?.report ?? '',
    step: ({ step }) => run.outputs[step]?.report ?? '',
    field: ({ step, field }) => {
      const value = run.outputs[step]?.fields?.[field];
      return value === undefined ? '' : fieldText(value);
    },
  };
  return template.map((part) => (part.kind === 'text' ? part.text : (REF_TEXT[part.ref.kind] as (r: Ref) => string)(part.ref))).join('');
}

const SHAPE: Readonly<Record<FieldType, string>> = { string: '"text"', number: '0', boolean: 'true', 'string[]': '["text"]' };

export function schemaNote(schema: OutputSchema): string {
  const shape = `{${Object.entries(schema)
    .map(([field, type]) => `"${field}": ${SHAPE[type]}`)
    .join(', ')}}`;
  return `End your report with one JSON block in a \`\`\`json fence, of exactly this shape: ${shape}`;
}

const FIELD_CHECK: Readonly<Record<FieldType, (value: unknown) => boolean>> = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  boolean: (value) => typeof value === 'boolean',
  'string[]': (value) => Array.isArray(value) && value.every((v) => typeof v === 'string'),
};

/** The fields of the last JSON block in a report that holds every field the schema names, with its type. */
export function readFields(report: string, schema: OutputSchema): Parsed<Record<string, FieldValue>> {
  const text = reportBody(report);
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!).reverse();
  for (const block of blocks) {
    let raw: unknown;
    try {
      raw = JSON.parse(block);
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;
    if (Object.entries(schema).every(([field, type]) => FIELD_CHECK[type](raw[field]))) {
      return { ok: true, value: Object.fromEntries(Object.keys(schema).map((field) => [field, raw[field] as FieldValue])) };
    }
  }
  return fail(`its report has no JSON block with ${Object.entries(schema).map(([field, type]) => `${field} (${type})`).join(', ')}`);
}

const nodeOf = (run: WorkflowRun): WorkflowNode | undefined => run.spec.steps[run.at.node];

const stopped = (run: WorkflowRun, stop: WorkflowStop): WorkflowRun => ({ ...run, status: stop.kind === 'cancelled' ? 'cancelled' : 'stopped', stop });

/** Moves past the node, or the pipeline's stage, whose units all settled. */
function advance(run: WorkflowRun): WorkflowRun {
  const node = nodeOf(run);
  if (node?.kind === 'pipeline' && run.at.stage + 1 < node.stages.length) return { ...run, at: { node: run.at.node, stage: run.at.stage + 1 } };
  if (node?.kind === 'pipeline') {
    const joined = (run.items ?? []).map(({ item, last }, i) => `Item ${i + 1}: ${item}\n${last?.report ?? '(no report)'}`).join('\n\n');
    return { ...run, at: { node: run.at.node + 1, stage: 0 }, items: undefined, outputs: { ...run.outputs, [node.id]: { report: joined, fields: undefined } } };
  }
  if (node?.kind === 'parallel') {
    const joined = node.branches.map((branch) => `${branch.id}:\n${run.outputs[branch.id]?.report ?? '(no report)'}`).join('\n\n');
    return { ...run, at: { node: run.at.node + 1, stage: 0 }, outputs: { ...run.outputs, [node.id]: { report: joined, fields: undefined } } };
  }
  return { ...run, at: { node: run.at.node + 1, stage: 0 } };
}

function itemsOf(run: WorkflowRun, source: ItemSource): PipelineItem[] {
  const raw = source.kind === 'list' ? source.items : ((run.outputs[source.step]?.fields?.[source.field] as readonly string[] | undefined) ?? []).slice(0, source.max);
  return raw.map((item) => ({ item, last: undefined }));
}

export type Round = { readonly run: WorkflowRun; readonly calls: readonly UnitCall[] };

/**
 * The calls the run makes next, once the units before them all settled; none when the run ended, by finishing or by a
 * stop. A round starts only when what the total cap has left covers every one of its calls' cost caps in full, so no
 * step gets less than its cap and the run never passes the total.
 */
export function nextRound(run: WorkflowRun, agents: readonly AgentDefinition[]): Round {
  if (run.status !== 'running' || run.units.some((unit) => unit.status === 'running')) return { run, calls: [] };
  let current = run;
  for (;;) {
    const node = nodeOf(current);
    if (node === undefined) return { run: { ...current, status: 'done' }, calls: [] };
    if (node.kind === 'gate' && node.test.kind === 'field') {
      const { step, field, equals } = node.test;
      const value = current.outputs[step]?.fields?.[field];
      if (value !== equals) return { run: stopped(current, { kind: 'gate', unit: node.id, why: `${step}.${field} is ${value === undefined ? 'missing' : JSON.stringify(value)}, not ${JSON.stringify(equals)}` }), calls: [] };
      current = advance(current);
      continue;
    }
    let items = current.items;
    if (node.kind === 'pipeline' && items === undefined) {
      items = itemsOf(current, node.items);
      if (items.length === 0) {
        current = { ...current, outputs: { ...current.outputs, [node.id]: { report: '(no items)', fields: undefined } }, at: { node: current.at.node + 1, stage: 0 } };
        continue;
      }
      current = { ...current, items };
    }
    type Planned = { readonly unit: Omit<WorkflowUnit, 'index'>; readonly call: (index: number) => UnitCall };
    const planAgent = (step: AgentStep, label: string, item: PipelineItem | undefined): Planned => {
      const role = findAgent(agents, step.role);
      const caps = stepCaps(step, role);
      const task = [render(step.prompt, current, item).trim(), ...(step.schema === undefined ? [] : ['', schemaNote(step.schema)])].join('\n');
      const key = unitKey({ task, caps, role: step.role, model: step.model, lane: step.lane });
      const unit = { node: current.at.node, kind: 'agent' as const, step: step.id, label, role: step.role, caps, status: 'running' as const, costUsd: null, turns: 0, sessionId: undefined, note: undefined, key, report: undefined, empty: false };
      return { unit, call: (index) => ({ kind: 'agent', index, role: step.role, task, model: step.model, lane: step.lane, caps }) };
    };
    const planned: Planned[] =
      node.kind === 'agent'
        ? [planAgent(node, node.id, undefined)]
        : node.kind === 'parallel'
          ? node.branches.map((branch) => planAgent(branch, branch.id, undefined))
          : node.kind === 'pipeline'
            ? items!.map((item, i) => planAgent(node.stages[current.at.stage]!, `${node.stages[current.at.stage]!.id} #${i + 1}`, item))
            : [{ unit: { node: current.at.node, kind: 'check', step: node.id, label: node.id, role: undefined, caps: undefined, status: 'running', costUsd: null, turns: 0, sessionId: undefined, note: undefined, key: undefined, report: undefined, empty: false }, call: (index) => ({ kind: 'check', index }) }];
    const needUsd = round6(planned.reduce((sum, { unit }) => sum + (unit.caps?.maxCostUsd ?? 0), 0));
    const leftUsd = round6(current.spec.maxCostUsd - workflowSpent(current));
    if (needUsd > leftUsd + 1e-9) return { run: stopped(current, { kind: 'total-cap', before: planned[0]!.unit.label, needUsd, leftUsd }), calls: [] };
    const first = current.units.length + 1;
    const units = planned.map(({ unit }, i) => ({ ...unit, index: first + i }));
    return { run: { ...current, units: [...current.units, ...units] }, calls: planned.map(({ call }, i) => call(first + i)) };
  }
}

export type UnitOutcome =
  | { readonly kind: 'agent'; readonly end: ChildEnd; readonly report: string; readonly costUsd: number | null; readonly turns: number; readonly sessionId: string | undefined }
  /** A resumed run's unit, settled from the earlier run's journal with no model call. */
  | { readonly kind: 'replayed'; readonly report: string; readonly sessionId: string | undefined }
  /** `passed` is undefined when the workspace has no check command. */
  | { readonly kind: 'check'; readonly passed: boolean | undefined; readonly text: string };

const UNIT_STATUS: { readonly [K in ChildEnd['kind']]: UnitStatus } = { done: 'done', failed: 'failed', cancelled: 'cancelled', capped: 'capped', interrupted: 'failed' };

/**
 * One unit settled. A failed, capped or cancelled step, a report without its schema's block, or a failed check stops
 * the run once the round's other units settle too; a round that settles cleanly moves the run on.
 */
export function settleUnit(run: WorkflowRun, index: number, outcome: UnitOutcome): WorkflowRun {
  const unit = run.units.find((u) => u.index === index);
  if (unit === undefined || unit.status !== 'running') return run;
  let settled: WorkflowUnit;
  let output: StepOutput | undefined;
  let stop: WorkflowStop | undefined;
  if (outcome.kind === 'check') {
    const why = outcome.passed === undefined ? 'the workspace has no check command (set "check" in .gcode.json)' : outcome.passed ? undefined : 'the check failed';
    settled = { ...unit, status: why === undefined ? 'passed' : 'failed', note: why };
    if (why !== undefined) stop = { kind: 'gate', unit: unit.label, why };
  } else {
    const replayed = outcome.kind === 'replayed';
    const end: ChildEnd = replayed ? { kind: 'done' } : outcome.end;
    const spent = replayed ? { costUsd: 0, turns: 0, sessionId: outcome.sessionId } : { costUsd: outcome.costUsd, turns: outcome.turns, sessionId: outcome.sessionId };
    if (end.kind === 'done') {
      const step = run.spec.steps.flatMap(agentSteps).find((s) => s.id === unit.step);
      const fields = step?.schema === undefined ? undefined : readFields(outcome.report, step.schema);
      if (fields?.ok === false) {
        settled = { ...unit, ...spent, status: 'failed', note: fields.problem };
        stop = { kind: 'step-failed', unit: unit.label, reason: fields.problem };
      } else {
        settled = { ...unit, ...spent, status: replayed ? 'replayed' : 'done', report: outcome.report, empty: reportBody(outcome.report).trim() === '' };
        output = { report: outcome.report, fields: fields?.ok === true ? fields.value : undefined };
      }
    } else {
      settled = { ...unit, ...spent, status: UNIT_STATUS[end.kind], note: childEndWords(end) };
      stop = end.kind === 'capped' ? { kind: 'step-cap', unit: unit.label, cap: end.cap } : end.kind === 'cancelled' ? { kind: 'cancelled' } : { kind: 'step-failed', unit: unit.label, reason: end.kind === 'failed' ? end.reason : childEndWords(end) };
    }
  }
  const node = nodeOf(run);
  const items =
    node?.kind === 'pipeline' && output !== undefined && run.items !== undefined
      ? run.items.map((item, i) => (i === pipelineIndex(run, unit) ? { ...item, last: output } : item))
      : run.items;
  const outputs = output !== undefined && node?.kind !== 'pipeline' ? { ...run.outputs, [unit.step]: output } : run.outputs;
  let next: WorkflowRun = { ...run, units: run.units.map((u) => (u.index === index ? settled : u)), outputs, items };
  // The first stop in issue order wins, so the report names what stopped the run first.
  if (stop !== undefined && (next.stop === undefined || next.stop.kind === 'cancelled')) next = { ...next, stop: next.stop?.kind === 'cancelled' ? next.stop : stop };
  if (next.units.some((u) => u.status === 'running')) return next;
  if (next.stop !== undefined) return stopped(next, next.stop);
  return next.status === 'running' ? advance(next) : next;
}

/** Which item of the running pipeline stage a unit is for: units of one stage are issued in item order. */
function pipelineIndex(run: WorkflowRun, unit: WorkflowUnit): number {
  const sameRound = run.units.filter((u) => u.node === unit.node && u.step === unit.step);
  return sameRound.findIndex((u) => u.index === unit.index);
}

/** The user cancelled, or the run's session ended under it: every unit still running is cancelled, and nothing more starts. */
export function cancelWorkflow(run: WorkflowRun, stop: WorkflowStop = { kind: 'cancelled' }): WorkflowRun {
  if (run.status !== 'running') return run;
  const note = stop.kind === 'cancelled' ? 'cancelled by the user' : 'its session ended';
  return stopped({ ...run, units: run.units.map((u) => (u.status === 'running' ? { ...u, status: 'cancelled' as const, note } : u)) }, stop);
}

const CHECK_LINE = /^check `.*` (passed|failed \(exit [^)]+\)|timed out)$/m;

/**
 * A unit's outcome as the session log records it, once it has one: the call's result, and for an agent call the
 * child's end. A child cancelled mid-batch has its end and no result.
 */
export function unitOutcomeOf(events: readonly TurnEvent[], unit: WorkflowUnit): UnitOutcome | undefined {
  const id = unitToolId(unit.index);
  const result = events.find((e) => e.kind === 'tool-result' && e.toolUseId === id);
  const output = result?.kind === 'tool-result' && 'output' in result ? result.output : '';
  if (unit.kind === 'check') {
    if (result === undefined) return undefined;
    const line = CHECK_LINE.exec(output);
    return { kind: 'check', passed: line === null ? undefined : line[1] === 'passed', text: output };
  }
  const ended = events.find((e) => e.kind === 'child-end' && e.toolUseId === id);
  if (ended?.kind === 'child-end') return { kind: 'agent', end: ended.end, report: output, costUsd: ended.costUsd, turns: ended.turns, sessionId: ended.child };
  if (result === undefined) return undefined;
  // The call failed before a child started, such as a role the engine does not know.
  return { kind: 'agent', end: { kind: 'failed', reason: output.trim() || 'it did not start' }, report: '', costUsd: 0, turns: 0, sessionId: undefined };
}

/** The run with every unit the log settled since it last looked. */
export function absorbOutcomes(run: WorkflowRun, events: readonly TurnEvent[]): WorkflowRun {
  let next = run;
  for (const unit of run.units) {
    if (unit.status !== 'running') continue;
    const outcome = unitOutcomeOf(events, unit);
    if (outcome !== undefined) next = settleUnit(next, unit.index, outcome);
  }
  return next;
}

/** A finished agent call as its run's journal keeps it: what finds it, the child that ran it, and its report. */
export type JournalEntry = { readonly key: string; readonly step: string; readonly child: string | undefined; readonly result: string };

/** The run's journal: every agent unit that ended done or replayed, in issue order, so a resumed run can replay it. */
export const journalOf = (run: WorkflowRun): JournalEntry[] =>
  run.units.flatMap((unit) =>
    (unit.status === 'done' || unit.status === 'replayed') && unit.key !== undefined && unit.report !== undefined ? [{ key: unit.key, step: unit.label, child: unit.sessionId, result: unit.report }] : [],
  );

/** What a resumed run replays from: the earlier run's journal, until a round runs an agent call live. */
export type Replay = { readonly run: string; readonly entries: readonly JournalEntry[]; readonly open: boolean };

export const startReplay = (run: string, entries: readonly JournalEntry[]): Replay => ({ run, entries, open: true });

/**
 * The round with each agent call the journal holds settled from it, with no model call, and the calls left to run.
 * Once a round runs an agent call live, nothing after it replays, since a later step may lean on what that one changed.
 * A check always runs, and does not end the replay: it reads the workspace as it is now.
 */
export function replayRound(round: Round, replay: Replay): { readonly round: Round; readonly replay: Replay } {
  if (!replay.open || round.calls.length === 0) return { round, replay };
  let { run } = round;
  let { entries } = replay;
  const live: UnitCall[] = [];
  for (const call of round.calls) {
    const key = call.kind === 'agent' ? run.units.find((unit) => unit.index === call.index)?.key : undefined;
    const at = key === undefined ? -1 : entries.findIndex((entry) => entry.key === key);
    if (at < 0) {
      live.push(call);
      continue;
    }
    const entry = entries[at]!;
    entries = entries.toSpliced(at, 1);
    run = settleUnit(run, call.index, { kind: 'replayed', report: entry.result, sessionId: entry.child });
  }
  return { round: { run, calls: live }, replay: { ...replay, entries, open: live.every((call) => call.kind === 'check') } };
}

/** `nextRound` past every round the journal replays whole: the calls are the first that run, or none once the run ended. */
export function nextLiveRound(run: WorkflowRun, agents: readonly AgentDefinition[], replay: Replay | undefined): { readonly round: Round; readonly replay: Replay | undefined } {
  for (let current = run; ; ) {
    const round = nextRound(current, agents);
    if (replay === undefined) return { round, replay };
    const replayed = replayRound(round, replay);
    replay = replayed.replay;
    if (replayed.round.calls.length > 0 || round.calls.length === 0) return { round: replayed.round, replay };
    current = replayed.round.run;
  }
}

/** The units a resumed run replays before its first call that runs, for the preview; a check's outcome can let more replay after it. */
export function replayedBeforeLive(spec: WorkflowSpec, input: string, agents: readonly AgentDefinition[], replay: Replay): string[] {
  const { round } = nextLiveRound(startWorkflow(spec, input, replay.run), agents, replay);
  return round.run.units.filter((unit) => unit.status === 'replayed').map((unit) => unit.label);
}

/** A round as the calls the workflow issues as the user's own, in place of a model turn. */
export function workflowTurn(calls: readonly UnitCall[], model: string): AssistantTurn {
  const content: ToolUseBlock[] = calls.map((call) => ({
    type: 'tool_use',
    id: unitToolId(call.index),
    name: call.kind === 'agent' ? AGENT_TOOL : WORKFLOW_CHECK_TOOL,
    input:
      call.kind === 'agent'
        ? { agent: call.role, task: call.task, max_turns: call.caps.maxTurns, max_cost_usd: call.caps.maxCostUsd, ...(call.model === undefined ? {} : { model: call.model }), ...(call.lane === undefined ? {} : { lane: call.lane }) }
        : {},
    caller: { type: 'direct' },
  }));
  return { content, stopReason: 'tool_use', usage: ZERO_USAGE, costUsd: 0, latencyMs: 0, model };
}

/** The run's last words in its own session, once it ended by itself. */
export const closingTurn = (run: WorkflowRun, model: string): AssistantTurn => ({
  content: [{ type: 'text', text: workflowReport(run), citations: null }],
  stopReason: 'end_turn',
  usage: ZERO_USAGE,
  costUsd: 0,
  latencyMs: 0,
  model,
});

const STOP_WORDS: { readonly [K in WorkflowStop['kind']]: (stop: Extract<WorkflowStop, { kind: K }>) => string } = {
  'total-cap': ({ before, needUsd, leftUsd }) => `stopped before ${before}: its caps need ${usd(needUsd)} and the total cap has ${usd(leftUsd)} left`,
  'step-cap': ({ unit, cap }) => `stopped at ${unit}, which hit its ${cap === 'turns' ? 'turn' : 'cost'} cap`,
  'step-failed': ({ unit, reason }) => `stopped at ${unit}: ${reason}`,
  gate: ({ unit, why }) => `stopped at the gate ${unit}: ${why}`,
  cancelled: () => 'was cancelled',
};

const stopWords = (stop: WorkflowStop): string => (STOP_WORDS[stop.kind] as (s: WorkflowStop) => string)(stop);

const UNIT_WORDS: Readonly<Record<UnitStatus, string>> = { running: 'running', done: 'done', replayed: 'replayed', failed: 'failed', capped: 'capped', cancelled: 'cancelled', passed: 'passed' };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * What ran, what each step spent, and why the run ended; how many steps came back empty, and whose session to read
 * before diagnosing a failed or empty one; then the last step's report.
 */
export function workflowReport(run: WorkflowRun): string {
  const spent = workflowSpent(run);
  const ran = `${plural(run.units.length, 'step', 'steps')} ran, ${usd(spent)} of its ${usd(run.spec.maxCostUsd)} cap.`;
  const replayed = run.units.filter((unit) => unit.status === 'replayed').length;
  const resumed = run.resumes === undefined ? '' : ` Resumed from run ${run.resumes}: ${replayed} replayed with no model call.`;
  const head = (run.status === 'done' ? `Workflow ${run.spec.name} finished: ${ran}` : `Workflow ${run.spec.name} ${run.stop === undefined ? 'ended' : stopWords(run.stop)}. ${ran}`) + resumed;
  const lines = run.units.map((unit) => {
    const what = unit.role === undefined ? unit.label : `${unit.label} (${unit.role})`;
    const cost =
      unit.kind !== 'agent' ? '' : unit.status === 'replayed' ? ', no model call' : `, ${plural(unit.turns, 'model call', 'model calls')}, ${unit.costUsd === null ? 'cost unknown' : usd(unit.costUsd)}`;
    const session = unit.sessionId === undefined ? '' : `, session ${unit.sessionId}`;
    const note = unit.empty ? ' (empty report)' : unit.note === undefined || unit.status === 'done' ? '' : ` (${unit.note})`;
    return `- ${what}: ${UNIT_WORDS[unit.status]}${note}${cost}${session}`;
  });
  const empty = run.units.filter((unit) => unit.empty).map((unit) => unit.label);
  const emptyLine = `Empty results: ${empty.length}${empty.length === 0 ? '' : ` (${empty.join(', ')})`}.`;
  const diagnose = run.units.flatMap((unit) =>
    unit.kind === 'agent' && unit.sessionId !== undefined && (unit.empty || unit.status === 'failed' || unit.status === 'capped') ? [`Read step session ${unit.sessionId} before diagnosing ${unit.label}.`] : [],
  );
  const reached = new Set(run.units.map((unit) => unit.step));
  const skipped = run.spec.steps
    .slice(run.at.node)
    .flatMap((node, i) => (node.kind === 'gate' ? (i === 0 ? [] : [node.id]) : agentSteps(node).map((s) => s.id)))
    .filter((id) => !reached.has(id));
  const notRun = run.status === 'done' || skipped.length === 0 ? [] : [`Did not run: ${skipped.join(', ')}.`];
  const last = run.units.findLast((unit) => unit.kind === 'agent' && (unit.status === 'done' || unit.status === 'replayed'));
  const lastReport = last === undefined ? undefined : reportBody(lastReportOf(run, last) ?? '').trim();
  return [head, '', ...lines, ...notRun, emptyLine, ...diagnose, ...(lastReport === undefined || lastReport === '' ? [] : ['', `The last report, from ${last!.label}:`, lastReport])].join('\n');
}

function lastReportOf(run: WorkflowRun, unit: WorkflowUnit): string | undefined {
  const node = run.spec.steps[unit.node];
  if (node?.kind === 'pipeline') return run.outputs[node.id]?.report;
  return run.outputs[unit.step]?.report;
}

/** How the run's end reads as a child's end, for the report's fence in the session that started it. */
export function workflowEnd(run: WorkflowRun): ChildEnd {
  if (run.status === 'done') return { kind: 'done' };
  if (run.stop?.kind === 'cancelled' || run.status === 'cancelled') return { kind: 'cancelled' };
  if (run.stop?.kind === 'step-cap') return { kind: 'capped', cap: run.stop.cap };
  if (run.stop?.kind === 'total-cap') return { kind: 'capped', cap: 'cost' };
  return { kind: 'failed', reason: run.stop === undefined ? 'it ended early' : stopWords(run.stop) };
}

export function workflowProgress(run: WorkflowRun): WorkflowProgress {
  return {
    name: run.spec.name,
    step: Math.min(run.at.node + 1, run.spec.steps.length),
    steps: run.spec.steps.length,
    running: run.units.filter((unit) => unit.status === 'running').map((unit) => unit.label),
    spentUsd: round6(workflowSpent(run)),
    capUsd: run.spec.maxCostUsd,
    status: run.status,
    ...(run.stop === undefined ? {} : { stop: stopWords(run.stop) }),
  };
}

export const WORKFLOW_TOOL_SPEC: Tool = {
  name: WORKFLOW_TOOL,
  description:
    'Run one of the workspace\'s workflows: a fixed sequence of subagent steps, such as review, then fix, then verify, from .g-code/workflows. It runs in the background, and its report arrives as a message when it ends. The user sees each step\'s cost cap and the total cap and confirms before anything runs. Use it only when the user asks you to run a workflow; never start one on your own. Without a name it lists the workflows.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The workflow to run, such as review-fix-verify. Omit it to list them.' },
      input: { type: 'string', description: 'The text the workflow takes, such as what to review.' },
      resume: { type: 'string', description: "An earlier run's session id. Its finished steps replay with no model call, and the rest run. Omit input to keep that run's." },
    },
    additionalProperties: false,
  },
};

/** Only a session someone watches can confirm the preview; a non-interactive run has nobody to ask. */
export const WORKFLOW_MODES: Readonly<Record<ApprovalMode, boolean>> = { plan: true, ask: true, auto: true, 'non-interactive': false };

export const workflowToolDefinitions = (mode: ApprovalMode, attached: boolean): readonly Tool[] => (attached && WORKFLOW_MODES[mode] ? [WORKFLOW_TOOL_SPEC] : []);

/** `resume` names an earlier run; with it, an empty input keeps that run's. */
export type WorkflowToolInput = { readonly name: string | undefined; readonly input: string; readonly resume?: string | undefined };

const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;

export function parseWorkflowInput(raw: unknown): Parsed<WorkflowToolInput> {
  if (!isRecord(raw)) return fail(`${WORKFLOW_TOOL} takes {"name", "input", "resume"}`);
  const extra = Object.keys(raw).find((key) => key !== 'name' && key !== 'input' && key !== 'resume');
  if (extra !== undefined) return fail(`${WORKFLOW_TOOL} has an unknown field "${extra}"`);
  const { name, input, resume } = raw;
  if (name !== undefined && (typeof name !== 'string' || !NAME.test(name.trim()))) return fail('name must be a workflow name, from the list');
  if (input !== undefined && typeof input !== 'string') return fail('input must be text');
  if (typeof resume === 'string' && resume.trim() === '') return fail("resume needs the session id of the run to resume, which that run's report and its Tasks row name: /workflow <name> --resume <run>");
  if (resume !== undefined && (typeof resume !== 'string' || !RUN_ID.test(resume.trim()))) return fail("resume must be an earlier run's session id");
  if (resume !== undefined && name === undefined) return fail('resume needs the name of the workflow it resumes');
  return { ok: true, value: { name: typeof name === 'string' ? name.trim() : undefined, input: (input ?? '').trim(), ...(typeof resume === 'string' ? { resume: resume.trim() } : {}) } };
}

/** `/workflow <name> [--resume <run>] [input]`: the name, the run it resumes, and the rest as the input. */
export function parseWorkflowCommand(args: string): WorkflowToolInput {
  const match = /^(\S+)(?:\s+--resume(?:\s+(\S+)|\s*$))?(?:\s+([\s\S]*))?$/.exec(args.trim());
  if (match === null) return { name: undefined, input: '' };
  // A bare --resume names no run, which the tool refuses, rather than being the input "--resume".
  const resume = match[2] ?? (/\s--resume$/.test(args.trim()) ? '' : undefined);
  return { name: match[1]!, input: (match[3] ?? '').trim(), ...(resume === undefined ? {} : { resume }) };
}

export const WORKFLOW_USAGE = 'Usage: /workflow <name> [--resume <run>] [input]. Workflows are JSON files in .g-code/workflows/ or ~/.g-code/workflows/.';

export function workflowList(specs: readonly WorkflowSpec[], problems: readonly string[]): string {
  const lines = specs.length === 0 ? ['No workflows yet. Add a JSON file to .g-code/workflows/ (docs/u64.md has examples).'] : ['The workflows:', ...specs.map((spec) => `- ${spec.name}: ${spec.description}${spec.input === undefined ? '' : ` Input: ${spec.input}`}`)];
  return [...lines, ...(problems.length === 0 ? [] : ['', 'Not loaded:', ...problems.map((problem) => `- ${problem}`)])].join('\n');
}
