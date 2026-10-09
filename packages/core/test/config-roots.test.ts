import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appHomeOf, byPrecedence, configHomesOf, configPaths, configRoots, LAUNCH_FILES, projectItemFiles, settingsFiles, type ConfigItem, type SettingsFile } from '../src/index.js';

const WS = '/ws';
const homes = configHomesOf(appHomeOf({}, '/h'), { HOME: '/h' });

describe('the config roots', () => {
  it.each<[Readonly<Record<string, string>>, object]>([
    [{ HOME: '/h' }, { app: '/h/.g-code', user: '/h', claude: '/h/.claude' }],
    [{ HOME: '/h', GCODE_HOME: '/g', CLAUDE_CONFIG_DIR: '/c' }, { app: '/g', user: '/h', claude: '/c' }],
    [{}, { app: '/os/.g-code', user: undefined, claude: undefined }],
  ])('take GCODE_HOME and CLAUDE_CONFIG_DIR over the home, and never guess a home: %j', (env, expected) => {
    expect(configHomesOf(appHomeOf(env, env['HOME'] ?? '/os'), env)).toEqual(expected);
  });

  it('lists every vendor in both places, Geno first, the user first', () => {
    expect(configRoots(homes, WS).map((root) => [root.place, root.vendor, root.dir, root.base])).toEqual([
      ['user', 'geno', '/h/.g-code', '/h/.g-code'],
      ['user', 'agents', '/h/.agents', '/h'],
      ['user', 'claude', '/h/.claude', '/h/.claude'],
      ['project', 'geno', '/ws/.g-code', WS],
      ['project', 'agents', '/ws/.agents', WS],
      ['project', 'claude', '/ws/.claude', WS],
    ]);
    expect(configRoots({ app: '/g', user: undefined }, WS).map((root) => root.dir)).toEqual(['/g', '/ws/.g-code', '/ws/.agents', '/ws/.claude']);
  });

  const items: readonly (readonly [ConfigItem, readonly string[]])[] = [
    ['skills', ['/h/.g-code/skills', '/h/.agents/skills', '/h/.claude/skills', '/ws/.g-code/skills', '/ws/.agents/skills', '/ws/.claude/skills']],
    ['agents', ['/h/.g-code/agents', '/h/.agents/agents', '/h/.claude/agents', '/ws/.g-code/agents', '/ws/.agents/agents', '/ws/.claude/agents']],
    ['commands', ['/h/.g-code/commands', '/h/.agents/commands', '/h/.claude/commands', '/ws/.g-code/commands', '/ws/.agents/commands', '/ws/.claude/commands']],
    ['workflows', ['/h/.g-code/workflows', '/ws/.g-code/workflows']],
    ['launch', ['/ws/.g-code/launch.json', '/ws/.claude/launch.json']],
  ];
  it.each(items)('finds %s in each root that holds them', (item, paths) => {
    expect(configPaths(homes, WS, item).map((root) => root.path)).toEqual(paths.map((p) => path.normalize(p)));
  });

  it('names the launch files workspace-relative, Geno first', () => {
    expect(projectItemFiles('launch')).toEqual(['.g-code/launch.json', '.claude/launch.json']);
    expect(LAUNCH_FILES).toEqual(['.g-code/launch.json', '.claude/launch.json']);
  });

  it('lists every settings file by scope, and orders them so a later one wins', () => {
    const files = settingsFiles(homes, WS);
    expect(files.map((f) => [f.scope, f.vendor, f.file, f.legacy ?? false])).toEqual([
      ['user', 'geno', '/h/.g-code/settings.json', false],
      ['user', 'agents', '/h/.agents/settings.json', false],
      ['user', 'claude', '/h/.claude/settings.json', false],
      ['project-shared', 'geno', '/ws/.g-code/settings.json', false],
      ['project-shared', 'geno', '/ws/.gcode.json', true],
      ['project-shared', 'agents', '/ws/.agents/settings.json', false],
      ['project-shared', 'claude', '/ws/.claude/settings.json', false],
      ['project-local', 'geno', '/ws/.g-code/settings.local.json', false],
      ['project-local', 'agents', '/ws/.agents/settings.local.json', false],
      ['project-local', 'claude', '/ws/.claude/settings.local.json', false],
    ]);
    const ranked = byPrecedence(files.map((source: SettingsFile) => ({ source }))).map(({ source }) => path.relative('/', source.file));
    expect(ranked).toEqual([
      'h/.claude/settings.json',
      'h/.agents/settings.json',
      'h/.g-code/settings.json',
      'ws/.claude/settings.json',
      'ws/.agents/settings.json',
      'ws/.gcode.json',
      'ws/.g-code/settings.json',
      'ws/.claude/settings.local.json',
      'ws/.agents/settings.local.json',
      'ws/.g-code/settings.local.json',
    ]);
  });
});
