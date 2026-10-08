import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { GENO_NOTE, HOOKS_METHOD, WORKSPACE_TRUST_CAPABILITY, type CommandPattern, type Denial, type HooksResponse, type SessionMode, type TurnEvent } from '@g-code/core';
import { runAgent } from '../../src/agent.js';
import { startSession } from '../../src/chat.js';
import { HookSessions } from '../../src/hooks.js';
import { permissionStore } from '../../src/permissions.js';
import { gcodeAgent } from '../../src/serve.js';
import { homeOf } from '../../src/store.js';
import { freshAuto, type Approval, type PermissionAnswer } from '../../src/tools/agent.js';
import { call, closeServers, report, say, scripted, sessionIdOf, WIRES, type ScriptedTurn, type Wire } from './scripted.js';

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
      // One write per payload, so hooks that run at once do not interleave their lines; `before` may read "$in".
      'in=$(cat)',
      `printf '%s\\n' "$in" >> '${log}'`,
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
    await userHooks(run, { SesionStart: group('echo typo'), SessionStart: group('echo start'), PreToolUse: group('check', { matcher: 'Edit' }), Stop: group('notify'), Notification: group('notify') });
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
      ['PreToolUse', 'check', 'runs'],
      ['Stop', 'notify', 'P15'],
      ['Notification', 'notify', 'never'],
      ['SessionEnd', 'echo end', 'untrusted'],
    ]);
  });
});

const deny = (reason: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const decide = (permissionDecision: string, extra: object = {}) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, ...extra } });
const resultOf = (run: Run, id: string) => run.seen().flatMap((seen) => seen.results).find((result) => result.id === id);

