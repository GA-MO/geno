import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  absorbOutcomes,
  asSessionId,
  BUILTIN_AGENTS,
  cancelWorkflow,
  childReport,
  closingTurn,
  ESTIMATE_CALL,
  ESTIMATE_CALLS,
  journalOf,
  nextLiveRound,
  nextRound,
  parseTemplate,
  parseWorkflow,
  parseWorkflowCommand,
  parseWorkflowInput,
  PRICES,
  previewQuestion,
  progressLine,
  readFields,
  replayedBeforeLive,
  settleUnit,
  startReplay,
  startWorkflow,
  unitKey,
  unitToolId,
  WORKFLOW_LIMITS,
  workflowEnd,
  workflowPreview,
  workflowProgress,
  workflowRefusal,
  workflowReport,
  workflowToolDefinitions,
  workflowTurn,
  type ChildEnd,
  type JournalEntry,
  type TurnEvent,
  type UnitCall,
  type UnitOutcome,
  type WorkflowRun,
  type WorkflowSpec,
} from '../src/index.js';

const origin = { name: 'review-fix-verify', source: 'workspace' as const, path: '.g-code/workflows/review-fix-verify.json' };

function spec(raw: unknown, name = origin.name): WorkflowSpec {
  const parsed = parseWorkflow(raw, { ...origin, name });
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.value;
}

const problemOf = (raw: unknown): string => {
  const parsed = parseWorkflow(raw, origin);
  if (parsed.ok) throw new Error('parsed');
  return parsed.problem;
};

const REVIEW_FIX_VERIFY = {
  description: 'Review the changes, fix what the review found, then check and verify.',
  input: 'What to focus on',
  maxCostUsd: 0.4,
  steps: [
    { id: 'review', role: 'review', prompt: 'Review the uncommitted changes. Focus: {{input}}', schema: { findings: 'string[]' } },
    { id: 'fix', role: 'worker', prompt: ['Fix these findings:', '{{review.findings}}'], maxCostUsd: 0.15, maxTurns: 20 },
    { gate: 'check' },
    { id: 'verify', role: 'review', prompt: 'Check that the fixes hold:\n{{fix}}', schema: { pass: 'boolean' } },
    { gate: { field: 'verify.pass', equals: true } },
  ],
};

