import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
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
import manifest from '../../extension/package.json' with { type: 'json' };
import { buildWeb, DIST } from '../build.mjs';
import { titleActions } from '../src/title-actions.js';

const EXTENSION = fileURLToPath(new URL('../../extension', import.meta.url));
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

/** The model, by what the conversation's last message holds: a greeting, a command to run, or the command's result. */
function replyTo(body: { messages?: unknown[] }): Reply {
  const last = JSON.stringify(body.messages?.at(-1) ?? '');
  if (last.includes('tu_read_b')) return toolCall('Editing b.', [{ id: 'tu_b', name: 'edit', input: { path: 'b.ts', old_str: 'b = 1', new_str: 'b = 2' } }], usage);
  if (last.includes('tu_read_c')) return toolCall('Editing c.', [{ id: 'tu_c1', name: 'edit', input: { path: 'c.ts', old_str: 'two = 2', new_str: 'two = 20' } }], usage);
  if (last.includes('tu_c1')) return toolCall('And the middle.', [{ id: 'tu_c2', name: 'edit', input: { path: 'c.ts', old_str: 'five = 5', new_str: 'five = 50' } }], usage);
  if (last.includes('tu_c2')) return toolCall('And the last line.', [{ id: 'tu_c3', name: 'edit', input: { path: 'c.ts', old_str: 'nine = 9', new_str: 'nine = 90' } }], usage);
  if (last.includes('tool_result')) return answer('Done.', usage);
  if (last.includes('Edit b')) return toolCall('Reading b.', [{ id: 'tu_read_b', name: 'read', input: { path: 'b.ts' } }], usage);
  if (last.includes('Edit c')) return toolCall('Reading c.', [{ id: 'tu_read_c', name: 'read', input: { path: 'c.ts' } }], usage);
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

type Host = { readonly process: ChildProcess; readonly address: string; readonly origin: string; readonly stderr: () => string };

const ROOT = mkdtemp(path.join(tmpdir(), 'gcode-web-')).then((dir) => realpath(dir));

/** Starts the built host on `repo`, with a fresh HOME and GCODE_HOME under `name`, holding `settings` as its user settings. */
async function startHost(repo: string, name: string, settings: Record<string, unknown> = {}): Promise<Host> {
  const root = path.join(await ROOT, name);
  await mkdir(path.join(root, 'gcode'), { recursive: true });
  await writeFile(path.join(root, 'gcode', 'web-settings.json'), JSON.stringify(settings));
  const child = spawn(process.execPath, [path.join(DIST, 'main.js'), '--workspace', repo], {
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
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const address = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
      const url = /Geno web: (\S+)/.exec(out)?.[1];
      if (url !== undefined) resolve(url);
    });
    child.once('exit', (code) => reject(new Error(`the web host exited with ${code}: ${stderr}`)));
  });
  return { process: child, address, origin: new URL(address).origin, stderr: () => stderr };
}

async function stopHost(host: Host | undefined): Promise<void> {
  if (host !== undefined && host.process.exitCode === null) await new Promise((resolve) => host.process.once('exit', resolve).kill('SIGTERM'));
}

/** The engine outlives the window that started it, as in VS Code, so the test ends it, by the socket the host logged. */
async function stopEngine(host: Host | undefined): Promise<void> {
  const socket = /serve --socket (\S+)/.exec(host?.stderr() ?? '')?.[1];
  if (socket === undefined) return;
  const running = () => spawnSync('pgrep', ['-f', `serve --socket ${socket}`], { encoding: 'utf8' }).stdout.trim();
  spawnSync('pkill', ['-f', `serve --socket ${socket}`]);
  for (const deadline = Date.now() + 10_000; running() !== '' && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 100));
}

let model: Awaited<ReturnType<typeof fakeModel>>;
let host: Host;
let origin: string;
let address: string;
let repo: string;
const stderr = () => host.stderr();