describe.each(WIRES)('PreToolUse on the %s wire', (wire: Wire) => {
  it('T-LOOP-01 runs PreToolUse for every call of a turn before the first one runs, and answers them in call order', async () => {
    const uses = ['one', 'two', 'three'].map((word) => ({ id: `tu_${word}`, name: 'bash', input: { command: `echo ${word} >> order.txt` } }));
    const run = await scripted(wire, [call('', uses), say('Done.')]);
    const hook = await hookScript(run, 'pre', { before: `echo pre >> '${path.join(run.workspace, 'order.txt')}'` });
    await userHooks(run, { PreToolUse: group(hook.command, { matcher: 'Bash' }) });

    const result = await run.cli(agent(run.workspace, 'Go'));
    expect(result.code).toBe(0);
    expect((await readFile(path.join(run.workspace, 'order.txt'), 'utf8')).split('\n').filter(Boolean)).toEqual(['pre', 'pre', 'pre', 'one', 'two', 'three']);
    expect(run.seen()[1]!.results.map((r) => r.id)).toEqual(['tu_one', 'tu_two', 'tu_three']);
    const payloads = await hook.payloads();
    expect(payloads.map((p) => p['tool_use_id']).sort()).toEqual(['tu_one', 'tu_three', 'tu_two']);
    expect(payloads.find((p) => p['tool_use_id'] === 'tu_one')).toEqual({
      session_id: sessionIdOf(result.stdout),
      transcript_path: expect.stringMatching(/\.jsonl$/),
      cwd: run.workspace,
      permission_mode: 'dontAsk',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo one >> order.txt' },
      tool_use_id: 'tu_one',
    });
  });

  it("T-PERM-06 a hook's deny blocks the call with Claude Code's text, and the other call of the batch still runs", async () => {
    const blocked = { id: 'tu_blocked', name: 'bash', input: { command: 'echo forbidden-word' } };
    const fine = { id: 'tu_fine', name: 'bash', input: { command: 'echo fine' } };
    const run = await scripted(wire, [call('', [blocked, fine]), say('Done.')]);
    // As research/claude-code-harness/experiments/hook-deny.sh does.
    const hook = await hookScript(run, 'deny', { before: `case "$in" in *forbidden-word*) echo '${deny('Policy: commands containing forbidden-word are blocked by hook-deny.sh')}'; exit 0;; esac` });
    await userHooks(run, { PreToolUse: group(hook.command, { matcher: 'Bash' }) });

    expect((await run.cli(agent(run.workspace, 'Go'))).code).toBe(0);
    expect(resultOf(run, 'tu_blocked')).toEqual({ id: 'tu_blocked', error: true, text: `${GENO_NOTE} PreToolUse:Bash hook error: Policy: commands containing forbidden-word are blocked by hook-deny.sh` });
    expect(resultOf(run, 'tu_fine')).toMatchObject({ error: false, text: expect.stringContaining('fine') });
  });

  it('T-PERM-06 exit 2 blocks with stderr as the reason; valid JSON on exit 1 still decides, as Claude Code reads it', async () => {
    const two = { id: 'tu_two', name: 'bash', input: { command: 'echo exit-two' } };
    const one = { id: 'tu_one', name: 'edit', input: { path: 'made.ts', new_str: 'x', create: true } };
    const run = await scripted(wire, [call('', [two]), call('', [one]), say('Done.')]);
    const bashHook = await hookScript(run, 'bash', { stderr: 'migrations are frozen', code: 2 });
    const editHook = await hookScript(run, 'edit', { stdout: deny('generated by the build'), code: 1 });
    await userHooks(run, { PreToolUse: [...group(bashHook.command, { matcher: 'Bash' }), ...group(editHook.command, { matcher: 'Edit|Write' })] });

    const result = await run.cli(agent(run.workspace, 'Go'));
    expect(result.code).toBe(0);
    expect(resultOf(run, 'tu_two')).toEqual({ id: 'tu_two', error: true, text: `${GENO_NOTE} PreToolUse:Bash hook error: migrations are frozen` });
    expect(resultOf(run, 'tu_one')).toEqual({ id: 'tu_one', error: true, text: `${GENO_NOTE} PreToolUse:Write hook error: generated by the build` });
    expect(existsSync(path.join(run.workspace, 'made.ts'))).toBe(false);
    expect((await editHook.payloads())[0]).toMatchObject({ tool_name: 'Write', tool_input: { file_path: path.join(run.workspace, 'made.ts'), content: 'x' } });
  });

  it('a failed hook without JSON blocks nothing and is reported, and a timed-out hook decides nothing', async () => {
    const use = { id: 'tu_echo', name: 'bash', input: { command: 'echo still-ran' } };
    const run = await scripted(wire, [call('', [use]), say('Done.')]);
    const failed = await hookScript(run, 'failed', { stdout: 'not json', stderr: 'boom', code: 1 });
    const slow = await hookScript(run, 'slow', { before: 'sleep 30', stdout: deny('too late') });
    await userHooks(run, { PreToolUse: [...group(failed.command), ...group(slow.command, { timeout: 1 })] });

    const result = await run.cli(agent(run.workspace, 'Go'));
    expect(resultOf(run, 'tu_echo')).toMatchObject({ error: false, text: expect.stringContaining('still-ran') });
    expect(result.stderr).toMatch(/PreToolUse:Bash hook error: .*failed\.sh.*: exit code 1: boom/);
    expect(result.stderr).toMatch(/PreToolUse:Bash hook error: .*slow\.sh.*: timed out after 1 s/);
  });

  it("runs a hook's updatedInput in place of the model's input, and the model reads what ran", async () => {
    const use = { id: 'tu_rewrite', name: 'bash', input: { command: 'echo original' } };
    const run = await scripted(wire, [call('', [use]), say('Done.')]);
    const hook = await hookScript(run, 'rewrite', { stdout: decide('allow', { updatedInput: { command: 'echo rewritten' } }) });
    await userHooks(run, { PreToolUse: group(hook.command, { matcher: 'Bash' }) });

    expect((await run.cli(agent(run.workspace, 'Go'))).code).toBe(0);
    const seen = resultOf(run, 'tu_rewrite')!;
    expect(seen.text).toContain('rewritten');
    expect(seen.text).not.toContain('original');
  });

  it('a hook ask in a run nobody can answer refuses the call with the reason', async () => {
    const use = { id: 'tu_ls', name: 'bash', input: { command: 'ls' } };
    const run = await scripted(wire, [call('', [use]), say('Done.')]);
    const hook = await hookScript(run, 'ask', { stdout: decide('ask', { permissionDecisionReason: 'Listing needs a look.' }) });
    await userHooks(run, { PreToolUse: group(hook.command) });

    expect((await run.cli(agent(run.workspace, 'Go'))).code).toBe(0);
    expect(resultOf(run, 'tu_ls')).toMatchObject({ error: true, text: expect.stringContaining('A PreToolUse hook [settings] asks first: Listing needs a look.') });
    expect(resultOf(run, 'tu_ls')!.text).not.toContain('a.ts');
  });

  it("a subagent's calls meet the session's PreToolUse hooks, named by agent_id and agent_type", async () => {
    const explore = call('', [{ id: 'tu_agent', name: 'agent', input: { agent: 'explore', task: 'Where is alpha defined?' } }]);
    const grep = call('', [{ id: 'tu_grep', name: 'grep', input: { pattern: 'alpha' } }]);
    const files = { 'a.ts': 'export const alpha = 1;\n', '.gcode.json': `${JSON.stringify({ agentTool: ['non-interactive'] })}\n` };
    const run = await scripted(wire, [explore, grep, report('The search was blocked.'), say('I could not search.')], files);
    const hook = await hookScript(run, 'grep', { stdout: deny('No searching in this repository.') });
    await userHooks(run, { PreToolUse: group(hook.command, { matcher: 'Grep' }) });

    const result = await run.cli(agent(run.workspace, 'Where is alpha defined?'));
    expect(result.code).toBe(0);
    expect(resultOf(run, 'tu_grep')).toEqual({ id: 'tu_grep', error: true, text: `${GENO_NOTE} PreToolUse:Grep hook error: No searching in this repository.` });
    const [payload] = await hook.payloads();
    expect(payload).toMatchObject({ session_id: sessionIdOf(result.stdout), tool_name: 'Grep', tool_input: { pattern: 'alpha' }, agent_type: 'explore', agent_id: expect.any(String) });
    expect(payload!['agent_id'], "the child's own session").not.toBe(sessionIdOf(result.stdout));
  });
});