const done = (report: string, costUsd = 0.01, turns = 2, child = 'child-1'): UnitOutcome => ({ kind: 'agent', end: { kind: 'done' }, report, costUsd, turns, sessionId: child });
const ended = (end: ChildEnd, costUsd = 0.01): UnitOutcome => ({ kind: 'agent', end, report: 'partial', costUsd, turns: 3, sessionId: 'child-x' });
const json = (value: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/** Runs every round to its end, answering each call with `answer`; returns the run and every call, in order. */
function drive(run: WorkflowRun, answer: (call: UnitCall, run: WorkflowRun) => UnitOutcome): { run: WorkflowRun; rounds: UnitCall[][] } {
  const rounds: UnitCall[][] = [];
  for (let current = run; ; ) {
    const round = nextRound(current, BUILTIN_AGENTS);
    current = round.run;
    if (round.calls.length === 0) return { run: current, rounds };
    rounds.push([...round.calls]);
    for (const call of round.calls) current = settleUnit(current, call.index, answer(call, current));
  }
}

describe('parseWorkflow', () => {
  it('reads review-fix-verify into nodes with ids, templates, caps and schemas', () => {
    const parsed = spec(REVIEW_FIX_VERIFY);
    expect(parsed.maxCostUsd).toBe(0.4);
    expect(parsed.steps.map((node) => [node.kind, node.id])).toEqual([
      ['agent', 'review'],
      ['agent', 'fix'],
      ['gate', 'gate'],
      ['agent', 'verify'],
      ['gate', 'gate-2'],
    ]);
    const fix = parsed.steps[1]!;
    expect(fix.kind === 'agent' && fix.prompt).toEqual([
      { kind: 'text', text: 'Fix these findings:\n' },
      { kind: 'ref', ref: { kind: 'field', step: 'review', field: 'findings' } },
    ]);
    expect(fix.kind === 'agent' && [fix.maxCostUsd, fix.maxTurns]).toEqual([0.15, 20]);
  });

  it('defaults the total cap and names unnamed steps after their role', () => {
    const parsed = spec({ description: 'Two reviews.', steps: [{ role: 'review', prompt: 'a' }, { role: 'review', prompt: 'b' }] });
    expect(parsed.maxCostUsd).toBe(0.5);
    expect(parsed.steps.map((node) => node.id)).toEqual(['review', 'review-2']);
  });

  it.each([
    [{ steps: [{ role: 'review', prompt: 'x' }] }, 'description must say'],
    [{ description: 'x', steps: [] }, 'steps must list at least one step'],
    [{ description: 'x', steps: [{ role: 'review', prompt: 'x' }], extra: 1 }, 'unknown field "extra"'],
    [{ description: 'x', steps: [{ role: 'review', prompt: 'x', color: 'red' }] }, 'step 1: unknown field "color"'],
    [{ description: 'x', steps: [{ role: 'review' }] }, 'step 1: prompt must be text'],
    [{ description: 'x', steps: [{ prompt: 'x' }] }, 'step 1: a step has a role'],
    [{ description: 'x', maxCostUsd: 6, steps: [{ role: 'review', prompt: 'x' }] }, 'maxCostUsd must be a number above 0 and at most 5'],
    [{ description: 'x', steps: [{ role: 'review', prompt: 'x', maxTurns: 2.5 }] }, 'maxTurns must be a whole number'],
    [{ description: 'x', steps: [{ role: 'review', prompt: 'x', schema: { ok: 'date' } }] }, 'schema field "ok" must be one of'],
    [{ description: 'x', steps: [{ role: 'review', prompt: '{{later}}' }, { id: 'later', role: 'review', prompt: 'x' }] }, '{{later}} names no earlier step'],
    [{ description: 'x', steps: [{ id: 'a', role: 'review', prompt: 'x' }, { role: 'review', prompt: '{{a.pass}}' }] }, "{{a.pass}} names no field of an earlier step's schema"],
    [{ description: 'x', steps: [{ role: 'review', prompt: '{{item}}' }] }, "{{item}} works only in a pipeline's stages"],
    [{ description: 'x', steps: [{ role: 'review', prompt: '{{ nope! }}' }] }, '{{nope!}} names nothing'],
    [{ description: 'x', steps: [{ id: 'a', role: 'review', prompt: 'x' }, { id: 'a', role: 'review', prompt: 'y' }] }, 'id "a" is used twice'],
    [{ description: 'x', steps: [{ gate: 'check' }] }, 'steps must run at least one agent'],
    [{ description: 'x', steps: [{ id: 'v', role: 'review', prompt: 'x', schema: { pass: 'boolean' } }, { gate: { field: 'v.pass', equals: 'yes' } }] }, 'v.pass" is a boolean, so equals must be one'],
    [{ description: 'x', steps: [{ parallel: [{ role: 'review', prompt: 'x' }] }] }, 'parallel takes 2 to 8 steps'],
    [{ description: 'x', steps: [{ id: 'r', role: 'review', prompt: 'x', schema: { n: 'number' } }, { pipeline: { items: 'r.n', stages: [{ role: 'review', prompt: '{{item}}' }] } }] }, 'must be a string[] field'],
    [{ description: 'x', steps: [{ pipeline: { items: ['a'], stages: [{ role: 'review', prompt: '{{previous}}' }] } }] }, "{{previous}} works from a pipeline's second stage on"],
  ])('refuses %j with a reason that names where', (raw, problem) => {
    expect(problemOf(raw)).toContain(problem);
  });

  it('refuses a file name that is not a plain name', () => {
    const parsed = parseWorkflow({ description: 'x', steps: [{ role: 'review', prompt: 'x' }] }, { ...origin, name: 'Bad Name' });
    expect(parsed.ok).toBe(false);
  });

  it('caps a run at its most steps, counting a pipeline at its most items', () => {
    const stages = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, role: 'review', prompt: 'x' }));
    const raw = { description: 'x', steps: [{ id: 'r', role: 'review', prompt: 'x', schema: { items: 'string[]' } }, { pipeline: { items: 'r.items', maxItems: 10, stages } }] };
    expect(problemOf(raw)).toBe(`runs up to 51 steps, over the ${WORKFLOW_LIMITS.units} a workflow may`);
  });

  it('reads templates with spaces inside the braces', () => {
    expect(parseTemplate('a {{ input }} b')).toEqual({ ok: true, value: [{ kind: 'text', text: 'a ' }, { kind: 'ref', ref: { kind: 'input' } }, { kind: 'text', text: ' b' }] });
  });
});

describe('workflowRefusal', () => {
  it('names a role the session has no agent for', () => {
    expect(workflowRefusal(spec({ description: 'x', steps: [{ role: 'tester', prompt: 'x' }] }), BUILTIN_AGENTS, 'ask')).toContain('names the role "tester"');
  });

  it('refuses a writer in Plan mode, and allows it in Ask and Auto', () => {
    const parsed = spec(REVIEW_FIX_VERIFY);
    expect(workflowRefusal(parsed, BUILTIN_AGENTS, 'plan')).toContain('step fix uses worker, which changes files');
    expect(workflowRefusal(parsed, BUILTIN_AGENTS, 'ask')).toBeUndefined();
    expect(workflowRefusal(parsed, BUILTIN_AGENTS, 'auto')).toBeUndefined();
  });

  it('lets a step run in a lane, and a role with worktree isolation', () => {
    const isolated = { ...BUILTIN_AGENTS.find((agent) => agent.name === 'worker')!, name: 'lone', isolation: 'worktree' as const };
    const parsed = spec({ description: 'x', steps: [{ role: 'review', prompt: 'a' }, { role: 'worker', prompt: 'b', lane: 'fix' }, { role: 'lone', prompt: 'c' }] });
    expect(workflowRefusal(parsed, [...BUILTIN_AGENTS, isolated], 'auto')).toBeUndefined();
  });

  it('lets a read-only workflow run in Plan', () => {
    expect(workflowRefusal(spec({ description: 'x', steps: [{ role: 'review', prompt: 'x' }] }), BUILTIN_AGENTS, 'plan')).toBeUndefined();
  });
});

