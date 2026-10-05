// Live smoke for diagrams: qwen3.8-flash on Model Studio, asked in the real chat panel to explain this repo's agent
// request flow as a diagram. The workspace is a copy of the files that flow runs through, so nothing here changes.
// Run from the repository root: pnpm tsx packages/extension/test/diagram-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Writable } from 'node:stream';
import { parseEnv } from 'node:util';
import { runTests } from '@vscode/test-electron';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { captureWindow, freePort } from './screenshot.js';

const EXTENSION = 'g-code.g-code';
const BUDGET_USD = 0.02;

/** The files a chat turn passes through, from the panel to the model and back. */
const FLOW_FILES = [
  'packages/extension/src/chat/chat.ts',
  'packages/extension/src/chat/engine.ts',
  'packages/engine/src/serve.ts',
  'packages/engine/src/agent.ts',
  'packages/engine/src/drive.ts',
  'packages/core/src/loop.ts',
  'packages/core/src/request.ts',
];

async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { recursive: true })) {
    const file = path.join(dir, entry);
    if ((await stat(file)).isFile() && (await readFile(file)).includes(needle)) found.push(file);
  }
  return found;
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

async function main(): Promise<number> {
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.resolve(root, '../../.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');
  const repo = path.resolve(root, '../..');
  const files = Object.fromEntries(await Promise.all(FLOW_FILES.map(async (file) => [file, await readFile(path.join(repo, file), 'utf8')] as const)));
  const { work, home, suite, launchArgs } = await setUp('diagram-live', files, { 'gcode.model': 'qwen3.8-flash' }, { 'gcode.baseUrl': baseUrl });
  const debugPort = await freePort();
  const shot = path.join(work, 'diagram-live.png');
  let report: unknown;
  let window: Window | undefined;
  const PANEL = '.transcript';
  const UI: Readonly<Record<string, (action: any, w: Window) => Promise<unknown>>> = {
    eval: async ({ expression }, w) => evaluate(await webview(w, EXTENSION, PANEL), expression),
    click: async ({ selector }, w) => click(await webview(w, EXTENSION, PANEL), selector),
    type: async ({ text }, w) => typeText(await webview(w, EXTENSION, PANEL), text),
    press: async ({ key: name }, w) => press(await webview(w, EXTENSION, PANEL), name),
    screenshot: async () => captureWindow(debugPort, shot),
    report: async ({ result }) => {
      report = result;
    },
  };
  const server = createServer((req, res) => {
    void bodyOf(req).then(async (body) => {
      try {
        const action = JSON.parse(body) as { do: string };
        window ??= await connectWindow(debugPort);
        const result = await UI[action.do]!(action, window);
        res.writeHead(200, { 'content-type': 'application/json' }).end(result === undefined ? '' : JSON.stringify(result));
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  let output = '';
  const capture = (stream: NodeJS.WriteStream) =>
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        output += chunk.toString();
        // The key must not reach this output; if it ever does, the check below fails without echoing it.
        stream.write(chunk.toString().replaceAll(key, '<key>'), done);
      },
    });
  const code = await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: suite,
    cachePath,
    ...(process.env['GCODE_VSCODE_VERSION'] ? { version: process.env['GCODE_VSCODE_VERSION'] } : {}),
    launchArgs: [...launchArgs, `--remote-debugging-port=${debugPort}`],
    extensionTestsEnv: {
      GCODE_HOME: home,
      GCODE_PROVIDER: 'modelstudio',
      GCODE_MODEL: 'qwen3.8-flash',
      DASHSCOPE_API_KEY: key,
      DASHSCOPE_BASE_URL: baseUrl,
      GCODE_TEST_UI: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    },
    stdout: capture(process.stdout),
    stderr: capture(process.stderr),
  }).catch(() => 1);
  window?.browser.close();
  server.close();

  const sessions = path.join(home, 'sessions');
  let cost = 0;
  for (const file of await readdir(sessions).catch(() => [])) {
    const events = (await readFile(path.join(sessions, file), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const answers = events.filter((e) => e.kind === 'assistant');
    cost += answers.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
    const tools = events.filter((e) => e.kind === 'tool-result').map((e) => `${e.name}:${e.status}`);
    console.log(`chat: ${answers.length} model calls (${answers[0]?.model}), tools: ${tools.join(' ') || 'none'}`);
  }
  console.log(`panel: ${JSON.stringify(report, null, 2)}`);
  const leaks = [...(output.includes(key) ? ['test output'] : []), ...(await filesContaining(work, key))];
  console.log(`key found in: ${leaks.length === 0 ? 'nothing' : leaks.join(', ')}`);
  console.log(`screenshot: ${shot}`);
  console.log(`estimated cost: $${cost.toFixed(6)} (budget $${BUDGET_USD})`);
  const passed = code === 0 && leaks.length === 0 && cost < BUDGET_USD;
  console.log(`smoke: ${passed ? 'passed' : `failed (exit ${code})`}`);
  return passed ? 0 : 1;
}

void main().then((code) => (process.exitCode = code));