describe.each(WIRES)('UserPromptSubmit on the %s wire', (wire: Wire) => {
  it("T-HOOK-02 T-HOOK-10 a hook's context follows the prompt in Claude Code's words, and a resumed session sends the same bytes", async () => {
    const run = await scripted(wire, [say('Ready.'), say('Again.')]);
    const context = await hookScript(run, 'context', { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'The secret word is BANANA.' } }) });
    const plain = await hookScript(run, 'plain', { stdout: 'Branch: main.' });
    await userHooks(run, { UserPromptSubmit: [...group(context.command), ...group(plain.command)] });

    const started = await run.cli(agent(run.workspace, 'What is the secret word?'));
    expect(started.code).toBe(0);
    expect((await context.payloads())[0]).toEqual({
      session_id: sessionIdOf(started.stdout),
      transcript_path: expect.stringMatching(/\.jsonl$/),
      cwd: run.workspace,
      permission_mode: 'dontAsk',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'What is the secret word?',
    });
    const first = run.seen()[0]!.text;
    const banana = `${GENO_NOTE} UserPromptSubmit hook additional context: The secret word is BANANA.`;
    const branch = `${GENO_NOTE} UserPromptSubmit hook success: Branch: main.`;
    expect(first).toContain(banana);
    expect(first).toContain(branch);
    expect(first.indexOf('What is the secret word?')).toBeLessThan(first.indexOf(banana));
    expect(run.openings()[0]!.system).not.toContain('BANANA');

    expect((await run.cli(resume(sessionIdOf(started.stdout), 'Once more'))).code).toBe(0);
    const [opened, resumed] = run.openings();
    expect(resumed!.first, 'the resumed session opens with the same bytes').toBe(opened!.first);
    const again = run.seen()[1]!.text;
    expect(again.indexOf('Once more')).toBeLessThan(again.lastIndexOf(banana));
    expect(again.endsWith(branch)).toBe(true);
  });

  it('T-HOOK-02 a block keeps the prompt from the model and tells the user why; the next prompt goes without it', async () => {
    const run = await scripted(wire, [say('Hello there.')]);
    const hook = await hookScript(run, 'gate', { before: `case "$in" in *'drop the database'*) echo 'No database talk here.' >&2; exit 2;; esac` });
    await userHooks(run, { UserPromptSubmit: group(hook.command) });

    const blocked = await run.cli(agent(run.workspace, 'Please drop the database'));
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain('A UserPromptSubmit hook blocked this prompt, so the model did not see it: No database talk here.');
    expect(run.seen()).toHaveLength(0);

    expect((await run.cli(resume(sessionIdOf(blocked.stdout), 'Say hello'))).code).toBe(0);
    expect(run.seen()).toHaveLength(1);
    expect(JSON.stringify(run.bodies()[0])).not.toContain('drop the database');
  });
});

