import { describe, expect, it } from 'vitest';
import { EXTERNAL_BACKENDS, backendShown, type BackendInfo } from '@g-code/core';
import { laneOffer, planCost, showsTokens, turnCost } from '../src/chat/backend-model.js';
import { BACKEND_LABELS, backendEnv } from '../src/chat/backends-host.js';
import { composerView, NO_FACTS, STARTS_NEW_CHAT, type ComposerFacts, type ComposerInput } from '../src/chat/composer-model.js';
import type { Action, Transcript } from '../src/chat/messages.js';
import { emptyTranscript, reduce } from '../src/chat/transcript.js';

const CURSOR = backendShown('cursor', 'please-read-a-ts');
const MISSING = 'Claude Code speaks ACP through its adapter: npm install -g @agentclientprotocol/claude-agent-acp';
const BACKENDS: BackendInfo[] = [
  { id: 'cursor', label: 'Cursor', plan: 'Cursor plan', availability: { kind: 'ready', path: '/bin/agent' } },
  { id: 'claude-code', label: 'Claude Code', plan: 'Claude plan', availability: { kind: 'missing', reason: MISSING } },
];
const AGENT_MODELS = {
  current: 'default[]',
  options: [
    { value: 'default[]', name: 'Auto' },
    { value: 'grok-4.7[fast=true]', name: 'grok-4.7' },
  ],
};
const GENO_MODELS = [{ provider: 'modelstudio', providerLabel: 'Alibaba Model Studio', model: 'qwen3.8-flash' }];

const at = 1_000_000;
const on = (backend: Transcript['backend'], ...actions: Action[]): Transcript => actions.reduce(reduce, { ...emptyTranscript('qwen3.8-flash'), backend });
const start = (id: string, prompt = 'Please read a.ts'): Action => ({ type: 'turn-start', id, at, prompt });
const end: Action = { type: 'turn-end', at: at + 1000, status: 'done', usage: { model: 'Auto', inputTokens: 0, outputTokens: 0, costUsd: null } };
const laneEdit = (id: string): Action => ({ type: 'tool', id, at, name: 'edit', target: 'a.ts', toolKind: 'edit', status: 'completed' });
const read = (id: string): Action => ({ type: 'tool', id, at, name: 'read', target: 'a.ts', toolKind: 'read', status: 'completed' });
const applied = (id: string): Action[] => [
  { type: 'tool', id, at, name: 'edit', target: 'a.ts', toolKind: 'edit', status: 'completed' },
  { type: 'diff', toolId: id, at, diff: { path: 'a.ts', hunks: [{ id: 'h1', line: 2, removed: ['two'], added: ['TWO'], status: 'pending' }] } },
];

const facts = (more: Partial<ComposerFacts> = {}): ComposerFacts => ({ ...NO_FACTS, provider: 'modelstudio', models: GENO_MODELS, backends: BACKENDS, bahtPerUsd: 33, ...more });
const input = (transcript: Transcript, more: Partial<ComposerFacts> = {}): ComposerInput => ({ transcript, facts: facts(more), mcp: { kind: 'loading' }, queued: undefined, now: at + 5000 });

describe('the model menu with backends', () => {
  it('offers Geno, then each agent the engine knows: another backend starts a new chat, a missing one is disabled with its reason', () => {
    const { menu, model } = composerView(input(on(undefined)));
    expect(menu.backends).toEqual([
      { id: 'geno', label: 'Geno', current: true, disabled: false, detail: undefined },
      { id: 'cursor', label: 'Cursor', current: false, disabled: false, detail: STARTS_NEW_CHAT },
      { id: 'claude-code', label: 'Claude Code', current: false, disabled: true, detail: MISSING },
    ]);
    expect(menu.models.map((m) => [m.label, m.detail, m.current, m.pick])).toEqual([['qwen3.8-flash', 'Alibaba Model Studio', true, { kind: 'geno', provider: 'modelstudio', model: 'qwen3.8-flash' }]]);
    expect(model.backend).toBeUndefined();
  });

  it('lists no backends before the engine answers', () => {
    expect(composerView(input(on(undefined), { backends: [] })).menu.backends).toEqual([]);
  });

  it('lists an external session’s own models, marks its agent current, and names it on the button', () => {
    const { menu, model } = composerView(input(on(CURSOR), { agentModels: AGENT_MODELS }));
    expect(menu.backends.map((b) => [b.id, b.current, b.detail])).toEqual([
      ['geno', false, STARTS_NEW_CHAT],
      ['cursor', true, undefined],
      ['claude-code', false, MISSING],
    ]);
    expect(menu.models.map((m) => [m.key, m.label, m.current, m.pick])).toEqual([
      ['agent:default[]', 'Auto', true, { kind: 'agent', value: 'default[]' }],
      ['agent:grok-4.7[fast=true]', 'grok-4.7', false, { kind: 'agent', value: 'grok-4.7[fast=true]' }],
    ]);
    expect(model).toEqual({ name: 'Auto', effort: undefined, backend: 'Cursor' });
    expect(menu.note).toBeUndefined();
  });
});