describe('workflowPreview', () => {
  const rates = (model: string) => PRICES.modelstudio[model];
  const session = { model: 'qwen3.8-flash', rates };
  const flash = PRICES.modelstudio['qwen3.8-flash']!;
  const call = (ESTIMATE_CALL.input * flash.input + ESTIMATE_CALL.output * flash.output) / 1e6;

  it('estimates each step from its model price and caps, and sums the caps', () => {
    const preview = workflowPreview(spec(REVIEW_FIX_VERIFY), 'auth', BUILTIN_AGENTS, session);
    expect(preview.rows.map((row) => [row.label, row.role, row.caps?.maxCostUsd, row.caps?.maxTurns])).toEqual([
      ['review', 'review', 0.05, 8],
      ['fix', 'worker', 0.15, 20],
      ['check', undefined, undefined, undefined],
      ['verify', 'review', 0.05, 8],
      ['verify.pass is true', undefined, undefined, undefined],
    ]);
    const each = Math.round(ESTIMATE_CALLS * call * 1e6) / 1e6;
    expect(preview.rows[0]!.estimateUsd).toBe(each);
    expect(preview.estimateUsd).toBe(Math.round(each * 3 * 1e6) / 1e6);
    expect(preview.worstUsd).toBe(0.25);
    expect(preview.capUsd).toBe(0.4);
    expect(preview.stopsBefore).toBeUndefined();
    expect(previewQuestion(preview)).toBe(`Run workflow review-fix-verify: 4 steps, about $${preview.estimateUsd!.toFixed(2)}, at most $0.25 (cap $0.40)?`);
  });

  it('holds a step estimate to its cost cap and its turn cap', () => {
    const tight = spec({ description: 'x', steps: [{ role: 'review', prompt: 'x', maxCostUsd: 0.001 }, { role: 'review', prompt: 'y', maxTurns: 2 }] });
    const preview = workflowPreview(tight, '', BUILTIN_AGENTS, session);
    expect(preview.rows[0]!.estimateUsd).toBe(0.001);
    expect(preview.rows[1]!.estimateUsd).toBe(Math.round(2 * call * 1e6) / 1e6);
  });

  it('names the step the total cap stops before, were every step to spend its cap', () => {
    const raw = { ...REVIEW_FIX_VERIFY, maxCostUsd: 0.18 };
    expect(workflowPreview(spec(raw), '', BUILTIN_AGENTS, session).stopsBefore).toBe('fix');
  });

  it('counts a pipeline over an earlier list at its most items', () => {
    const raw = {
      description: 'x',
      steps: [
        { id: 'find', role: 'explore', prompt: 'x', schema: { files: 'string[]' } },
        { pipeline: { items: 'find.files', maxItems: 3, stages: [{ id: 'look', role: 'review', prompt: '{{item}}' }] } },
      ],
    };
    const preview = workflowPreview(spec(raw), '', BUILTIN_AGENTS, session);
    expect(preview.rows.map((row) => [row.label, row.count, row.dynamic])).toEqual([
      ['find', 1, false],
      ['look × up to 3', 3, true],
    ]);
    expect(preview.worstUsd).toBe(0.02 + 3 * 0.05);
  });

  it('says a model has no price, and gives no estimate then', () => {
    const preview = workflowPreview(spec({ description: 'x', steps: [{ role: 'review', prompt: 'x', model: 'mystery' }] }), '', BUILTIN_AGENTS, session);
    expect(preview.unpriced).toEqual(['mystery']);
    expect(preview.estimateUsd).toBeNull();
    expect(previewQuestion(preview)).toContain('cost unknown');
  });
});

