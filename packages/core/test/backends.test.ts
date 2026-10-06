import { describe, expect, it } from 'vitest';
import {
  ACP_TOOL_KINDS,
  accessOf,
  acpToolKindOf,
  agentModeFor,
  agentSetupOf,
  EXTERNAL_BACKENDS,
  EXTERNAL_TOOL_STEPS,
  externalAnswer,
  externalDenialFor,
  externalTitle,
  externalToolUse,
  modelNameOf,
  type ApprovalMode,
  type CommandScope,
  type ExternalCall,
  type SessionSetupShape,
} from '../src/index.js';

const WS = '/repo/.geno/worktrees/fix';
const scope: CommandScope = { workspace: WS, tempDir: '/tmp/x', home: '/home/me' };
const call = (kind: ExternalCall['kind'], over: Partial<ExternalCall> = {}): ExternalCall => ({ kind, title: '', rawInput: {}, locations: [], ...over });

describe('the translated event table', () => {
  it('names a Geno step, a panel kind and an access class for every ACP kind', () => {
    const rows = Object.fromEntries(ACP_TOOL_KINDS.map((kind) => [kind, [EXTERNAL_TOOL_STEPS[kind].tool, EXTERNAL_TOOL_STEPS[kind].shown, EXTERNAL_TOOL_STEPS[kind].access]]));
    expect(rows).toEqual({
      read: ['read', 'read', 'read'],
      search: ['grep', 'search', 'read'],
      think: ['think', 'other', 'read'],
      edit: ['edit', 'edit', 'write'],
      delete: ['edit', 'edit', 'write'],
      move: ['edit', 'edit', 'write'],
      execute: ['bash', 'execute', 'command'],
      fetch: ['fetch', 'other', 'other'],
      switch_mode: ['tool', 'other', 'other'],
      other: ['tool', 'other', 'other'],
    });
  });

  it('reads an unknown or missing kind as other', () => {
    expect(acpToolKindOf('teleport')).toBe('other');
    expect(acpToolKindOf(undefined)).toBe('other');
    expect(acpToolKindOf('execute')).toBe('execute');
  });

  it('logs calls in the shape of Geno’s own tools, relative to the workspace', () => {
    expect(externalToolUse(call('read', { title: 'Read a.ts', locations: [`${WS}/src/a.ts`] }), WS)).toEqual({ name: 'read', input: { path: 'src/a.ts' } });
    expect(externalToolUse(call('edit', { rawInput: { path: `${WS}/b.ts` } }), WS)).toEqual({ name: 'edit', input: { path: 'b.ts' } });
    expect(externalToolUse(call('execute', { title: 'Run tests', rawInput: { command: ['npm', 'test'] } }), WS)).toEqual({ name: 'bash', input: { command: 'npm test' } });
    expect(externalToolUse(call('execute', { title: 'ls -la' }), WS)).toEqual({ name: 'bash', input: { command: 'ls -la' } });
    expect(externalToolUse(call('search', { title: 'createFetcher' }), WS)).toEqual({ name: 'grep', input: { pattern: 'createFetcher' } });
    expect(externalToolUse(call('fetch', { title: 'https://example.com' }), WS)).toEqual({ name: 'fetch', input: { title: 'https://example.com' } });
  });

  it('titles a step as `<tool> <target>`', () => {
    expect(externalTitle({ name: 'read', input: { path: 'src/a.ts' } })).toBe('read src/a.ts');
    expect(externalTitle({ name: 'bash', input: { command: 'npm test' } })).toBe('bash npm test');
    expect(externalTitle({ name: 'grep', input: { pattern: 'x y' } })).toBe('grep "x y"');
    expect(externalTitle({ name: 'think', input: { title: '' } })).toBe('think');
  });
});

describe('the permission table', () => {
  const verdict = (c: ExternalCall, mode: ApprovalMode) => externalDenialFor(c, scope, mode)?.verdict ?? 'allow';
  const inLane = { locations: [`${WS}/a.ts`] };
  const rows: readonly [string, ExternalCall, Record<ApprovalMode, string>][] = [
    ['read inside', call('read', inLane), { plan: 'allow', ask: 'ask', auto: 'allow', 'non-interactive': 'allow' }],
    ['read outside', call('read', { locations: ['/etc/passwd'] }), { plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'deny' }],
    ['edit', call('edit', inLane), { plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'deny' }],
    ['delete', call('delete', inLane), { plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'deny' }],
    ['safe command', call('execute', { rawInput: { command: 'ls' } }), { plan: 'deny', ask: 'ask', auto: 'allow', 'non-interactive': 'deny' }],
    ['rm -rf outside', call('execute', { rawInput: { command: 'rm -rf /home/me/x' } }), { plan: 'deny', ask: 'ask', auto: 'ask', 'non-interactive': 'deny' }],
    ['fetch', call('fetch', { title: 'https://example.com' }), { plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'deny' }],
  ];
  for (const [name, c, expected] of rows) {
    it(`settles ${name} per mode`, () => {
      const got = Object.fromEntries((['plan', 'ask', 'auto', 'non-interactive'] as const).map((mode) => [mode, verdict(c, mode)]));
      expect(got).toEqual(expected);
    });
  }

  it('names the rule and what is asked about', () => {
    expect(externalDenialFor(call('edit', inLane), scope, 'ask')).toEqual({ rule: 'external-write', reason: 'an external agent changing files', command: 'edit a.ts', verdict: 'ask' });
    expect(accessOf(call('think'), WS)).toBe('read');
  });

  it('answers once and never always', () => {
    const cursor = [
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'allow-always', kind: 'allow_always' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ];
    expect(externalAnswer(cursor, 'allow')).toBe('allow-once');
    expect(externalAnswer(cursor, 'deny')).toBe('reject-once');
    const alwaysOnly = [
      { optionId: 'yes', kind: 'allow_always' },
      { optionId: 'no', kind: 'reject_always' },
    ];
    expect(externalAnswer(alwaysOnly, 'allow')).toBeUndefined();
    expect(externalAnswer(alwaysOnly, 'deny')).toBeUndefined();
    expect(externalAnswer([{ optionId: 'yes', kind: 'allow_always' }, { optionId: 'no', kind: 'reject_once' }], 'allow')).toBe('no');
  });
});

