import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { PROMPT_ACTION_META, PROMPT_ACTIONS, STEER_META } from '@g-code/core';
import { gcodeAgent } from '../../src/serve.js';
import { call, say, scripted, WIRES, type Wire } from '../conformance/scripted.js';
import { normalizeRequest } from '../request-normal.js';

/**
 * The exact request bodies Geno sends for a few representative turns, on both wires, after the normalization in
 * `request-normal.ts`, compared with the files in `requests/`. Any change to what the model receives fails here in
 * seconds with a diff. When the change is meant, update the files with `pnpm test:golden -u` and commit them.
 */

type Run = Awaited<ReturnType<typeof scripted>>;
type Scenario = (wire: Wire) => Promise<readonly unknown[]>;

const agent = (run: Run, prompt: string, ...flags: string[]) => run.cli(['agent', '--workspace', run.workspace, '--non-interactive', ...flags, prompt]);

async function ok(result: Promise<{ code: number; stderr: string }>): Promise<void> {
  const { code, stderr } = await result;
  expect(code, stderr).toBe(0);
}

/** An editor session over ACP that allows every call; `drive` gets a prompt function and the raw context. */
async function editor(run: Run, drive: (prompt: (text: string, meta?: Record<string, unknown>) => Promise<acp.PromptResponse>) => Promise<void>): Promise<void> {
  const client = acp
    .client({ name: 'golden' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => ({ outcome: { outcome: 'selected', optionId: params.options[0]!.optionId } }))
    .onNotification(acp.methods.client.session.update, () => {});
  await client.connectWith(gcodeAgent(run.io, run.store, { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: run.workspace, mcpServers: [] });
    await drive((text, meta) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }], ...(meta === undefined ? {} : { _meta: meta }) }));
  });
}

async function userHooks(run: Run, hooks: Readonly<Record<string, string>>): Promise<void> {
  const settings: Record<string, unknown> = {};
  for (const [event, stdout] of Object.entries(hooks)) {
    const script = path.join(run.env['HOME']!, 'hooks', `${event}.sh`);
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, `#!/bin/sh\ncat > /dev/null\ncat <<'EOF'\n${stdout}\nEOF\n`);
    await chmod(script, 0o755);
    settings[event] = [{ hooks: [{ type: 'command', command: `'${script}'` }] }];
  }
  await mkdir(path.join(run.env['HOME']!, '.claude'), { recursive: true });
  await writeFile(path.join(run.env['HOME']!, '.claude', 'settings.json'), JSON.stringify({ hooks: settings }));
}

const FAKE_MCP = fileURLToPath(new URL('../fake-mcp-server.ts', import.meta.url));

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  'plain-prompt': async (wire) => {
    const run = await scripted(wire, [say('Hello.')]);
    await ok(agent(run, 'Hi.'));
    return run.bodies();
  },

  'tool-round-trip': async (wire) => {
    const run = await scripted(wire, [call('Reading.', [{ id: 'tu_read', name: 'read', input: { path: 'a.ts' } }]), say('a is 1.')]);
    await ok(agent(run, 'What is a?'));
    return run.bodies();
  },

  steer: async (wire) => {
    const wait = 'until [ -f go ]; do sleep 0.05; done';
    const run = await scripted(wire, [call('Waiting for the build.', [{ id: 'tu_wait', name: 'bash', input: { command: wait } }]), say('Checked b.ts too.')]);
    await editor(run, async (prompt) => {
      const turn = prompt('Wait for the build, then check a.ts.');
      while (run.bodies().length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      const steered = prompt('Also check b.ts.', { [STEER_META]: true });
      // The steer reaches the engine in-process within milliseconds; the wait keeps the batch open until then.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(path.join(run.workspace, 'go'), '');
      await Promise.all([turn, steered]);
    });
    return run.bodies();
  },

  'background-notice': async (wire) => {
    const run = await scripted(wire, [
      call('Starting it.', [{ id: 'tu_bg', name: 'bash', input: { command: 'echo started; sleep 0.3; echo finished', run_in_background: true } }]),
      call('Waiting.', [{ id: 'tu_sleep', name: 'bash', input: { command: 'sleep 1' } }]),
      say('Done.'),
    ]);
    await ok(agent(run, 'Run it in the background.'));
    return run.bodies();
  },

  compaction: async (wire) => {
    const summary = '## Goal\nAnswer the user.\n## Progress\nSaid hello.\n## Decisions\n## Next steps\nGo on.';
    const run = await scripted(wire, [say('Hello.'), say(summary), say('Going on.')]);
    await editor(run, async (prompt) => {
      await prompt('Hi.');
      await prompt('/compact keep the greeting');
      await prompt('Go on.');
    });
    return run.bodies();
  },

  'prompt-action': async (wire) => {
    const run = await scripted(wire, [say('แผน: เพิ่มปุ่มรีเซ็ต'), say('เพิ่มแล้ว'), say('เสร็จแล้ว')]);
    await editor(run, async (prompt) => {
      await prompt('วางแผนเพิ่มปุ่มรีเซ็ตในเกม');
      await prompt(PROMPT_ACTIONS['start-building'], { [PROMPT_ACTION_META]: 'start-building' });
      await prompt(PROMPT_ACTIONS.continue, { [PROMPT_ACTION_META]: 'continue' });
    });
    return run.bodies();
  },

  'mcp-briefing': async (wire) => {
    const run = await scripted(wire, [say('Noted.')]);
    const docs = { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), FAKE_MCP], env: { INSTRUCTIONS: 'Search before you echo.' } };
    await mkdir(path.dirname(run.store.mcpConfigFile), { recursive: true });
    await writeFile(run.store.mcpConfigFile, JSON.stringify({ mcpServers: { docs } }));
    await ok(agent(run, 'Use the docs.', '--mcp'));
    return run.bodies();
  },

  'hooks-context': async (wire) => {
    const run = await scripted(wire, [say('BANANA.')]);
    await userHooks(run, {
      SessionStart: 'You have pstack.',
      UserPromptSubmit: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'The secret word is BANANA.' } }),
    });
    await ok(agent(run, 'What is the secret word?'));
    return run.bodies();
  },
};

