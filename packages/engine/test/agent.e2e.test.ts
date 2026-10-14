import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_PROMPTS, AGENT_TOOL_DEFINITIONS, MODE_NOTICES, asSessionId, CLASSIFIER_TOOL, DEFERRED_TOOLS_NOTE, DENY_RULE_IDS, DENY_RULES, toolRoster, webToolDefinitions, type TurnEvent } from '@g-code/core';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, offeredTools, toolCall, type FakeToolUse } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand, runCli } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

async function setup(files: Record<string, string>) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = {
    GCODE_HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-parent-key-must-not-leak',
    DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
    FAKE_SECRET: 'fake-secret-must-not-leak',
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  return { workspace, env, store: openStore(env) };
}

const sessionIdOf = (stdout: string): string => /^session: (\S+)$/m.exec(stdout)![1]!;
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const ofKind = <K extends TurnEvent['kind']>(events: readonly TurnEvent[], kind: K) =>
  events.filter((e): e is Extract<TurnEvent, { kind: K }> => e.kind === kind);

let nextId = 0;
const use = (name: string, input: unknown): FakeToolUse => ({ id: `tu_${nextId++}`, name, input });
const bash = (command: string) => use('bash', { command });
const toolResult = (body: { messages: { content: { type: string; content?: string }[] }[] }): string =>
  body.messages.at(-1)!.content.find((block) => block.type === 'tool_result')!.content!;

/** A turn that ends with thinking alone, no text and no tool call (ISSUES.md G-03). */
const thinkingOnly = () => ({ events: answer('', usage).events.filter((e) => e['index'] !== 1) });

