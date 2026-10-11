import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { makeRepo } from '../../engine/test/git-fixture.js';
import { rgCommand } from '../../engine/test/helpers.js';
import { buildExtension } from '../../extension/build.mjs';
import { buildWeb, DIST } from '../build.mjs';

const EXTENSION = fileURLToPath(new URL('../../extension', import.meta.url));
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

/** The model, by what the conversation's last message holds: a greeting, a command to run, or the command's result. */
function replyTo(body: { messages?: unknown[] }): Reply {
  const last = JSON.stringify(body.messages?.at(-1) ?? '');
  if (last.includes('tool_result')) return answer('Listed.', usage);
  if (last.includes('List the parent')) return toolCall('Listing it.', [{ id: 'tu_parent', name: 'bash', input: { command: 'ls ..' } }], usage);
  if (last.includes('Say hello')) return answer('Hello from the fake model.', usage);
  return answer('Fine.', usage);
}

async function fakeModel(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let text = '';
    req.setEncoding('utf8').on('data', (chunk: string) => (text += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseBody(replyTo(JSON.parse(text || '{}') as { messages?: unknown[] })));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/apps/anthropic` };
}

type Event = { readonly event: string; readonly data: any };

/** The page's event stream, read as a browser's EventSource would, with a wait for the event a test expects. */
async function events(origin: string, cookie: string) {
  const res = await fetch(`${origin}/events?view=chat`, { headers: { cookie } });
  expect(res.headers.get('content-type')).toBe('text/event-stream');
  const seen: Event[] = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  void (async () => {
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += value;
      const frames = buffer.split('\n\n');
      buffer = frames.pop()!;
      for (const frame of frames) {
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (event !== undefined && data !== undefined) seen.push({ event, data: JSON.parse(data) });
      }
    }
  })();
  return {
    seen,
    async until(what: string, test: (event: Event) => boolean, ms = 30_000): Promise<Event> {
      const deadline = Date.now() + ms;
      for (;;) {
        const found = seen.find(test);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`no ${what} in ${JSON.stringify(seen.map((e) => e.data?.type ?? e.event))}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    close: () => reader.cancel(),
  };
}

let model: Awaited<ReturnType<typeof fakeModel>>;
let web: ChildProcess;
let origin: string;
let address: string;
let repo: string;
let stderr = '';

