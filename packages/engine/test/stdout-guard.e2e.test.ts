import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { guardStdout } from '../src/stdout-guard.js';

const fakeStream = (sink: string[]) => ({
  write: (chunk: string | Uint8Array, ...rest: unknown[]) => {
    sink.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    const callback = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
    callback?.();
    return true;
  },
});

describe('the stdout guard', () => {
  it('sends other writes to stderr and keeps stdout for the stream it returns', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const stdout = fakeStream(out);
    const frames = guardStdout(stdout as never, fakeStream(err) as never).getWriter();
    stdout.write('stray\n');
    stdout.write(new TextEncoder().encode('bytes\n'), () => {});
    await frames.write(new TextEncoder().encode('{"jsonrpc":"2.0"}\n'));
    expect(out).toEqual(['{"jsonrpc":"2.0"}\n']);
    expect(err).toEqual(['stray\n', 'bytes\n']);
  });

  it('keeps gcode serve speaking valid ACP while a dependency logs to stdout', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gcode-guard-'));
    const cli = path.join(root, 'cli.mjs');
    await build({
      entryPoints: [path.resolve('packages/engine/src/embedded.ts')],
      outfile: cli,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'error',
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    });
    const stray = path.join(root, 'stray.mjs');
    await writeFile(stray, "setInterval(() => console.log('stray log from a dependency'), 2).unref();\n");
    const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: root, GCODE_HOME: path.join(root, 'home'), DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: 'http://127.0.0.1:9' };
    const child = spawn(process.execPath, ['--import', stray, cli, 'serve', '--stdio'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const responses = new Map<number, unknown>();
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      for (const line of stdout.split('\n').slice(0, -1)) {
        const message = JSON.parse(line) as { id?: number; result?: unknown };
        if (message.id !== undefined) responses.set(message.id, message.result);
      }
    });
    const request = async (id: number, method: string, params: unknown) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      for (let waited = 0; !responses.has(id); waited += 10) {
        if (waited > 20_000) throw new Error(`no response to ${method}; stdout: ${stdout}; stderr: ${stderr}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      return responses.get(id);
    };
    try {
      expect(await request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })).toMatchObject({ protocolVersion: 1 });
      expect(await request(2, 'session/new', { cwd: root, mcpServers: [] })).toMatchObject({ sessionId: expect.any(String) });
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      child.kill();
    }
    const lines = stdout.split('\n').filter((line) => line !== '');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    expect(stderr).toContain('stray log from a dependency');
  }, 60_000);
});
