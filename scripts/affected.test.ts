import { describe, expect, it } from 'vitest';
import { selectVscode, suiteFilesOf, tokensOf, type Suite } from './affected.js';

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

  it('runs everything when the harness changes', () => {
    expect(names(['packages/extension/test/launch.ts'])).toHaveLength(SUITES.length);
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