describe('the cost of an external turn', () => {
  it('is the plan while it runs and the agent named no price', () => {
    const running = composerView(input(on(CURSOR, start('t1')))).running;
    expect(running?.cost).toEqual({ text: 'Cursor plan', title: 'Cursor reports no price for this turn; your Cursor plan pays for it' });
    expect(composerView(input(on(CURSOR, start('t1')), { turnCostUsd: null })).running?.cost?.text).toBe('Cursor plan');
    expect(composerView(input(on(undefined, start('t1')), { turnCostUsd: null })).running?.cost?.text).toBe('฿ unknown');
    expect(composerView(input(on(undefined, start('t1')))).running?.cost).toBeUndefined();
  });

  it('is the plan in the footer when the agent named none, its price when it did, and nothing for Geno’s unpriced model', () => {
    expect(turnCost(null, CURSOR)).toEqual(planCost(CURSOR));
    expect(turnCost(0.0123, CURSOR)).toEqual({ text: '$0.01', title: '$0.0123 estimated' });
    expect(turnCost(null, undefined)).toBeUndefined();
  });

  it('shows no token counts for an agent that counts none through Geno', () => {
    const usage = { model: 'Auto', inputTokens: 0, outputTokens: 0, costUsd: null };
    expect(showsTokens(usage, CURSOR)).toBe(false);
    expect(showsTokens(usage, undefined)).toBe(true);
    expect(showsTokens({ ...usage, inputTokens: 10 }, CURSOR)).toBe(true);
  });
});

describe('the Apply offer', () => {
  it('follows a turn that edited in the lane, until an apply brings the edits back for review', () => {
    expect(laneOffer(on(CURSOR, start('t1'), read('r1'), end))).toBeUndefined();
    const edited = on(CURSOR, start('t1'), laneEdit('e1'), end);
    expect(laneOffer(edited)).toBe('please-read-a-ts');
    expect(laneOffer([start('t2'), read('r2'), end].reduce(reduce, edited)), 'a later read-only turn still offers it').toBe('please-read-a-ts');
    expect(laneOffer(reduce(edited, start('t2'))), 'nothing while a turn runs').toBeUndefined();
    const back = [start('t2', 'Apply lane please-read-a-ts'), ...applied('a1'), end].reduce(reduce, edited);
    expect(laneOffer(back)).toBeUndefined();
    expect(laneOffer([start('t3'), laneEdit('e3'), end].reduce(reduce, back)), 'a new edit offers it again').toBe('please-read-a-ts');
  });

  it('waits for the lane, and never shows for Geno’s own sessions', () => {
    expect(laneOffer(on({ ...CURSOR, lane: null }, start('t1'), laneEdit('e1'), end))).toBeUndefined();
    expect(laneOffer(on(undefined, start('t1'), laneEdit('e1'), end))).toBeUndefined();
  });

  it('takes the lane from a later backend update', () => {
    const named = reduce(on({ ...CURSOR, lane: null }, start('t1'), laneEdit('e1'), end), { type: 'backend', backend: CURSOR });
    expect(named.backend?.lane).toBe('please-read-a-ts');
    expect(laneOffer(named)).toBe('please-read-a-ts');
  });
});

describe('what the extension tells the engine and the panes of a backend', () => {
  it('names each agent as the registry does', () => {
    expect(BACKEND_LABELS).toEqual({ cursor: EXTERNAL_BACKENDS.cursor.label, 'claude-code': EXTERNAL_BACKENDS['claude-code'].label });
  });

  it('answers the env request with the stored key under the agent’s own variable, and nothing without one', async () => {
    const stored: Record<string, string> = { 'gcode.agents.cursor.apiKey': 'crsr-1', 'gcode.agents.claude-code.apiKey': 'sk-ant-2' };
    const secrets = { get: async (key: string) => stored[key] };
    expect(await backendEnv(secrets, 'cursor')).toEqual({ env: { CURSOR_API_KEY: 'crsr-1' } });
    expect(await backendEnv(secrets, 'claude-code')).toEqual({ env: { ANTHROPIC_API_KEY: 'sk-ant-2' } });
    expect(await backendEnv({ get: async () => undefined }, 'cursor')).toEqual({ env: {} });
    expect(await backendEnv({ get: async () => '' }, 'claude-code')).toEqual({ env: {} });
  });
});
