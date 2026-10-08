import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeCatalog } from '../../engine/test/fake-catalog.js';
import { answer, loadTools, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow } from './screenshot.js';
import { leaseWindow } from './pool/client.js';
import { AGENT, FILES, SKILL, STEPS } from './suite/skills-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const READY = '.transcript';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const shots = process.env['GCODE_SCREENSHOTS'];

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

const replies: readonly Reply[] = [
  toolCall('', [loadTools('skill')], usage),
  toolCall('Loading the skill.', [{ id: 'tu_skill', name: 'skill', input: { name: 'deploy-notes' } }], usage),
  asModel(answer('The skill is loaded.', usage)),
];
const requests: { messages: { content: unknown }[] }[] = [];
let debugPort = 0;
let window: Window | undefined;

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const UI: Readonly<Record<string, (action: any, window: Window) => Promise<unknown>>> = {
  eval: async ({ expression }, w) => evaluate(await webview(w, EXTENSION, READY), expression),
  click: async ({ selector }, w) => click(await webview(w, EXTENSION, READY), selector),
  type: async ({ text }, w) => typeText(await webview(w, EXTENSION, READY), text),
  press: async ({ key, modifiers }, w) => press(await webview(w, EXTENSION, READY), key, modifiers),
  pointerAway: async (_action, w) => w.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 300 }),
  resize: async ({ width }, w) => resizeSideBar(w, width),
  screenshot: async ({ name }, w) => {
    if (shots === undefined) return;
    await captureWindow(debugPort, path.resolve(shots, `${name}.png`));
    await capturePanel(w, path.resolve(shots, `${name}-panel.png`), 2);
  },
};

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    const reply = replies[requests.push(JSON.parse(await bodyOf(req))) - 1];
    if (reply === undefined) res.writeHead(500).end(`no reply for request ${requests.length - 1}`);
    else res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(reply));
  },
  'POST /ui': async (req, res) => {
    const action = JSON.parse(await bodyOf(req)) as { do: string };
    try {
      window ??= await connectWindow(debugPort);
      const result = await UI[action.do]!(action, window);
      res.writeHead(200, { 'content-type': 'application/json' }).end(result === undefined ? '' : JSON.stringify(result));
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  },
};

const fake = createServer((req, res) => {
  const route = ROUTES[`${req.method} ${req.url?.split('?')[0]}`];
  if (route === undefined) res.writeHead(404).end();
  else void route(req, res);
});

beforeAll(() => new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve)));
afterAll(() => {
  window?.browser.close();
  fake.closeAllConnections();
  return new Promise<void>((resolve) => fake.close(() => resolve()));
});

describe('skills from a catalog in Settings', () => {
  it('previews a catalog entry read-only, installs a skill for the user and an agent for the workspace, loads the skill in a chat, and uninstalls it, running nothing', async () => {
    const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-skills-')));
    const catalog = path.join(scratch, 'catalog');
    const marker = path.join(scratch, 'install-ran');
    await writeCatalog(catalog, [
      { kind: 'skill', name: 'deploy-notes', description: 'Write release notes for a deploy', files: { 'SKILL.md': SKILL, 'references/steps.md': STEPS, 'install.sh': `#!/bin/sh\ntouch "${marker}"\n` } },
      { kind: 'agent', name: 'reviewer', description: 'Reviews a diff for bugs', files: { 'reviewer.md': AGENT } },
    ]);
    const { work, workspace, home, suite } = await setUp('skills', FILES, {}, { 'gcode.skills.catalogs': [catalog] });
    if (shots !== undefined) await mkdir(shots, { recursive: true });
    const vscodeWindow = await leaseWindow();
    debugPort = vscodeWindow.debugPort;
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    await vscodeWindow.run(suite, { workspace, work }, {
      GCODE_HOME: home,
      GCODE_PROVIDER: 'modelstudio',
      GCODE_MODEL: MODEL,
      DASHSCOPE_API_KEY: 'sk-fake',
      DASHSCOPE_BASE_URL: url,
      GCODE_FAKE_MODEL: url,
      GCODE_CLASSIFIER_MODEL: 'off',
    });
    expect(requests).toHaveLength(replies.length);

    const results = requests.flatMap((r) => (r.messages.at(-1)!.content as { type: string; tool_use_id?: string; content?: string }[]).filter((b) => b.type === 'tool_result'));
    const loaded = results.find((b) => b.tool_use_id === 'tu_skill')?.content ?? '';
    expect(loaded).toContain(`Skill deploy-notes, from ${path.join(home, 'skills', 'deploy-notes', 'SKILL.md')}`);
    expect(loaded).toContain('Read references/steps.md, then write the notes.');

    expect(existsSync(path.join(home, 'skills', 'deploy-notes')), 'Uninstall removed the skill it installed').toBe(false);
    expect(await readFile(path.join(workspace, '.claude', 'agents', 'reviewer.md'), 'utf8')).toBe(AGENT);
    const manifest = JSON.parse(await readFile(path.join(home, 'catalog', 'installs.json'), 'utf8'));
    expect(manifest.installs).toEqual([expect.objectContaining({ kind: 'agent', name: 'reviewer', scope: 'project', catalog })]);
    expect(existsSync(marker), 'install.sh was copied and never run').toBe(false);
    expect(await readdir(scratch)).toEqual(['catalog']);
  }, 600_000);
});
