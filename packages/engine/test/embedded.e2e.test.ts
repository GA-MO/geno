import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const src = path.resolve('packages/engine/src');

/** Bundles an entry three directories below `root`, where the engine looks for its .env. */
async function bundle(root: string, entry: string): Promise<string> {
  const outfile = path.join(root, 'a/b/c', `${entry}.mjs`);
  await build({
    entryPoints: [path.join(src, `${entry}.ts`)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'error',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  return outfile;
}

describe('the engine the extension bundles', () => {
  it('ignores a .env that the repository CLI reads', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gcode-embedded-'));
    await mkdir(path.join(root, 'home'));
    await writeFile(path.join(root, '.env'), 'GCODE_PROVIDER=provider-from-dotenv\n');
    const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: root, GCODE_HOME: path.join(root, 'home') };
    const chat = (cli: string) => spawnSync(process.execPath, [cli, 'chat', 'hello'], { env, encoding: 'utf8' });

    const repo = chat(await bundle(root, 'cli'));
    const embedded = chat(await bundle(root, 'embedded'));

    expect(repo.stderr).toContain('unknown provider: provider-from-dotenv');
    expect(embedded.status).not.toBe(0);
    expect(embedded.stderr).not.toContain('provider-from-dotenv');
    expect(embedded.stderr).toMatch(/_API_KEY is not set/);
  }, 60_000);
});
