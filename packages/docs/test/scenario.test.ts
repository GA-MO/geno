import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, test } from 'vitest';
import { compileScenario, type CompileContext } from '../src/scenario/compile.js';
import type { OptionId, StepId } from '../src/scenario/model.js';
import { sourceIndex, type SourceIndex } from '../src/scenario/refs.js';
import { lanesSchema, scenarioSchema } from '../src/scenario/schema.js';
import { loadSite, siteOptions } from '../src/scenario/site.js';
import { progressAt, reduce, stateFromHash, walk } from '../src/scenario/tour.js';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(DOCS, '../..');
const lanes = lanesSchema.parse(parse(readFileSync(path.join(DOCS, 'src/data/lanes.yaml'), 'utf8')));

/** Every ref resolves to line 1 unless it names `missing`; every emitted name exists. */
const fakeSource: SourceIndex = {
  resolve: (ref) => (ref.includes('missing') ? `${ref}: no declaration named missing` : { path: ref.split('#')[0]!, anchor: ref.split('#')[1]!, line: 1, url: 'vscode://file/x:1' }),
  literalExists: () => true,
};

function compile(steps: unknown[], source = fakeSource, fragments: CompileContext['fragments'] = {}) {
  const ctx: CompileContext = {
    file: 'test.md',
    id: 'test',
    href: '/test/',
    title: 'test',
    lanes,
    fragments,
    source,
    catalog: { 'turn.text-answer': { id: 'turn.text-answer', title: 'ถามแล้วได้คำตอบ' } },
  };
  return compileScenario(scenarioSchema.parse({ surface: 'vscode', trigger: 't', covers: ['turn.text-answer'], steps }), ctx);
}

const REF = 'packages/core/src/loop.ts#loopStep';
const ends = { end: { turn: 'done', reason: 'end_turn' } };

describe('the ask-mode example scenario', () => {
  const site = loadSite(siteOptions(DOCS));
  const scenario = site.scenarios['ask-mode-bash-approval']!;
  const choose = (option: string) => walk(scenario, { choice: option as OptionId });
  const endOf = (path: readonly StepId[]) => progressAt(scenario, path, path.length - 1);

  test('the real site has no errors', () => {
    expect(site.problems.filter((problem) => problem.level === 'error')).toEqual([]);
  });

  test('Allow once and Always allow both rejoin at run, and the turn goes on to the next model call', () => {
    for (const option of ['allow', 'allow-workspace']) {
      const path = choose(option);
      expect(path).toContain('run');
      expect(path.indexOf('run' as StepId)).toBeGreaterThan(path.indexOf(`choice.${option}.3` as StepId));
      expect(endOf(path).turn).toEqual({ kind: 'end', end: { turn: 'continues', reason: 'call-model' } });
      expect(endOf(path).toolRuns).toBe(1);
    }
  });

  test('Reject never runs the command and ends the turn done (end_turn)', () => {
    const path = choose('reject');
    expect(path).not.toContain('run');
    expect(endOf(path).turn).toEqual({ kind: 'end', end: { turn: 'done', reason: 'end_turn' } });
    expect(endOf(path).toolRuns).toBe(0);
  });

  test('No, and tell the agent skips the command and the turn continues', () => {
    const path = choose('comment');
    expect(path).not.toContain('run');
    expect(path.at(-1)).toBe('choice.comment.10');
    expect(endOf(path).turn).toEqual({ kind: 'end', end: { turn: 'continues', reason: 'call-model' } });
  });

  test('a link into an arm selects that arm', () => {
    const state = stateFromHash(scenario, '#at=choice.reject.4');
    expect(state.choices['choice']).toBe('reject');
    expect(walk(scenario, state.choices)[state.index]).toBe('choice.reject.4');
  });

  test('choosing at the fork keeps the reader on the fork and changes what comes next', () => {
    const atFork = reduce(scenario, stateFromHash(scenario, '#at=choice'), { type: 'choose', fork: 'choice' as StepId, option: 'reject' as OptionId });
    const next = reduce(scenario, atFork, { type: 'next' });
    expect(walk(scenario, next.choices)[next.index]).toBe('choice.reject.1');
  });
});

