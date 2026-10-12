import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { asSessionId, COMMAND_META, MODE_NOTICES, REPLAYED_TURN_META, type TurnEvent, ENVIRONMENT_HEADING, USER_PROMPT_FOLLOWS } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const SKILL = '---\nname: add-i18n\ndescription: Add a locale to the site\nargument-hint: <locale>\n---\nCopy messages/en.json to the new locale.\n';

async function setup(replies: readonly Reply[]) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const write = async (file: string, text: string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  await write(path.join(workspace, '.claude', 'commands', 'review.md'), '---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $1 for ${2:-bugs}.\n');
  await write(path.join(workspace, '.claude', 'skills', 'add-i18n', 'SKILL.md'), SKILL);
  const env = { GCODE_HOME: home, GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic' };
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
  const updates: acp.SessionUpdate[] = [];
  const client = acp.client({ name: 'test-editor' }).onNotification(acp.methods.client.session.update, ({ params }) => {
    updates.push(params.update);
  });
  const connect = <T>(work: (ctx: acp.ClientContext, sessionId: string) => Promise<T>) =>
    client.connectWith(gcodeAgent(io, openStore(env), { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
      return work(ctx, sessionId);
    });
  const say = (ctx: acp.ClientContext, sessionId: string, text: string) =>
    ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
  const events = async (sessionId: string) => (await readSessionLog(sessionFile(openStore(env), asSessionId(sessionId)))).events;
  const userEvents = async (sessionId: string) => (await events(sessionId)).filter((e): e is Extract<TurnEvent, { kind: 'user' }> => e.kind === 'user');
  return { workspace, home, write, transport, updates, connect, say, events, userEvents };
}

async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; !done(); waited += 10) {
    if (waited > 5000) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

type Listed = Extract<acp.SessionUpdate, { sessionUpdate: 'available_commands_update' }>;
const listings = (updates: readonly acp.SessionUpdate[]) =>
  updates.filter((u): u is Listed => u.sessionUpdate === 'available_commands_update').map((u) => u.availableCommands.map((c) => c.name));

/** The first user message after the workspace's loaded context, which the skill folder makes non-empty. */
const firstMessage = (body: { messages: { content: { text?: string; cache_control?: unknown }[] }[] }) =>
  body.messages[0]!.content
    .slice(1)
    .filter((block) => block.text?.startsWith(ENVIRONMENT_HEADING) !== true)
    .map(({ cache_control: _, ...block }) => block);

describe('gcode serve slash commands', () => {
  it('publishes the commands once the session exists, and again when a command file is added', async () => {
    const { workspace, home, write, updates, connect } = await setup([]);

    await connect(async () => {
      await until(() => listings(updates).length === 1);
      // Give FSEvents a moment to start before changing the folders it watches.
      await new Promise((r) => setTimeout(r, 150));
      await write(path.join(workspace, '.agents', 'commands', 'ship.md'), 'Ship it.');
      await until(() => listings(updates).length === 2);
      await write(path.join(home, 'commands', 'standup.md'), 'Standup for $ARGUMENTS.');
      await until(() => listings(updates).length === 3);
    });

    const builtins = ['new', 'history', 'mode', 'model', 'clear', 'compact', 'rules', 'memory', 'init', 'best-of-n', 'lane', 'schedule', 'workflow'];
    expect(listings(updates)).toEqual([
      [...builtins, 'review', 'add-i18n'],
      [...builtins, 'ship', 'review', 'add-i18n'],
      [...builtins, 'standup', 'ship', 'review', 'add-i18n'],
    ]);
    const first = updates.find((u): u is Listed => u.sessionUpdate === 'available_commands_update')!;
    expect(first.availableCommands.find((c) => c.name === 'add-i18n')).toEqual({
      name: 'add-i18n',
      description: 'Add a locale to the site',
      input: { hint: '<locale>' },
      _meta: { [COMMAND_META]: { kind: 'skill' } },
    });
  });

  it('stops watching the command folders when the session closes', async () => {
    const { workspace, write, updates, connect } = await setup([]);

    await connect(async (ctx, sessionId) => {
      await until(() => listings(updates).length === 1);
      await new Promise((r) => setTimeout(r, 150));
      await write(path.join(workspace, '.agents', 'commands', 'ship.md'), 'Ship it.');
      await until(() => listings(updates).length === 2);
      await ctx.request(acp.methods.agent.session.close, { sessionId });
      await write(path.join(workspace, '.agents', 'commands', 'land.md'), 'Land it.');
      // Well past the 200 ms debounce a live watch would publish after.
      await new Promise((r) => setTimeout(r, 1500));
    });

    expect(listings(updates), 'a closed session publishes no more lists').toHaveLength(2);
  });

  it('sends a command invocation to the model expanded, and logs the command name and its arguments', async () => {
    const { transport, connect, say, userEvents } = await setup([answer('Looks fine.', usage)]);

    const sessionId = await connect(async (ctx, sessionId) => {
      expect((await say(ctx, sessionId, '/review src/app.ts "error paths"')).stopReason).toBe('end_turn');
      return sessionId;
    });

    expect(firstMessage(transport.requests[0]!.body)).toEqual([{ type: 'text', text: 'Review src/app.ts for error paths.' }]);
    expect(await userEvents(sessionId)).toEqual([
      expect.objectContaining({ content: 'Review src/app.ts for error paths.', command: { name: 'review', args: 'src/app.ts "error paths"', description: 'Review a file' }, context: [] }),
    ]);
  });

  it('keeps the typed text of a skill invocation and attaches its SKILL.md as a context item', async () => {
    const { transport, connect, say, userEvents } = await setup([answer('Adding th.', usage)]);

    const sessionId = await connect(async (ctx, sessionId) => {
      await say(ctx, sessionId, '/add-i18n th');
      return sessionId;
    });

    expect(firstMessage(transport.requests[0]!.body)).toEqual([
      { type: 'text', text: '/add-i18n th' },
      {
        type: 'text',
        text: `The user attached these from the editor, as they were when the message was sent:\n\n<context_item kind="skill" name="add-i18n" path=".claude/skills/add-i18n/SKILL.md">\n${SKILL}\n</context_item>`,
      },
    ]);
    expect(await userEvents(sessionId)).toEqual([
      expect.objectContaining({
        content: '/add-i18n th',
        command: { name: 'add-i18n', args: 'th', description: 'Add a locale to the site' },
        context: [{ kind: 'skill', name: 'add-i18n', path: '.claude/skills/add-i18n/SKILL.md', text: SKILL }],
      }),
    ]);
  });

  it('titles a chat started with a command by the text after it, else by what the command does', async () => {
    const { workspace, updates, connect, say } = await setup([answer('Adding th.', usage), answer('Which locale?', usage), answer('Adding th.', usage), answer('Reviewed.', usage), answer('Created.', usage)]);
    const titled = async (...prompts: string[]) => {
      updates.length = 0;
      const { sessionId, listed } = await connect(async (ctx, sessionId) => {
        for (const prompt of prompts) await say(ctx, sessionId, prompt);
        return { sessionId, listed: await ctx.request(acp.methods.agent.session.list, { cwd: workspace }) };
      });
      const shown = updates.flatMap((u) => (u.sessionUpdate === 'session_info_update' && u.title != null ? [u.title] : []));
      return { shown, listed: listed.sessions.find((s) => s.sessionId === sessionId)?.title };
    };

    expect(await titled('/add-i18n เพิ่มภาษาไทย')).toEqual({ shown: ['เพิ่มภาษาไทย'], listed: 'เพิ่มภาษาไทย' });
    expect(await titled('/add-i18n', 'th, for the Bangkok office')).toEqual({ shown: ['Add a locale to the site'], listed: 'Add a locale to the site' });
    expect(await titled('/review src/app.ts')).toEqual({ shown: ['src/app.ts'], listed: 'src/app.ts' });
    expect(await titled('/init')).toEqual({ shown: ['Create or update AGENTS.md for this project'], listed: 'Create or update AGENTS.md for this project' });
  });

  it('runs /mode in the engine without a model call, answers an editor built-in, and passes unknown names through', async () => {
    const { transport, updates, connect, say, events, userEvents } = await setup([answer('It is a path.', usage)]);

    const sessionId = await connect(async (ctx, sessionId) => {
      expect((await say(ctx, sessionId, '/mode auto')).stopReason).toBe('end_turn');
      expect((await say(ctx, sessionId, '/mode yolo')).stopReason).toBe('end_turn');
      expect((await say(ctx, sessionId, '/new')).stopReason).toBe('end_turn');
      expect((await say(ctx, sessionId, '/rules')).stopReason).toBe('end_turn');
      await say(ctx, sessionId, '/usr/bin what is this');
      return sessionId;
    });

    expect(updates).toContainEqual({ sessionUpdate: 'current_mode_update', currentModeId: 'auto' });
    const replies = updates.flatMap((u) => (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? [u.content.text] : []));
    expect(replies.slice(0, 4)).toEqual([
      'Approval mode: auto.',
      'Usage: /mode plan | ask | auto',
      '/new runs in the editor, and this client does not offer it.',
      '/rules runs in the editor, and this client does not offer it.',
    ]);
    expect(transport.requests).toHaveLength(1);
    expect(firstMessage(transport.requests[0]!.body), 'the switch to Auto is told before the prompt').toEqual([
      { type: 'text', text: MODE_NOTICES.auto },
      { type: 'text', text: USER_PROMPT_FOLLOWS },
      { type: 'text', text: '/usr/bin what is this' },
    ]);
    expect((await events(sessionId)).map((e) => e.kind)).toEqual(['session-start', 'mode', 'user', 'notice', 'checkpoint', 'assistant']);
    expect((await userEvents(sessionId))[0]).not.toHaveProperty('command');
  });

  it('replays a command turn with its name and arguments beside the expanded text', async () => {
    const { workspace, updates, connect, say } = await setup([answer('Looks fine.', usage)]);

    const sessionId = await connect(async (ctx, sessionId) => {
      await say(ctx, sessionId, '/review src/app.ts');
      return sessionId;
    });
    updates.length = 0;
    await connect((ctx) => ctx.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] }));

    expect(updates.filter((u) => u.sessionUpdate === 'user_message_chunk')).toEqual([
      expect.objectContaining({
        content: { type: 'text', text: 'Review src/app.ts for bugs.' },
        _meta: { [REPLAYED_TURN_META]: expect.objectContaining({ command: { name: 'review', args: 'src/app.ts', description: 'Review a file' } }) },
      }),
    ]);
  });
});