type Asked = { readonly mode: SessionMode; readonly answers?: readonly PermissionAnswer[]; readonly files?: Readonly<Record<string, string>>; readonly deny?: string };

/** One agent run in an editor's mode with the user's hooks, the user answering each card from `answers`. */
async function interactive(wire: Wire, script: readonly ScriptedTurn[], hooks: (run: Run) => Promise<object>, { mode, answers = [], files, deny: denied }: Asked) {
  const run = await scripted(wire, script, files);
  await userHooks(run, await hooks(run));
  if (denied !== undefined) await permissionStore(homeOf(run.store), run.workspace).add('deny', denied.split(' ') as unknown as CommandPattern);
  const asked: Denial[] = [];
  const pending = [...answers];
  const approval: Approval = {
    kind: 'interactive',
    mode: () => mode,
    approve: async (denial) => {
      asked.push(denial);
      return pending.shift() ?? 'reject';
    },
    classify: async () => {
      throw new Error('a hook allow or ask never reaches the classifier here');
    },
    auto: freshAuto(),
  };
  const opened = await startSession(run.store, run.io, { workspace: run.workspace, provider: undefined, model: undefined, effort: undefined });
  const { events } = await runAgent(run.io, run.store, opened, 'Go.', { limits: { maxTurns: 6, maxCostUsd: 1 }, check: undefined, checkAfterEdit: false, approval, hooks: new HookSessions() });
  // A no ends the turn, so the model never reads that call's result: the log has it.
  const logged = (id: string) => events.find((e): e is Extract<TurnEvent, { kind: 'tool-result' }> => e.kind === 'tool-result' && e.toolUseId === id);
  return { run, asked, logged };
}

const always = (decision: string) => async (run: Run) => ({ PreToolUse: group((await hookScript(run, decision, { stdout: decide(decision, { permissionDecisionReason: `The hook says ${decision}.` }) })).command) });