beforeAll(async () => {
  if (!existsSync(path.join(EXTENSION, 'dist/engine/cli.js')) || !existsSync(path.join(EXTENSION, 'dist/webview.js'))) await buildExtension();
  await buildWeb();
  model = await fakeModel();
  repo = await realpath(makeRepo('work', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-web-')));
  web = spawn(process.execPath, [path.join(DIST, 'main.js'), '--workspace', repo], {
    env: {
      ...process.env,
      HOME: path.join(root, 'home'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      GCODE_HOME: path.join(root, 'gcode'),
      GCODE_PROVIDER: 'modelstudio',
      DASHSCOPE_API_KEY: 'sk-fake',
      DASHSCOPE_BASE_URL: model.url,
      GCODE_CLASSIFIER_MODEL: 'off',
      GCODE_AUTO_WAKE: 'off',
      GCODE_RG: rgCommand(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  web.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  address = await new Promise<string>((resolve, reject) => {
    let out = '';
    web.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
      const url = /Geno web: (\S+)/.exec(out)?.[1];
      if (url !== undefined) resolve(url);
    });
    web.once('exit', (code) => reject(new Error(`the web host exited with ${code}: ${stderr}`)));
  });
  origin = new URL(address).origin;
}, 120_000);

/** The engine outlives the window that started it, as in VS Code, so the test ends it, by the socket the host logged. */
async function stopEngine(): Promise<void> {
  const socket = /serve --socket (\S+)/.exec(stderr)?.[1];
  if (socket === undefined) return;
  const running = () => spawnSync('pgrep', ['-f', `serve --socket ${socket}`], { encoding: 'utf8' }).stdout.trim();
  spawnSync('pkill', ['-f', `serve --socket ${socket}`]);
  for (const deadline = Date.now() + 10_000; running() !== '' && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 100));
}

afterAll(async () => {
  if (web !== undefined && web.exitCode === null) await new Promise((resolve) => web.once('exit', resolve).kill('SIGTERM'));
  await stopEngine();
  model?.server.close();
});

/** Signs in with the printed address, as a browser does, and returns the cookie it got. */
async function signIn(): Promise<string> {
  const res = await fetch(address, { redirect: 'manual' });
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe('/');
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

const post = (cookie: string, message: unknown) =>
  fetch(`${origin}/message?view=chat`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(message) });

describe('the web host', () => {
  it('refuses requests without the token, from another origin, or by another host name', async () => {
    expect((await fetch(`${origin}/`)).status).toBe(401);
    expect((await fetch(`${origin}/events?view=chat&token=wrong`)).status).toBe(401);
    const cookie = await signIn();
    expect((await fetch(`${origin}/`, { headers: { cookie } })).status).toBe(200);
    const forged = await fetch(`${origin}/message?view=chat`, { method: 'POST', headers: { cookie, origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{"type":"stop"}' });
    expect(forged.status).toBe(403);
    // fetch sends the Host its URL names, so a rebinding page's request is made by hand.
    const rebound = await new Promise<number>((resolve, reject) =>
      request(`${origin}/`, { headers: { host: `evil.example:${new URL(origin).port}`, cookie } }, (res) => resolve(res.statusCode ?? 0)).on('error', reject).end(),
    );
    expect(rebound).toBe(403);
  });

  it('serves the panel under its CSP with the web client, and answers ready with the transcript', async () => {
    const cookie = await signIn();
    const page = await (await fetch(`${origin}/`, { headers: { cookie } })).text();
    expect(page).toContain(`connect-src ${origin};`);
    expect(page).toMatch(new RegExp(`<script nonce="[^"]+" src="${origin}/web-client.js" data-view="chat">`));
    expect(page).toContain(`src="${origin}/vscode-resource${encodeURI(path.join(EXTENSION, 'dist/webview.js'))}"`);
    const script = await fetch(`${origin}/vscode-resource${encodeURI(path.join(EXTENSION, 'dist/webview.js'))}`, { headers: { cookie } });
    expect(script.status).toBe(200);
    expect((await fetch(`${origin}/vscode-resource${'/etc/hosts'}`, { headers: { cookie } })).status).toBe(404);
    const stream = await events(origin, cookie);
    expect((await post(cookie, { type: 'ready' })).status).toBe(204);
    const reset = await stream.until('reset', (e) => e.event === 'message' && e.data.type === 'reset');
    expect(reset.data.transcript.turns).toEqual([]);
    await stream.until('header', (e) => e.event === 'message' && e.data.type === 'header' && e.data.header.project === 'work');
    await stream.close();
  });

  it('runs a prompt the panel sends through the engine and streams the reply back', async () => {
    const cookie = await signIn();
    const stream = await events(origin, cookie);
    await post(cookie, { type: 'ready' });
    await post(cookie, { type: 'send', text: 'Say hello', attachments: [] });
    const end = await stream.until('the turn’s end', (e) => e.event === 'message' && e.data.type === 'turn-end', 45_000).catch((error: unknown) => {
      throw new Error(`${String(error)}\n${stderr}`);
    });
    expect(end.data.status).toBe('done');
    const text = stream.seen.filter((e) => e.event === 'message' && e.data.type === 'text').map((e) => e.data.text).join('');
    expect(text).toBe('Hello from the fake model.');
    await stream.close();
  }, 60_000);

  it('asks for permission in the panel and runs the command once it is allowed', async () => {
    const cookie = await signIn();
    const stream = await events(origin, cookie);
    await post(cookie, { type: 'ready' });
    await post(cookie, { type: 'send', text: 'List the parent folder', attachments: [] });
    const asked = await stream.until('a permission card', (e) => e.event === 'message' && e.data.type === 'permission', 45_000);
    expect(asked.data).toMatchObject({ command: 'ls ..', reason: 'a path outside the workspace', toolId: 'tu_parent' });
    const ran = (e: Event) => e.event === 'message' && e.data.type === 'tool' && e.data.id === 'tu_parent' && typeof e.data.output === 'string';
    expect(stream.seen.some(ran)).toBe(false);
    const allow = (asked.data.options as { optionId: string; kind: string }[]).find((o) => o.kind === 'allow_once')!;
    await post(cookie, { type: 'permission', id: asked.data.id, optionId: allow.optionId });
    await stream.until('the card settled', (e) => e.event === 'message' && e.data.type === 'permission-done' && e.data.id === asked.data.id && e.data.optionId === allow.optionId);
    // The parent holds only the repository's folder, so the listing is its name.
    expect((await stream.until('the command’s output', ran, 45_000)).data.output).toContain(path.basename(repo));
    const end = await stream.until('the turn’s end', (e) => e.event === 'message' && e.data.type === 'turn-end' && stream.seen.indexOf(e) > stream.seen.indexOf(asked), 45_000);
    expect(end.data.status).toBe('done');
    await stream.close();
  }, 60_000);

  it('boots the panel in a browser, which sends a prompt and shows the answer', async ({ skip }) => {
    const browser = await chromium.launch(process.env['GCODE_CHROMIUM'] ? { executablePath: process.env['GCODE_CHROMIUM'] } : {}).catch((error: unknown) => skip(`no Chromium for playwright: ${String(error)}`));
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => void (message.type() === 'error' && errors.push(message.text())));
      await page.goto(address);
      expect(new URL(page.url()).search).toBe('');
      await page.locator('textarea').waitFor();
      await page.locator('textarea').fill('Say hello again');
      await page.keyboard.press('Enter');
      await page.getByText('Hello from the fake model.').last().waitFor({ timeout: 45_000 });
      expect(errors).toEqual([]);
      expect(await readFile(path.join(repo, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    } finally {
      await browser.close();
    }
  }, 90_000);
});
