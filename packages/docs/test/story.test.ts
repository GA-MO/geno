import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, test } from 'vitest';
import { compileScenario, type CompileContext } from '../src/scenario/compile.js';
import { LOOP_FILE, readEndTables, SERVE_FILE } from '../src/scenario/ends.js';
import type { OptionId, Scenario, StepId } from '../src/scenario/model.js';
import { runFiles, type PayloadView } from '../src/scenario/payload.js';
import type { SourceIndex } from '../src/scenario/refs.js';
import { lanesSchema, scenarioSchema } from '../src/scenario/schema.js';
import { loadSite, siteOptions } from '../src/scenario/site.js';
import { ACTORS, beatsOf, branchesAt, choose, layoutLanes, storyBeats, storyFromHash, storyHash, storyStart } from '../src/scenario/story.js';
import { walk } from '../src/scenario/tour.js';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(DOCS, '../..');
const lanes = lanesSchema.parse(parse(readFileSync(path.join(DOCS, 'src/data/lanes.yaml'), 'utf8')));
const tables = readEndTables(readFileSync(path.join(REPO, LOOP_FILE), 'utf8'), readFileSync(path.join(REPO, SERVE_FILE), 'utf8'));
if (!tables.ok) throw new Error(tables.reason);

const source: SourceIndex = { resolve: (ref) => ({ ok: true, ref: { path: ref.split('#')[0]!, anchor: ref.split('#')[1]!, line: 1, url: 'vscode://file/x:1' } }), literalExists: () => true };
const REF = 'packages/core/src/loop.ts#loopStep';
const end = { end: { turn: 'continues' } };
const beat = (title: string, extra: Record<string, unknown> = {}) => ({ beat: { title, text: 'ข้อความ', ...extra } });

function compile(steps: unknown[], fragments: CompileContext['fragments'] = {}) {
  return compileScenario(scenarioSchema.parse({ surface: 'vscode', trigger: 't', covers: ['turn.text-answer'], steps }), {
    file: 'test.md',
    id: 'test',
    href: '/test/',
    title: 'test',
    lanes,
    fragments,
    source,
    runs: runFiles(REPO),
    ends: tables.ok ? tables.tables : (undefined as never),
    catalog: {},
  });
}
const compiled = (steps: unknown[], fragments: CompileContext['fragments'] = {}): Scenario => {
  const result = compile(steps, fragments);
  if (!result.ok) throw new Error(result.problems.map((problem) => `${problem.path} ${problem.message}`).join('\n'));
  return result.value;
};
const messages = (steps: unknown[], fragments: CompileContext['fragments'] = {}) => {
  const result = compile(steps, fragments);
  return result.ok ? [] : result.problems.map((problem) => `${problem.path}: ${problem.message}`);
};

interface ForkPage {
  [i: number]: { beat: { ask?: string }; fork: { options: { label: string; steps: { beat?: unknown }[] }[] } };
}

/** You type, the engine forks on your answer; one arm rejoins, the other ends. */
const forked = [
  { lane: 'user', do: 'พิมพ์', ...beat('You ask') },
  { lane: 'loop', at: 'step', do: 'คิด', ref: REF },
  {
    id: 'ask',
    lane: 'panel',
    at: 'card',
    do: 'ถาม',
    ref: REF,
    ...beat('Geno asks you', { ask: 'Which answer?', to: 'you' }),
    fork: {
      ask: 'ตอบอะไร',
      options: [
        { id: 'yes', label: 'Yes', then: 'run', steps: [{ lane: 'user', do: 'ตอบ yes', ...beat('You say yes') }] },
        { id: 'no', label: 'No', steps: [{ lane: 'user', do: 'ตอบ no', ...beat('You say no', { end: 'Refused' }), ...end }] },
      ],
    },
  },
  { id: 'run', lane: 'tool', at: 'shell', do: 'รัน', ref: REF },
  { lane: 'loop', at: 'step', do: 'จบ', ref: REF, ...beat('Geno finishes'), ...end },
];

