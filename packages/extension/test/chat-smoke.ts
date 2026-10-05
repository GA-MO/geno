// Live smoke for the chat panel: VS Code, the built engine, and the model configured in the repo's .env.
// Run from the repository root after `pnpm build`: pnpm tsx packages/extension/test/chat-smoke.ts
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { cachePath, root, setUp } from './launch.js';
import { ORIGINAL } from './suite/chat-fixture.js';

async function main(): Promise<number> {
  const { home, suite, launchArgs } = await setUp('chat-live', { 'math.ts': ORIGINAL }, {});
  const code = await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: suite,
    cachePath,
    launchArgs,
    extensionTestsEnv: { GCODE_HOME: home, GCODE_MODEL: process.env['GCODE_MODEL'] || 'qwen3.8-flash' },
  });
  
  const sessions = path.join(home, 'sessions');
  for (const file of await readdir(sessions).catch(() => [])) {
    const events = (await readFile(path.join(sessions, file), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const answers = events.filter((e) => e.kind === 'assistant');
    const cost = answers.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
    const tools = events.filter((e) => e.kind === 'tool-result').map((e) => `${e.name}:${e.status}`);
    console.log(`session log: ${path.join(sessions, file)}`);
    console.log(`model calls: ${answers.length} tools: ${tools.join(' ')} estimated cost: $${cost.toFixed(6)}`);
  }
  console.log(`smoke: ${code === 0 ? 'passed' : `failed (exit ${code})`}`);
  return code;
}

void main().then((code) => (process.exitCode = code));