describe('a run', () => {
  it('runs review, fix, check and verify in order, passing each report on', () => {
    const run = startWorkflow(spec(REVIEW_FIX_VERIFY), 'the login form');
    const { run: end, rounds } = drive(run, (call) => {
      if (call.kind === 'check') return { kind: 'check', passed: true, text: 'check `pnpm test` passed' };
      if (call.task.startsWith('Review the uncommitted')) return done(json({ findings: ['a.ts:3 null check', 'b.ts:9 typo'] }));
      if (call.task.startsWith('Fix')) return done('Fixed both.', 0.03, 5);
      return done(json({ pass: true }));
    });
    expect(rounds.map((round) => round.map((call) => (call.kind === 'agent' ? call.role : 'check')))).toEqual([['review'], ['worker'], ['check'], ['review']]);
    const [review, fix, , verify] = rounds.map((round) => round[0]!) as [UnitCall, UnitCall, UnitCall, UnitCall];
    expect(review.kind === 'agent' && review.task).toBe(
      'Review the uncommitted changes. Focus: the login form\n\nEnd your report with one JSON block in a ```json fence, of exactly this shape: {"findings": ["text"]}',
    );
    expect(fix.kind === 'agent' && fix.task).toBe('Fix these findings:\n["a.ts:3 null check","b.ts:9 typo"]');
    expect(fix.kind === 'agent' && fix.caps).toEqual({ maxTurns: 20, maxCostUsd: 0.15 });
    expect(verify.kind === 'agent' && verify.task).toContain('Check that the fixes hold:\nFixed both.');
    expect(end.status).toBe('done');
    expect(end.units.map((unit) => [unit.index, unit.label, unit.status])).toEqual([
      [1, 'review', 'done'],
      [2, 'fix', 'done'],
      [3, 'gate', 'passed'],
      [4, 'verify', 'done'],
    ]);
    expect(workflowEnd(end)).toEqual({ kind: 'done' });
  });

  it('runs a parallel fan-out of 3 in one round, then joins their reports', () => {
    const raw = {
      description: 'Three angles, then a summary.',
      steps: [
        { parallel: [{ id: 'security', role: 'review', prompt: 'security' }, { id: 'tests', role: 'review', prompt: 'tests' }, { id: 'naming', role: 'review', prompt: 'naming' }] },
        { id: 'sum', role: 'plan', prompt: 'Sum up:\n{{parallel}}\nAnd tests alone: {{tests}}' },
      ],
    };
    const { run, rounds } = drive(startWorkflow(spec(raw), ''), (call) => done(call.kind === 'agent' ? `on ${call.task.split('\n')[0]}` : ''));
    expect(rounds.map((round) => round.length)).toEqual([3, 1]);
    const sum = rounds[1]![0]!;
    expect(sum.kind === 'agent' && sum.task).toBe('Sum up:\nsecurity:\non security\n\ntests:\non tests\n\nnaming:\non naming\nAnd tests alone: on tests');
    expect(run.status).toBe('done');
  });

  it('runs a pipeline over an earlier list, one stage for every item at once, with {{previous}}', () => {
    const raw = {
      description: 'x',
      steps: [
        { id: 'find', role: 'explore', prompt: 'list', schema: { files: 'string[]' } },
        { id: 'each', pipeline: { items: 'find.files', maxItems: 2, stages: [{ id: 'read', role: 'explore', prompt: 'read {{item}}' }, { id: 'judge', role: 'review', prompt: 'judge {{item}}: {{previous}}' }] } },
        { id: 'end', role: 'plan', prompt: '{{each}}' },
      ],
    };
    const { run, rounds } = drive(startWorkflow(spec(raw), ''), (call) => {
      if (call.kind !== 'agent') throw new Error('no check');
      if (call.task.startsWith('list')) return done(json({ files: ['a.ts', 'b.ts', 'c.ts'] }));
      return done(`seen ${call.task}`);
    });
    expect(rounds.map((round) => round.map((call) => (call.kind === 'agent' ? call.task.split('\n')[0] : '')))).toEqual([
      ['list'],
      ['read a.ts', 'read b.ts'],
      ['judge a.ts: seen read a.ts', 'judge b.ts: seen read b.ts'],
      ['Item 1: a.ts'],
    ]);
    expect(run.units.map((unit) => unit.label)).toEqual(['find', 'read #1', 'read #2', 'judge #1', 'judge #2', 'end']);
  });

  it('skips a pipeline whose list is empty', () => {
    const raw = { description: 'x', steps: [{ id: 'find', role: 'explore', prompt: 'list', schema: { files: 'string[]' } }, { pipeline: { items: 'find.files', stages: [{ role: 'review', prompt: '{{item}}' }] } }, { role: 'plan', prompt: 'end' }] };
    const { rounds } = drive(startWorkflow(spec(raw), ''), (call) => done(call.kind === 'agent' && call.task.startsWith('list') ? json({ files: [] }) : 'ok'));
    expect(rounds.length).toBe(2);
  });

  it('stops at a step that hits its cost cap, with a report of what ran and what did not', () => {
    const { run, rounds } = drive(startWorkflow(spec(REVIEW_FIX_VERIFY), ''), (call) =>
      call.kind === 'agent' && call.role === 'worker' ? ended({ kind: 'capped', cap: 'cost' }, 0.15) : done(json({ findings: ['x'] }), 0.02),
    );
    expect(rounds.length).toBe(2);
    expect(run.status).toBe('stopped');
    expect(run.stop).toEqual({ kind: 'step-cap', unit: 'fix', cap: 'cost' });
    expect(workflowEnd(run)).toEqual({ kind: 'capped', cap: 'cost' });
    const report = workflowReport(run);
    expect(report).toContain('Workflow review-fix-verify stopped at fix, which hit its cost cap. 2 steps ran, $0.17 of its $0.40 cap.');
    expect(report).toContain('- fix (worker): capped (stopped at its cost cap), 3 model calls, $0.15, session child-x');
    expect(report).toContain('Did not run: gate, verify, gate-2.');
    expect(report).toContain('The last report, from review:');
  });

  it('stops before a round whose caps the total cap no longer covers', () => {
    const raw = { ...REVIEW_FIX_VERIFY, maxCostUsd: 0.18 };
    const { run, rounds } = drive(startWorkflow(spec(raw), ''), () => done(json({ findings: ['x'] }), 0.04));
    expect(rounds.length).toBe(1);
    expect(run.stop).toEqual({ kind: 'total-cap', before: 'fix', needUsd: 0.15, leftUsd: 0.14 });
    expect(workflowReport(run)).toContain('stopped before fix: its caps need $0.15 and the total cap has $0.14 left');
  });

  it('starts a round the total cap covers exactly', () => {
    const raw = { description: 'x', maxCostUsd: 0.1, steps: [{ role: 'review', prompt: 'a' }, { role: 'review', prompt: 'b' }] };
    const { run } = drive(startWorkflow(spec(raw), ''), () => done('ok', 0.05));
    expect(run.status).toBe('done');
  });

  it('waits for the rest of a round before it stops at a failed branch', () => {
    const raw = { description: 'x', steps: [{ parallel: [{ id: 'a', role: 'review', prompt: 'a' }, { id: 'b', role: 'review', prompt: 'b' }] }, { role: 'plan', prompt: 'end' }] };
    let run = nextRound(startWorkflow(spec(raw), ''), BUILTIN_AGENTS).run;
    run = settleUnit(run, 1, ended({ kind: 'failed', reason: 'model error' }));
    expect(run.status).toBe('running');
    expect(nextRound(run, BUILTIN_AGENTS).calls).toEqual([]);
    run = settleUnit(run, 2, done('fine'));
    expect(run.stop).toEqual({ kind: 'step-failed', unit: 'a', reason: 'model error' });
    expect(nextRound(run, BUILTIN_AGENTS).calls).toEqual([]);
  });

  it('fails a step whose report lacks its schema block', () => {
    const { run } = drive(startWorkflow(spec(REVIEW_FIX_VERIFY), ''), () => done('No JSON here.'));
    expect(run.stop).toEqual({ kind: 'step-failed', unit: 'review', reason: 'its report has no JSON block with findings (string[])' });
  });

  it('stops at a failed check, and at a workspace with no check', () => {
    const answer = (passed: boolean | undefined) => (call: UnitCall) => (call.kind === 'check' ? ({ kind: 'check', passed, text: '' } as const) : done(json({ findings: ['x'] })));
    expect(drive(startWorkflow(spec(REVIEW_FIX_VERIFY), ''), answer(false)).run.stop).toEqual({ kind: 'gate', unit: 'gate', why: 'the check failed' });
    expect(drive(startWorkflow(spec(REVIEW_FIX_VERIFY), ''), answer(undefined)).run.stop).toEqual({ kind: 'gate', unit: 'gate', why: 'the workspace has no check command (set "check" in .gcode.json)' });
  });

  it('stops at a field gate whose value differs', () => {
    const { run } = drive(startWorkflow(spec(REVIEW_FIX_VERIFY), ''), (call) =>
      call.kind === 'check' ? { kind: 'check', passed: true, text: '' } : done(call.task.startsWith('Check that') ? json({ pass: false }) : json({ findings: [] })),
    );
    expect(run.stop).toEqual({ kind: 'gate', unit: 'gate-2', why: 'verify.pass is false, not true' });
  });

  it('cancels: running units end cancelled and nothing more starts', () => {
    let run = nextRound(startWorkflow(spec(REVIEW_FIX_VERIFY), ''), BUILTIN_AGENTS).run;
    run = cancelWorkflow(run);
    expect(run.status).toBe('cancelled');
    expect(run.units.map((unit) => unit.status)).toEqual(['cancelled']);
    expect(nextRound(run, BUILTIN_AGENTS).calls).toEqual([]);
    expect(workflowEnd(run)).toEqual({ kind: 'cancelled' });
    expect(workflowReport(run)).toContain('Workflow review-fix-verify was cancelled. 1 step ran');
  });

  it('settles a unit once', () => {
    let run = nextRound(startWorkflow(spec(REVIEW_FIX_VERIFY), ''), BUILTIN_AGENTS).run;
    run = settleUnit(run, 1, done(json({ findings: [] }), 0.01));
    const again = settleUnit(run, 1, done(json({ findings: [] }), 0.5));
    expect(again).toBe(run);
  });

  it('is deterministic: the same reports give the same calls, ids and tasks', () => {
    const answer = (call: UnitCall): UnitOutcome => (call.kind === 'check' ? { kind: 'check', passed: true, text: '' } : done(call.task.startsWith('Check') ? json({ pass: true }) : json({ findings: ['x'] })));
    const first = drive(startWorkflow(spec(REVIEW_FIX_VERIFY), 'same'), answer);
    const second = drive(startWorkflow(spec(REVIEW_FIX_VERIFY), 'same'), answer);
    const turns = (rounds: UnitCall[][]) => rounds.map((round) => workflowTurn(round, 'm'));
    expect(turns(second.rounds)).toEqual(turns(first.rounds));
    expect(second.run).toEqual(first.run);
  });
});

