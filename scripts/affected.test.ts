import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { onlyScriptsChanged, readSuites, selectVscode, suiteFilesOf, tokensOf, type Suite } from './affected.js';

const suite = (name: string, text: string, extra: string[] = []): Suite => ({
  name,
  files: [`packages/extension/test/${name}.integration.test.ts`, `packages/extension/test/suite/${name}.ts`, ...extra],
  text,
});
const SUITES = [
  suite('composer', "click('.mode-picker') .send-menu", ['packages/extension/test/suite/composer-fixture.ts']),
  suite('modes', "click('.mode-picker') .mode-option"),
  suite('lanes', '.lane-card .send-menu'),
  suite('panel', '.turn .rail'),
  suite('chat', '.turn'),
  suite('working', '.working-dino'),
];
const names = (changed: string[], diff = '') => selectVscode(changed, diff, SUITES).map((p) => p.file.replace(/.*\/|\.integration\.test\.ts/g, ''));

describe('selectVscode', () => {
  it('runs only the suites that check a class the panel change touched', () => {
    expect(names(['packages/extension/src/chat/modes.ts'], "+  h('li', { class: 'mode-option' })")).toEqual(['modes']);
  });

  it('runs every suite that names a shared class', () => {
    expect(names(['packages/extension/src/chat/composer.css'], '-.mode-picker {\n+.mode-picker { gap: 2px }')).toEqual(['composer', 'modes']);
  });

  it('ignores a token most suites use and falls back to the panel smoke set', () => {
    expect(names(['packages/extension/src/chat/glyphs.ts'], "+ h('div', { class: 'turn-x' }) .turn")).toEqual(['chat', 'composer', 'panel']);
  });

  it('also matches the changed module by its name', () => {
    expect(names(['packages/extension/src/chat/working-dino.ts'], '+  const x = 1;')).toEqual(['working']);
  });

  it('runs a suite whose own test or fixture changed', () => {
    expect(names(['packages/extension/test/suite/composer-fixture.ts'])).toEqual(['composer']);
  });

  it('runs the engine smoke set for an engine change, and nothing for docs', () => {
    expect(names(['packages/engine/src/drive.ts'])).toEqual(['chat', 'panel', 'working']);
    expect(names(['docs/u44.md'])).toEqual([]);
  });

  it('runs every suite that reads requests or the session log when a file that shapes them changes', () => {
    const readers = [
      ...SUITES,
      suite('mentions', 'const [prompt] = requests[0].messages[0].content'),
      suite('modes-x', 'expect(offeredTools(requests[8]))'),
      suite('context', 'expect(requests[3]!.system).toEqual(requests[0]!.system)'),
      suite('review', "readFile(path.join(home, 'sessions', log))"),
    ];
    const picked = (changed: string[]) => selectVscode(changed, '', readers).map((p) => p.file.replace(/.*\/|\.integration\.test\.ts/g, ''));
    const all = ['chat', 'context', 'mentions', 'modes-x', 'panel', 'review', 'working'];
    expect(picked(['packages/core/src/session.ts'])).toEqual(all);
    expect(picked(['packages/engine/src/tools/agent.ts'])).toEqual(all);
    expect(picked(['packages/engine/src/gh.ts']), 'an engine file that shapes no request runs the smoke set').toEqual(['chat', 'panel', 'working']);
  });

  it('picks the suites that broke silently when P5 to P17 changed the request on purpose', () => {
    const real = readSuites(fileURLToPath(new URL('..', import.meta.url)));
    const broke = ['arena', 'attachments', 'background', 'context', 'mentions', 'modes', 'read-terminal', 'todo', 'wake', 'workflows'];
    const files = ['packages/core/src/session.ts', 'packages/core/src/fence.ts', 'packages/core/src/agent.ts', 'packages/core/src/loop.ts', 'packages/engine/src/drive.ts', 'packages/engine/src/subagents.ts'];
    for (const file of files) {
      const picked = selectVscode([file], '', real).map((p) => p.file.replace(/.*\/|\.integration\.test\.ts/g, ''));
      expect(picked, file).toEqual(expect.arrayContaining(broke));
    }
  });

  it('runs everything when the harness changes', () => {
    expect(names(['packages/extension/test/launch.ts'])).toHaveLength(SUITES.length);
    expect(names(['scripts/vscode-workers.ts']), 'how many files run at once').toHaveLength(SUITES.length);
    for (const file of ['packages/extension/test/pool/broker.ts', 'packages/extension/test/pool/host.ts', 'packages/extension/test/suite/shooting.ts', 'scripts/test-vscode.ts', 'docker/vscode-tests-entry.sh']) {
      expect(names([file]), `${file} runs every suite`).toHaveLength(SUITES.length);
    }
  });

  it('leaves the pool’s own unit test to the unit project', () => {
    expect(names(['packages/extension/test/pool/broker.test.ts'])).toEqual([]);
    expect(names(['scripts/flakes.test.ts'])).toEqual([]);
  });
});

describe('onlyScriptsChanged', () => {
  const manifest = (scripts: Record<string, string>, devDependencies: Record<string, string> = { vitest: '^5.0.3' }) =>
    JSON.stringify({ name: 'g-code', scripts, devDependencies }, null, 2);

  it('lets a root package.json change that adds or edits scripts run no VS Code file', () => {
    expect(onlyScriptsChanged(manifest({ test: 'vitest run' }), manifest({ test: 'vitest run', 'test:golden': 'tsx scripts/golden.ts' }))).toBe(true);
    expect(onlyScriptsChanged(manifest({ test: 'vitest run' }), manifest({ test: 'vitest run --project unit' }))).toBe(true);
  });

  it('treats a dependency change, or a manifest it cannot read, as harness', () => {
    expect(onlyScriptsChanged(manifest({}), manifest({}, { vitest: '^5.1.0' }))).toBe(false);
    expect(onlyScriptsChanged('', manifest({}))).toBe(false);
  });
});

describe('suite parts', () => {
  it('finds imported, set-up and prefixed suite files', () => {
    const text = "import { X } from './suite/lanes-fixture.js';\nawait setUp('lanes', FILES);";
    expect(suiteFilesOf(text, ['lanes', 'lanes-fixture', 'lanes-reload', 'lanesx', 'modes'])).toEqual([
      'packages/extension/test/suite/lanes.ts',
      'packages/extension/test/suite/lanes-fixture.ts',
      'packages/extension/test/suite/lanes-reload.ts',
    ]);
  });

  it('reads classes, kebab strings, message types and command ids from changed lines only', () => {
    expect([...tokensOf(" .not-me {}\n+.lane-card { }\n+ post({ type: 'retry-now' }); run('gcode.lanes.open')")].sort()).toEqual([
      'gcode.lanes.open',
      'lane-card',
      'retry-now',
    ]);
  });
});
