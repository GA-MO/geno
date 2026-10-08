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
  await writeFile(path.join(ws, '.env.local'), 'SERVER_URL=https://secret-host\n');
  await mkdir(path.join(ws, 'config', 'credentials'), { recursive: true });
  await writeFile(path.join(ws, 'config', 'credentials', 'prod.json'), '{"SERVER_URL": "https://secret-host"}\n');
  await symlink(path.join(ws, '.env.local'), path.join(ws, 'settings.txt'));
  ctx = { workspace: ws, spillDir: path.join(root, 'spill', 's1'), readRoots: [], credentialPlaces: [], attachmentsDir: path.join(root, 'spill', 's1', 'attachments'), rg: rgCommand(), signal: new AbortController().signal, files: DISK_FILES, events: () => [], earlierCalls: async () => {}, spillChars: 24_000 };
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
    expect(await call('read', { path: 'nope.ts' })).toEqual(failure(/^no such file or directory: nope.ts\. Relative paths start at the workspace root, \/.+\.$/));
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

  it('limits the search with a glob, still takes a glob in path, and can ignore case', async () => {
    expect(await call('grep', { pattern: 'server_url', glob: 'src/*.ts' })).toEqual(ok('src/config.ts:3:export const server_url_lower = 1;'));
    expect((await call('grep', { pattern: 'server_url', path: 'src/lib/**', ignore_case: true })).text).toBe(
      'src/lib/util.ts:1:export const util = SERVER_URL;',
    );
  });

  it('N-01 searches the directory or the file that path names', async () => {
    const lib = ['src/lib/util.ts:1:export const util = SERVER_URL;'];
    const config = ["src/config.ts:1:export const SERVER_URL = process.env.SERVER_URL ?? '';", "src/config.ts:2:export const trimmed = SERVER_URL.replace(/\\/$/, '');"];
    expect(await call('grep', { pattern: 'SERVER_URL', path: 'src' })).toEqual(ok([...config, ...lib].join('\n')));
    expect(await call('grep', { pattern: 'SERVER_URL', path: 'src/lib' })).toEqual(ok(lib.join('\n')));
    expect(await call('grep', { pattern: 'SERVER_URL', path: 'src/config.ts' })).toEqual(ok(config.join('\n')));
    expect(await call('grep', { pattern: 'SERVER_URL', path: 'src', glob: '*.ts' })).toEqual(ok([...config, ...lib].join('\n')));
  });

  it('N-01 finds pendingToolUses in packages/core/src of this repository, as the parity review searched it', async () => {
    const repo = { ...ctx, workspace: await realpath(path.join(import.meta.dirname, '..', '..', '..')) };
    const use = { type: 'tool_use', id: 'tu_repo', name: 'grep', input: { pattern: 'export function pendingToolUses', path: 'packages/core/src' }, caller: { type: 'direct' } } as const;
    expect(await runTool(use, repo, EXECUTORS)).toEqual(ok(expect.stringMatching(/^packages\/core\/src\/loop\.ts:\d+:export function pendingToolUses\(/)));
  });

  it('fails on a path that does not exist, and when ripgrep searched no files, rather than saying no matches', async () => {
    expect(await call('grep', { pattern: 'SERVER_URL', path: 'source' })).toEqual(failure(/^no such file or directory: source\. Relative paths start at the workspace root, \/.+\.$/));
    expect(await call('grep', { pattern: 'SERVER_URL', glob: 'nothing/**' })).toEqual(failure(/searched no files/));
    expect(await call('grep', { pattern: 'SERVER_URL', path: 'src', glob: '*.py' })).toEqual(failure(/searched no files in src/));
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
    expect((await grep({ pattern: 'SERVER_URL', path: 'src' })).text).toBe(
      ['src/a:b.ts:1:SERVER_URL in a new file', 'src/config.ts:1:export const SERVER_URL = 1;', 'src/config.ts:2:const a = { b: SERVER_URL };', 'src/lib/util.ts:1:export const util = SERVER_URL;'].join('\n'),
    );
    expect((await grep({ pattern: 'SERVER_URL', path: 'src/config.ts' })).text).toBe('src/config.ts:1:export const SERVER_URL = 1;\nsrc/config.ts:2:const a = { b: SERVER_URL };');
    const glob = await runTool({ type: 'tool_use', id: 'tu_g', name: 'glob', input: { pattern: 'src/**/*.ts' }, caller: { type: 'direct' } } as ToolUseBlock, editor, EXECUTORS);
    expect(glob.text).toBe('src/a:b.ts\nsrc/config.ts\nsrc/lib/util.ts');
  });

  it('sort as ripgrep does, directory by directory', () => {
    expect(['a-b/x', 'a/x', 'a/b/c', 'a.ts'].toSorted(comparePaths)).toEqual(['a/b/c', 'a/x', 'a-b/x', 'a.ts']);
  });
});