describe('the log', () => {
  const call = (round: UnitCall[]) => workflowTurn(round, 'qwen3.8-flash');

  it('issues agent calls with their caps and model, and checks as the check tool', () => {
    const turn = call([
      { kind: 'agent', index: 1, role: 'review', task: 'look', model: 'qwen3.7-plus', lane: undefined, caps: { maxTurns: 8, maxCostUsd: 0.05 } },
      { kind: 'check', index: 2 },
    ]);
    expect(turn.content).toEqual([
      { type: 'tool_use', id: 'toolu_gcode_wf_1', name: 'agent', input: { agent: 'review', task: 'look', max_turns: 8, max_cost_usd: 0.05, model: 'qwen3.7-plus' }, caller: { type: 'direct' } },
      { type: 'tool_use', id: 'toolu_gcode_wf_2', name: 'check', input: {}, caller: { type: 'direct' } },
    ]);
    expect(turn.costUsd).toBe(0);
  });

  it('reads each unit from its result and its child end, and a cancelled child from its end alone', () => {
    const raw = { description: 'x', steps: [{ parallel: [{ id: 'a', role: 'review', prompt: 'a' }, { id: 'b', role: 'review', prompt: 'b' }] }, { gate: 'check' }] };
    const run = nextRound(startWorkflow(spec(raw), ''), BUILTIN_AGENTS).run;
    const child = asSessionId('c-a');
    const events: TurnEvent[] = [
      { kind: 'child-end', seq: 3, at: '', child, toolUseId: unitToolId(1), end: { kind: 'done' }, turns: 2, costUsd: 0.004, summary: '' },
      { kind: 'tool-result', seq: 4, at: '', toolUseId: unitToolId(1), name: 'agent', status: 'ok', output: childReport('review', child, { kind: 'done' }, 'all good', { turns: 2, costUsd: 0.004, durationMs: 4000 }) },
      { kind: 'child-end', seq: 5, at: '', child: asSessionId('c-b'), toolUseId: unitToolId(2), end: { kind: 'cancelled' }, turns: 1, costUsd: 0.001, summary: '' },
    ];
    const next = absorbOutcomes(run, events);
    expect(next.units.map((unit) => [unit.label, unit.status, unit.costUsd, unit.sessionId])).toEqual([
      ['a', 'done', 0.004, 'c-a'],
      ['b', 'cancelled', 0.001, 'c-b'],
    ]);
    expect(next.status).toBe('cancelled');
  });

  it('reads a check result by its headline', () => {
    const raw = { description: 'x', steps: [{ role: 'review', prompt: 'a' }, { gate: 'check' }] };
    let run = nextRound(startWorkflow(spec(raw), ''), BUILTIN_AGENTS).run;
    run = settleUnit(run, 1, done('ok'));
    run = nextRound(run, BUILTIN_AGENTS).run;
    const passed = absorbOutcomes(run, [{ kind: 'tool-result', seq: 9, at: '', toolUseId: unitToolId(2), name: 'check', status: 'ok', output: 'check `pnpm test` passed\nok' }]);
    expect(passed.units[1]!.status).toBe('passed');
    const none = absorbOutcomes(run, [{ kind: 'tool-result', seq: 9, at: '', toolUseId: unitToolId(2), name: 'check', status: 'ok', output: 'This workspace has no check command.' }]);
    expect(none.stop?.kind).toBe('gate');
  });

  it('closes with the report as a text turn', () => {
    const { run } = drive(startWorkflow(spec({ description: 'x', steps: [{ role: 'review', prompt: 'a' }] }), ''), () => done('Looks fine.'));
    const turn = closingTurn(run, 'm');
    expect(turn.stopReason).toBe('end_turn');
    expect(turn.content).toEqual([{ type: 'text', text: workflowReport(run), citations: null }]);
    expect(workflowReport(run)).toBe(
      ['Workflow review-fix-verify finished: 1 step ran, $0.01 of its $0.50 cap.', '', '- review (review): done, 2 model calls, $0.01, session child-1', 'Empty results: 0.', '', 'The last report, from review:', 'Looks fine.'].join('\n'),
    );
  });
});

