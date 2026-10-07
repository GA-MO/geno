import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { GENO_NOTE, HOOKS_METHOD, WORKSPACE_TRUST_CAPABILITY, type HooksResponse } from '@g-code/core';
import { gcodeAgent } from '../../src/serve.js';
import { closeServers, say, scripted, sessionIdOf, WIRES, type Wire } from './scripted.js';

afterEach(closeServers);

type Run = Awaited<ReturnType<typeof scripted>>;

const agent = (workspace: string, prompt: string) => ['agent', '--workspace', workspace, '--non-interactive', prompt];
const resume = (id: string, prompt: string) => ['agent', '--session', id, '--non-interactive', prompt];

const group = (command: string, { matcher, timeout }: { matcher?: string; timeout?: number } = {}) => [
  { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command, ...(timeout === undefined ? {} : { timeout }) }] },
];

/** Writes `hooks` as the user's own Claude Code settings, under the fake home the run uses. */
async function userHooks(run: Run, hooks: object, file = path.join(run.env['HOME']!, '.claude', 'settings.json')): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ hooks }));
}

/**
 * A hook script that appends its stdin payload to `<name>.jsonl` next to it, writes `stderr` to stderr, prints
 * `stdout`, and exits with `code`, as the hooks in research/claude-code-harness/experiments do.
 */
async function hookScript(
  run: Run,
  name: string,
  opts: { stdout?: string; stderr?: string; code?: number; before?: string; dir?: string } = {},
): Promise<{ command: string; payloads: () => Promise<Record<string, unknown>[]> }> {
  const dir = opts.dir ?? path.join(run.env['HOME']!, 'hooks');
  await mkdir(dir, { recursive: true });
  const script = path.join(dir, `${name}.sh`);
  const log = path.join(dir, `${name}.jsonl`);
  await writeFile(
    script,
    [
      '#!/bin/sh',
      `cat >> '${log}'`,
      `echo >> '${log}'`,
      opts.before ?? '',
      opts.stderr === undefined ? '' : `printf '%s\\n' '${opts.stderr}' >&2`,
      opts.stdout === undefined ? '' : `cat <<'EOF'\n${opts.stdout}\nEOF`,
      `exit ${opts.code ?? 0}`,
      '',
    ].join('\n'),
  );
  await chmod(script, 0o755);
  const payloads = async () => (existsSync(log) ? (await readFile(log, 'utf8')).split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>) : []);
  return { command: `'${script}'`, payloads };
}

const startup = (text: string) => `${GENO_NOTE} SessionStart:startup hook success: ${text}`;