describe.each(WIRES)('a PreToolUse hook and the permission checks on the %s wire', (wire: Wire) => {
  it("T-PERM-05 a hook's allow answers a command's question but never beats a deny rule or the secret-path rule", async () => {
    const cloud = { id: 'tu_cloud', name: 'bash', input: { command: 'kubectl get pods' } };
    const ruled = { id: 'tu_publish', name: 'bash', input: { command: 'pnpm publish' } };
    const secret = { id: 'tu_cat', name: 'bash', input: { command: 'cat .env' } };
    const read = { id: 'tu_read', name: 'read', input: { path: '.env' } };
    const { run, asked } = await interactive(wire, [call('', [cloud, ruled, secret, read]), say('Done.')], always('allow'), {
      mode: 'ask',
      answers: ['allow', 'allow'],
      files: { '.env': 'API_KEY=sk-live-0123456789abcdef\n', 'a.ts': 'export const a = 1;\n' },
      deny: 'pnpm publish',
    });
    expect(asked.map((card) => [card.rule, card.command])).toEqual([
      ['secret-path', 'cat .env'],
      ['secret-path', 'read .env'],
    ]);
    expect(resultOf(run, 'tu_cloud')!.text, 'the cloud CLI ran without a question').not.toMatch(/denied|rejected/);
    expect(resultOf(run, 'tu_publish')).toMatchObject({ error: true, text: expect.stringContaining('matches the workspace rule that denies `pnpm publish`') });
  });

  it('T-PERM-12 an allow never opens a path outside the workspace, nor the sandbox', async () => {
    const outside = { id: 'tu_outside', name: 'bash', input: { command: 'cat ../outside.txt' } };
    const readOut = { id: 'tu_read_out', name: 'read', input: { path: '/etc/hosts' } };
    const escape = { id: 'tu_escape', name: 'bash', input: { command: `node -e "require('fs').writeFileSync(require('os').homedir() + '/escaped.txt', 'x')"` } };
    // The user's no to the outside path ends the turn, so it goes last.
    const { run, asked, logged } = await interactive(wire, [call('', [readOut, escape, outside]), say('Done.')], always('allow'), { mode: 'ask' });
    expect(asked.map((card) => [card.rule, card.command]), 'the outside path still asks').toEqual([['path-outside-workspace', 'cat ../outside.txt']]);
    expect(logged('tu_read_out')).toMatchObject({ status: 'error', output: expect.stringContaining('outside the workspace') });
    expect(existsSync(path.join(run.env['HOME']!, 'escaped.txt')), 'the sandbox still holds the write').toBe(false);
  });

  it("an allow never skips an edit's read-before-edit check", async () => {
    const edit = { id: 'tu_edit', name: 'edit', input: { path: 'a.ts', old_str: '1', new_str: '2' } };
    const { run } = await interactive(wire, [call('', [edit]), say('Done.')], always('allow'), { mode: 'ask' });
    expect(resultOf(run, 'tu_edit')).toMatchObject({ error: true, text: expect.stringContaining('read a.ts before editing it') });
    expect(await readFile(path.join(run.workspace, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it("a hook's ask puts a card before a call that asks nobody, in Auto too, and a no turns it down", async () => {
    const make = { id: 'tu_make', name: 'edit', input: { path: 'made.ts', new_str: 'x', create: true } };
    const { run, asked, logged } = await interactive(wire, [call('', [make]), say('Stopped.')], always('ask'), { mode: 'auto', answers: ['reject'] });
    expect(asked).toEqual([{ rule: 'hook-ask', reason: 'A PreToolUse hook [settings] asks first: The hook says ask.', command: 'edit made.ts', verdict: 'ask' }]);
    expect(logged('tu_make')).toMatchObject({ status: 'rejected', output: expect.stringContaining('The user rejected') });
    expect(existsSync(path.join(run.workspace, 'made.ts'))).toBe(false);
  });

  it("a yes to a hook's ask runs the call, and counts as the command's own answer", async () => {
    const cloud = { id: 'tu_cloud', name: 'bash', input: { command: 'kubectl get pods' } };
    const { run, asked } = await interactive(wire, [call('', [cloud]), say('Done.')], always('ask'), { mode: 'ask', answers: ['allow'] });
    expect(asked.map((card) => card.rule), 'one card, not a second for the cloud CLI').toEqual(['hook-ask']);
    expect(resultOf(run, 'tu_cloud')!.text).not.toMatch(/denied|rejected/);
  });
});