describe('resume', () => {
  const THREE = {
    description: 'Three looks.',
    steps: [
      { id: 'one', role: 'explore', prompt: 'look one at {{input}}' },
      { id: 'two', role: 'explore', prompt: 'look two' },
      { id: 'three', role: 'review', prompt: 'judge', schema: { pass: 'boolean' } },
    ],
  };
  const changed = (step: number, prompt: string) => ({ ...THREE, steps: THREE.steps.map((s, i) => (i === step ? { ...s, prompt } : s)) });

  /** Runs every round live or from the journal; returns the run and the calls that ran live. */
  function resumeDrive(run: WorkflowRun, journal: readonly JournalEntry[] | undefined, answer: (call: UnitCall) => UnitOutcome) {
    const live: UnitCall[] = [];
    let replay = journal === undefined ? undefined : startReplay('run-1', journal);
    for (let current = run; ; ) {
      const next = nextLiveRound(current, BUILTIN_AGENTS, replay);
      current = next.round.run;
      replay = next.replay;
      if (next.round.calls.length === 0) return { run: current, live };
      live.push(...next.round.calls);
      for (const call of next.round.calls) current = settleUnit(current, call.index, answer(call));
    }
  }
  const passing = (call: UnitCall) => done(call.kind === 'agent' && call.task.startsWith('judge') ? json({ pass: true }) : `saw ${call.kind === 'agent' ? call.task : ''}`, 0.01, 2, `child-${call.index}`);
  const failingThree = (call: UnitCall) => (call.kind === 'agent' && call.task.startsWith('judge') ? done('no block') : passing(call));
  const tasksOf = (calls: readonly UnitCall[]) => calls.map((call) => (call.kind === 'agent' ? call.task.split('\n')[0] : 'check'));

  it('keys a call on its task, caps, role and model, and gives a step in a lane none', () => {
    const base = { task: 'look', caps: { maxTurns: 8, maxCostUsd: 0.05 }, role: 'explore', model: undefined, lane: undefined };
    const key = unitKey(base)!;
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(unitKey({ ...base })).toBe(key);
    for (const other of [{ task: 'look!' }, { caps: { maxTurns: 9, maxCostUsd: 0.05 } }, { caps: { maxTurns: 8, maxCostUsd: 0.06 } }, { role: 'review' }, { model: 'qwen3.7-plus' }]) {
      expect(unitKey({ ...base, ...other }), JSON.stringify(other)).not.toBe(key);
    }
    expect(unitKey({ ...base, lane: 'fix' })).toBeUndefined();
  });

  it('journals each agent call that ended done, with its child and its report, and no failed one', () => {
    const { run } = resumeDrive(startWorkflow(spec(THREE), 'a.ts'), undefined, failingThree);
    expect(run.stop).toMatchObject({ kind: 'step-failed', unit: 'three' });
    const journal = journalOf(run);
    expect(journal.map((entry) => [entry.step, entry.child, entry.result])).toEqual([
      ['one', 'child-1', 'saw look one at a.ts'],
      ['two', 'child-2', 'saw look two'],
    ]);
    expect(journal.map((entry) => entry.key)).toEqual(run.units.slice(0, 2).map((unit) => unit.key));
  });

  it('replays steps 1 and 2 with no call once step 3 failed, and runs step 3', () => {
    const first = resumeDrive(startWorkflow(spec(THREE), 'a.ts'), undefined, failingThree);
    const { run, live } = resumeDrive(startWorkflow(spec(THREE), 'a.ts', 'run-1'), journalOf(first.run), passing);
    expect(tasksOf(live)).toEqual(['judge']);
    expect(run.status).toBe('done');
    expect(run.units.map((unit) => [unit.label, unit.status, unit.costUsd, unit.turns, unit.sessionId])).toEqual([
      ['one', 'replayed', 0, 0, 'child-1'],
      ['two', 'replayed', 0, 0, 'child-2'],
      ['three', 'done', 0.01, 2, 'child-3'],
    ]);
    expect(run.outputs['two']?.report, 'a replayed report feeds the steps after it').toBe('saw look two');
    const report = workflowReport(run);
    expect(report).toContain('Workflow review-fix-verify finished: 3 steps ran, $0.01 of its $0.50 cap. Resumed from run run-1: 2 replayed with no model call.');
    expect(report).toContain('- one (explore): replayed, no model call, session child-1');
  });

  it('runs a step whose prompt changed, and every step after it, though their keys match', () => {
    const first = resumeDrive(startWorkflow(spec(THREE), 'a.ts'), undefined, passing);
    expect(first.run.status).toBe('done');
    const { live } = resumeDrive(startWorkflow(spec(changed(1, 'look two again')), 'a.ts', 'run-1'), journalOf(first.run), passing);
    expect(tasksOf(live)).toEqual(['look two again', 'judge']);
    const input = resumeDrive(startWorkflow(spec(THREE), 'b.ts', 'run-1'), journalOf(first.run), passing);
    expect(tasksOf(input.live), 'another input changes the first prompt').toEqual(['look one at b.ts', 'look two', 'judge']);
  });

  it('converges: resuming twice, or resuming the resumed run, replays the same, and a run that finished replays whole', () => {
    const first = resumeDrive(startWorkflow(spec(THREE), 'a.ts'), undefined, failingThree);
    const again = () => resumeDrive(startWorkflow(spec(THREE), 'a.ts', 'run-1'), journalOf(first.run), passing);
    const [a, b] = [again(), again()];
    expect(b.live).toEqual(a.live);
    expect(b.run).toEqual(a.run);
    const resumedJournal = journalOf(a.run);
    expect(resumedJournal.map((entry) => entry.step), 'the resumed run journals its replays too').toEqual(['one', 'two', 'three']);
    const whole = resumeDrive(startWorkflow(spec(THREE), 'a.ts', 'run-1'), resumedJournal, () => {
      throw new Error('no call runs');
    });
    expect(whole.live).toEqual([]);
    expect(whole.run.status).toBe('done');
  });

  it('runs a check while it replays, and replays the steps after a check that passes', () => {
    const answer = (call: UnitCall): UnitOutcome => (call.kind === 'check' ? { kind: 'check', passed: true, text: '' } : done(call.task.startsWith('Check') ? json({ pass: true }) : json({ findings: ['x'] })));
    const first = drive(startWorkflow(spec(REVIEW_FIX_VERIFY), 'auth'), answer);
    const { run, live } = resumeDrive(startWorkflow(spec(REVIEW_FIX_VERIFY), 'auth', 'run-1'), journalOf(first.run), answer);
    expect(tasksOf(live)).toEqual(['check']);
    expect(run.units.map((unit) => unit.status)).toEqual(['replayed', 'replayed', 'passed', 'replayed']);
    expect(replayedBeforeLive(spec(REVIEW_FIX_VERIFY), 'auth', BUILTIN_AGENTS, startReplay('run-1', journalOf(first.run))), 'the preview counts up to the first call that runs').toEqual(['review', 'fix']);
  });

  it('never replays a step in a lane', () => {
    const laned = { ...THREE, steps: THREE.steps.map((s, i) => (i === 0 ? { ...s, role: 'worker', lane: 'fix' } : s)) };
    const first = resumeDrive(startWorkflow(spec(laned), 'a.ts'), undefined, passing);
    expect(journalOf(first.run).map((entry) => entry.step)).toEqual(['two', 'three']);
    const { live } = resumeDrive(startWorkflow(spec(laned), 'a.ts', 'run-1'), journalOf(first.run), passing);
    expect(tasksOf(live)).toEqual(['look one at a.ts', 'look two', 'judge']);
  });

  it('counts empty results and points at the session to read for a failed or empty step', () => {
    const raw = { description: 'x', steps: [{ parallel: [{ id: 'a', role: 'explore', prompt: 'a' }, { id: 'b', role: 'explore', prompt: 'b' }, { id: 'c', role: 'explore', prompt: 'c' }] }] };
    let run = nextRound(startWorkflow(spec(raw), ''), BUILTIN_AGENTS).run;
    run = settleUnit(run, 1, done('  ', 0.01, 2, 'child-a'));
    run = settleUnit(run, 2, { kind: 'agent', end: { kind: 'failed', reason: 'model error' }, report: '', costUsd: 0.01, turns: 1, sessionId: 'child-b' });
    run = settleUnit(run, 3, done('found it', 0.01, 2, 'child-c'));
    const report = workflowReport(run);
    expect(report).toContain('- a (explore): done (empty report), 2 model calls, $0.01, session child-a');
    expect(report).toContain('Empty results: 1 (a).');
    expect(report).toContain('Read step session child-a before diagnosing a.\nRead step session child-b before diagnosing b.');
    expect(report).not.toContain('before diagnosing c');
  });

  it('reads --resume from the command and resume from the tool, and says so in the preview', () => {
    expect(parseWorkflowCommand('three --resume 0a1b-2c the alpha')).toEqual({ name: 'three', input: 'the alpha', resume: '0a1b-2c' });
    expect(parseWorkflowCommand('three --resume 0a1b')).toEqual({ name: 'three', input: '', resume: '0a1b' });
    expect(parseWorkflowInput({ name: 'three', resume: ' 0a1b ' })).toEqual({ ok: true, value: { name: 'three', input: '', resume: '0a1b' } });
    expect(parseWorkflowInput({ name: 'three', resume: '../x' }).ok).toBe(false);
    expect(parseWorkflowInput({ resume: '0a1b' })).toEqual({ ok: false, problem: 'resume needs the name of the workflow it resumes' });
    expect(parseWorkflowCommand('three --resume'), 'a bare --resume names no run, and is not the input').toEqual({ name: 'three', input: '', resume: '' });
    expect(parseWorkflowCommand('three   --resume  ')).toEqual({ name: 'three', input: '', resume: '' });
    expect(parseWorkflowCommand('three --resumes')).toEqual({ name: 'three', input: '--resumes' });
    expect(parseWorkflowInput({ name: 'three', resume: '' })).toEqual({
      ok: false,
      problem: "resume needs the session id of the run to resume, which that run's report and its Tasks row name: /workflow <name> --resume <run>",
    });
    const preview = workflowPreview(spec(THREE), 'a.ts', BUILTIN_AGENTS, { model: 'qwen3.8-flash', rates: (model) => PRICES.modelstudio[model] });
    expect(previewQuestion({ ...preview, resume: { run: 'run-1', replays: ['one', 'two'] } })).toMatch(/^Resume workflow review-fix-verify from run run-1: 3 steps, 2 replayed with no model call, about \$0\.\d+, at most \$0\.09 \(cap \$0\.50\)\?$/);
  });
});

