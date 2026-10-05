import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { TOOL_SPECS, type ToolName } from '@g-code/core';
import { DISK_FILES } from '../src/files.js';
import { listEntries } from '../src/tools/list.js';
import { comparePaths } from '../src/tools/ripgrep.js';
import { describeCall, EXECUTORS, runTool, type ToolContext } from '../src/tools/index.js';
import { rgCommand } from './helpers.js';

let ctx: ToolContext;

beforeAll(async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-tools-')));
  const ws = path.join(root, 'ws');
  await mkdir(path.join(ws, 'src', 'lib'), { recursive: true });
  await mkdir(path.join(root, 'outside'));
  await writeFile(path.join(ws, 'README.md'), '# Fixture\n');
  await writeFile(
    path.join(ws, 'src', 'config.ts'),
    "export const SERVER_URL = process.env.SERVER_URL ?? '';\nexport const trimmed = SERVER_URL.replace(/\\/$/, '');\nexport const server_url_lower = 1;\n",
  );
  await writeFile(path.join(ws, 'src', 'lib', 'util.ts'), 'export const util = SERVER_URL;\n');
  await writeFile(path.join(ws, '.hidden.ts'), 'SERVER_URL hidden\n');
  await mkdir(path.join(ws, '.github', 'workflows'), { recursive: true });
  await writeFile(path.join(ws, '.github', 'workflows', 'ci.yml'), 'env:\n  SERVER_URL: https://ci\n');
  await mkdir(path.join(ws, '.git'));
  await writeFile(path.join(ws, '.git', 'config'), 'SERVER_URL in git internals\n');
  await writeFile(path.join(ws, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  await writeFile(path.join(root, 'outside', 'secret.txt'), 'secret\n');
  await symlink(path.join(root, 'outside', 'secret.txt'), path.join(ws, 'escape.txt'));
  await symlink(path.join(root, 'outside'), path.join(ws, 'escape-dir'));
  await symlink(path.join(ws, 'src', 'config.ts'), path.join(ws, 'alias.ts'));
  ctx = { workspace: ws, spillDir: path.join(root, 'spill', 's1'), readRoots: [], attachmentsDir: path.join(root, 'spill', 's1', 'attachments'), rg: rgCommand(), signal: new AbortController().signal, files: DISK_FILES, events: () => [], earlierCalls: async () => {} };
});

let nextId = 0;
const call = (name: string, input: unknown) =>
  runTool({ type: 'tool_use', id: `tu_${nextId++}`, name, input, caller: { type: 'direct' } } as ToolUseBlock, ctx, EXECUTORS);
const ok = (text: string) => ({ status: 'ok', text });
const failure = (pattern: RegExp) => ({ status: 'error', text: expect.stringMatching(pattern) });

describe('read', () => {
  it('numbers every line of a whole file', async () => {
    expect(await call('read', { path: 'src/config.ts' })).toEqual(
      ok(
        "1\texport const SERVER_URL = process.env.SERVER_URL ?? '';\n2\texport const trimmed = SERVER_URL.replace(/\\/$/, '');\n3\texport const server_url_lower = 1;",
      ),
    );
  });

  it('numbers a range from its real line numbers and says what part it is', async () => {
    expect(await call('read', { path: 'src/config.ts', start_line: 2, end_line: 3 })).toEqual(
      ok("2\texport const trimmed = SERVER_URL.replace(/\\/$/, '');\n3\texport const server_url_lower = 1;\n[lines 2-3 of 3]"),
    );
    expect(await call('read', { path: 'src/config.ts', start_line: 3, end_line: null })).toEqual(
      ok('3\texport const server_url_lower = 1;\n[lines 3-3 of 3]'),
    );
  });

  it('rejects a range past the end, a directory, a binary file and a missing file', async () => {
    expect(await call('read', { path: 'src/config.ts', start_line: 9 })).toEqual(failure(/past the end of src\/config.ts, which has 3 lines/));
    expect(await call('read', { path: 'src' })).toEqual(failure(/src is a directory; use list/));
    expect(await call('read', { path: 'image.bin' })).toEqual(failure(/binary/));
    expect(await call('read', { path: 'nope.ts' })).toEqual(failure(/^no such file or directory: nope.ts$/));
  });

  it('returns bad input as an error naming the field, not a throw', async () => {
    expect(await call('read', { path: 'src/config.ts', start_line: 0 })).toEqual(failure(/invalid input[\s\S]*start_line/));
    expect(await call('read', {})).toEqual(failure(/invalid input[\s\S]*path/));
    expect(await call('read', { path: 'a', extra: 1 })).toEqual(failure(/invalid input[\s\S]*extra/));
  });

  it('follows a symlink that stays inside the workspace', async () => {
    expect(await call('read', { path: 'alias.ts', start_line: 3 })).toEqual(ok('3\texport const server_url_lower = 1;\n[lines 3-3 of 3]'));
  });
});

describe('workspace confinement', () => {
  it.each([
    ['read', { path: '../outside/secret.txt' }],
    ['read', { path: '../../../../../../etc/hosts' }],
    ['read', { path: '/etc/hosts' }],
    ['read', { path: '../outside/missing.txt' }],
    ['read', { path: 'escape.txt' }],
    ['read', { path: 'escape-dir/secret.txt' }],
    ['list', { directory: '..' }],
    ['list', { directory: 'escape-dir' }],
  ])('%s %j is rejected as outside the workspace', async (name, input) => {
    expect(await call(name, input)).toEqual(failure(/is outside the workspace$/));
  });

  it('does not search through a symlinked directory', async () => {
    expect(await call('grep', { pattern: 'secret' })).toEqual(ok('no matches'));
  });
});

describe('grep', () => {
  it('returns path:line:text sorted by path, including hidden files but not .git', async () => {
    expect(await call('grep', { pattern: 'SERVER_URL' })).toEqual(
      ok(
        [
          '.github/workflows/ci.yml:2:  SERVER_URL: https://ci',
          '.hidden.ts:1:SERVER_URL hidden',
          "src/config.ts:1:export const SERVER_URL = process.env.SERVER_URL ?? '';",
          "src/config.ts:2:export const trimmed = SERVER_URL.replace(/\\/$/, '');",
          'src/lib/util.ts:1:export const util = SERVER_URL;',
        ].join('\n'),
      ),
    );
  });

  it('limits the search to a path glob and can ignore case', async () => {
    expect(await call('grep', { pattern: 'server_url', path: 'src/*.ts' })).toEqual(
      ok('src/config.ts:3:export const server_url_lower = 1;'),
    );
    expect((await call('grep', { pattern: 'server_url', path: 'src/lib/**', ignore_case: true })).text).toBe(
      'src/lib/util.ts:1:export const util = SERVER_URL;',
    );
  });

  it('says when nothing matched and reports a bad regex', async () => {
    expect(await call('grep', { pattern: 'NOT_PRESENT_ANYWHERE' })).toEqual(ok('no matches'));
    expect(await call('grep', { pattern: '(' })).toEqual(failure(/^ripgrep failed: /));
  });

  it('fails clearly when ripgrep is not installed', async () => {
    const missing = { ...ctx, rg: '/nonexistent/bin/rg' };
    const use = { type: 'tool_use', id: 'tu_rg', name: 'grep', input: { pattern: 'x' }, caller: { type: 'direct' } } as const;
    expect(await runTool(use, missing, EXECUTORS)).toEqual(
      failure(/ripgrep \(\/nonexistent\/bin\/rg\) is not installed or not on PATH; install ripgrep or set GCODE_RG/),
    );
  });
});

describe('unsaved buffers', () => {
  it('replace their files for grep, keeping the path glob and ripgrep order, and ignore buffers outside', async () => {
    const buffers = [
      { path: path.join(ctx.workspace, 'src', 'config.ts'), text: 'export const SERVER_URL = 1;\nconst a = { b: SERVER_URL };\n' },
      { path: path.join(ctx.workspace, 'src', 'a:b.ts'), text: 'SERVER_URL in a new file\n' },
      { path: path.join(ctx.workspace, '..', 'outside', 'secret.txt'), text: 'SERVER_URL secret\n' },
    ];
    const editor = { ...ctx, files: { ...DISK_FILES, unsaved: async () => buffers } };
    const grep = (input: unknown) =>
      runTool({ type: 'tool_use', id: `tu_${nextId++}`, name: 'grep', input, caller: { type: 'direct' } } as ToolUseBlock, editor, EXECUTORS);
    expect((await grep({ pattern: 'SERVER_URL', path: 'src/**' })).text).toBe(
      ['src/a:b.ts:1:SERVER_URL in a new file', 'src/config.ts:1:export const SERVER_URL = 1;', 'src/config.ts:2:const a = { b: SERVER_URL };', 'src/lib/util.ts:1:export const util = SERVER_URL;'].join('\n'),
    );
    const glob = await runTool({ type: 'tool_use', id: 'tu_g', name: 'glob', input: { pattern: 'src/**/*.ts' }, caller: { type: 'direct' } } as ToolUseBlock, editor, EXECUTORS);
    expect(glob.text).toBe('src/a:b.ts\nsrc/config.ts\nsrc/lib/util.ts');
  });

  it('sort as ripgrep does, directory by directory', () => {
    expect(['a-b/x', 'a/x', 'a/b/c', 'a.ts'].toSorted(comparePaths)).toEqual(['a/b/c', 'a/x', 'a-b/x', 'a.ts']);
  });
});

describe('glob', () => {
  it('lists matching files sorted, relative to the workspace, without symlinks', async () => {
    expect(await call('glob', { pattern: 'src/**/*.ts' })).toEqual(ok('src/config.ts\nsrc/lib/util.ts'));
    expect(await call('glob', { pattern: '*.md' })).toEqual(ok('README.md'));
    expect(await call('glob', { pattern: '.github/workflows/*' })).toEqual(ok('.github/workflows/ci.yml'));
    expect(await call('glob', { pattern: 'config' })).toEqual(ok('no files match'));
    expect(await call('glob', { pattern: '*.py' })).toEqual(ok('no files match'));
  });
});

describe('list', () => {
  it('shows entries to the depth asked, counting files below the cut, without .git or symlinks', async () => {
    const root = '.github/ (1 file)\n.hidden.ts\nREADME.md\nimage.bin\nsrc/ (2 files)';
    expect(await call('list', { depth: 1 })).toEqual(ok(root));
    expect(await call('list', { directory: '', depth: 1 })).toEqual(ok(root));
    expect(await call('list', { directory: 'src' })).toEqual(ok('src/config.ts\nsrc/lib/\nsrc/lib/util.ts'));
  });

  it('rejects a file', async () => {
    expect(await call('list', { directory: 'README.md' })).toEqual(failure(/README.md is not a directory; use read/));
  });

  it('builds entries from file paths', () => {
    expect(listEntries(['a/b/c.ts', 'a/b/d.ts', 'a/e.ts', 'f.ts'], 2)).toEqual(['a/', 'a/b/ (2 files)', 'a/e.ts', 'f.ts']);
  });
});

describe('the tool table', () => {
  it('turns an unknown tool into an error result', async () => {
    expect(await call('bash', { command: 'ls' })).toEqual(failure(/^unknown tool bash; the tools are glob, grep, list, read$/));
  });

  it('prints each call as one line', () => {
    const use = (name: string, input: unknown) => ({ type: 'tool_use', id: 'x', name, input, caller: { type: 'direct' } }) as const;
    expect(describeCall(use('grep', { pattern: 'SERVER_URL', path: 'src/**' }), EXECUTORS)).toBe('grep "SERVER_URL" src/**');
    expect(describeCall(use('read', { path: 'a.ts', start_line: 3, end_line: 9 }), EXECUTORS)).toBe('read a.ts:3-9');
    expect(describeCall(use('list', {}), EXECUTORS)).toBe('list .');
    expect(describeCall(use('glob', { pattern: '*.md' }), EXECUTORS)).toBe('glob "*.md"');
    expect(describeCall(use('read', { nope: 1 }), EXECUTORS)).toBe('{"nope":1}');
  });

  it('parses exactly the fields each published schema declares', () => {
    for (const name of Object.keys(TOOL_SPECS) as ToolName[]) {
      const published = TOOL_SPECS[name].input_schema;
      const parsed = z.toJSONSchema(EXECUTORS[name].input, { io: 'input' });
      expect(Object.keys(parsed.properties ?? {}).sort(), name).toEqual(Object.keys(published.properties ?? {}).sort());
      expect((parsed.required ?? []).sort(), name).toEqual([...(published.required ?? [])].sort());
    }
  });
});