/** A value repeated from earlier is named, not repeated, from this many characters of JSON. */
const SHARED_MIN = 200;
const INLINE_MAX = 80;

/**
 * Renders request bodies one value per line, with each string line after `|`, so a diff points at the line that
 * changed. A value of `SHARED_MIN` or more JSON characters that `seen` already holds is written as `= <where>`.
 */
function render(bodies: readonly unknown[], seen: Map<string, string>, file: string): string {
  const lines: string[] = [];
  const value = (v: unknown, where: string, indent: string, lead: string): void => {
    const json = JSON.stringify(v);
    const earlier = json.length >= SHARED_MIN ? seen.get(json) : undefined;
    if (earlier !== undefined) return void lines.push(`${lead} = ${earlier}`);
    if (json.length >= SHARED_MIN) seen.set(json, `${file} ${where}`);
    if (typeof v === 'string' && v.includes('\n')) {
      lines.push(lead);
      for (const line of v.split('\n')) lines.push(`${indent}  |${line === '' ? '' : ` ${line}`}`);
    } else if (v === null || typeof v !== 'object' || json.length <= INLINE_MAX) {
      lines.push(`${lead} ${json}`);
    } else if (Array.isArray(v)) {
      lines.push(lead);
      v.forEach((item, i) => value(item, `${where}[${i}]`, `${indent}  `, `${indent}  -`));
    } else {
      lines.push(lead);
      for (const [key, item] of Object.entries(v)) value(item, `${where}.${key}`, `${indent}  `, `${indent}  ${key}:`);
    }
  };
  bodies.forEach((body, i) => {
    lines.push('', `=== request ${i + 1}`);
    for (const [key, item] of Object.entries(body as object)) value(item, `request ${i + 1} ${key}`, '', `${key}:`);
  });
  return `${lines.join('\n').trimStart()}\n`;
}

const golden = (scenario: string, wire: Wire) => `./requests/${scenario}.${wire}.golden`;

describe.each(WIRES)('the requests Geno sends on the %s wire', (wire: Wire) => {
  // Every scenario names the values it shares with the plain prompt, such as the system prompt and the tools.
  const base = new Map<string, string>();
  beforeAll(async () => {
    render((await SCENARIOS['plain-prompt']!(wire)).map(normalizeRequest), base, `plain-prompt.${wire}.golden`);
  });

  it.each(Object.keys(SCENARIOS))('%s', async (scenario) => {
    const bodies = (await SCENARIOS[scenario]!(wire)).map(normalizeRequest);
    const seen = scenario === 'plain-prompt' ? new Map<string, string>() : new Map(base);
    await expect(render(bodies, seen, `${scenario}.${wire}.golden`)).toMatchFileSnapshot(golden(scenario, wire));
  }, 60_000);
});