describe.each(WIRES)('SessionStart on the %s wire', (wire: Wire) => {
  it('T-HOOK-06 B/B-100 a startup hook gets the payload, and its stdout opens the first request before the prompt', async () => {
    const run = await scripted(wire, [say('Ready.')]);
    const hook = await hookScript(run, 'start', { stdout: 'You have pstack.' });
    await userHooks(run, { SessionStart: group(hook.command, { matcher: 'startup|resume|clear|compact' }) });

    const started = await run.cli(agent(run.workspace, 'Hello'));
    expect(started.code).toBe(0);

    const [payload] = await hook.payloads();
    expect(payload).toEqual({
      session_id: sessionIdOf(started.stdout),
      transcript_path: expect.stringMatching(new RegExp(`${sessionIdOf(started.stdout)}\\.jsonl$`)),
      cwd: run.workspace,
      permission_mode: 'dontAsk',
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    expect(existsSync(payload!['transcript_path'] as string), 'the transcript path is the session log').toBe(true);
    const first = run.openings()[0]!.first;
    expect(first).toContain(startup('You have pstack.'));
    expect(first.indexOf(startup('You have pstack.'))).toBeLessThan(first.lastIndexOf('Hello'));
    expect(first.endsWith('Hello')).toBe(true);
    expect(run.openings()[0]!.system, 'the system prompt holds no hook text').not.toContain('pstack');
  });

  it('T-HOOK-06 a resumed session runs the hook with source resume, and the opening keeps its bytes', async () => {
    const run = await scripted(wire, [say('Ready.'), say('Again.')]);
    const hook = await hookScript(run, 'start', { stdout: 'Mandate.' });
    await userHooks(run, { SessionStart: group(hook.command, { matcher: 'startup|resume' }) });

    const started = await run.cli(agent(run.workspace, 'Hello'));
    const again = await run.cli(resume(sessionIdOf(started.stdout), 'Once more'));
    expect(again.code).toBe(0);

    expect((await hook.payloads()).map((p) => p['source'])).toEqual(['startup', 'resume']);
    const [opened, resumed] = run.openings();
    expect(resumed!.first, 'the resumed session opens with the same bytes').toBe(opened!.first);
    const last = run.seen()[1]!.text;
    expect(last).toContain(`${GENO_NOTE} SessionStart:resume hook success: Mandate.`);
    expect(last.endsWith('Once more')).toBe(true);
  });

  it('T-HOOK-06 a hook whose matcher names another source does not run', async () => {
    const run = await scripted(wire, [say('Ready.')]);
    const hook = await hookScript(run, 'compact-only', { stdout: 'Only after compacting.' });
    await userHooks(run, { SessionStart: group(hook.command, { matcher: 'compact' }) });
    expect((await run.cli(agent(run.workspace, 'Hello'))).code).toBe(0);
    expect(await hook.payloads()).toEqual([]);
    expect(run.openings()[0]!.first).not.toContain('Only after compacting.');
  });

  it("T-HOOK-10 a JSON additionalContext reaches the model in Claude Code's words, and systemMessage only the user", async () => {
    const run = await scripted(wire, [say('Ready.')]);
    const output = { systemMessage: 'Shown to the user.', hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'The secret word is BANANA.' } };
    const hook = await hookScript(run, 'json', { stdout: JSON.stringify(output) });
    await userHooks(run, { SessionStart: group(hook.command) });

    const started = await run.cli(agent(run.workspace, 'Hello'));
    expect(started.code).toBe(0);
    const first = run.openings()[0]!.first;
    expect(first).toContain(`${GENO_NOTE} SessionStart:startup hook additional context: The secret word is BANANA.`);
    expect(first).not.toContain('Shown to the user.');
    expect(started.stderr).toContain('SessionStart:startup hook: Shown to the user.');
  });

  it('T-HOOK-08 exit 2 and exit 1 do not stop the session and put nothing before the model; JSON that does not parse is a reported error', async () => {
    const run = await scripted(wire, [say('Ready.')]);
    const two = await hookScript(run, 'two', { stdout: 'TWO-OUT', stderr: 'two said no', code: 2 });
    const one = await hookScript(run, 'one', { stdout: 'ONE-OUT', stderr: 'one failed', code: 1 });
    const broken = await hookScript(run, 'broken', { stdout: '{"hookSpecificOutput": ' });
    await userHooks(run, { SessionStart: [...group(two.command), ...group(one.command), ...group(broken.command)] });

    const started = await run.cli(agent(run.workspace, 'Hello'));
    expect(started.code).toBe(0);
    expect(run.seen()).toHaveLength(1);
    const first = run.openings()[0]!.first;
    for (const text of ['TWO-OUT', 'ONE-OUT', 'hookSpecificOutput']) expect(first).not.toContain(text);
    expect(started.stderr).toMatch(/SessionStart:startup hook error: .*two\.sh.*: exit code 2: two said no/);
    expect(started.stderr).toMatch(/SessionStart:startup hook error: .*one\.sh.*: exit code 1: one failed/);
    expect(started.stderr).toMatch(/SessionStart:startup hook error: .*broken\.sh.*: printed JSON that does not parse/);
  });

  it('T-HOOK-09 matching hooks run at once, and a handler in two settings files runs once', async () => {
    const run = await scripted(wire, [say('Ready.')]);
    const marks = path.join(run.env['HOME']!, 'hooks');
    // Each hook marks that it started, then waits for the other's mark: only hooks that run at once both see one.
    const wait = (other: string) => `touch "${marks}/$(basename "$0").started"; i=0; while [ ! -e '${marks}/${other}.sh.started' ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; [ -e '${marks}/${other}.sh.started' ] && echo "${other} ran beside me"`;
    const a = await hookScript(run, 'a', { before: wait('b') });
    const b = await hookScript(run, 'b', { before: wait('a') });
    await userHooks(run, { SessionStart: [...group(a.command), ...group(b.command)] });
    await userHooks(run, { SessionStart: group(a.command) }, path.join(run.env['GCODE_HOME']!, 'settings.json'));

    expect((await run.cli(agent(run.workspace, 'Hello'))).code).toBe(0);
    expect(await a.payloads(), 'the duplicate ran once').toHaveLength(1);
    expect(await b.payloads()).toHaveLength(1);
    const first = run.openings()[0]!.first;
    expect(first).toContain(startup('b ran beside me'));
    expect(first).toContain(startup('a ran beside me'));
  });

  it("T-HOOK-11 a hook is killed at its timeout, and the session goes on", async () => {
    const run = await scripted(wire, [say('Ready.')]);
    const slow = await hookScript(run, 'slow', { before: 'sleep 30', stdout: 'too late' });
    await userHooks(run, { SessionStart: group(slow.command, { timeout: 1 }) });

    const started = performance.now();
    const result = await run.cli(agent(run.workspace, 'Hello'));
    expect(result.code).toBe(0);
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(result.stderr).toMatch(/SessionStart:startup hook error: .*slow\.sh.*: timed out after 1 s and was killed/);
    expect(run.openings()[0]!.first).not.toContain('too late');
  });

  it('T-HOOK-07 an event name Claude Code does not have is reported, and its hook never runs', async () => {
    const run = await scripted(wire, [say('Ready.')]);
    const hook = await hookScript(run, 'typo', { stdout: 'typo ran' });
    await userHooks(run, { SesionStart: group(hook.command) });

    const result = await run.cli(agent(run.workspace, 'Hello'));
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/hooks: .*settings\.json: SesionStart is not a hook event/);
    expect(await hook.payloads()).toEqual([]);
  });
});

