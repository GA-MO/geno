import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { GENO_NOTE, HOOKS_METHOD, WORKSPACE_TRUST_CAPABILITY, type CommandPattern, type Denial, type HooksResponse, type SessionMode, type TurnEvent } from '@g-code/core';
import { runAgent } from '../../src/agent.js';
import { startSession } from '../../src/chat.js';
import { HookSessions } from '../../src/hooks.js';
import { permissionStore } from '../../src/permissions.js';
import { gcodeAgent } from '../../src/serve.js';
import { homeOf } from '../../src/store.js';
import { type Approval, type PermissionAnswer } from '../../src/tools/agent.js';
import { call, report, say, scripted, sessionIdOf, WIRES, type Turn, type Wire } from './scripted.js';

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
      ['Stop', 'notify', 'runs'],
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
    const uses = ['one', 'two', 'three'].map((word) => ({ id: `tu_${word}`, name: 'bash', input: { command: `node -e "require('fs').appendFileSync('order.txt', '${word}\\n')"` } }));
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
      tool_input: { command: `node -e "require('fs').appendFileSync('order.txt', 'one\\n')"` },
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
    const use = { id: 'tu_ls', name: 'bash', input: { command: 'ls -t' } };
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
async function interactive(wire: Wire, script: readonly Turn[], hooks: (run: Run) => Promise<object>, { mode, answers = [], files, deny: denied }: Asked) {
  const run = await scripted(wire, script, files);
  await userHooks(run, await hooks(run));
  if (denied !== undefined) await permissionStore(homeOf(run.store), run.workspace).add({ effect: 'deny', pattern: denied.split(' ') as unknown as CommandPattern });
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
    const secret = { id: 'tu_cat', name: 'bash', input: { command: 'cat -v .env' } };
    const read = { id: 'tu_read', name: 'read', input: { path: '.env' } };
    const { run, asked } = await interactive(wire, [call('', [cloud, ruled, secret, read]), say('Done.')], always('allow'), {
      mode: 'ask',
      answers: ['allow', 'allow'],
      files: { '.env': 'API_KEY=sk-live-0123456789abcdef\n', 'a.ts': 'export const a = 1;\n' },
      deny: 'pnpm publish',
    });
    expect(asked.map((card) => [card.rule, card.command])).toEqual([
      ['secret-path', 'cat -v .env'],
      ['secret-path', 'read .env'],
    ]);
    expect(resultOf(run, 'tu_cloud')!.text, 'the cloud CLI ran without a question').not.toMatch(/denied|rejected/);
    expect(resultOf(run, 'tu_publish')).toMatchObject({ error: true, text: expect.stringContaining('matches the workspace rule that denies `pnpm publish`') });
  });

  it('T-PERM-12 an allow never opens a path outside the workspace, nor the sandbox', async () => {
    const outside = { id: 'tu_outside', name: 'bash', input: { command: 'cat -v ../outside.txt' } };
    const readOut = { id: 'tu_read_out', name: 'read', input: { path: '/etc/hosts' } };
    const escape = { id: 'tu_escape', name: 'bash', input: { command: `node -e "require('fs').writeFileSync(require('os').homedir() + '/escaped.txt', 'x')"` } };
    // The user's no to the outside path ends the turn, so it goes last.
    const { run, asked, logged } = await interactive(wire, [call('', [escape, readOut, outside]), say('Done.')], always('allow'), { mode: 'ask', answers: ['allow'] });
    expect(asked.map((card) => [card.rule, card.command]), 'the outside paths still ask').toEqual([
      ['path-outside-workspace', `read ${realpathSync('/etc/hosts')}`],
      ['path-outside-workspace', 'cat -v ../outside.txt'],
    ]);
    expect(logged('tu_read_out')).toMatchObject({ status: 'ok', approval: expect.objectContaining({ decidedBy: 'user' }) });
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

const context = (event: string, text: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
const common = (stdout: string, event: string) => ({
  session_id: sessionIdOf(stdout),
  transcript_path: expect.stringMatching(/\.jsonl$/),
  cwd: expect.any(String),
  permission_mode: 'dontAsk',
  hook_event_name: event,
});

describe.each(WIRES)('after-tool hooks on the %s wire', (wire: Wire) => {
  it("T-HOOK-03 PostToolUse runs after Geno's check with Claude Code's payload, and its context ends the result, the same bytes on resume", async () => {
    const write = { id: 'tu_write', name: 'edit', input: { path: 'made.ts', new_str: 'export const b = 2;\n', create: true } };
    const run = await scripted(wire, [call('', [write]), say('Done.'), say('Again.')]);
    const hook = await hookScript(run, 'post', { stdout: context('PostToolUse', 'Formatted made.ts.') });
    const bashOnly = await hookScript(run, 'bash-only');
    await userHooks(run, { PostToolUse: [...group(hook.command, { matcher: 'Edit|Write' }), ...group(bashOnly.command, { matcher: 'Bash' })] });

    const result = await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', '--check', 'true', 'Make b']);
    expect(result.code).toBe(0);
    const file = path.join(run.workspace, 'made.ts');
    expect(await hook.payloads()).toEqual([
      {
        ...common(result.stdout, 'PostToolUse'),
        cwd: run.workspace,
        tool_name: 'Write',
        tool_input: { file_path: file, content: 'export const b = 2;\n' },
        tool_response: { type: 'create', filePath: file, content: 'export const b = 2;\n' },
        tool_use_id: 'tu_write',
        duration_ms: expect.any(Number),
      },
    ]);
    expect(await bashOnly.payloads(), 'a Bash matcher does not fire on an edit').toEqual([]);
    const note = `${GENO_NOTE} PostToolUse:Write hook additional context: Formatted made.ts.`;
    const seen = resultOf(run, 'tu_write')!;
    expect(seen.error).toBe(false);
    expect(seen.text.indexOf('check `true` passed'), "Geno's check comes first").toBeGreaterThan(-1);
    expect(seen.text.indexOf('check `true` passed')).toBeLessThan(seen.text.indexOf(note));
    expect(seen.text.endsWith(note)).toBe(true);

    expect((await run.cli(resume(sessionIdOf(result.stdout), 'Once more'))).code).toBe(0);
    expect(JSON.stringify(run.bodies()[2]), 'a resumed session sends the hook text again').toContain(JSON.stringify(note).slice(1, -1));
    expect(await hook.payloads(), 'the resume runs no hook for the old call').toHaveLength(1);
  });

  it('T-HOOK-04 a command that exits non-zero fires PostToolUseFailure, not PostToolUse, with the error', async () => {
    const failing = { id: 'tu_fail', name: 'bash', input: { command: 'cat -v definitely-missing.txt' } };
    const fine = { id: 'tu_fine', name: 'bash', input: { command: 'echo fine' } };
    const run = await scripted(wire, [call('', [failing, fine]), say('Done.')]);
    const post = await hookScript(run, 'post');
    const failure = await hookScript(run, 'failure', { stdout: context('PostToolUseFailure', 'That file was never made; read the README.') });
    await userHooks(run, { PostToolUse: group(post.command, { matcher: 'Bash' }), PostToolUseFailure: group(failure.command, { matcher: 'Bash' }) });

    const result = await run.cli(agent(run.workspace, 'Go'));
    expect(result.code).toBe(0);
    expect((await post.payloads()).map((p) => p['tool_use_id'])).toEqual(['tu_fine']);
    expect(await failure.payloads()).toEqual([
      {
        ...common(result.stdout, 'PostToolUseFailure'),
        cwd: run.workspace,
        tool_name: 'Bash',
        tool_input: { command: 'cat -v definitely-missing.txt' },
        tool_use_id: 'tu_fail',
        error: expect.stringMatching(/^Exit code 1\n.*definitely-missing\.txt/s),
        is_interrupt: false,
        duration_ms: expect.any(Number),
      },
    ]);
    expect((await post.payloads())[0]).toMatchObject({ tool_response: { stdout: expect.stringContaining('fine'), stderr: '', interrupted: false, isImage: false } });
    const failed = resultOf(run, 'tu_fail')!;
    expect(failed.error).toBe(true);
    expect(failed.text.endsWith(`${GENO_NOTE} PostToolUseFailure:Bash hook additional context: That file was never made; read the README.`)).toBe(true);
  });

  it('a call a PreToolUse hook refused fires neither after-tool event', async () => {
    const use = { id: 'tu_no', name: 'bash', input: { command: 'echo refused' } };
    const run = await scripted(wire, [call('', [use]), say('Done.')]);
    const pre = await hookScript(run, 'pre', { stderr: 'not today', code: 2 });
    const post = await hookScript(run, 'post');
    await userHooks(run, { PreToolUse: group(pre.command), PostToolUse: group(post.command), PostToolUseFailure: group(post.command) });

    expect((await run.cli(agent(run.workspace, 'Go'))).code).toBe(0);
    expect(await post.payloads()).toEqual([]);
  });

  it('B/B-109 PostToolBatch runs once per batch with every call, and its context follows the results', async () => {
    const uses = ['one', 'two', 'three'].map((word) => ({ id: `tu_${word}`, name: 'bash', input: { command: `echo ${word}` } }));
    const read = { id: 'tu_read', name: 'read', input: { path: 'a.ts' } };
    const run = await scripted(wire, [call('', uses), call('', [read]), say('Done.')]);
    const batch = await hookScript(run, 'batch', { stdout: context('PostToolBatch', 'Run the tests before you finish.') });
    await userHooks(run, { PostToolBatch: group(batch.command) });

    const result = await run.cli(agent(run.workspace, 'Go'));
    expect(result.code).toBe(0);
    const [first, second] = await batch.payloads();
    expect(first).toEqual({
      ...common(result.stdout, 'PostToolBatch'),
      cwd: run.workspace,
      tool_calls: uses.map(({ id, input }) => ({ tool_name: 'Bash', tool_input: input, tool_use_id: id, tool_response: expect.objectContaining({ stdout: expect.stringContaining(input.command.slice(5)) }) })),
    });
    expect(second).toMatchObject({ tool_calls: [{ tool_name: 'Read', tool_input: { file_path: path.join(run.workspace, 'a.ts') }, tool_use_id: 'tu_read', tool_response: expect.stringContaining('export const a') }] });
    expect(await batch.payloads()).toHaveLength(2);
    const note = `${GENO_NOTE} PostToolBatch hook additional context: Run the tests before you finish.`;
    expect(run.seen()[1]!.results.map((r) => r.id)).toEqual(['tu_one', 'tu_two', 'tu_three']);
    expect(run.seen()[1]!.text).toContain(note);
    expect(run.seen()[1]!.results.some((r) => r.text.includes(note)), 'the batch note is not part of any one result').toBe(false);
  });

  it('B/B-109 a PostToolBatch block stops the loop before the next model call, and the model reads why when the session goes on', async () => {
    const use = { id: 'tu_echo', name: 'bash', input: { command: 'echo ran' } };
    const run = await scripted(wire, [call('', [use]), say('Picked up.')]);
    const batch = await hookScript(run, 'batch', { stderr: 'Tests are red.', code: 2 });
    await userHooks(run, { PostToolBatch: group(batch.command) });

    const stopped = await run.cli(agent(run.workspace, 'Go'));
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain('A PostToolBatch hook stopped the turn: Tests are red.');
    expect(run.seen(), 'the model is not called after the batch').toHaveLength(1);

    await writeFile(path.join(run.env['HOME']!, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    expect((await run.cli(resume(sessionIdOf(stopped.stdout), 'Go on'))).code).toBe(0);
    const next = run.seen()[1]!;
    expect(next.results.map((r) => r.id)).toEqual(['tu_echo']);
    expect(next.text).toContain(`${GENO_NOTE} PostToolBatch hook blocking error: Tests are red.`);
    expect(next.text.endsWith('Go on')).toBe(true);
  });

  it("a subagent's calls fire the session's PostToolUse hooks with agent_id and agent_type", async () => {
    const explore = call('', [{ id: 'tu_agent', name: 'agent', input: { agent: 'explore', task: 'Where is alpha defined?' } }]);
    const grep = call('', [{ id: 'tu_grep', name: 'grep', input: { pattern: 'alpha' } }]);
    const files = { 'a.ts': 'export const alpha = 1;\n', '.gcode.json': `${JSON.stringify({ agentTool: ['non-interactive'] })}\n` };
    const run = await scripted(wire, [explore, grep, report('In a.ts.'), say('alpha is in a.ts.')], files);
    const post = await hookScript(run, 'post');
    const stop = await hookScript(run, 'stop');
    await userHooks(run, { PostToolUse: group(post.command, { matcher: 'Grep' }), Stop: group(stop.command) });

    const result = await run.cli(agent(run.workspace, 'Where is alpha defined?'));
    expect(result.code).toBe(0);
    const [payload] = await post.payloads();
    expect(payload).toMatchObject({ session_id: sessionIdOf(result.stdout), tool_name: 'Grep', tool_use_id: 'tu_grep', agent_type: 'explore', agent_id: expect.any(String) });
    expect(payload!['agent_id']).not.toBe(sessionIdOf(result.stdout));
    expect((await stop.payloads()).map((p) => p['last_assistant_message']), "Stop runs for the session's model only; a subagent's end fires SubagentStop").toEqual(['alpha is in a.ts.']);
  });
});

describe.each(WIRES)('Stop on the %s wire', (wire: Wire) => {
  it('T-LOOP-03 end_turn ends the turn and runs Stop with the last message and stop_hook_active', async () => {
    const run = await scripted(wire, [say('All done.')]);
    const stop = await hookScript(run, 'stop');
    await userHooks(run, { Stop: group(stop.command) });

    const result = await run.cli(agent(run.workspace, 'Finish'));
    expect(result.code).toBe(0);
    expect(await stop.payloads()).toEqual([{ ...common(result.stdout, 'Stop'), cwd: run.workspace, stop_hook_active: false, last_assistant_message: 'All done.' }]);
  });

  it('B/B-114 a Stop block keeps the turn going once with the reason; a second block in a row ends the turn', async () => {
    const run = await scripted(wire, [say('All done.'), say('Really done.')]);
    const stop = await hookScript(run, 'stop', { stderr: 'Run the tests first.', code: 2 });
    await userHooks(run, { Stop: group(stop.command) });

    const result = await run.cli(agent(run.workspace, 'Finish'));
    expect(result.code).toBe(0);
    expect((await stop.payloads()).map((p) => [p['stop_hook_active'], p['last_assistant_message']])).toEqual([
      [false, 'All done.'],
      [true, 'Really done.'],
    ]);
    expect(run.seen(), 'the model is called once more, not in a loop').toHaveLength(2);
    expect(run.seen()[1]!.text).toBe(`${GENO_NOTE} Stop hook blocking error: Run the tests first.`);
    expect(result.stderr).toContain('Stop hook blocked the end of the turn again');
  });

  it('B/B-114 a block counts again once the model called a tool, and a hook that reads stop_hook_active lets it stop', async () => {
    const test = { id: 'tu_test', name: 'bash', input: { command: 'echo tests pass' } };
    const run = await scripted(wire, [say('Done.'), call('', [test]), say('Tests pass.'), say('Final.')]);
    const always = await hookScript(run, 'always', { stderr: 'Run the tests first.', code: 2 });
    await userHooks(run, { Stop: group(always.command) });
    expect((await run.cli(agent(run.workspace, 'Finish'))).code).toBe(0);
    expect(run.seen()).toHaveLength(4);
    expect((await always.payloads()).map((p) => p['last_assistant_message'])).toEqual(['Done.', 'Tests pass.', 'Final.']);

    const polite = await scripted(wire, [say('Done.'), say('Done, really.')]);
    // The guard Claude Code's hooks reference recommends.
    const guard = await hookScript(polite, 'guard', { before: `case "$in" in *'"stop_hook_active":true'*) exit 0;; esac\necho 'Run the tests first.' >&2\nexit 2` });
    await userHooks(polite, { Stop: group(guard.command) });
    const ended = await polite.cli(agent(polite.workspace, 'Finish'));
    expect(ended.code).toBe(0);
    expect(polite.seen()).toHaveLength(2);
    expect(ended.stderr).not.toContain('again');
  });

  it('runs the phone notice example of docs/hooks.md as written, and the turn ends', async () => {
    const run = await scripted(wire, [say('All done.')]);
    const doc = await readFile(new URL('../../../../docs/hooks.md', import.meta.url), 'utf8');
    const settings = /```json\n([\s\S]*?)```/.exec(doc.slice(doc.indexOf('## Example: a phone notice')))![1]!;
    const bin = path.join(run.env['HOME']!, 'bin');
    await mkdir(bin, { recursive: true });
    const sent = path.join(run.env['HOME']!, 'curl-args.txt');
    await writeFile(path.join(bin, 'curl'), `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >> '${sent}'; done\n`);
    await chmod(path.join(bin, 'curl'), 0o755);
    run.env['PATH'] = `${bin}:${run.env['PATH']}`;
    await writeFile(path.join(run.env['GCODE_HOME']!, 'settings.json'), settings);

    const result = await run.cli(agent(run.workspace, 'Finish'));
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('hook error');
    expect((await readFile(sent, 'utf8')).split('\n').filter(Boolean)).toEqual(['-s', '-d', `Geno finished in ${path.basename(run.workspace)}`, 'https://ntfy.sh/my-geno-topic-4f7a']);
    expect(run.seen()).toHaveLength(1);
  });

  it('T-HOOK-01 the events of a turn fire in order: SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolBatch, Stop, SessionEnd', async () => {
    const echo = { id: 'tu_echo', name: 'bash', input: { command: 'echo hi' } };
    const kube = { id: 'tu_kube', name: 'bash', input: { command: 'kubectl get pods' } };
    const run = await scripted(wire, [call('', [echo, kube]), say('Done.')]);
    const hook = await hookScript(run, 'all');
    const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Stop', 'SessionEnd'];
    await userHooks(run, Object.fromEntries(events.map((event) => [event, group(hook.command)])));

    expect((await run.cli(agent(run.workspace, 'Go'))).code).toBe(0);
    // As in Claude Code's E34: every PreToolUse first, then each call's card or result in call order.
    expect((await hook.payloads()).map((p) => p['hook_event_name'])).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'PostToolBatch', 'Stop', 'SessionEnd']);
  });
});

const answerCard = (decision: object) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
const kubectl = { id: 'tu_kube', name: 'bash', input: { command: 'kubectl get pods' } };

describe.each(WIRES)('PermissionRequest on the %s wire', (wire: Wire) => {
  it("T-HOOK-05 answers a card in a run nobody can answer, with Geno's offered rule as permission_suggestions", async () => {
    const run = await scripted(wire, [call('', [kubectl]), say('Done.')]);
    const hook = await hookScript(run, 'answer', { stdout: answerCard({ behavior: 'allow' }) });
    await userHooks(run, { PermissionRequest: group(hook.command, { matcher: 'Bash' }) });

    const result = await run.cli(agent(run.workspace, 'List the pods'));
    expect(result.code).toBe(0);
    expect(await hook.payloads()).toEqual([
      {
        ...common(result.stdout, 'PermissionRequest'),
        cwd: run.workspace,
        tool_name: 'Bash',
        tool_input: { command: 'kubectl get pods' },
        permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'kubectl get pods' }], behavior: 'allow', destination: 'localSettings' }],
      },
    ]);
    expect(resultOf(run, 'tu_kube')!.text, 'the command ran, though no kubectl is installed').not.toMatch(/denied/);
  });

  it("refuses with the hook's message, and never asks the hook about a deny rule's refusal or a call that needs no card", async () => {
    const publish = { id: 'tu_publish', name: 'bash', input: { command: 'pnpm publish' } };
    const ls = { id: 'tu_ls', name: 'bash', input: { command: 'ls -t' } };
    const run = await scripted(wire, [call('', [kubectl, publish, ls]), say('Done.')]);
    await permissionStore(homeOf(run.store), run.workspace).add({ effect: 'deny', pattern: ['pnpm', 'publish'] as unknown as CommandPattern });
    const hook = await hookScript(run, 'refuse', { stdout: answerCard({ behavior: 'deny', message: 'No cluster access from here.' }) });
    await userHooks(run, { PermissionRequest: group(hook.command) });

    expect((await run.cli(agent(run.workspace, 'Go'))).code).toBe(0);
    expect((await hook.payloads()).map((p) => (p['tool_input'] as { command: string }).command)).toEqual(['kubectl get pods']);
    expect(resultOf(run, 'tu_kube')).toMatchObject({ error: true, text: expect.stringContaining('A PermissionRequest hook answered for the user and refused it: No cluster access from here.') });
    expect(resultOf(run, 'tu_publish')).toMatchObject({ error: true, text: expect.stringContaining('matches the workspace rule that denies `pnpm publish`') });
    expect(resultOf(run, 'tu_ls')!.text).toContain('a.ts');
  });

  it("runs an allow's updatedInput in place of the call, and the model reads what ran", async () => {
    const run = await scripted(wire, [call('', [kubectl]), say('Done.')]);
    const hook = await hookScript(run, 'rewrite', { stdout: answerCard({ behavior: 'allow', updatedInput: { command: 'echo rewritten' } }) });
    await userHooks(run, { PermissionRequest: group(hook.command) });

    expect((await run.cli(agent(run.workspace, 'Go'))).code).toBe(0);
    expect(resultOf(run, 'tu_kube')!.text).toContain('rewritten');
    expect(await hook.payloads(), 'the new input asks no second card').toHaveLength(1);
  });

  it("answers a PreToolUse hook's ask in a run nobody can answer, after PreToolUse, as Claude Code orders them", async () => {
    const ls = { id: 'tu_ls', name: 'bash', input: { command: 'ls -t' } };
    const run = await scripted(wire, [call('', [ls]), say('Done.')]);
    const order = path.join(run.env['HOME']!, 'order.txt');
    const pre = await hookScript(run, 'pre', { stdout: decide('ask', { permissionDecisionReason: 'Listing needs a look.' }), before: `echo pre >> '${order}'` });
    const card = await hookScript(run, 'card', { stdout: answerCard({ behavior: 'allow' }), before: `echo card >> '${order}'` });
    await userHooks(run, { PreToolUse: group(pre.command), PermissionRequest: group(card.command) });

    expect((await run.cli(agent(run.workspace, 'Go'))).code).toBe(0);
    expect(resultOf(run, 'tu_ls')!.text).toContain('a.ts');
    expect((await readFile(order, 'utf8')).split('\n').filter(Boolean)).toEqual(['pre', 'card']);
  });

  it('answers the card in an editor before the user sees it, and a deny with interrupt ends the turn as a no does', async () => {
    const allowed = await interactive(wire, [call('', [kubectl]), say('Done.')], async (run) => ({ PermissionRequest: group((await hookScript(run, 'yes', { stdout: answerCard({ behavior: 'allow' }) })).command) }), { mode: 'ask' });
    expect(allowed.asked, 'the user saw no card').toEqual([]);
    expect(allowed.logged('tu_kube')).toMatchObject({ approval: { decidedBy: 'hook', verdict: 'allow' } });

    const stopped = await interactive(wire, [call('', [kubectl]), say('Stopped.')], async (run) => ({ PermissionRequest: group((await hookScript(run, 'stop', { stdout: answerCard({ behavior: 'deny', interrupt: true }) })).command) }), { mode: 'ask' });
    expect(stopped.asked).toEqual([]);
    expect(stopped.logged('tu_kube')).toMatchObject({ status: 'rejected', approval: { decidedBy: 'hook', verdict: 'deny', interrupt: true } });
  });

  it('runs the reset example of docs/hooks.md as written: the exact command runs, and a longer line stays refused', async () => {
    const reset = { id: 'tu_reset', name: 'bash', input: { command: 'git reset --hard' } };
    const chained = { id: 'tu_chained', name: 'bash', input: { command: 'git reset --hard && touch chained.out' } };
    const run = await scripted(wire, [call('', [reset]), call('', [chained]), say('Done.')]);
    const section = (await readFile(new URL('../../../../docs/hooks.md', import.meta.url), 'utf8')).split('## PermissionRequest')[1]!;
    const settings = /```json\n([\s\S]*?)```/.exec(section)![1]!;
    const script = /```sh\n([\s\S]*?)```/.exec(section)![1]!;
    await mkdir(path.join(run.env['HOME']!, 'bin'), { recursive: true });
    await writeFile(path.join(run.env['HOME']!, 'bin', 'allow-reset.sh'), script);
    await chmod(path.join(run.env['HOME']!, 'bin', 'allow-reset.sh'), 0o755);
    await writeFile(path.join(run.env['GCODE_HOME']!, 'settings.json'), settings);
    await writeFile(path.join(run.workspace, 'a.ts'), 'changed\n');

    const result = await run.cli(agent(run.workspace, 'Start over'));
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('hook error');
    expect(resultOf(run, 'tu_reset')!.text).not.toMatch(/denied/);
    expect(await readFile(path.join(run.workspace, 'a.ts'), 'utf8'), 'the reset ran').toBe('export const a = 1;\n');
    expect(resultOf(run, 'tu_chained')).toMatchObject({ error: true, text: expect.stringContaining('denied') });
    expect(existsSync(path.join(run.workspace, 'chained.out'))).toBe(false);
  });

  it('leaves a card without a decision to the user, and a Plan refusal to Plan', async () => {
    const asked = await interactive(wire, [call('', [kubectl]), say('Done.')], async (run) => ({ PermissionRequest: group((await hookScript(run, 'quiet', { code: 2, stderr: 'not a decision' })).command) }), { mode: 'ask', answers: ['allow'] });
    expect(asked.asked.map((card) => card.command), 'exit 2 decides nothing').toEqual(['kubectl get pods']);

    let hook: Awaited<ReturnType<typeof hookScript>> | undefined;
    const plan = await interactive(wire, [call('', [kubectl]), say('Done.')], async (run) => ({ PermissionRequest: group((hook = await hookScript(run, 'plan', { stdout: answerCard({ behavior: 'allow' }) })).command) }), { mode: 'plan' });
    expect(plan.logged('tu_kube')).toMatchObject({ status: 'denied' });
    expect(await hook!.payloads()).toEqual([]);
  });
});