describe('beats along a walk', () => {
  const scenario = compiled(forked);
  const titles = (option: string) => beatsOf(scenario, walk(scenario, { ['ask' as StepId]: option as OptionId })).map((item) => item.head.title);

  test('each arm reads as its own story, and a step after a rejoin joins the beat of the arm that reached it', () => {
    expect(titles('yes')).toEqual(['You ask', 'Geno asks you', 'You say yes', 'Geno finishes']);
    expect(titles('no')).toEqual(['You ask', 'Geno asks you', 'You say no']);
    const yes = beatsOf(scenario, walk(scenario, { ['ask' as StepId]: 'yes' as OptionId }));
    expect(yes[2]!.steps).toEqual(['ask.yes.1', 'run']);
    expect(yes[2]!.to).toBe('machine');
  });

  test('from and to default to the actors of the first and last step, and the header overrides them', () => {
    const [first, second] = beatsOf(scenario, walk(scenario, {}));
    expect([first!.from, first!.to, first!.who]).toEqual(['you', 'engine', 'you']);
    expect([second!.from, second!.to, second!.who]).toEqual(['panel', 'you', 'geno']);
  });

  test('a fork lists every option with the beat it opens and where its walk ends', () => {
    const branches = branchesAt(scenario, scenario.defaults, 'ask' as StepId);
    expect(branches.map((branch) => [branch.option.id, branch.chosen, branch.first.head.title, branch.ending.label, branch.beats])).toEqual([
      ['yes', true, 'You say yes', 'Turn ทำต่อ', 4],
      ['no', false, 'You say no', 'Refused', 3],
    ]);
  });

  test('choosing moves the reader to the first beat of the option, and the hash brings both back', () => {
    const state = choose(scenario, { ...storyStart(scenario), at: 1 }, 'ask' as StepId, 'no' as OptionId);
    expect(storyBeats(scenario, state.choices)[state.at]!.head.title).toBe('You say no');
    expect(storyHash(scenario, state)).toBe('#at=ask.no.1');
    expect(storyFromHash(scenario, storyHash(scenario, state))).toEqual(state);
  });

  test('an old link to any step lands on the beat that holds it', () => {
    const state = storyFromHash(scenario, '#at=run');
    expect(storyBeats(scenario, state.choices)[state.at]!.head.title).toBe('You say yes');
  });
});

describe('actors', () => {
  test('every lane maps to one of the five story actors', () => {
    const named = new Set(ACTORS.map((actor) => actor.id));
    expect(lanes.lanes.map((lane) => [lane.id, lane.actor])).toEqual([
      ['user', 'you'],
      ['panel', 'panel'],
      ['editor', 'panel'],
      ['server', 'engine'],
      ['loop', 'engine'],
      ['child', 'model'],
      ['model', 'model'],
      ['tool', 'machine'],
      ['policy', 'engine'],
      ['external', 'machine'],
    ]);
    for (const lane of lanes.lanes) expect(named.has(lane.actor)).toBe(true);
  });
});

describe('story checks reject', () => {
  test('a step before the first beat', () => {
    expect(messages([{ lane: 'user', do: 'x' }, { lane: 'user', do: 'y', ...beat('Later'), ...end }])).toContainEqual(expect.stringContaining('starts with a beat'));
  });

  test('a fork arm that opens no beat', () => {
    const steps = structuredClone(forked) as unknown as ForkPage;
    delete steps[2]!.fork.options[1]!.steps[0]!.beat;
    expect(messages(steps as unknown as unknown[])).toContainEqual(expect.stringContaining('option "no" starts no beat'));
  });

  test('a walk with fewer than two beats', () => {
    expect(messages([{ lane: 'user', do: 'x', ...beat('Only one'), ...end }])).toEqual([expect.stringContaining('1 beat(s)')]);
  });

  test('a title over 60 characters, counting a Thai vowel or tone mark with its consonant', () => {
    const sixty = 'ที่'.repeat(60);
    expect(messages([{ lane: 'user', do: 'x', ...beat(sixty) }, { lane: 'user', do: 'y', ...beat('Model ขอรัน `pnpm add zod`'), ...end }])).toEqual([]);
    expect(messages([{ lane: 'user', do: 'x', ...beat(`${sixty}ก`) }, { lane: 'user', do: 'y', ...beat('จบ'), ...end }])).toEqual([expect.stringContaining('is 61 characters')]);
  });

  test('a beat that ends at a fork without ask', () => {
    const steps = structuredClone(forked) as unknown as ForkPage;
    delete steps[2]!.beat.ask;
    expect(messages(steps as unknown as unknown[])).toEqual([expect.stringContaining('give it ask:')]);
  });

  test('a header inside a fragment', () => {
    const fragments = { shared: [{ lane: 'user', do: 'x', ...beat('Shared') }] };
    expect(messages([{ use: 'shared', ...beat('First') }, { lane: 'user', do: 'y', ...beat('Next'), ...end }], fragments)).toEqual([expect.stringContaining('a fragment carries no beat header')]);
  });

  test('a mock with a prop it does not have, or without one it needs', () => {
    expect(() => compile([{ lane: 'user', do: 'x', ...beat('One', { sees: { kind: 'step', label: 'x', status: 'spinning' } }) }])).toThrow();
    expect(() => compile([{ lane: 'user', do: 'x', ...beat('One', { sees: { kind: 'permission' } }) }])).toThrow();
  });
});

