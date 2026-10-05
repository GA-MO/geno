// Live smoke for g-code as a user installs it: the .vsix in a clean VS Code with no node on PATH, the Model Studio
// key handed to SecretStorage through g-code: Set API Key, and Tab on the llama-server the extension starts itself.
// Run from the repository root: pnpm tsx packages/extension/test/live-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { parseEnv } from 'node:util';
import { runTests } from '@vscode/test-electron';
import { DEFAULT_TAB_MODEL_FILE } from '@g-code/core/tab';
import { healthy } from '../src/tab/server.js';
import { BARE_PATH, buildSuite, cachePath, installClean, makeWorkspace, root } from './launch.js';
import { captureWindow, freePort } from './screenshot.js';
import { ORIGINAL } from './suite/chat-fixture.js';

async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { recursive: true })) {
    const file = path.join(dir, entry);
    if ((await stat(file)).isFile() && (await readFile(file)).includes(needle)) found.push(file);
  }
  return found;
}

async function main(): Promise<number> {
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.resolve(root, '../../.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');
  const tabEndpoint = `http://127.0.0.1:${await freePort()}`;
  const { work, workspace, home } = await makeWorkspace(
    { 'math.ts': ORIGINAL, 'add.ts': 'export function add(a: number, b: number): number {\n  return \n}\n' },
    {
      'gcode.baseUrl': baseUrl,
      'gcode.model': 'qwen3.8-flash',
      'gcode.tab.endpoint': tabEndpoint,
      'gcode.tab.modelPath': path.join(homedir(), '.g-code', 'models', DEFAULT_TAB_MODEL_FILE),
      'gcode.tab.debounceMs': 10,
    },
  );
  const installed = await installClean(work);
  const suite = await buildSuite(work, 'installed');
  const keyFile = path.join(work, 'key');
  await writeFile(keyFile, key, { mode: 0o600 });
  const debugPort = await freePort();
  const shot = path.join(work, 'installed.png');
  const shots = createServer((_req, res) => void captureWindow(debugPort, shot).then(() => res.end(), (e) => res.writeHead(500).end(String(e))));
  await new Promise<void>((resolve) => shots.listen(0, '127.0.0.1', resolve));

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
    vscodeExecutablePath: installed.executable,
    extensionDevelopmentPath: installed.harness,
    extensionTestsPath: suite,
    cachePath,
    launchArgs: [workspace, ...installed.launchArgs, `--remote-debugging-port=${debugPort}`],
    extensionTestsEnv: {
      PATH: BARE_PATH,
      GCODE_HOME: home,
      GCODE_TEST_CHAT: 'live',
      GCODE_TEST_EXTENSIONS_DIR: installed.extensionsDir,
      GCODE_TEST_KEY_FILE: keyFile,
      GCODE_TEST_SCREENSHOT: `http://127.0.0.1:${(shots.address() as AddressInfo).port}`,
      DASHSCOPE_API_KEY: '',
      DASHSCOPE_BASE_URL: '',
    },
    stdout: capture(process.stdout),
    stderr: capture(process.stderr),
  }).catch(() => 1);
  shots.close();

  const sessions = path.join(home, 'sessions');
  let cost = 0;
  for (const file of await readdir(sessions).catch(() => [])) {
    const events = (await readFile(path.join(sessions, file), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const answers = events.filter((e) => e.kind === 'assistant');
    cost += answers.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
    const tools = events.filter((e) => e.kind === 'tool-result').map((e) => `${e.name}:${e.status}`);
    console.log(`chat: ${answers.length} model calls (${answers[0]?.model}), tools: ${tools.join(' ')}`);
  }
  const tabEvents = (await readFile(path.join(home, 'tab-events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const accepted = tabEvents.find((e) => e.kind === 'outcome' && e.outcome.kind === 'accepted');
  const request = tabEvents.find((e) => e.kind === 'request' && e.request.id === accepted?.id)?.request;
  console.log(`tab: accepted ${JSON.stringify(request?.text)} from ${request?.model} in ${request?.latencyMs ?? '?'} ms`);
  let stopped = false;
  for (let i = 0; i < 50 && !stopped; i++) {
    stopped = !(await healthy(tabEndpoint));
    if (!stopped) await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`tab server stopped with VS Code: ${stopped}`);
  const leaks = [...(output.includes(key) ? ['test output'] : []), ...(await filesContaining(work, key))];
  console.log(`key found in: ${leaks.length === 0 ? 'nothing' : leaks.join(', ')}`);
  console.log(`screenshot: ${shot}`);
  console.log(`estimated cost: $${cost.toFixed(6)}`);
  const passed = code === 0 && accepted !== undefined && stopped && leaks.length === 0;
  console.log(`smoke: ${passed ? 'passed' : `failed (exit ${code})`}`);
  return passed ? 0 : 1;
}

void main().then((code) => (process.exitCode = code));
