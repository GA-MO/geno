import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { AGENT_PROMPTS, asSessionId, DEFERRED_TOOLS_NOTE, toolResultText, WORKSPACE_TRUST_CAPABILITY, type TurnEvent } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { renderGenoTools } from '../src/geno-tools.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, loadTools, toolCall, type FakeToolUse } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand, runCli } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const HOW = '---\nname: how\ndescription: Explain how a subsystem works\n---\n# How\n\nRead references/explorer.md first.\n';

async function setup(pluginName: string) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-plugins-e2e-')));
  const pluginRoot = path.join(root, 'cache', pluginName);
  const write = async (file: string, text: string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  await write(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: pluginName }));
  await write(path.join(pluginRoot, 'skills', 'how', 'SKILL.md'), HOW);
  await write(path.join(pluginRoot, 'skills', 'how', 'references', 'explorer.md'), 'Explore with grep.\n');
  await write(
    path.join(root, 'claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { [`${pluginName}@market`]: [{ scope: 'user', installPath: pluginRoot }] } }),
  );
  const home = path.join(root, 'gcode-home');
  const env = {
    GCODE_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-fake',
    DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  return { workspace, env, home, pluginRoot, store: openStore(env) };
}

const sessionIdOf = (stdout: string): string => /^session: (\S+)$/m.exec(stdout)![1]!;
let nextId = 0;
const use = (name: string, input: unknown): FakeToolUse => ({ id: `tu_${nextId++}`, name, input });
const results = (events: readonly TurnEvent[]) =>
  events.flatMap((e) => (e.kind === 'tool-result' ? [{ name: e.name, status: e.status, output: toolResultText(e) }] : []));

describe('pstack through gcode agent', () => {
  it('loads a plugin skill with the skill tool, reads its folder, and cannot write there even when the user allows the command', async () => {
    const { workspace, env, home, pluginRoot, store } = await setup('pstack');
    const escaped = path.join(pluginRoot, 'escaped.txt');
    const transport = fakeTransport([
      toolCall('', [loadTools('skill')], usage),
      toolCall('Loading the skill.', [use('skill', { name: 'pstack:how' })], usage),
      toolCall('Reading its reference.', [use('read', { path: path.join(pluginRoot, 'skills', 'how', 'references', 'explorer.md') })], usage),
      toolCall('Writing there.', [use('bash', { command: `echo escaped > '${escaped}'` })], usage),
      answer('Done.', usage),
    ]);
    const run = await runCli(['agent', '--workspace', workspace, '--mode', 'ask', 'Explain a.ts with /pstack:how'], env, { fetch: transport.fetch, confirm: () => true });
    expect(run.code).toBe(0);

    const genoTools = path.join(await realpath(home), 'geno-tools.md');
    expect(await readFile(genoTools, 'utf8')).toBe(renderGenoTools({ subagents: false }));
    const system = transport.requests[0]!.body.system[0].text as string;
    expect(system.startsWith(AGENT_PROMPTS.rules)).toBe(true);
    expect(system.slice(AGENT_PROMPTS.rules.length)).toBe(
      `\n\n${DEFERRED_TOOLS_NOTE}\n\npstack skills are installed. They are written for Claude Code; before you follow one, read ${genoTools}, which maps their tools to yours.`,
    );

    const log = await readSessionLog(sessionFile(store, asSessionId(sessionIdOf(run.stdout))));
    const [, skill, read, bash] = results(log.events);
    expect(skill).toEqual({ name: 'skill', status: 'ok', output: expect.stringContaining('# How\n\nRead references/explorer.md first.') });
    expect(read).toEqual({ name: 'read', status: 'ok', output: '1\tExplore with grep.' });
    expect(bash).toMatchObject({ name: 'bash', status: 'error', output: expect.stringMatching(/^Exit code 1\n[\s\S]*Operation not permitted[\s\S]*\[exit code 1\]$/) });
    expect(existsSync(escaped)).toBe(false);
  });

  it('C/C-77 points the model at the geno-tools text that maps Agent to agent when the run offers it', async () => {
    const { workspace, env, home } = await setup('pstack');
    await writeFile(path.join(workspace, '.gcode.json'), '{ "agentTool": ["non-interactive"] }\n');
    const transport = fakeTransport([answer('Hi.', usage)]);
    expect((await runCli(['agent', '--workspace', workspace, '--non-interactive', 'Hi'], env, { fetch: transport.fetch })).code).toBe(0);
    const system = transport.requests[0]!.body.system[0].text as string;
    const pointed = /before you follow one, read (\S+), which maps/.exec(system)![1]!;
    expect(path.dirname(pointed)).toBe(await realpath(home));
    expect(await readFile(pointed, 'utf8')).toBe(renderGenoTools({ subagents: true }));
  });

  it('leaves the system prompt as it was when no pstack skill is installed', async () => {
    const { workspace, env, home } = await setup('other');
    const transport = fakeTransport([answer('Hi.', usage)]);
    expect((await runCli(['agent', '--workspace', workspace, '--non-interactive', 'Hi'], env, { fetch: transport.fetch })).code).toBe(0);
    expect(transport.requests[0]!.body.system[0].text).toBe(`${AGENT_PROMPTS.rules}\n\n${DEFERRED_TOOLS_NOTE}`);
    expect(existsSync(path.join(home, 'geno-tools.md'))).toBe(false);
  });
});

/** pstack's own hook, as its plugin ships it: hooks.json names the script by CLAUDE_PLUGIN_ROOT, and the script reads the override sheet. */
const PSTACK_HOOKS = { hooks: { SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh" claude' }] }] } };
const PSTACK_SESSION_START = [
  '#!/bin/sh',
  'set -eu',
  'case "${1:-}" in',
  '  claude) sheet="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md" ;;',
  '  *) echo "unknown runtime" >&2; exit 2 ;;',
  'esac',
  "if grep -qs '^session hook: off$' \"$sheet\"; then",
  '  exit 0',
  'fi',
  'cat "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-context.md"',
  '',
].join('\n');
const MANDATE = '<EXTREMELY_IMPORTANT>\nYou have pstack.\n</EXTREMELY_IMPORTANT>';

describe("a plugin's SessionStart hook", () => {
  async function withHook() {
    const set = await setup('pstack');
    await mkdir(path.join(set.pluginRoot, 'hooks'), { recursive: true });
    await writeFile(path.join(set.pluginRoot, 'hooks', 'hooks.json'), JSON.stringify(PSTACK_HOOKS));
    await writeFile(path.join(set.pluginRoot, 'hooks', 'session-start.sh'), PSTACK_SESSION_START, { mode: 0o755 });
    await writeFile(path.join(set.pluginRoot, 'hooks', 'session-start-context.md'), `${MANDATE}\n`);
    return set;
  }

  /** The text of the first request's first message, from an editor that trusts its workspace, as VS Code runs Geno. */
  async function firstRequest(set: Awaited<ReturnType<typeof setup>>): Promise<string> {
    const transport = fakeTransport([answer('Ready.', usage)]);
    const io: Io = { env: set.env, cwd: set.workspace, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: transport.fetch };
    const editor = acp.client({ name: 'vscode' }).onNotification(acp.methods.client.session.update, () => {});
    await editor.connectWith(gcodeAgent(io, set.store, { maxTurns: 5, maxCostUsd: 1 }), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { _meta: { [WORKSPACE_TRUST_CAPABILITY]: true } } });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: set.workspace, mcpServers: [] });
      await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Fix the bug in a.ts' }] });
    });
    const first = transport.requests[0]!.body.messages[0].content as readonly { readonly type: string; readonly text?: string }[];
    return first.flatMap((block) => (block.type === 'text' ? [block.text!] : [])).join('\n');
  }

  it("puts pstack's mandate in the first request before the prompt, as Claude Code adds it", async () => {
    const first = await firstRequest(await withHook());
    expect(first).toContain(`[Geno] SessionStart:startup hook success: ${MANDATE}`);
    expect(first.indexOf('You have pstack.')).toBeLessThan(first.indexOf('Fix the bug in a.ts'));
  });

  it("leaves it out when the user's override sheet turns the hook off", async () => {
    const set = await withHook();
    await writeFile(path.join(set.env.CLAUDE_CONFIG_DIR, 'pstack-models.md'), 'session hook: off\n');
    expect(await firstRequest(set)).not.toContain('You have pstack.');
  });
});