describe('progress', () => {
  it('says which step runs and what it spent', () => {
    let run = nextRound(startWorkflow(spec(REVIEW_FIX_VERIFY), ''), BUILTIN_AGENTS).run;
    expect(progressLine(workflowProgress(run))).toBe('Step 1 of 5: review · $0.00 of $0.40');
    run = settleUnit(run, 1, done(json({ findings: [] }), 0.012));
    run = nextRound(run, BUILTIN_AGENTS).run;
    expect(progressLine(workflowProgress(run))).toBe('Step 2 of 5: fix · $0.01 of $0.40');
    run = settleUnit(run, 2, ended({ kind: 'capped', cap: 'turns' }, 0.02));
    expect(progressLine(workflowProgress(run))).toBe('Step 2 of 5: stopped at fix, which hit its turn cap · $0.03 of $0.40');
  });
});

describe('the tool and the command', () => {
  it('is offered only to a watched session of a client that shows workflows', () => {
    expect(workflowToolDefinitions('ask', true).map((tool) => tool.name)).toEqual(['workflow']);
    expect(workflowToolDefinitions('ask', false)).toEqual([]);
    expect(workflowToolDefinitions('non-interactive', true)).toEqual([]);
  });

  it('reads its input and refuses what it does not take', () => {
    expect(parseWorkflowInput({ name: 'review-fix-verify', input: ' auth ' })).toEqual({ ok: true, value: { name: 'review-fix-verify', input: 'auth' } });
    expect(parseWorkflowInput({})).toEqual({ ok: true, value: { name: undefined, input: '' } });
    expect(parseWorkflowInput({ name: 'x', budget: 1 })).toEqual({ ok: false, problem: 'workflow has an unknown field "budget"' });
    expect(parseWorkflowInput({ name: '../etc' }).ok).toBe(false);
  });

  it('splits /workflow into the name and the input', () => {
    expect(parseWorkflowCommand('review-fix-verify the auth module')).toEqual({ name: 'review-fix-verify', input: 'the auth module' });
    expect(parseWorkflowCommand('  ')).toEqual({ name: undefined, input: '' });
  });

  it('reads the last JSON block that has every field', () => {
    expect(readFields('```json\n{"pass": true}\n```\nthen\n```json\n{"pass": "yes"}\n```', { pass: 'boolean' })).toEqual({ ok: true, value: { pass: true } });
  });
});

describe('the example workflows in docs/workflows', () => {
  const dir = path.join(import.meta.dirname, '..', '..', '..', 'docs', 'workflows');
  const names = readdirSync(dir).filter((file) => file.endsWith('.json'));

  it.each(names)('%s parses, runs in Ask with the built-in roles, and fits its own cap', (file) => {
    const parsed = parseWorkflow(JSON.parse(readFileSync(path.join(dir, file), 'utf8')), { name: file.slice(0, -5), source: 'workspace', path: `docs/workflows/${file}` });
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(workflowRefusal(parsed.value, BUILTIN_AGENTS, 'ask')).toBeUndefined();
    expect(workflowPreview(parsed.value, '', BUILTIN_AGENTS, { model: 'qwen3.8-flash', rates: (model) => PRICES.modelstudio[model] }).stopsBefore).toBeUndefined();
  });

  it('ships both examples', () => {
    expect(names).toEqual(['review-fix-verify.json', 'three-angle-review.json']);
  });
});