describe('compile rejects', () => {
  test('a ref the TypeScript declarations do not have, naming the field', () => {
    const result = compile([{ lane: 'loop', at: 'step', do: 'x', ref: 'packages/core/src/loop.ts#noSuchFunction', ...ends }], sourceIndex(REPO));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems).toEqual([expect.objectContaining({ path: 'steps[0].ref', message: expect.stringContaining('no declaration named noSuchFunction') })]);
  });

  test('a lane that is not in lanes.yaml', () => {
    const result = compile([{ lane: 'harness', do: 'x', ref: REF, ...ends }]);
    expect(!result.ok && result.problems).toEqual([expect.objectContaining({ path: 'steps[0].lane', message: expect.stringContaining('"harness" is not in lanes.yaml') })]);
  });

  test('a step no walk reaches', () => {
    const result = compile([{ lane: 'user', do: 'a', ...ends }, { lane: 'user', do: 'b', ...ends }]);
    expect(!result.ok && result.problems).toEqual([expect.objectContaining({ path: 'steps[1]', message: expect.stringContaining('unreachable') })]);
  });

  test('a fork whose arm falls off the end without an end', () => {
    const result = compile([
      { lane: 'user', do: 'pick', fork: { ask: '?', options: [{ id: 'a', label: 'A', steps: [{ lane: 'user', do: 'a', ...ends }] }, { id: 'b', label: 'B', steps: [{ lane: 'user', do: 'b' }] }] } },
    ]);
    expect(!result.ok && result.problems).toEqual([expect.objectContaining({ path: 'steps[0].fork.options[1].steps[0]', message: expect.stringContaining('never ends') })]);
  });

  test('a fork that rejoins before itself and so loops forever', () => {
    const result = compile([
      { id: 'top', lane: 'user', do: 'top' },
      { lane: 'user', do: 'pick', fork: { ask: '?', options: [{ id: 'a', label: 'A', steps: [{ lane: 'user', do: 'a', ...ends }] }, { id: 'b', label: 'B', then: 'top' }] } },
    ]);
    expect(!result.ok && result.problems).toEqual([expect.objectContaining({ message: expect.stringContaining('a walk never ends: choosing 2=b') })]);
  });
});

describe('a rejoin', () => {
  const inner = { inner: [{ id: 'run', lane: 'user', do: 'inner run', ...ends }] } as unknown as CompileContext['fragments'];
  const pick = (then: string) => ({ lane: 'user', do: 'pick', fork: { ask: '?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', then }] } });
  const rejoinOf = (result: ReturnType<typeof compile>) => {
    const flow = result.ok ? result.value.steps['1']!.flow : undefined;
    return flow?.kind === 'fork' ? flow.options.find((option) => option.id === 'b')?.to : undefined;
  };

  test('targets the scenario\'s own step, not a same-named step inside a fragment spliced after it', () => {
    const result = compile([pick('run'), { id: 'run', lane: 'user', do: 'own run' }, { use: 'inner' }], fakeSource, inner);
    expect(rejoinOf(result)).toBe('run');
  });

  test('reaches into a fragment only by its scoped id', () => {
    expect(rejoinOf(compile([pick('inner.run'), { use: 'inner' }], fakeSource, inner))).toBe('inner.run');
  });

  test('to a step only a fragment has fails, naming the scoped candidate', () => {
    const result = compile([pick('run'), { use: 'inner' }], fakeSource, inner);
    expect(!result.ok && result.problems).toEqual([expect.objectContaining({ path: 'steps[0].fork.options[1].then', message: expect.stringContaining('inner.run') })]);
  });

  test('that matches an own step and a fragment step inside an arm fails, naming both', () => {
    const arm = { id: 'x', label: 'X', steps: [pick('run'), { id: 'run', lane: 'user', do: 'own run', ...ends }, { use: 'inner' }] };
    const result = compile([{ lane: 'user', do: 'outer', fork: { ask: '?', options: [arm, { id: 'y', label: 'Y', steps: [{ lane: 'user', do: 'y', ...ends }] }] } }], fakeSource, inner);
    expect(!result.ok && result.problems).toEqual([
      expect.objectContaining({ path: 'steps[0].fork.options[0].steps[0].fork.options[1].then', message: expect.stringMatching(/1\.x\.run.*1\.x\.inner\.run/) }),
    ]);
  });
});

describe('refs through the TypeScript compiler', () => {
  const index = sourceIndex(REPO);
  const lineOf = (file: string, text: string) => readFileSync(path.join(REPO, file), 'utf8').split('\n').findIndex((line) => line.includes(text)) + 1;

  test('a function, a class member, and a quoted line resolve to their own lines', () => {
    expect(index.resolve('packages/core/src/loop.ts#loopStep')).toMatchObject({ line: lineOf('packages/core/src/loop.ts', 'export function loopStep(') });
    expect(index.resolve('packages/extension/src/chat/chat.ts#Chat.askPermission')).toMatchObject({ line: lineOf('packages/extension/src/chat/chat.ts', 'private async askPermission(') });
    expect(index.resolve('packages/engine/src/drive.ts#"results.some((result) => result?.status === \'rejected\')"')).toMatchObject({ line: lineOf('packages/engine/src/drive.ts', "results.some((result) => result?.status === 'rejected')") });
  });

  test('a bare name declared twice at the same depth is ambiguous', () => {
    expect(index.resolve('packages/engine/src/serve.ts#prompt')).toEqual(expect.stringContaining('declared 2 times'));
  });
});