beforeAll(async () => {
  if (!existsSync(path.join(EXTENSION, 'dist/engine/cli.js')) || !existsSync(path.join(EXTENSION, 'dist/webview.js'))) await buildExtension();
  await buildWeb();
  model = await fakeModel();
  repo = await realpath(makeRepo('work', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' } }]));
  host = await startHost(repo, 'auto');
  ({ origin, address } = host);
}, 120_000);

afterAll(async () => {
  await stopHost(host);
  await stopEngine(host);
  model?.server.close();
});

/** Signs in with the printed address, as a browser does, and returns the cookie it got. */
async function signIn(at: Host = host): Promise<string> {
  const res = await fetch(at.address, { redirect: 'manual' });
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe('/');
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

const post = (cookie: string, message: unknown, at: Host = host) =>
  fetch(`${at.origin}/message?view=chat`, { method: 'POST', headers: { cookie, origin: at.origin, 'content-type': 'application/json' }, body: JSON.stringify(message) });

type Stream = Awaited<ReturnType<typeof events>>;

const isMessage = (type: string) => (e: Event) => e.event === 'message' && e.data.type === type;

/** Sends a prompt, allows every permission it asks for, and returns what the page heard until its turn ended. */
async function runTurn(at: Host, cookie: string, stream: Stream, text: string): Promise<Event[]> {
  const from = stream.seen.length;
  await post(cookie, { type: 'send', text, attachments: [] }, at);
  const allowed = new Set<string>();
  for (const deadline = Date.now() + 45_000; ; ) {
    const heard = stream.seen.slice(from);
    for (const asked of heard.filter(isMessage('permission')).filter((e) => !allowed.has(e.data.id))) {
      allowed.add(asked.data.id);
      const allow = (asked.data.options as { optionId: string; kind: string }[]).find((o) => o.kind === 'allow_once')!;
      await post(cookie, { type: 'permission', id: asked.data.id, optionId: allow.optionId }, at);
    }
    if (heard.some(isMessage('turn-end'))) return heard;
    if (Date.now() > deadline) throw new Error(`the turn did not end: ${JSON.stringify(heard.map((e) => e.data?.type ?? e.event))}\n${at.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The edit diffs a turn showed for `file`, in order. */
const diffsOf = (heard: readonly Event[], file: string): { change: string; hunks: { id: string }[] }[] =>
  heard.filter((e) => isMessage('diff')(e) && e.data.diff.path === file).map((e) => e.data.diff);

/** Each hunk's status as the page last heard it, from review messages and from the transcript a reset carries. */
function statusesHeard(heard: readonly Event[]): Record<string, string> {
  const statuses: Record<string, string> = {};
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    if (typeof record['id'] === 'string' && typeof record['status'] === 'string' && Array.isArray(record['added'])) statuses[record['id']] = record['status'];
    Object.values(record).forEach(walk);
  };
  for (const e of heard) {
    if (isMessage('review')(e)) Object.assign(statuses, e.data.hunks);
    else if (isMessage('reset')(e)) walk(e.data.transcript);
  }
  return statuses;
}

async function untilStatuses(stream: Stream, from: number, want: Record<string, string>): Promise<void> {
  for (const deadline = Date.now() + 30_000; ; ) {
    const heard = statusesHeard(stream.seen.slice(from));
    if (Object.entries(want).every(([id, status]) => heard[id] === status)) return;
    if (Date.now() > deadline) throw new Error(`hunks are ${JSON.stringify(heard)}, not ${JSON.stringify(want)}; the page heard ${JSON.stringify(stream.seen.slice(from).map((e) => e.data?.type ?? e.data?.text ?? e.event))}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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
    expect(page).toMatch(new RegExp(`<script nonce="[^"]+" src="${origin}/web-client.js" data-view="chat" data-actions="[^"]+">`));
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
      throw new Error(`${String(error)}\n${stderr()}`);
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

  it('undoes a turn’s edits on disk from the turn’s Undo, and shows the turn undone', async () => {
    const cookie = await signIn();
    const stream = await events(origin, cookie);
    await post(cookie, { type: 'ready' });
    const turn = await runTurn(host, cookie, stream, 'Edit b');
    const file = path.join(repo, 'b.ts');
    expect(await readFile(file, 'utf8')).toBe('export const b = 2;\n');
    const [diff] = diffsOf(turn, 'b.ts');
    const from = stream.seen.length;
    await post(cookie, { type: 'undo-turn', checkpoint: { before: diff!.change }, later: false });
    await untilStatuses(stream, from, Object.fromEntries(diff!.hunks.map((h) => [h.id, 'undone'])));
    expect(await readFile(file, 'utf8')).toBe('export const b = 1;\n');
    expect(stream.seen.slice(from).filter((e) => e.event === 'note')).toEqual([]);
    await stream.close();
  }, 60_000);

  it('boots the panel in a browser, which sends a prompt, shows the answer, and undoes an edit from the turn’s Undo', async ({ skip }) => {
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
      expect(await readFile(path.join(repo, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
      await page.locator('textarea').fill('Edit b');
      await page.keyboard.press('Enter');
      const undo = page.locator('.turn-undo');
      await undo.waitFor({ timeout: 45_000 });
      expect(await readFile(path.join(repo, 'b.ts'), 'utf8')).toBe('export const b = 2;\n');
      await undo.click();
      await undo.waitFor({ state: 'detached' });
      expect(await readFile(path.join(repo, 'b.ts'), 'utf8')).toBe('export const b = 1;\n');
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 90_000);

  it('runs only the chat view’s title actions, from the header icons and, when narrow, from its … menu', async ({ skip }) => {
    const cookie = await signIn();
    const run = (command: string) => fetch(`${origin}/command`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ command }) });
    expect((await run('workbench.action.openSettings')).status, 'a command outside the title bar is refused').toBe(400);
    const browser = await chromium.launch(process.env['GCODE_CHROMIUM'] ? { executablePath: process.env['GCODE_CHROMIUM'] } : {}).catch((error: unknown) => skip(`no Chromium for playwright: ${String(error)}`));
    try {
      const page = await browser.newPage({ viewport: { width: 360, height: 700 } });
      await page.goto(address);
      const view = () => page.evaluate(() => document.body.dataset['view']);
      const lanes = page.locator('.geno-web-actions button[data-command="gcode.chat.lanes"]');
      await lanes.waitFor();
      const shown = await page.locator('.geno-web-actions button').evaluateAll((buttons) => buttons.map((b) => (b as HTMLElement).dataset['command'] ?? 'more'));
      expect(shown, 'at 360px every action shows as an icon, in the manifest’s order').toEqual(titleActions(manifest, 'gcode.chat').map((action) => action.command));
      const fit = await page.evaluate(() => {
        const header = document.querySelector('.chat-header')!.getBoundingClientRect();
        const bar = document.querySelector('.geno-web-actions')!.getBoundingClientRect();
        return { inside: bar.right <= header.right + 0.5 && bar.top >= header.top && bar.bottom <= header.bottom, title: document.querySelector('.header-title')!.getBoundingClientRect().width };
      });
      expect(fit.inside, 'the icons sit inside the header’s one row').toBe(true);
      expect(fit.title, 'and the chat’s title keeps room').toBeGreaterThan(40);
      await lanes.click();
      await page.waitForFunction(() => document.body.dataset['view'] === 'lanes');

      await page.setViewportSize({ width: 260, height: 700 });
      const more = page.locator('.geno-web-actions button[aria-haspopup="menu"]');
      await more.waitFor();
      expect(await page.locator('.geno-web-actions button[data-command]').count(), 'a narrow header keeps two icons and the menu').toBe(2);
      await more.click();
      const items = await page.locator('.geno-web-menu [role="menuitem"]').allTextContents();
      expect(items).toEqual(['Lanes', 'Tasks', 'MCP Servers', 'Models and Keys']);
      await page.locator('.geno-web-menu [role="menuitem"]', { hasText: 'MCP Servers' }).click();
      await page.waitForFunction(() => document.body.dataset['view'] === 'mcp');
      expect(await page.locator('.geno-web-menu').count(), 'the menu closes once an item runs').toBe(0);
      expect(await view()).toBe('mcp');
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('shows a lane’s finished notice under the header, clear of the composer, and lets it go after a while unless the pointer is on it', async ({ skip }) => {
    const browser = await chromium.launch(process.env['GCODE_CHROMIUM'] ? { executablePath: process.env['GCODE_CHROMIUM'] } : {}).catch((error: unknown) => skip(`no Chromium for playwright: ${String(error)}`));
    try {
      const page = await browser.newPage({ viewport: { width: 360, height: 700 } });
      await page.clock.install();
      await page.goto(address);
      await page.locator('textarea').fill('/lane Say hello');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.body.dataset['view'] === 'lanes');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.body.dataset['view'] === 'chat');
      const finished = page.locator('.geno-web-toast[data-severity="info"]', { hasText: 'Geno finished' });
      await finished.waitFor({ timeout: 45_000 });
      const boxes = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const toast = box('.geno-web-toast');
        const meets = (other: DOMRect) => toast.left < other.right && other.left < toast.right && toast.top < other.bottom && other.top < toast.bottom;
        return { composer: meets(box('form.composer')), header: meets(box('.chat-header')) };
      });
      expect(boxes, 'the toast covers neither the composer nor the header').toEqual({ composer: false, header: false });

      await finished.hover();
      await page.clock.fastForward(30_000);
      expect(await finished.count(), 'it stays while the pointer is on it').toBe(1);
      await page.mouse.move(180, 400);
      await page.clock.fastForward(11_000);
      await finished.waitFor({ state: 'detached' });
      expect(await page.locator('.geno-web-toast').count(), 'and then goes').toBe(0);
    } finally {
      await browser.close();
    }
  }, 90_000);
});

describe('the web host in review mode', () => {
  const settings = { 'gcode.review.mode': 'review' };
  const lines = (values: readonly number[]) => ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].map((name, i) => `export const ${name} = ${values[i]};\n`).join('');
  let reviewing: Host | undefined;
  let first: Host | undefined;
  let work: string;

  beforeAll(async () => {
    work = await realpath(makeRepo('reviewed', [{ message: 'start', files: { 'c.ts': lines([1, 2, 3, 4, 5, 6, 7, 8, 9]) } }]));
    reviewing = first = await startHost(work, 'review', settings);
  }, 60_000);

  afterAll(async () => {
    await stopHost(reviewing);
    await stopEngine(first);
    await stopEngine(reviewing);
  });

  it('undoes hunks and keeps one, on disk and in the engine’s log, which a reloaded host reads back', async () => {
    const cookie = await signIn(reviewing);
    const stream = await events(reviewing!.origin, cookie);
    await post(cookie, { type: 'ready' }, reviewing);
    const turn = await runTurn(reviewing!, cookie, stream, 'Edit c three times');
    const file = path.join(work, 'c.ts');
    expect(await readFile(file, 'utf8')).toBe(lines([1, 20, 3, 4, 50, 6, 7, 8, 90]));
    const [two, five, nine] = diffsOf(turn, 'c.ts').map((diff) => diff.hunks[0]!.id);
    let from = stream.seen.length;
    await post(cookie, { type: 'undo', hunks: [two] }, reviewing);
    await untilStatuses(stream, from, { [two!]: 'undone', [five!]: 'pending', [nine!]: 'pending' });
    expect(await readFile(file, 'utf8')).toBe(lines([1, 2, 3, 4, 50, 6, 7, 8, 90]));
    // The first undo made the file shorter, so this one only lands right if the later hunks moved with it.
    from = stream.seen.length;
    await post(cookie, { type: 'undo', hunks: [nine] }, reviewing);
    await untilStatuses(stream, from, { [nine!]: 'undone' });
    expect(await readFile(file, 'utf8')).toBe(lines([1, 2, 3, 4, 50, 6, 7, 8, 9]));
    from = stream.seen.length;
    await post(cookie, { type: 'keep', hunks: [five] }, reviewing);
    await untilStatuses(stream, from, { [two!]: 'undone', [five!]: 'kept', [nine!]: 'undone' });
    expect(await readFile(file, 'utf8')).toBe(lines([1, 2, 3, 4, 50, 6, 7, 8, 9]));
    await stream.close();

    await stopHost(reviewing);
    reviewing = await startHost(work, 'review', settings);
    const again = await signIn(reviewing);
    const reloaded = await events(reviewing.origin, again);
    await post(again, { type: 'ready' }, reviewing);
    await untilStatuses(reloaded, 0, { [two!]: 'undone', [five!]: 'kept', [nine!]: 'undone' });
    await reloaded.close();
  }, 120_000);
});