describe('payload mocks read real runs', () => {
  const RUN = 'docs/results/real-usecases/runs/A06-read-not-cat/1';
  const story = (sees: unknown) => [{ lane: 'user', do: 'x', ...beat('One', { sees }) }, { lane: 'user', do: 'y', ...beat('Two'), ...end }];

  test('a request expands its $prefix messages, picks a path, and trims long text', () => {
    const scenario = compiled(story({ kind: 'payload', direction: 'request', source: `${RUN}/requests.jsonl#seq=9`, select: 'messages[-1]', highlight: ['content[0].tool_use_id'] }));
    const view = scenario.steps[scenario.start]!.beat!.sees[0] as PayloadView;
    const message = view.value as { role: string; content: { type: string }[] };
    expect(message.role).toBe('user');
    expect(message.content.map((block) => block.type)).toEqual(['tool_result', 'tool_result', 'tool_result']);
    expect(view.highlight).toEqual(['content.0.tool_use_id']);
    expect(view.caption).toBe('A06 read-not-cat, qwen3.8-flash');
    const whole = compiled(story({ kind: 'payload', direction: 'request', source: `${RUN}/requests.jsonl#seq=9`, select: 'tools[0].description' }));
    expect((whole.steps[whole.start]!.beat!.sees[0] as PayloadView).value).toEqual({ $long: expect.any(String), chars: expect.any(Number) });
  });

  test('a missing seq, a path that does not resolve, and a missing file fail docs:check', () => {
    expect(messages(story({ kind: 'payload', direction: 'response', source: `${RUN}/session.jsonl#seq=999` }))).toEqual([expect.stringContaining('no record with seq 999')]);
    expect(messages(story({ kind: 'payload', direction: 'response', source: `${RUN}/session.jsonl#seq=4`, select: 'content[9]' }))).toEqual([expect.stringContaining('index 9 is outside')]);
    expect(messages(story({ kind: 'payload', direction: 'response', source: `${RUN}/nope.jsonl#seq=4` }))).toEqual([expect.stringContaining('does not exist')]);
  });
});

describe('the exemplar stories', () => {
  const site = loadSite(siteOptions(DOCS));

  test.each(['ask-mode-bash-approval', 'with-tools', 'blocking-report'])('%s has a story of 8 to 15 beats on every walk', (id) => {
    const scenario = site.scenarios[id]!;
    expect(scenario.story).toBe(true);
    for (const beat of storyBeats(scenario, scenario.defaults))
      if (beat.flow.kind === 'fork') expect(branchesAt(scenario, scenario.defaults, beat.last).map((branch) => branch.option.id)).toEqual(beat.flow.options.map((option) => option.id));
    const walks = Object.values(scenario.steps).flatMap((step) => (step.flow.kind === 'fork' ? branchesAt(scenario, scenario.defaults, step.id) : []));
    for (const count of [storyBeats(scenario, scenario.defaults).length, ...walks.map((branch) => branch.beats)]) {
      expect(count).toBeGreaterThanOrEqual(8);
      expect(count).toBeLessThanOrEqual(15);
    }
  });
});

