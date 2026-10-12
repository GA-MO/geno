import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  PERMISSION_ADD_METHOD,
  PERMISSION_COMMENT_META,
  PERMISSION_REMOVE_METHOD,
  PERMISSIONS_METHOD,
  type PermissionAddRequest,
  type PermissionRemoveRequest,
  type PermissionsRequest,
  type PermissionsResponse,
} from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, toolCall, type FakeToolUse, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
let nextId = 0;
const bash = (command: string): FakeToolUse => ({ id: `tu_rule_${nextId++}`, name: 'bash', input: { command } });
const read = (file: string): FakeToolUse => ({ id: `tu_rule_${nextId++}`, name: 'read', input: { path: file } });

async function setup(replies: readonly Reply[]) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-home-')));
  const env = {
    GCODE_HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-fake',
    DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  const transport = fakeTransport(replies);
  const io: Io = {
    env,
    cwd: workspace,
    out: () => {},
    err: () => {},
    write: () => {},
    interrupts: () => new AbortController().signal,
    confirm: async () => false,
    fetch: transport.fetch,
  };
  const permissions: acp.RequestPermissionRequest[] = [];
  let optionId = 'reject';
  let comment: string | undefined;
  const client = acp
    .client({ name: 'test-editor' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      permissions.push(params);
      return { outcome: { outcome: 'selected', optionId, ...(comment === undefined ? {} : { _meta: { [PERMISSION_COMMENT_META]: comment } }) } };
    })
    .onNotification(acp.methods.client.session.update, () => {});
  const store = openStore(env);
  /** A fresh engine and a new session in the workspace, as a reopened window would have. */
  const session = <T>(work: (ctx: acp.ClientContext, sessionId: string) => Promise<T>) =>
    client.connectWith(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
      return work(ctx, sessionId);
    });
  /** A fresh engine with no session, as Settings has before the first prompt. */
  const sessionless = <T>(work: (ctx: acp.ClientContext) => Promise<T>) =>
    client.connectWith(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      return work(ctx);
    });
  const prompt = (ctx: acp.ClientContext, sessionId: string, text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
  const results = () =>
    new Map(
      transport.requests.flatMap((r) =>
        (r.body.messages.at(-1).content as { type: string; tool_use_id?: string; content?: string }[]).flatMap((b) => (b.type === 'tool_result' ? [[b.tool_use_id!, b.content!] as const] : [])),
      ),
    );
  return { workspace, home, store, transport, permissions, session, sessionless, prompt, results, answerWith: (id: string, said?: string) => ((optionId = id), (comment = said)) };
}

const list = (ctx: acp.ClientContext, cwd: string) => ctx.request<PermissionsResponse, PermissionsRequest>(PERMISSIONS_METHOD, { cwd });
const add = (ctx: acp.ClientContext, cwd: string, effect: 'allow' | 'ask' | 'deny', text: string) =>
  ctx.request<PermissionsResponse, PermissionAddRequest>(PERMISSION_ADD_METHOD, { cwd, effect, text });

