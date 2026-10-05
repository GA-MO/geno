import { mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asSessionId, type ToolResultEvent } from '@g-code/core';
import { runShell } from '../src/process.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, toolCall, type FakeToolUse } from './fake-transport.js';
import { rgCommand, runCli } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const TSC = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const CHECK = 'npx tsc --noEmit';
const GOOD = 'export const n: number = 1;\n';
const PLANTED = "export const n: number = 'one';\n";

/** A TypeScript project as Next.js makes one: `incremental` is on, so a plain `tsc --noEmit` writes its build info here. */
async function project() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-check-')));
  const workspace = path.join(root, 'ws');
  await mkdir(path.join(workspace, 'node_modules', '.bin'), { recursive: true });
  await symlink(TSC, path.join(workspace, 'node_modules', '.bin', 'tsc'));
  await writeFile(path.join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, incremental: true, skipLibCheck: true }, include: ['*.ts'] }));
  await writeFile(path.join(workspace, 'a.ts'), GOOD);
  const home = path.join(root, 'home');
  const env = {
    GCODE_HOME: home,
    HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-test',
    DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  return { root, workspace, home, env };
}

/** What a plain, non-incremental `tsc --noEmit` says about `files`, in a fresh copy of the project. */
async function plainTscOn(files: Record<string, string>): Promise<string> {
  const { workspace } = await project();
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(workspace, name), text);
  const result = await runShell('./node_modules/.bin/tsc --noEmit --incremental false', { cwd: workspace, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } });
  return result.output.trim();
}

let nextId = 0;
const edit = (from: string, to: string): FakeToolUse => ({ id: `tu_${nextId++}`, name: 'edit', input: { path: 'a.ts', old_str: from, new_str: to } });

describe('the check after an edit', () => {
  it('fails on a planted type error, cold and warm, with the plain check\'s words, and writes nothing into the workspace', async () => {
    const { workspace, home, env } = await project();
    const plantedError = await plainTscOn({ 'a.ts': PLANTED });
    expect(plantedError).toMatch(/^a\.ts\(1,14\): error TS2322: Type 'string' is not assignable to type 'number'\.$/);

    const transport = fakeTransport([
      toolCall('Reading.', [{ id: 'tu_read', name: 'read', input: { path: 'a.ts' } }], usage),
      toolCall('Planting.', [edit('= 1;', "= 'one';")], usage),
      toolCall('Fixing.', [edit("= 'one';", '= 1;')], usage),
      toolCall('Planting again.', [edit('= 1;', "= 'one';")], usage),
      answer('Done.', usage),
    ]);
    const result = await runCli(['agent', '--workspace', workspace, '--non-interactive', '--check', CHECK, 'Change n'], env, { fetch: transport.fetch });
    expect(result.code).toBe(0);

    const id = /^session: (\S+)$/m.exec(result.stdout)![1]!;
    const log = await readSessionLog(sessionFile(openStore(env), asSessionId(id)));
    const edits = log.events.filter((e): e is ToolResultEvent => e.kind === 'tool-result' && e.name === 'edit').map((e) => ('output' in e ? e.output : ''));
    expect(edits).toEqual([
      `Edited a.ts.\n\ncheck \`${CHECK}\` failed (exit 2)\n${plantedError}`,
      `Edited a.ts.\n\ncheck \`${CHECK}\` passed`,
      `Edited a.ts.\n\ncheck \`${CHECK}\` failed (exit 2)\n${plantedError}`,
    ]);

    expect((await readdir(workspace)).sort(), 'no build info in the workspace').toEqual(['a.ts', 'node_modules', 'tsconfig.json']);
    const caches = await readdir(path.join(home, 'check-cache'));
    expect(caches).toHaveLength(1);
    expect(await readdir(path.join(home, 'check-cache', caches[0]!))).toEqual(['tsbuildinfo']);
  });

  it('finds the error a change causes in a file the edit did not touch, once warm', async () => {
    const { workspace, env } = await project();
    const user = "import { n } from './a';\nexport const m: number = n;\n";
    await writeFile(path.join(workspace, 'b.ts'), user);
    const expected = await plainTscOn({ 'a.ts': "export const n: string = 'one';\n", 'b.ts': user });
    expect(expected).toMatch(/^b\.ts\(2,14\): error TS2322: Type 'string' is not assignable to type 'number'\.$/);

    const transport = fakeTransport([
      toolCall('Reading.', [{ id: 'tu_read', name: 'read', input: { path: 'a.ts' } }], usage),
      toolCall('Touching.', [edit('= 1;', '= 2;')], usage),
      toolCall('Retyping.', [edit('n: number = 2;', "n: string = 'one';")], usage),
      answer('Done.', usage),
    ]);
    const result = await runCli(['agent', '--workspace', workspace, '--non-interactive', '--check', CHECK, 'Retype n'], env, { fetch: transport.fetch });
    expect(result.code).toBe(0);

    const id = /^session: (\S+)$/m.exec(result.stdout)![1]!;
    const log = await readSessionLog(sessionFile(openStore(env), asSessionId(id)));
    const edits = log.events.filter((e): e is ToolResultEvent => e.kind === 'tool-result' && e.name === 'edit').map((e) => ('output' in e ? e.output : ''));
    expect(edits).toEqual([`Edited a.ts.\n\ncheck \`${CHECK}\` passed`, `Edited a.ts.\n\ncheck \`${CHECK}\` failed (exit 2)\n${expected}`]);
  });
});