/** The approval card's five buttons: the first goes on to run the command, the other four end the walk. */
const fiveWay = [
  { lane: 'user', do: 'พิมพ์', ...beat('You ask') },
  { lane: 'loop', at: 'step', do: 'คิด', ref: REF, ...beat('Geno checks') },
  {
    id: 'ask',
    lane: 'panel',
    at: 'card',
    do: 'ถาม',
    ref: REF,
    ...beat('Geno asks you', { ask: 'Which button?' }),
    fork: {
      ask: 'กดปุ่มไหน',
      options: ['Allow', 'Always allow in this workspace', 'Deny', 'No, and tell the agent…', 'Stop'].map((label, k) => ({
        id: `o${k}`,
        label,
        ...(k === 0 ? { then: 'run' } : {}),
        steps: [{ lane: k % 2 === 0 ? 'user' : 'model', do: label, ref: REF, ...beat(`You press ${k}`), ...(k === 0 ? {} : end) }],
      })),
    },
  },
  { id: 'run', lane: 'tool', at: 'shell', do: 'รัน', ref: REF, ...beat('Command runs') },
  { lane: 'loop', at: 'step', do: 'จบ', ref: REF, ...beat('Geno finishes'), ...end },
];

describe('the swim-lane layout', () => {
  const overlaps = (a: { x: number; w: number; row: number }, b: { x: number; w: number; row: number }) => a.row === b.row && a.x < b.x + b.w && b.x < a.x + a.w;

  /** Every choice at every fork: no two items share space in a row, time runs left to right, and a fork is one column of chips. */
  function expectTidy(scenario: Scenario) {
    const forks = Object.values(scenario.steps).filter((step) => step.flow.kind === 'fork');
    const choiceSets = [scenario.defaults, ...forks.flatMap((step) => (step.flow.kind === 'fork' ? step.flow.options.map((option) => ({ ...scenario.defaults, [step.id]: option.id })) : []))];
    for (const choices of choiceSets) {
      const beats = storyBeats(scenario, choices);
      const layout = layoutLanes(scenario, choices, beats);
      layout.items.forEach((a, i) => layout.items.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
      const placed = layout.items.filter((item) => item.kind === 'beat');
      placed.slice(1).forEach((item, i) => expect(item.x).toBeGreaterThan(placed[i]!.x));
      for (const diamond of placed.filter((item) => item.fork)) {
        const chips = layout.items.flatMap((item) => (item.kind === 'branch' && item.beat === diamond.beat ? [item] : []));
        expect(chips.map((chip) => chip.branch.option.id)).toEqual(branchesAt(scenario, choices, beats[diamond.beat]!.last).map((branch) => branch.option.id));
        expect(chips.map((chip) => chip.row)).toEqual(chips.map((_, k) => chips[0]!.row + k));
        expect(new Set(chips.map((chip) => chip.x)).size).toBe(1);
        expect(chips[0]!.x).toBeGreaterThan(diamond.x + diamond.w);
        for (const later of placed.filter((item) => item.beat > diamond.beat)) expect(later.x).toBeGreaterThan(chips[0]!.x + chips[0]!.w);
        for (const chip of chips) {
          const at = layout.items.indexOf(chip);
          expect(layout.edges.filter((edge) => edge.to === at)).toEqual([{ from: layout.items.indexOf(diamond), to: at }]);
          expect(layout.edges.filter((edge) => edge.from === at).length).toBe(chip.branch.chosen ? 1 : 0);
        }
      }
    }
  }

  test.each(['ask-mode-bash-approval', 'with-tools', 'blocking-report'])('%s lays out tidily on every walk', (id) => {
    expectTidy(loadSite(siteOptions(DOCS)).scenarios[id]!);
  });

  test('a five-way fork stacks its options in one column, in order, and the walk goes on from the chosen one', () => {
    const scenario = compiled(fiveWay);
    expectTidy(scenario);
    expect(layoutLanes(scenario, scenario.defaults, storyBeats(scenario, scenario.defaults)).rows).toBe(ACTORS.length);
  });
});