describe('the site', () => {
  test('two pages that cover the same catalog id fail, naming the second page and field', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gdocs-'));
    cpSync(path.join(DOCS, 'src/data'), path.join(root, 'src/data'), { recursive: true });
    mkdirSync(path.join(root, 'src/content/docs/s'), { recursive: true });
    const page = (title: string) =>
      `---\ntitle: ${title}\nscenario:\n  surface: vscode\n  trigger: t\n  covers: [turn.text-answer]\n  steps:\n    - { lane: user, do: x, end: { turn: none } }\n---\n`;
    writeFileSync(path.join(root, 'src/content/docs/s/a.md'), page('A'));
    writeFileSync(path.join(root, 'src/content/docs/s/b.md'), page('B'));
    const site = loadSite({ docsRoot: root, repoRoot: REPO });
    expect(site.problems.filter((problem) => problem.level === 'error')).toEqual([
      { level: 'error', file: 'src/content/docs/s/b.md', path: 'scenario.covers[0]', message: '"turn.text-answer" is already covered by src/content/docs/s/a.md' },
    ]);
  });

  test('a page covering an id the catalog does not have fails', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gdocs-'));
    cpSync(path.join(DOCS, 'src/data'), path.join(root, 'src/data'), { recursive: true });
    mkdirSync(path.join(root, 'src/content/docs'), { recursive: true });
    writeFileSync(
      path.join(root, 'src/content/docs/a.md'),
      `---\ntitle: A\nscenario:\n  surface: vscode\n  trigger: t\n  covers: [turn.not-a-row]\n  steps:\n    - { lane: user, do: x, end: { turn: none } }\n---\n`,
    );
    const errors = loadSite({ docsRoot: root, repoRoot: REPO }).problems.filter((problem) => problem.level === 'error');
    expect(errors).toEqual([expect.objectContaining({ path: 'scenario.covers[0]', message: expect.stringContaining('not in the catalog') })]);
  });

  test('a YAML syntax error in frontmatter or a fragment is a problem on its file and line, and the other pages still load', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gdocs-'));
    cpSync(path.join(DOCS, 'src/data'), path.join(root, 'src/data'), { recursive: true });
    writeFileSync(path.join(root, 'src/data/fragments/broken.yaml'), '- id: a\n  lane: user\n   do: [x\n');
    mkdirSync(path.join(root, 'src/content/docs'), { recursive: true });
    writeFileSync(path.join(root, 'src/content/docs/bad.md'), `---\ntitle: Bad\nscenario:\n  surface: vscode\n  steps: [\n---\n`);
    writeFileSync(
      path.join(root, 'src/content/docs/good.md'),
      `---\ntitle: Good\nscenario:\n  surface: vscode\n  trigger: t\n  covers: [turn.text-answer]\n  steps:\n    - { lane: user, do: x, end: { turn: none } }\n---\n`,
    );
    const site = loadSite({ docsRoot: root, repoRoot: REPO });
    expect(site.problems.filter((problem) => problem.level === 'error')).toEqual([
      { level: 'error', file: 'src/data/fragments/broken.yaml', path: 'line 2', message: expect.not.stringContaining('\n') },
      { level: 'error', file: 'src/content/docs/bad.md', path: 'line 5', message: expect.not.stringContaining('\n') },
    ]);
    expect(Object.keys(site.scenarios)).toEqual(['good']);
  });
});

describe('the progress counters count calls, not steps', () => {
  const site = loadSite(siteOptions(DOCS));
  const endOf = (id: string, choices: Record<string, string>) => {
    const scenario = site.scenarios[id]!;
    const path = walk(scenario, { ...scenario.defaults, ...choices } as Record<string, OptionId>);
    return progressAt(scenario, path, path.length - 1);
  };
  const tallyOf = (steps: unknown[]) => {
    const result = compile(steps);
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    const path = walk(result.value, {});
    return progressAt(result.value, path, path.length - 1);
  };
  const model = { lane: 'model', do: 'asks', ref: REF };
  const tool = (extra = {}) => ({ lane: 'tool', at: 'executor', do: 'runs', ref: REF, ...extra });
  const policy = { lane: 'policy', at: 'rules', do: 'allows', ref: REF };

  test('one bash call drawn as several tool steps is one run on every arm of bash-safe-runs', () => {
    for (const exit of ['zero', 'nonzero', 'timeout']) expect(endOf('bash-safe-runs', { exit })).toMatchObject({ modelCalls: 1, toolRuns: 1 });
  });

  test('a step that stands for two parallel reads counts two', () => {
    expect(tallyOf([model, tool({ runs: 2 }), { ...policy, ...ends }]).toolRuns).toBe(2);
    expect(endOf('mixed-batch-sequencing', { choice: 'allow' }).toolRuns).toBe(4);
    expect(endOf('mixed-batch-sequencing', { choice: 'reject' }).toolRuns).toBe(2);
  });

  test('tool steps split by a policy step are one call, and the next model call opens a new batch', () => {
    expect(tallyOf([model, tool(), policy, tool(), { ...model, ...ends }]).toolRuns).toBe(1);
    expect(tallyOf([model, tool(), model, tool(ends)])).toMatchObject({ modelCalls: 2, toolRuns: 2 });
  });

  test('a call refused before the tool does its work counts nothing', () => {
    expect(tallyOf([model, tool({ runs: 0 }), tool(ends)]).toolRuns).toBe(0);
    expect(endOf('plan-refuses', { which: 'edit' }).toolRuns).toBe(0);
  });

  test('model steps of parallel sessions are separate calls', () => {
    expect(endOf('arena-best-of-n', { 'race-c': 'wait', rank: 'two-plus', choose: 'pick' }).modelCalls).toBe(4);
  });
});