describe('credentials files', () => {
  it('are refused by read, by name, through a link and inside a credentials directory', async () => {
    for (const file of ['.env.local', 'settings.txt', 'config/credentials/prod.json']) {
      expect(await call('read', { path: file })).toEqual(failure(new RegExp(`^${file.replace(/\./g, '\\.')} is off limits to read: it matches Geno's built-in rule for credentials files`)));
    }
  });

  it('are left out of grep and glob results, and a search that names them is refused', async () => {
    const grep = await call('grep', { pattern: 'secret-host' });
    expect(grep).toEqual(ok('no matches'));
    expect((await call('glob', { pattern: '**/*.{local,json}' })).text).not.toMatch(/\.env|credentials/);
    expect(await call('glob', { pattern: '.env*' })).toEqual(failure(/^\.env\* is off limits to glob/));
    for (const input of [{ path: '**/.env*' }, { glob: '*.pem' }, { path: 'config/credentials' }, { path: '.env.local' }, { path: 'settings.txt' }]) {
      expect(await call('grep', { pattern: 'x', ...input })).toEqual(failure(/is off limits to grep: it matches Geno's built-in rule for credentials files/));
    }
    expect(await call('glob', { pattern: '*.json', directory: 'config/credentials' })).toEqual(failure(/^config\/credentials is off limits to glob/));
  });

  it('are left out of an unsaved buffer search too', async () => {
    const files = { ...DISK_FILES, unsaved: async () => [{ path: path.join(ctx.workspace, '.env.local'), text: 'SERVER_URL=https://buffered-secret\n' }] };
    const result = await runTool({ type: 'tool_use', id: 'tu_buffer', name: 'grep', input: { pattern: 'buffered-secret' } } as ToolUseBlock, { ...ctx, files }, EXECUTORS);
    expect(result).toEqual(ok('no matches'));
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
    const root = '.env.local\n.github/ (1 file)\n.hidden.ts\nREADME.md\nconfig/ (1 file)\nimage.bin\nsrc/ (2 files)';
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

  it('names the call to make for a writing tool another harness has, when this run has it', async () => {
    const withEdit = { ...EXECUTORS, edit: EXECUTORS.read };
    for (const name of ['create', 'write', 'create_file', 'write_file', 'Write']) {
      const run = await runTool({ type: 'tool_use', id: 'x', name, input: {}, caller: { type: 'direct' } } as ToolUseBlock, ctx, withEdit);
      expect(run).toMatchObject({ status: 'error', text: expect.stringMatching(new RegExp(`^unknown tool ${name}; to create or overwrite a file, call edit with create: true and the whole content as new_str\\. The tools are `)) });
    }
    expect(await call('create', {})).toEqual(failure(/^unknown tool create; the tools are glob, grep, list, read$/));
  });

  it('prints each call as one line', () => {
    const use = (name: string, input: unknown) => ({ type: 'tool_use', id: 'x', name, input, caller: { type: 'direct' } }) as const;
    expect(describeCall(use('grep', { pattern: 'SERVER_URL', path: 'src', glob: '*.ts' }), EXECUTORS)).toBe('grep "SERVER_URL" src *.ts');
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