const subagentFiles = { 'a.ts': 'export const alpha = 1;\n', '.gcode.json': `${JSON.stringify({ agentTool: ['non-interactive'] })}\n` };
const explore = call('', [{ id: 'tu_agent', name: 'agent', input: { agent: 'explore', task: 'Where is alpha defined?' } }]);

describe.each(WIRES)('SubagentStart and SubagentStop on the %s wire', (wire: Wire) => {
  it("B/B-112 SubagentStart names the child, and its context opens the child's first request before the task", async () => {
    const run = await scripted(wire, [explore, report('In a.ts.'), say('alpha is in a.ts.')], subagentFiles);
    const start = await hookScript(run, 'start', { stdout: context('SubagentStart', 'Search only under src.') });
    const other = await hookScript(run, 'other');
    await userHooks(run, { SubagentStart: [...group(start.command, { matcher: 'explore' }), ...group(other.command, { matcher: 'worker' })] });

    const result = await run.cli(agent(run.workspace, 'Where is alpha defined?'));
    expect(result.code).toBe(0);
    const [payload] = await start.payloads();
    expect(payload).toEqual({ ...common(result.stdout, 'SubagentStart'), cwd: run.workspace, agent_id: expect.any(String), agent_type: 'explore' });
    expect(payload!['agent_id'], "the child's own session").not.toBe(sessionIdOf(result.stdout));
    expect(await other.payloads(), 'the matcher reads agent_type').toEqual([]);
    const first = run.openings()[1]!.first;
    const note = `${GENO_NOTE} SubagentStart hook additional context: Search only under src.`;
    expect(first).toContain(note);
    expect(first.indexOf(note)).toBeLessThan(first.lastIndexOf('Where is alpha defined?'));
    expect(run.openings()[0]!.first, 'the parent never reads it').not.toContain('Search only under src.');
  });

  it('B/B-112 SubagentStart runs again when the parent resumes the child, and its context goes in only once', async () => {
    const run = await scripted(wire, [explore, report('In a.ts.'), say('alpha is in a.ts.')], subagentFiles);
    const start = await hookScript(run, 'start', { stdout: context('SubagentStart', 'Search only under src.') });
    await userHooks(run, { SubagentStart: group(start.command) });
    const first = await run.cli(agent(run.workspace, 'Where is alpha defined?'));
    const parentId = sessionIdOf(first.stdout);
    const childId = (await start.payloads())[0]!['agent_id'] as string;
    const load = call('', [{ id: 'tu_load', name: 'tool_search', input: { select: ['message_agent'] } }]);
    const message = call('', [{ id: 'tu_msg', name: 'message_agent', input: { agent_session: childId, text: 'And beta?' } }]);
    run.more(load, message, report('Not found.', 'tu_report_2'), say('No beta.'));
    expect((await run.cli(resume(parentId, 'And beta?'))).code).toBe(0);

    expect((await start.payloads()).map((p) => p['agent_id'])).toEqual([childId, childId]);
    const resumed = JSON.stringify(run.bodies()[5]!.messages);
    expect(resumed.split('SubagentStart hook additional context: Search only under src.').length - 1, 'the copy from the launch stays, and no second one joins it').toBe(1);
  });

  it("B/B-112 SubagentStop gets the child's report and transcript, and a block keeps the child going once", async () => {
    const run = await scripted(wire, [explore, report('In a.ts.', 'tu_r1'), report('In a.ts, line 1.', 'tu_r2'), say('alpha is in a.ts.')], subagentFiles);
    const stop = await hookScript(run, 'stop', { stderr: 'Name the line.', code: 2 });
    const parent = await hookScript(run, 'parent');
    await userHooks(run, { SubagentStop: group(stop.command, { matcher: 'explore' }), Stop: group(parent.command) });

    const result = await run.cli(agent(run.workspace, 'Where is alpha defined?'));
    expect(result.code).toBe(0);
    const payloads = await stop.payloads();
    expect(payloads[0]).toEqual({
      ...common(result.stdout, 'SubagentStop'),
      cwd: run.workspace,
      stop_hook_active: false,
      agent_id: expect.any(String),
      agent_type: 'explore',
      agent_transcript_path: expect.stringMatching(new RegExp(`${payloads[0]!['agent_id'] as string}\\.jsonl$`)),
      last_assistant_message: 'In a.ts.',
    });
    expect(existsSync(payloads[0]!['agent_transcript_path'] as string)).toBe(true);
    expect(payloads.map((p) => [p['stop_hook_active'], p['last_assistant_message']])).toEqual([
      [false, 'In a.ts.'],
      [true, 'In a.ts, line 1.'],
    ]);
    expect(run.seen()[2]!.text, "the child's next request").toContain(`${GENO_NOTE} SubagentStop hook blocking error: Name the line.`);
    expect(run.seen(), 'a second block in a row does not count').toHaveLength(4);
    expect(resultOf(run, 'tu_agent')!.text).toContain('In a.ts, line 1.');
    expect((await parent.payloads()).map((p) => p['last_assistant_message']), 'Stop runs for the parent only').toEqual(['alpha is in a.ts.']);
  });

  it("a subagent's card asks PermissionRequest with agent_id and agent_type", async () => {
    const kube = call('', [{ ...kubectl, id: 'tu_child_kube' }]);
    const worker = call('', [{ id: 'tu_agent', name: 'agent', input: { agent: 'worker', task: 'List the pods.' } }]);
    const run = await scripted(wire, [worker, kube, report('Listed.'), say('Done.')], subagentFiles);
    const hook = await hookScript(run, 'card', { stdout: answerCard({ behavior: 'deny', message: 'Children ask nothing.' }) });
    await userHooks(run, { PermissionRequest: group(hook.command) });

    const result = await run.cli([...agent(run.workspace, 'Go'), '--allow-worker']);
    expect(result.code).toBe(0);
    expect(await hook.payloads()).toEqual([expect.objectContaining({ tool_name: 'Bash', agent_type: 'worker', agent_id: expect.any(String) })]);
    expect(resultOf(run, 'tu_child_kube')!.text).toContain('Children ask nothing.');
  });
});