describe('gcode agent', () => {
  it('G-03 nudges once after a turn that ends with thinking alone, then takes the answer', async () => {
    const { workspace, env } = await setup({ 'a.ts': 'export const a = 1;\n' });
    const transport = fakeTransport([thinkingOnly(), answer('a is 1.', usage)]);
    const result = await runCli(['agent', '--workspace', workspace, '--non-interactive', 'What is a?'], env, { fetch: transport.fetch });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('a is 1.');
    expect(JSON.stringify(transport.requests[1]!.body.messages.at(-1))).toContain('ended with no text and no tool call');
  });

  it('G-03 ends the run as an error when the turn after the nudge is empty too', async () => {
    const { workspace, env } = await setup({ 'a.ts': 'export const a = 1;\n' });
    const transport = fakeTransport([thinkingOnly(), thinkingOnly()]);
    const result = await runCli(['agent', '--workspace', workspace, '--non-interactive', 'What is a?'], env, { fetch: transport.fetch });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ended its turn twice with no text and no tool call');
    expect(transport.requests).toHaveLength(2);
  });

  it('sends the project context loaded at session start, unchanged after the files change, on every turn', async () => {
    const { workspace, env, store } = await setup({
      'AGENTS.md': 'Run tests with pnpm test.\n',
      '.cursor/rules/ts.mdc': '---\nglobs: *.ts\n---\nNo default exports.\n',
      'a.ts': 'export const a = 1;\n',
    });
    const transport = fakeTransport([toolCall('Reading.', [use('read', { path: 'a.ts' })], usage), answer('Read it.', usage), answer('Again.', usage)]);
    const first = await runCli(['agent', '--workspace', workspace, '--non-interactive', 'Read a.ts'], env, { fetch: transport.fetch });
    expect(first.code).toBe(0);
    writeFileSync(path.join(workspace, 'AGENTS.md'), 'Changed after the session started.\n');
    const id = sessionIdOf(first.stdout);
    expect((await runCli(['agent', '--session', id, '--non-interactive', 'Once more'], env, { fetch: transport.fetch })).code).toBe(0);

    const opening = (i: number) => transport.requests[i]!.body.messages[0].content[0].text as string;
    expect(opening(0)).toContain('<project_instructions path="AGENTS.md">\nRun tests with pnpm test.\n\n</project_instructions>');
    expect(opening(0)).toContain('- .cursor/rules/ts.mdc (*.ts)');
    expect(transport.requests[0]!.body.system[0].text).toBe(`${AGENT_PROMPTS.rules}\n\n${DEFERRED_TOOLS_NOTE}`);
    expect(opening(2)).toBe(opening(0));
    expect(toolResult(transport.requests[1]!.body)).toContain('<project_rule path=".cursor/rules/ts.mdc" matched="a.ts">\nNo default exports.\n</project_rule>');
    const log = await readSessionLog(sessionFile(store, asSessionId(id)));
    expect(log.events[0]).toMatchObject({ kind: 'session-start', context: { instructions: [{ path: 'AGENTS.md', text: 'Run tests with pnpm test.\n' }] } });
  });

  it('edits two files across two turns, and rewind restores both byte for byte', async () => {
    const original = { 'a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' };
    const { workspace, env, store } = await setup(original);
    const files = ['a.ts', 'src/b.ts'].map((f) => path.join(workspace, f));
    const before = files.map(sha256);

    const transport = fakeTransport([
      toolCall('Reading.', [use('read', { path: 'a.ts' }), use('read', { path: 'src/b.ts' })], usage),
      toolCall('Editing a.', [use('edit', { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 10' })], usage),
      toolCall('Editing b.', [
        use('edit', { path: 'src/b.ts', old_str: 'b = 2', new_str: 'b = 20' }),
        use('edit', { path: 'src/c.ts', create: true, new_str: 'export const c = 3;\n' }),
      ], usage),
      answer('Done.', usage),
    ]);
    const result = await runCli(
      ['agent', '--workspace', workspace, '--non-interactive', '--check', 'grep -q "a = 10" a.ts', 'Bump the constants'],
      env,
      { fetch: transport.fetch },
    );
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(readFileSync(files[0]!, 'utf8')).toBe('export const a = 10;\n');
    expect(readFileSync(files[1]!, 'utf8')).toBe('export const b = 20;\n');
    expect(existsSync(path.join(workspace, 'src', 'c.ts'))).toBe(true);

    const [first] = transport.requests;
    expect(first!.body.tools).toEqual(toolRoster([...AGENT_TOOL_DEFINITIONS, ...webToolDefinitions(false)]).offered);
    expect(first!.body.system[0].text).toBe(`${AGENT_PROMPTS.rules}\n\n${DEFERRED_TOOLS_NOTE}`);

    const id = sessionIdOf(result.stdout);
    const log = await readSessionLog(sessionFile(store, asSessionId(id)));
    const checkpoints = ofKind(log.events, 'checkpoint');
    expect(checkpoints.map((c) => [c.turnSeq, c.files])).toEqual([
      [3, []],
      [7, []],
      [10, ['a.ts']],
      [14, ['src/b.ts', 'src/c.ts']],
    ]);
    for (const c of checkpoints) {
      expect(ofKind(log.events, 'assistant').some((a) => a.seq === c.turnSeq)).toBe(true);
    }
    const editResults = ofKind(log.events, 'tool-result').filter((r) => r.name === 'edit');
    expect(editResults.map((r) => ('output' in r ? r.output : ''))).toEqual([
      'Edited a.ts. The file state is current in your context; no need to read it back.\n\ncheck `grep -q "a = 10" a.ts` passed',
      'Edited src/b.ts. The file state is current in your context; no need to read it back.\n\ncheck `grep -q "a = 10" a.ts` passed',
      'Created src/c.ts. The file state is current in your context; no need to read it back.\n\ncheck `grep -q "a = 10" a.ts` passed',
    ]);

    const firstEditTurn = checkpoints[1]!.turnSeq;
    const rewound = await runCli(['rewind', '--session', id, '--to', String(firstEditTurn)], env);
    expect(rewound.code).toBe(0);
    expect(rewound.stdout).toContain('a.ts');
    const after = files.map(sha256);
    console.log(`sha256 before: ${before.join(' ')}`);
    console.log(`sha256 after rewind to turn ${firstEditTurn}: ${after.join(' ')}`);
    expect(after).toEqual(before);
    expect(existsSync(path.join(workspace, 'src', 'c.ts'))).toBe(false);

    const again = await runCli(['rewind', '--session', id, '--to', String(firstEditTurn)], env);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('no files changed');
    expect(files.map(sha256)).toEqual(before);
    const restored = ofKind((await readSessionLog(sessionFile(store, asSessionId(id)))).events, 'restored');
    expect(restored.map((r) => r.files)).toEqual([['a.ts', 'src/b.ts', 'src/c.ts'], []]);

    const missing = await runCli(['rewind', '--session', id, '--to', '4'], env);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('checkpoints exist before turns: 3, 7, 10, 14');
  });

  it('tells the next model call what a rewind restored', async () => {
    const { workspace, env } = await setup({ 'a.ts': 'export const a = 1;\n' });
    const transport = fakeTransport([
      toolCall('Reading.', [use('read', { path: 'a.ts' })], usage),
      toolCall('Editing.', [use('edit', { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 2' })], usage),
      answer('Done.', usage),
      answer('Noted.', usage),
    ]);
    const first = await runCli(['agent', '--workspace', workspace, '--non-interactive', 'Change a'], env, { fetch: transport.fetch });
    const id = sessionIdOf(first.stdout);
    expect((await runCli(['rewind', '--session', id, '--to', '6'], env)).code).toBe(0);
    const resumed = await runCli(['agent', '--session', id, '--non-interactive', 'What changed?'], env, { fetch: transport.fetch });
    expect(resumed.code).toBe(0);
    expect(transport.requests[3]!.body.messages.at(-1).content.map((b: { text: string }) => b.text)).toEqual([
      '[Geno] The user rewound the workspace to how it was before turn 6. These files were restored: a.ts. Read a file again before editing it.',
      'What changed?',
    ]);
  });

  it('refuses to edit a file the model has not read, and one that changed since it was read', async () => {
    const { workspace, env, store } = await setup({ 'a.ts': 'export const a = 1;\n' });
    const transport = fakeTransport([
      toolCall('Editing blind.', [use('edit', { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 2' })], usage),
      toolCall('Reading, then changing it behind my own back.', [
        use('read', { path: 'a.ts' }),
        bash(`node -e "require('fs').writeFileSync('a.ts', 'export const a = 5;\\n')"`),
        use('edit', { path: 'a.ts', old_str: 'a = 5', new_str: 'a = 6' }),
      ], usage),
      answer('Gave up.', usage),
    ]);
    const result = await runCli(['agent', '--workspace', workspace, '--non-interactive', 'Change a'], env, { fetch: transport.fetch });
    expect(result.code).toBe(0);
    const log = await readSessionLog(sessionFile(store, asSessionId(sessionIdOf(result.stdout))));
    const edits = ofKind(log.events, 'tool-result').filter((r) => r.name === 'edit');
    expect(edits.map((r) => [r.status, 'output' in r ? r.output : ''])).toEqual([
      ['error', 'read a.ts before editing it'],
      ['error', 'a.ts changed since it was last read; read it again before editing'],
    ]);
    expect(readFileSync(path.join(workspace, 'a.ts'), 'utf8')).toBe('export const a = 5;\n');
  });

  it('G-05 keeps the reads of an earlier run of a resumed session, and edits a file that changed since only as the change note told it', async () => {
    const { workspace, env, store } = await setup({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    const transport = fakeTransport([
      toolCall('Reading.', [use('read', { path: 'a.ts' }), use('read', { path: 'b.ts' })], usage),
      answer('Read both.', usage),
      toolCall('Editing.', [use('edit', { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 2' }), use('edit', { path: 'b.ts', old_str: 'b = 3', new_str: 'b = 4' })], usage),
      answer('Done.', usage),
    ]);
    const first = await runCli(['agent', '--workspace', workspace, '--non-interactive', 'Read a and b'], env, { fetch: transport.fetch });
    const id = sessionIdOf(first.stdout);
    writeFileSync(path.join(workspace, 'b.ts'), 'export const b = 3;\n');
    expect((await runCli(['agent', '--session', id, '--non-interactive', 'Change them'], env, { fetch: transport.fetch })).code).toBe(0);
    const log = await readSessionLog(sessionFile(store, asSessionId(id)));
    const edits = ofKind(log.events, 'tool-result').filter((r) => r.name === 'edit');
    expect(edits.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(ofKind(log.events, 'file-changed').map((e) => e.shown), 'the model heard of the change before it edited').toEqual(['b.ts']);
    expect(readFileSync(path.join(workspace, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(readFileSync(path.join(workspace, 'b.ts'), 'utf8')).toBe('export const b = 4;\n');
  });

  it('denies every deny-list rule without asking in non-interactive mode, and runs npx vitest run', async () => {
    const { workspace, env, store } = await setup({ 'a.ts': 'export const a = 1;\n' });
    const denied = [
      'rm -rf .git',
      'git push origin main',
      'git reset --hard HEAD',
      'git stash -u',
      'cat -v /etc/hosts',
      'curl https://example.com',
      'gcloud projects list',
      'psql -c "select 1"',
      'cat -v .env',
      'pkill -f gcode-e2e-no-such-process',
    ];
    const asked: string[] = [];
    const transport = fakeTransport([
      toolCall('Trying things.', [...denied.map(bash), bash('npx vitest run')], usage),
      answer('Done.', usage),
    ]);
    const result = await runCli(['agent', '--workspace', workspace, '--non-interactive', 'Try things'], env, {
      fetch: transport.fetch,
      confirm: (question) => {
        asked.push(question);
        return true;
      },
    });
    expect(result.code).toBe(0);
    expect(asked).toEqual([]);
    const log = await readSessionLog(sessionFile(store, asSessionId(sessionIdOf(result.stdout))));
    const results = ofKind(log.events, 'tool-result');
    expect(results.map((r) => r.status).slice(0, denied.length)).toEqual(denied.map(() => 'denied'));
    expect(results.slice(0, denied.length).map((r) => ('output' in r ? r.output.split(' uses ')[1]!.split(',')[0] : ''))).toEqual([
      'rm -rf of the workspace',
      'git push',
      'git reset --hard',
      'a git command that can lose uncommitted work: stash',
      'a path outside the workspace',
      'curl or wget',
      'a cloud CLI',
      'a database CLI',
      'a credentials file such as .env',
      'pkill',
    ]);
    expect(DENY_RULE_IDS.filter((rule) => DENY_RULES[rule].verdicts['non-interactive'] === 'deny')).toHaveLength(denied.length);
    const outside = results[denied.indexOf('cat -v /etc/hosts')]!;
    expect('output' in outside && outside.output, 'a path the user must allow invites no other tool (ISSUES.md P-06)').toContain('Do not reach that path another way');
    expect('output' in outside && outside.output).not.toContain('You *may* attempt');
    const vitest = results.at(-1)!;
    const [, code] = /\[exit code (\d+)\]$/.exec('output' in vitest ? vitest.output : '')!;
    expect(vitest.status).toBe(code === '0' ? 'ok' : 'error');
    expect(transport.requests[1]!.body.messages.at(-1).content[0]).toMatchObject({ is_error: true });
  });

  it('asks on the terminal in interactive mode and runs the command when the user says yes', async () => {
    const { workspace, env, store } = await setup({ 'a.ts': 'export const a = 1;\n' });
    const asked: string[] = [];
    const transport = fakeTransport([toolCall('Cleaning.', [bash('rm -rf .git')], usage), answer('Done.', usage)]);
    const result = await runCli(['agent', '--workspace', workspace, 'Clean up'], env, {
      fetch: transport.fetch,
      confirm: (question) => {
        asked.push(question);
        return true;
      },
    });
    expect(result.code).toBe(0);
    expect(asked).toEqual(['Allow `rm -rf .git`? It uses rm -rf of the workspace, its .git or a path outside it.']);
    const log = await readSessionLog(sessionFile(store, asSessionId(sessionIdOf(result.stdout))));
    expect(ofKind(log.events, 'tool-result')[0]).toMatchObject({ status: 'ok', output: '[exit code 0]' });
  });

  const deletes = ['rm -rf node_modules', 'd=$(mktemp -d); rm -rf "$d"'];

  it('asks before rm -rf inside the workspace in interactive mode, and keeps the folder when the user says no', async () => {
    const { workspace, env, store } = await setup({ 'a.ts': 'export const a = 1;\n', 'node_modules/pkg/index.js': 'module.exports = 1;\n' });
    const asked: string[] = [];
    const transport = fakeTransport([toolCall('Cleaning.', deletes.map(bash), usage), answer('Done.', usage)]);
    const result = await runCli(['agent', '--workspace', workspace, 'Clean up'], env, {
      fetch: transport.fetch,
      confirm: (question) => {
        asked.push(question);
        return false;
      },
    });
    expect(result.code).toBe(0);
    expect(asked).toEqual(['Allow `rm -rf node_modules`? It uses rm -rf of a path inside the workspace.']);
    expect(existsSync(path.join(workspace, 'node_modules/pkg/index.js'))).toBe(true);
    const log = await readSessionLog(sessionFile(store, asSessionId(sessionIdOf(result.stdout))));
    // The user's no ends the turn: the second delete does not run, and the model is not called again.
    expect(ofKind(log.events, 'tool-result').map((r) => r.status)).toEqual(['rejected', 'error']);
    expect(transport.requests).toHaveLength(1);
  });

  it('runs rm -rf inside the workspace without asking in non-interactive mode', async () => {
    const { workspace, env, store } = await setup({ 'a.ts': 'export const a = 1;\n', 'node_modules/pkg/index.js': 'module.exports = 1;\n' });
    const asked: string[] = [];
    const transport = fakeTransport([toolCall('Cleaning.', deletes.map(bash), usage), answer('Done.', usage)]);
    const result = await runCli(['agent', '--workspace', workspace, '--non-interactive', 'Clean up'], env, {
      fetch: transport.fetch,
      confirm: (question) => {
        asked.push(question);
        return false;
      },
    });
    expect(result.code).toBe(0);
    expect(asked).toEqual([]);
    expect(existsSync(path.join(workspace, 'node_modules'))).toBe(false);
    const log = await readSessionLog(sessionFile(store, asSessionId(sessionIdOf(result.stdout))));
    expect(ofKind(log.events, 'tool-result').map((r) => r.status)).toEqual(['ok', 'ok']);
  });

  it('runs bash with only PATH, HOME, LANG, TERM and TMPDIR from the parent environment', async () => {
    const { workspace, env, store } = await setup({ 'a.ts': 'export const a = 1;\n' });
    const transport = fakeTransport([toolCall('Looking.', [bash('env')], usage), answer('Done.', usage)]);
    const result = await runCli(['agent', '--workspace', workspace, '--non-interactive', 'Show env'], env, { fetch: transport.fetch });
    expect(result.code).toBe(0);
    const log = await readSessionLog(sessionFile(store, asSessionId(sessionIdOf(result.stdout))));
    const output = ofKind(log.events, 'tool-result')[0]!;
    expect(output.status).toBe('ok');
    const text = 'output' in output ? output.output : '';
    console.log(`env inside bash:\n${text}`);
    expect(text).toContain(`PATH=${env.PATH}`);
    for (const secret of ['sk-parent-key-must-not-leak', 'fake-secret-must-not-leak', 'DASHSCOPE', 'GCODE_HOME']) {
      expect(text).not.toContain(secret);
    }
  });
});

const verdict = (answer: 'allow' | 'ask' | 'deny', reason: string) =>
  toolCall('', [use(CLASSIFIER_TOOL.name, { verdict: answer, reason })], { input: 400, cacheRead: 0, cacheWrite: 0 });
const isClassifierCall = (request: { body: { tool_choice?: unknown } }) => request.body.tool_choice !== undefined;
const userText = (request: { body: { messages: { content: { text: string }[] }[] } }) =>
  request.body.messages[0]!.content.map((block) => block.text).join('');

describe('gcode agent --mode auto', () => {
  it('G-09 counts the classifier calls in the run cost and in gcode usage', async () => {
    const { workspace, env, store } = await setup({ 'a.ts': 'export const a = 1;\n' });
    const transport = fakeTransport([toolCall('One.', [bash('node -e "1"')], usage), verdict('allow', 'harmless'), answer('Done.', usage)]);
    const ran = await runCli(['agent', '--workspace', workspace, '--mode', 'auto', 'One'], env, { fetch: transport.fetch });
    expect(ran.code, ran.stderr).toBe(0);
    const id = sessionIdOf(ran.stdout);
    const events = (await readSessionLog(sessionFile(store, asSessionId(id)))).events;
    const classifier = ofKind(events, 'tool-result').reduce((sum, e) => sum + (e.approval?.classifier?.costUsd ?? 0), 0);
    const models = ofKind(events, 'assistant').reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
    expect(classifier).toBeGreaterThan(0);
    const spend = JSON.parse((await runCli(['usage', '--session', id, '--json'], env)).stdout) as { costUsd: number; classifierCostUsd: number };
    expect(spend.classifierCostUsd).toBeCloseTo(classifier, 10);
    expect(spend.costUsd).toBeCloseTo(models + classifier, 10);
    expect(ran.stdout).toContain(`cost=$${(models + classifier).toFixed(6)}`);
  });

  it('runs safe commands, lets the classifier judge the gray ones, blocks what it will not allow without asking, asks before what rules keep, and logs each decision', async () => {
    const { workspace, env, store } = await setup({ 'a.ts': 'export const a = 1;\n', 'node_modules/pkg/index.js': 'module.exports = 1;\n' });
    const asked: string[] = [];
    const commands = ['ls -t', 'node -e "console.log(41 + 1)"', 'rm -rf node_modules', 'node -e "console.log(7)"', 'rm -rf ~/old-project'];
    const transport = fakeTransport([
      toolCall('Working.', commands.map(bash), usage),
      verdict('allow', 'prints a number'),
      verdict('deny', 'the request did not ask to delete dependencies'),
      verdict('ask', 'unclear why this is needed'),
      answer('Done.', usage),
    ]);
    const result = await runCli(['agent', '--workspace', workspace, '--mode', 'auto', 'Print the answer'], env, {
      fetch: transport.fetch,
      confirm: (question) => {
        asked.push(question);
        return false;
      },
    });
    expect(result.code).toBe(0);

    const classified = transport.requests.filter(isClassifierCall);
    expect(classified.map(userText)).toEqual([
      expect.stringContaining('console.log(41 + 1)'),
      expect.stringContaining('rm -rf node_modules'),
      expect.stringContaining('console.log(7)'),
    ]);
    expect(userText(classified[0]!)).toContain('Print the answer');
    expect(asked).toEqual(['Allow `rm -rf ~/old-project`? It uses rm -rf of the workspace, its .git or a path outside it.']);
    expect(existsSync(path.join(workspace, 'node_modules/pkg/index.js'))).toBe(true);
    expect(result.stdout).toContain('auto: the classifier allowed it: prints a number');
    expect(result.stdout).toContain('auto: the classifier denied it: the request did not ask to delete dependencies');

    const log = await readSessionLog(sessionFile(store, asSessionId(sessionIdOf(result.stdout))));
    expect(ofKind(log.events, 'mode').map((e) => e.mode)).toEqual(['auto']);
    const results = ofKind(log.events, 'tool-result');
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'denied', 'denied', 'rejected']);
    expect('output' in results[1]! && results[1].output).toContain('42');
    expect('output' in results[2]! && results[2].output).toContain('the request did not ask to delete dependencies');
    expect('output' in results[3]! && results[3].output).toContain('Auto mode blocked `node -e console.log(7)` without asking the user, because the safety classifier would not allow it: unclear why this is needed');
    expect('output' in results[3]! && results[3].output).toContain('say in your answer what you need the user to allow');
    expect(results.map((r) => r.approval)).toEqual([
      undefined,
      expect.objectContaining({
        mode: 'auto',
        rule: 'unlisted',
        decidedBy: 'classifier',
        verdict: 'allow',
        classifier: expect.objectContaining({ verdict: 'allow', reason: 'prints a number', model: 'qwen3.8-flash', costUsd: expect.any(Number), latencyMs: expect.any(Number) }),
      }),
      expect.objectContaining({ mode: 'auto', rule: 'rm-rf-in-workspace', decidedBy: 'classifier', verdict: 'deny', classifier: expect.objectContaining({ verdict: 'deny' }) }),
      expect.objectContaining({ mode: 'auto', rule: 'unlisted', decidedBy: 'classifier', verdict: 'deny', classifier: expect.objectContaining({ verdict: 'ask' }) }),
      { mode: 'auto', rule: 'rm-rf-outside-workspace', reason: 'rm -rf of the workspace, its .git or a path outside it', command: 'rm -rf ~/old-project', decidedBy: 'user', verdict: 'deny' },
    ]);
  });

  it('keeps auto on a resumed session, and ask mode never calls the classifier', async () => {
    const { workspace, env } = await setup({ 'a.ts': 'export const a = 1;\n' });
    const transport = fakeTransport([
      toolCall('One.', [bash('node -e "1"')], usage),
      verdict('allow', 'harmless'),
      answer('Done.', usage),
      toolCall('Two.', [bash('node -e "2"')], usage),
      verdict('allow', 'harmless'),
      answer('Done.', usage),
      toolCall('Three.', [bash('node -e "3"')], usage),
    ]);
    const first = await runCli(['agent', '--workspace', workspace, '--mode', 'auto', 'One'], env, { fetch: transport.fetch });
    const id = sessionIdOf(first.stdout);
    expect((await runCli(['agent', '--session', id, 'Two'], env, { fetch: transport.fetch })).code).toBe(0);
    expect(transport.requests.filter(isClassifierCall)).toHaveLength(2);
    expect((await runCli(['agent', '--session', id, '--mode', 'ask', 'Three'], env, { fetch: transport.fetch })).code).toBe(0);
    expect(transport.requests.filter(isClassifierCall)).toHaveLength(2);
    // Ask puts the command to the user, and with no terminal to answer, the refusal ends the turn.
    expect(transport.requests).toHaveLength(7);
  });

  it('rejects an unknown mode', async () => {
    const { workspace, env } = await setup({ 'a.ts': 'export const a = 1;\n' });
    const result = await runCli(['agent', '--workspace', workspace, '--mode', 'yolo', 'Hi'], env, { fetch: fakeTransport([]).fetch });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--mode must be ask or auto');
  });
});

describe('gcode agent --mode plan', () => {
  it('offers no edit tool, runs only safe commands, refuses writes without asking, and plans under its own prompt', async () => {
    const { workspace, env, store } = await setup({ 'a.ts': 'export const a = 1;\n', 'build/out.js': 'console.log(1);\n' });
    const asked: string[] = [];
    const edit = use('edit', { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 2' });
    const transport = fakeTransport([
      toolCall('Looking.', [bash('ls -t'), bash('rm -rf build'), bash(`node -e "require('fs').writeFileSync('x', '1')"`), edit], usage),
      answer('1. Change a.ts. Risks: none.', usage),
    ]);
    const result = await runCli(['agent', '--workspace', workspace, '--mode', 'plan', 'Plan the change'], env, {
      fetch: transport.fetch,
      confirm: (question) => {
        asked.push(question);
        return true;
      },
    });
    expect(result.code).toBe(0);

    const [first] = transport.requests;
    expect(first!.body.tools, 'Plan is offered the tools of every mode, and refuses what it leaves out').toEqual(toolRoster([...AGENT_TOOL_DEFINITIONS, ...webToolDefinitions(false)], []).offered);
    expect(first!.body.system[0].text).toBe(`${AGENT_PROMPTS.rules}\n\n${DEFERRED_TOOLS_NOTE}`);
    expect(JSON.stringify(first!.body.messages.at(-1).content)).toContain(JSON.stringify(MODE_NOTICES.plan).slice(1, -1));
    expect(asked).toEqual([]);
    expect(transport.requests.filter(isClassifierCall)).toEqual([]);
    expect(existsSync(path.join(workspace, 'build/out.js'))).toBe(true);
    expect(existsSync(path.join(workspace, 'x'))).toBe(false);
    expect(readFileSync(path.join(workspace, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');

    const log = await readSessionLog(sessionFile(store, asSessionId(sessionIdOf(result.stdout))));
    expect(ofKind(log.events, 'mode').map((e) => e.mode)).toEqual(['plan']);
    const results = ofKind(log.events, 'tool-result');
    expect(results.map((r) => r.status)).toEqual(['ok', 'denied', 'denied', 'error']);
    expect('output' in results[1]! && results[1].output).toContain('Plan mode is read-only; switch to Ask or Auto to make changes');
    expect(results[1]!.approval).toMatchObject({ mode: 'plan', rule: 'rm-rf-in-workspace', decidedBy: 'rule', verdict: 'deny' });
    expect(results[2]!.approval).toMatchObject({ mode: 'plan', rule: 'unlisted', decidedBy: 'rule', verdict: 'deny' });
    expect('output' in results[3]! && results[3].output).toContain('edit is not available: Plan mode is read-only');
  });
});
