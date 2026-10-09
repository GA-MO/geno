import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_TRUST_CAPABILITY } from '@g-code/core';
import { gcodeAgent } from '../../src/serve.js';
import { say, scripted, WIRES, type Wire } from './scripted.js';

type Run = Awaited<ReturnType<typeof scripted>>;

const agent = (workspace: string, prompt: string) => ['agent', '--workspace', workspace, '--non-interactive', prompt];
const A_TS = { 'a.ts': 'export const a = 1;\n' };
const json = (value: unknown) => `${JSON.stringify(value)}\n`;

/** The tool names of a request as sent, on either wire. */
const toolsOf = (body: { readonly tools?: readonly { readonly name?: string; readonly function?: { readonly name: string } }[] }): string[] =>
  (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? '');

async function writeAll(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
}

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n${name} steps\n`;
const agentFile = (description: string) => `---\ndescription: ${description}\n---\nBody of ${description}.\n`;

describe.each(WIRES)("P39 Geno's own keys on the %s wire", (wire: Wire) => {
  it('T-ASM-05 a key in .g-code/settings.json applies, and so does one left in .gcode.json', async () => {
    const run = await scripted(wire, [say('One.')], { ...A_TS, '.g-code/settings.json': json({ agentTool: ['non-interactive'] }), '.gcode.json': json({ appendSystemPrompt: 'Use tabs.' }) });
    const ran = await run.cli(agent(run.workspace, 'Hi.'));
    expect(ran.code, ran.stderr).toBe(0);
    expect(toolsOf(run.bodies()[0])).toContain('agent');
    expect(run.openings()[0]!.system.endsWith('\n\nUse tabs.')).toBe(true);
    expect(ran.stderr).toContain('settings: .gcode.json is read beneath .g-code/settings.json, whose keys win; move its keys there');
  });

  it('T-ASM-05 .g-code/settings.local.json wins a key over .g-code/settings.json, which wins over .gcode.json and the user file', async () => {
    const run = await scripted(wire, [say('One.')], {
      ...A_TS,
      '.gcode.json': json({ appendSystemPrompt: 'Legacy.' }),
      '.g-code/settings.json': json({ appendSystemPrompt: 'Shared.' }),
      '.g-code/settings.local.json': json({ appendSystemPrompt: 'Local.' }),
    });
    await writeAll(run.env['GCODE_HOME']!, { 'settings.json': json({ appendSystemPrompt: 'User.' }) });
    expect((await run.cli(agent(run.workspace, 'Hi.'))).code).toBe(0);
    const { system } = run.openings()[0]!;
    expect(system.endsWith('\n\nLocal.')).toBe(true);
    for (const lost of ['Legacy.', 'Shared.', 'User.']) expect(system).not.toContain(lost);
  });

  it('a Geno-only key in .claude/settings.json is ignored with one warning line, and an unknown key in .g-code/settings.json warns too', async () => {
    const run = await scripted(wire, [say('One.')], { ...A_TS, '.claude/settings.json': json({ agentTool: ['non-interactive'], model: 'opus' }), '.g-code/settings.json': json({ chek: 'true' }) });
    const ran = await run.cli(agent(run.workspace, 'Hi.'));
    expect(ran.code, ran.stderr).toBe(0);
    expect(toolsOf(run.bodies()[0])).not.toContain('agent');
    const lines = ran.stderr.split('\n').filter((line) => line.startsWith('settings: '));
    expect(lines).toEqual([
      'settings: .g-code/settings.json: Geno ignores chek, which it does not know',
      'settings: .claude/settings.json: Geno ignores agentTool, which it reads only from .g-code/settings.json',
    ]);
  });

  it('a settings file that is not JSON is reported and the run goes on', async () => {
    const run = await scripted(wire, [say('One.')], { ...A_TS, '.g-code/settings.json': '{ "check": ' });
    const ran = await run.cli(agent(run.workspace, 'Hi.'));
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).toMatch(/^permissions: \.g-code\/settings\.json is not valid JSON, so its rules do not apply: /m);
  });
});

describe.each(WIRES)('P39 skills and agents in every root on the %s wire', (wire: Wire) => {
  it("T-SKILL-01 the listing has skills from ~/.agents/skills and the workspace's .g-code/skills, and the agent tool agents from ~/.agents/agents and .g-code/agents", async () => {
    const run = await scripted(wire, [say('Ready.')], {
      ...A_TS,
      '.g-code/settings.json': json({ agentTool: ['non-interactive'] }),
      '.g-code/skills/lint/SKILL.md': skill('lint', 'Lint from the workspace Geno folder.'),
      '.g-code/agents/tidy.md': agentFile('Tidy from the workspace Geno folder.'),
    });
    await writeAll(run.env['HOME']!, { '.agents/skills/deploy/SKILL.md': skill('deploy', 'Deploy from ~/.agents.'), '.agents/agents/scout.md': agentFile('Scout from ~/.agents.') });
    const ran = await run.cli(agent(run.workspace, 'Hello.'));
    expect(ran.code, ran.stderr).toBe(0);
    const { first } = run.openings()[0]!;
    expect(first).toContain('- deploy: Deploy from ~/.agents.');
    expect(first).toContain('- lint: Lint from the workspace Geno folder.');
    const sent = JSON.stringify(run.bodies()[0]);
    expect(sent).toContain('- scout: Scout from ~/.agents.');
    expect(sent).toContain('- tidy: Tidy from the workspace Geno folder.');
  });
});

describe.each(WIRES)('P39 hooks in every root on the %s wire', (wire: Wire) => {
  /** One session served to an editor that trusts the workspace, as the extension serves it. */
  async function trustedSession(run: Run): Promise<void> {
    const editor = acp.client({ name: 'conformance' }).onNotification(acp.methods.client.session.update, () => {});
    await editor.connectWith(gcodeAgent(run.io, run.store, { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { _meta: { [WORKSPACE_TRUST_CAPABILITY]: true } } });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: run.workspace, mcpServers: [] });
      await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Hi' }] });
    });
  }

  it('T-HOOK-09 a hook in .g-code/settings.json runs once, and the same hook in .claude/settings.json does not run again', async () => {
    const run = await scripted(wire, [say('Ready.')]);
    // A workspace hook runs in the sandbox, which writes only in the workspace.
    const log = path.join(run.workspace, 'hook.log');
    const hooks = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `cat >> '${log}'; echo From the project.` }] }] } };
    await writeAll(run.workspace, { '.g-code/settings.json': json(hooks), '.claude/settings.json': json(hooks) });

    await trustedSession(run);
    expect(existsSync(log), 'the hook ran').toBe(true);
    expect((await readFile(log, 'utf8')).match(/"hook_event_name":"SessionStart"/g), 'it ran once').toHaveLength(1);
    expect(run.openings()[0]!.first.match(/From the project\./g)).toHaveLength(1);
  });
});
