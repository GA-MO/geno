import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { gcodeAgent } from '../../src/serve.js';
import { call, closeServers, report, say, scripted, sessionIdOf, WIRES } from './scripted.js';

afterEach(closeServers);

type Run = Awaited<ReturnType<typeof scripted>>;

const skill = (name: string, description: string, body: string, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`;

const WORKSPACE = {
  'a.ts': 'export const a = 1;\n',
  '.claude/skills/review/SKILL.md': skill('review', 'Review a diff.', 'Review steps.'),
  '.claude/skills/tidy/SKILL.md': skill('tidy', 'A workspace tidy that replaces yours', 'Workspace tidy steps.'),
  '.claude/skills/digest/SKILL.md': skill('digest', 'Summarize a file in a subagent.', 'Digest steps.', 'context: fork\nagent: Explore\n'),
};

async function writeAll(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
}

/** The user's own skills in ~/.g-code and ~/.claude, and a plugin installed for the user, as Claude Code records it. */
async function installUserSkills(run: Run): Promise<void> {
  const home = run.env['HOME']!;
  const plugin = path.join(home, 'plugin-cache', 'pstack');
  await writeAll(home, {
    'skills/tidy/SKILL.md': skill('tidy', 'Tidy the repo', 'Tidy steps.'),
    '.claude/skills/go/SKILL.md': skill('go', 'Finish the whole task. User-invoked only.', 'Go steps for $ARGUMENTS.', 'disable-model-invocation: true\n'),
    'plugin-cache/pstack/.claude-plugin/plugin.json': JSON.stringify({ name: 'pstack' }),
    'plugin-cache/pstack/skills/how/SKILL.md': skill('how', 'Explain how a subsystem works.', 'How steps.'),
    '.claude/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'pstack@pstack-claude': [{ scope: 'user', installPath: plugin }] } }),
  });
}

const loadSkill = call('', [{ id: 'tu_load', name: 'tool_search', input: { select: ['skill'] } }]);
const use = (id: string, input: Readonly<Record<string, unknown>>) => call('', [{ id, name: 'skill', input }]);

/** Every tool result the model read, by its call's id. */
const resultsOf = (run: Run) => new Map(run.seen().flatMap((request) => request.results.map((result) => [result.id, result] as const)));

describe.each(WIRES)('skills on the %s wire', (wire) => {
  it("T-SKILL-01 the first request lists the user's, the workspace's and a plugin's skills by name and description, hides a user-only one, and a resume sends the same bytes", async () => {
    const run = await scripted(wire, [say('Ready.'), say('Still here.')], WORKSPACE);
    await installUserSkills(run);
    const first = await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', 'Hello.']);
    expect(first.code, first.stderr).toBe(0);
    await writeAll(run.env['HOME']!, { 'skills/later/SKILL.md': skill('later', 'Added after the session started', 'Later steps.') });
    const again = await run.cli(['agent', '--session', sessionIdOf(first.stdout), '--non-interactive', 'Again.']);
    expect(again.code, again.stderr).toBe(0);

    const [opened, resumed] = run.openings();
    const listing = opened!.first.slice(opened!.first.indexOf('The following skills are available for use with the skill tool.'));
    const after = listing.split('\n').slice(2);
    const lines = after.slice(0, after.findIndex((line) => !line.startsWith('- ')));
    expect(lines).toEqual(['- tidy: Tidy the repo', '- digest: Summarize a file in a subagent.', '- review: Review a diff.', '- pstack:how: Explain how a subsystem works.']);
    expect(opened!.first).not.toContain('SKILL.md');
    expect(first.stderr).toContain(`.claude/skills/tidy/SKILL.md: not loaded, because your own skill tidy (${path.join(run.env['HOME']!, 'skills', 'tidy', 'SKILL.md')}) has its name`);
    expect(resumed!.first).toBe(opened!.first);
  });

  it('T-SKILL-03 skill loads a listed skill with its args, and refuses a user-only one the user did not type', async () => {
    const run = await scripted(wire, [loadSkill, use('tu_review', { name: 'review', args: 'src/b.ts' }), use('tu_go', { name: 'go' }), use('tu_tidy', { name: 'tidy' }), say('Done.')], WORKSPACE);
    await installUserSkills(run);
    expect((await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', 'Review src/b.ts.'])).code).toBe(0);

    const results = resultsOf(run);
    expect(results.get('tu_review')).toEqual({
      id: 'tu_review',
      error: false,
      text: `Skill review, from .claude/skills/review/SKILL.md. Resolve relative paths in it against .claude/skills/review.\n\nReview steps.\n\nARGUMENTS: src/b.ts`,
    });
    expect(results.get('tu_go')).toMatchObject({ error: true, text: expect.stringContaining('only the user runs go, as /go') });
    expect(results.get('tu_tidy')!.text, "the user's own tidy, not the workspace's").toContain('Tidy steps.');
  });

  it('T-SKILL-02 a user-only skill the user typed as a slash command comes with the message, and skill loads it then with its args', async () => {
    const run = await scripted(wire, [loadSkill, use('tu_go', { name: 'go', args: 'ship it' }), say('Done.')], WORKSPACE);
    await installUserSkills(run);
    const editor = acp
      .client({ name: 'conformance' })
      .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'cancelled' } }))
      .onNotification(acp.methods.client.session.update, () => {});
    await editor.connectWith(gcodeAgent(run.io, run.store, { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: run.workspace, mcpServers: [] });
      const turn = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: '/go ship it' }] });
      expect(turn.stopReason).toBe('end_turn');
    });

    const asked = run.seen()[0]!.text;
    expect(asked).toContain('/go ship it');
    expect(asked).toContain(`<context_item kind="skill" name="go" path="${path.join(run.env['HOME']!, '.claude', 'skills', 'go', 'SKILL.md')}">`);
    expect(resultsOf(run).get('tu_go')).toMatchObject({ error: false, text: expect.stringMatching(/\n\nGo steps for ship it\.\n?$/) });
  });

  it('C/C-53 a context: fork skill runs as the subagent it names, which gets the skill and its args as its task, and its report is the result', async () => {
    const run = await scripted(wire, [loadSkill, use('tu_digest', { name: 'digest', args: 'a.ts' }), report('a.ts exports a.'), say('a.ts exports a.')], WORKSPACE);
    expect((await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', 'Digest a.ts.'])).code).toBe(0);

    const child = JSON.stringify(run.bodies()[2]);
    expect(child).toContain('You are explore');
    expect(child).toContain('Digest steps.');
    expect(child).toContain('ARGUMENTS: a.ts');
    const result = resultsOf(run).get('tu_digest')!;
    expect(result.error).toBe(false);
    expect(result.text).toMatch(/^<subagent_report agent="explore" /);
    expect(result.text).toContain('a.ts exports a.');
  });
});