// Recorded from `agent acp` session/new on this Mac: 2026.01.23 (modes carry models) and 2026.10.01 (config options).
const CURSOR_2026_01: SessionSetupShape = {
  modes: {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'auto' },
      { id: 'composer-2.5', name: 'composer-2.5' },
      { id: 'gpt-5.3-codex', name: 'gpt-5.3-codex' },
    ],
  },
};
const CURSOR_2026_10: SessionSetupShape = {
  modes: { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }, { id: 'ask', name: 'Ask' }] },
  models: { currentModelId: 'default[]', availableModels: [{ modelId: 'default[]', name: 'Auto' }, { modelId: 'grok-4.7[fast=true]', name: 'grok-4.7' }] },
  configOptions: [
    { id: 'mode', category: 'mode', type: 'select', currentValue: 'agent', options: [{ value: 'agent', name: 'Agent' }, { value: 'plan', name: 'Plan' }, { value: 'ask', name: 'Ask' }] },
    { id: 'model', category: 'model', type: 'select', currentValue: 'default[]', options: [{ value: 'default[]', name: 'Auto' }, { value: 'grok-4.7[fast=true]', name: 'grok-4.7' }] },
  ],
};

describe('models and modes from session/new', () => {
  it('reads Cursor 2026.01’s modes as its models, with no approval modes', () => {
    const setup = agentSetupOf(CURSOR_2026_01);
    expect(setup.models).toEqual({ source: { kind: 'modes' }, current: 'default', available: CURSOR_2026_01.modes!.availableModes });
    expect(setup.modes).toBeUndefined();
    expect(agentModeFor(setup.modes, 'plan')).toBeUndefined();
  });

  it('prefers a model config option, and maps Geno’s modes onto the agent’s', () => {
    const setup = agentSetupOf(CURSOR_2026_10);
    expect(setup.models?.source).toEqual({ kind: 'config', configId: 'model' });
    expect(setup.models?.available.map((m) => m.id)).toEqual(['default[]', 'grok-4.7[fast=true]']);
    expect(setup.modes).toEqual({ source: { kind: 'config', configId: 'mode' }, current: 'agent', plan: 'plan', build: 'agent' });
    expect([agentModeFor(setup.modes, 'plan'), agentModeFor(setup.modes, 'ask'), agentModeFor(setup.modes, 'auto')]).toEqual(['plan', 'agent', 'agent']);
    expect(modelNameOf(setup.models, 'grok-4.7[fast=true]')).toBe('grok-4.7');
    expect(modelNameOf(setup.models, 'gone')).toBe('gone');
  });

  it('falls back to ACP’s models field, then to nothing', () => {
    const { configOptions: _, ...noConfig } = CURSOR_2026_10;
    expect(agentSetupOf(noConfig).models?.source).toEqual({ kind: 'models' });
    expect(agentSetupOf(noConfig).modes?.source).toEqual({ kind: 'modes' });
    expect(agentSetupOf({})).toEqual({ models: undefined, modes: undefined });
  });

  it('flattens grouped select options', () => {
    const grouped: SessionSetupShape = { configOptions: [{ id: 'm', category: 'model', type: 'select', currentValue: 'a', options: [{ group: 'g', options: [{ value: 'a', name: 'A' }] }] }] };
    expect(agentSetupOf(grouped).models?.available).toEqual([{ id: 'a', name: 'A' }]);
  });
});

describe('the registry', () => {
  it('runs Cursor sandboxed with its own sandbox off, and Claude Code through its ACP adapter', () => {
    expect(EXTERNAL_BACKENDS.cursor.sandbox?.args).toEqual(['--sandbox', 'disabled']);
    expect(EXTERNAL_BACKENDS.cursor.sandbox?.writableHome).not.toContain('.cursor/cli-config.json');
    expect(EXTERNAL_BACKENDS['claude-code'].binaries[0]).toBe('claude-agent-acp');
    expect(EXTERNAL_BACKENDS['claude-code'].sandbox).toBeUndefined();
  });
});