describe('remembered permission rules', () => {
  it('saves "Always allow in this workspace" under the app home, and a later session runs the same command without asking in Ask', async () => {
    const first = bash('ls ..');
    const again = bash('ls ..');
    const longer = bash('ls .. -a');
    const { workspace, home, permissions, session, sessionless, prompt, results, answerWith } = await setup([
      toolCall('Listing.', [first], usage),
      answer('Listed.', usage),
      toolCall('Listing again.', [again], usage),
      toolCall('And with more.', [longer], usage),
      answer('Done.', usage),
    ]);
    answerWith('allow-workspace');

    await session((ctx, sessionId) => prompt(ctx, sessionId, 'What is next to this folder?'));
    expect(permissions).toHaveLength(1);
    expect(permissions[0]!.options.map((o) => [o.optionId, o.name])).toEqual([
      ['allow', 'Allow once'],
      ['reject', 'Reject'],
      ['allow-workspace', 'Always allow in this workspace'],
      ['reject-with-comment', 'No, and tell the agent…'],
    ]);
    expect(permissions[0]!.toolCall.rawInput).toMatchObject({ command: 'ls ..', reason: 'a path outside the workspace', rule: 'ls ..' });

    answerWith('reject');
    const listed = await session(async (ctx, sessionId) => {
      await prompt(ctx, sessionId, 'List it again.');
      return list(ctx, workspace);
    });
    expect(permissions).toHaveLength(1);
    expect(results().get(again.id)).not.toContain('denied');
    expect(results().get(longer.id)).not.toContain('denied');
    expect(listed).toEqual({ workspace, rules: [expect.objectContaining({ effect: 'allow', pattern: ['ls', '..'] })] });

    expect(readdirSync(path.join(home, 'permissions'))).toHaveLength(1);
    const sessions = readdirSync(path.join(home, 'sessions')).length;
    expect(await sessionless((ctx) => list(ctx, workspace))).toEqual(listed);
    expect(readdirSync(path.join(home, 'sessions')), 'listing the rules starts no session').toHaveLength(sessions);
    expect(execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: workspace, encoding: 'utf8' })).toBe('');
  });

  it('asks about one command of a loop with the whole line beside it, logs both, and the saved rule covers the loop', async () => {
    const line = 'for f in a.ts; do node --import tsx $f; done && git status';
    const first = bash(line);
    const again = bash('for f in a.ts b.ts; do node --import tsx $f; done');
    const { workspace, store, permissions, session, prompt, results, answerWith } = await setup([
      toolCall('Checking.', [first], usage),
      answer('Checked.', usage),
      toolCall('Checking again.', [again], usage),
      answer('Done.', usage),
    ]);
    answerWith('allow-workspace');

    const sessionId = await session(async (ctx, id) => {
      await prompt(ctx, id, 'Check the syntax');
      return id;
    });
    expect(permissions).toHaveLength(1);
    expect(permissions[0]!.toolCall.rawInput).toEqual({ command: 'node --import tsx $f', line, reason: 'a command not on the safe list', rule: 'node --import' });
    expect(permissions[0]!.toolCall.title).toBe(`Allow \`node --import tsx $f\` in \`${line}\`? It uses a command not on the safe list.`);
    const log = await readSessionLog(sessionFile(store, asSessionId(sessionId)));
    const logged = log.events.flatMap((event) => (event.kind === 'tool-result' && event.approval !== undefined ? [event.approval] : []));
    expect(logged).toEqual([expect.objectContaining({ command: 'node --import tsx $f', line, decidedBy: 'user', verdict: 'allow' })]);

    const listed = await session(async (ctx, id) => {
      await prompt(ctx, id, 'Check both');
      return list(ctx, workspace);
    });
    expect(permissions).toHaveLength(1);
    expect(results().get(again.id)).not.toContain('denied');
    expect(listed.rules).toEqual([expect.objectContaining({ effect: 'allow', pattern: ['node', '--import'] })]);
  });

  it('blocks a command a deny rule names in Auto, without asking or calling the classifier, and removes the rule', async () => {
    const denied = bash('node -e "console.log(1)"');
    const { workspace, permissions, transport, session, prompt, results } = await setup([toolCall('Running.', [denied], usage), answer('Blocked.', usage)]);

    const after = await session(async (ctx, sessionId) => {
      const { rules } = await add(ctx, workspace, 'deny', 'node');
      expect(rules).toEqual([expect.objectContaining({ effect: 'deny', pattern: ['node'] })]);
      await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: 'auto' });
      await prompt(ctx, sessionId, 'Run it');
      return ctx.request<PermissionsResponse, PermissionRemoveRequest>(PERMISSION_REMOVE_METHOD, { cwd: workspace, id: rules[0]!.id });
    });

    expect(permissions).toEqual([]);
    expect(transport.requests.filter((r) => r.body.tool_choice !== undefined)).toEqual([]);
    expect(results().get(denied.id)).toBe(
      'denied: `node -e console.log(1)` matches the workspace rule that denies `node`, which the user set in Settings under Permissions. Do not retry it; find another way, or say in your answer that the rule stops you.',
    );
    expect(after.rules).toEqual([]);
  });

  it('saves an ask rule and a Read rule typed in Settings, and the ask rule puts a card up in Auto with no rule to keep', async () => {
    const listing = bash('ls');
    const { workspace, permissions, transport, session, prompt } = await setup([toolCall('Listing.', [listing], usage), answer('Not listed.', usage)]);
    await session(async (ctx, sessionId) => {
      const { rules } = await add(ctx, workspace, 'ask', 'Bash(ls *)');
      expect((await add(ctx, workspace, 'deny', 'Read(./private/**)')).rules).toEqual([
        expect.objectContaining({ effect: 'ask', pattern: ['ls'] }),
        expect.objectContaining({ effect: 'deny', tool: 'read', path: './private/**' }),
      ]);
      expect(rules).toHaveLength(1);
      await expect(add(ctx, workspace, 'allow', 'Read(src/**)')).rejects.toThrow(/only ask or deny/);
      await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: 'auto' });
      await prompt(ctx, sessionId, 'List it');
    });
    expect(permissions).toHaveLength(1);
    expect(permissions[0]!.toolCall.rawInput).toEqual({ command: 'ls', reason: 'the workspace rule that asks before `ls`, which the user set in Settings under Permissions' });
    expect(permissions[0]!.options.map((o) => o.optionId)).toEqual(['allow', 'reject', 'reject-with-comment']);
    expect(transport.requests.filter((r) => r.body.tool_choice !== undefined), 'the classifier is not called').toEqual([]);
  });

  it('still asks before a hard ask that an allow rule names, offers no rule for it, and refuses to save an allow rule for one', async () => {
    const forced = bash('git push --force origin main');
    const { workspace, permissions, transport, session, prompt, results } = await setup([toolCall('Pushing.', [forced], usage), answer('Not pushed.', usage)]);

    await session(async (ctx, sessionId) => {
      await add(ctx, workspace, 'allow', 'git push');
      await expect(add(ctx, workspace, 'allow', 'git push --force')).rejects.toThrow(/always asks/);
      await expect(add(ctx, workspace, 'allow', 'pnpm test && rm -rf x')).rejects.toThrow(/one command/);
      await prompt(ctx, sessionId, 'Push it');
    });

    expect(permissions).toHaveLength(1);
    expect(permissions[0]!.toolCall.rawInput).toEqual({ command: 'git push --force origin main', reason: 'git push' });
    expect(permissions[0]!.options.map((o) => o.optionId)).toEqual(['allow', 'reject', 'reject-with-comment']);
    expect(results().get(forced.id), 'the rejection ends the turn, so no request carries its result').toBeUndefined();
    expect(transport.requests).toHaveLength(1);
  });

  it('B/B-71 "No, and tell the agent…" puts the comment in the tool result, and the turn goes on with it', async () => {
    const push = bash('git push origin main');
    const fork = bash('git status');
    const { permissions, transport, session, prompt, results, answerWith } = await setup([toolCall('Pushing.', [push], usage), toolCall('Checking.', [fork], usage), answer('Pushed to the fork instead.', usage)]);
    answerWith('reject-with-comment', '  Push to my fork, not origin.  ');
    await session((ctx, sessionId) => prompt(ctx, sessionId, 'Ship it'));
    expect(permissions).toHaveLength(1);
    expect(results().get(push.id)).toBe('The user rejected `git push origin main`, so it did not run. To tell you how to proceed, the user said:\nPush to my fork, not origin.');
    expect(transport.requests.length, 'the model is called again with the comment').toBeGreaterThanOrEqual(2);
  });

  it('B/B-71 "No, and tell the agent…" with an empty comment is a plain no, which ends the turn', async () => {
    const push = bash('git push origin main');
    const { transport, session, prompt, results, answerWith } = await setup([toolCall('Pushing.', [push], usage), answer('Not pushed.', usage)]);
    answerWith('reject-with-comment', '   ');
    await session((ctx, sessionId) => prompt(ctx, sessionId, 'Ship it'));
    expect(results().get(push.id)).toBeUndefined();
    expect(transport.requests).toHaveLength(1);
  });

  it('T-PERM-04 the card for a read outside the workspace offers "Allow this directory for the session", and the next prompt reads there without one', async () => {
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-sibling-')));
    await writeFile(path.join(outside, 'a.md'), 'first note\n');
    await writeFile(path.join(outside, 'b.md'), 'second note\n');
    const first = read(path.join(outside, 'a.md'));
    const second = read(path.join(outside, 'b.md'));
    const { permissions, session, prompt, results, answerWith } = await setup([
      toolCall('Reading.', [first], usage),
      answer('Read.', usage),
      toolCall('Reading the other.', [second], usage),
      answer('Read it too.', usage),
    ]);
    answerWith('allow-session');
    await session(async (ctx, sessionId) => {
      await prompt(ctx, sessionId, 'Read the notes next door.');
      await prompt(ctx, sessionId, 'And the other one.');
    });
    expect(permissions).toHaveLength(1);
    expect(permissions[0]!.toolCall.title).toBe(`Allow \`read ${path.join(outside, 'a.md')}\`? It uses a path outside the workspace.`);
    expect(permissions[0]!.toolCall.rawInput).toMatchObject({ subject: { kind: 'read', path: path.join(outside, 'a.md') } });
    expect(permissions[0]!.options.map((o) => [o.optionId, o.name])).toEqual([
      ['allow', 'Allow once'],
      ['allow-session', 'Allow this directory for the session'],
      ['reject', 'Reject'],
      ['reject-with-comment', 'No, and tell the agent…'],
    ]);
    expect(results().get(first.id)).toBe('1\tfirst note');
    expect(results().get(second.id)).toBe('1\tsecond note');
  });
});

describe('the rules of the settings files in Settings', () => {
  it("lists each settings file's rule read-only with its file, and leaves out an allow that waits for trust", async () => {
    const { workspace, home, sessionless } = await setup([]);
    await mkdir(path.join(workspace, '.agents'), { recursive: true });
    await writeFile(path.join(workspace, '.agents', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(touch:*)'], allow: ['Bash(curl -s https://a.invalid/x:*)'] } }));
    await writeFile(path.join(home, 'settings.json'), JSON.stringify({ permissions: { deny: ['WebFetch'] } }));
    const listed = await sessionless((ctx) => list(ctx, workspace));
    expect(listed.rules).toEqual([]);
    expect(listed.imported).toEqual([
      { effect: 'deny', text: 'touch', source: '.agents/settings.json' },
      { effect: 'deny', text: 'WebFetch', source: path.join(home, 'settings.json') },
    ]);
  });
});