describe('the session lifecycle', () => {
  it('T-HOOK-01 B/B-126 SessionStart runs before the first model call and SessionEnd after the run, with reason other', async () => {
    const run = await scripted('anthropic', [say('Ready.')]);
    const order = path.join(run.env['HOME']!, 'order.txt');
    const start = await hookScript(run, 'start', { before: `echo start >> '${order}'` });
    const end = await hookScript(run, 'end', { before: `echo end >> '${order}'` });
    await userHooks(run, { SessionStart: group(start.command), SessionEnd: group(end.command) });

    const result = await run.cli(agent(run.workspace, 'Hello'));
    expect(result.code).toBe(0);
    expect((await readFile(order, 'utf8')).split('\n').filter(Boolean)).toEqual(['start', 'end']);
    expect((await end.payloads())[0]).toMatchObject({ hook_event_name: 'SessionEnd', reason: 'other', session_id: sessionIdOf(result.stdout) });
  });

  it('T-HOOK-06 a compaction runs the hook again with source compact, and its output follows the compacted context', async () => {
    const run = await scripted('anthropic', [
      say('First answer.'),
      say('Cut short by the window', 'model_context_window_exceeded'),
      say('## Goal\nAnswer the user.\n## Progress\n## Decisions\n## Next steps'),
      say('Second answer, after compacting.'),
    ]);
    const hook = await hookScript(run, 'start', { stdout: 'Mandate again.' });
    await userHooks(run, { SessionStart: group(hook.command, { matcher: 'startup|resume|compact' }) });

    const first = await run.cli(agent(run.workspace, 'first'));
    const second = await run.cli(resume(sessionIdOf(first.stdout), 'second'));
    expect(second.code).toBe(0);

    expect((await hook.payloads()).map((p) => p['source'])).toEqual(['startup', 'resume', 'compact']);
    const retry = run.seen()[3]!.text;
    expect(retry).toContain('<compacted_context>');
    expect(retry).toContain(`${GENO_NOTE} SessionStart:compact hook success: Mandate again.`);
  });

  it('runs project hooks only for an editor whose workspace VS Code trusts, never on the command line', async () => {
    const run = await scripted('anthropic', [say('Ready.'), say('Trusted.'), say('Not trusted.')]);
    // In the workspace: a project hook runs in the sandbox, which writes only there.
    const hook = await hookScript(run, 'project', { stdout: 'From the repository.', dir: path.join(run.workspace, '.claude', 'hooks') });
    await mkdir(path.join(run.workspace, '.claude'), { recursive: true });
    await writeFile(path.join(run.workspace, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: group(hook.command) } }));

    expect((await run.cli(agent(run.workspace, 'Hello'))).code).toBe(0);
    expect(await hook.payloads(), 'the command line runs no project hook').toEqual([]);

    for (const trusted of [true, false]) {
      const editor = acp.client({ name: 'conformance' }).onNotification(acp.methods.client.session.update, () => {});
      await editor.connectWith(gcodeAgent(run.io, run.store, { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { _meta: { [WORKSPACE_TRUST_CAPABILITY]: trusted } } });
        const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: run.workspace, mcpServers: [] });
        await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Hi' }] });
      });
    }
    expect((await hook.payloads()).map((p) => p['source'])).toEqual(['startup']);
    expect(run.openings()[1]!.first).toContain(startup('From the repository.'));
    expect(run.openings()[2]!.first).not.toContain('From the repository.');
  });

  it('T-HOOK-07 the Settings listing warns about an unknown event and says which hooks run', async () => {
    const run = await scripted('anthropic', []);
    await userHooks(run, { SesionStart: group('echo typo'), SessionStart: group('echo start'), Stop: group('notify'), Notification: group('notify') });
    await mkdir(path.join(run.workspace, '.claude'), { recursive: true });
    await writeFile(path.join(run.workspace, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionEnd: group('echo end') } }));

    const editor = acp.client({ name: 'conformance' });
    let listing: HooksResponse | undefined;
    await editor.connectWith(gcodeAgent(run.io, run.store, { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { _meta: { [WORKSPACE_TRUST_CAPABILITY]: false } } });
      listing = await ctx.request<HooksResponse>(HOOKS_METHOD, { cwd: run.workspace });
    });
    expect(listing!.problems).toEqual([{ severity: 'warning', text: expect.stringMatching(/SesionStart is not a hook event/) }]);
    expect(listing!.hooks.map((h) => [h.event, h.command, h.status])).toEqual([
      ['SessionStart', 'echo start', 'runs'],
      ['Stop', 'notify', 'P15'],
      ['Notification', 'notify', 'never'],
      ['SessionEnd', 'echo end', 'untrusted'],
    ]);
  });
});
