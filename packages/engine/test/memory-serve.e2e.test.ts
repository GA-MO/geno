import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  GLOBAL_RULES_METHOD,
  MEMORY_CAPABILITY,
  MEMORY_DELETE_METHOD,
  MEMORY_EDIT_METHOD,
  MEMORY_METHOD,
  REMEMBER_META,
  RULES_METHOD,
  type GlobalRulesResponse,
  type MemoryResponse,
  type RulesResponse,
  type TurnEvent,
} from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, loadTools, offeredTools, toolCall, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

type Editor = {
  writes: acp.WriteTextFileRequest[];
  permissions: acp.RequestPermissionRequest[];
  elicitations: acp.CreateElicitationRequest[];
  updates: acp.SessionUpdate[];
  /** What the editor answers a remember question with. */
  remember: string;
  /** What the editor answers an elicitation with; `wait` holds it until the request is cancelled, and `fail` errors. */
  elicit: acp.CreateElicitationResponse | 'wait' | 'fail';
  cancelled: number;
};

async function setup(replies: readonly Reply[], capable = true) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n', 'AGENTS.md': 'Use pnpm.\n' } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  await writeFile(path.join(home, 'AGENTS.md'), 'Answer in British English.\n');
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
  const editor: Editor = { writes: [], permissions: [], elicitations: [], updates: [], remember: 'allow', elicit: { action: 'decline' }, cancelled: 0 };
  const client = acp
    .client({ name: 'test-editor' })
    .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => ({ content: readFileSync(params.path, 'utf8') }))
    .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => {
      editor.writes.push(params);
      writeFileSync(params.path, params.content);
      return {};
    })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      editor.permissions.push(params);
      return { outcome: { outcome: 'selected', optionId: editor.remember } };
    })
    .onRequest(acp.methods.client.elicitation.create, ({ params, signal }) => {
      editor.elicitations.push(params);
      if (editor.elicit === 'fail') throw new Error('this editor cannot show that form');
      if (editor.elicit !== 'wait') return editor.elicit;
      return new Promise<acp.CreateElicitationResponse>((resolve) =>
        signal.addEventListener('abort', () => {
          editor.cancelled++;
          resolve({ action: 'cancel' });
        }),
      );
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      editor.updates.push(params.update);
    });
  const connect = <T>(work: (ctx: acp.ClientContext, sessionId: string) => Promise<T>) =>
    client.connectWith(gcodeAgent(io, openStore(env), { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: capable
          ? { fs: { readTextFile: true, writeTextFile: true }, elicitation: { form: {} }, _meta: { [MEMORY_CAPABILITY]: true } }
          : { fs: { readTextFile: true, writeTextFile: true } },
      });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
      return work(ctx, sessionId);
    });
  const say = (ctx: acp.ClientContext, sessionId: string, text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
  const events = async (sessionId: string) => (await readSessionLog(sessionFile(openStore(env), asSessionId(sessionId)))).events;
  return { workspace, home, transport, editor, connect, say, events };
}

const toolNames = offeredTools;
const systemOf = (body: { system: { text: string }[] }) => body.system[0]!.text;
const toolResults = (body: { messages: { content: unknown }[] }) => JSON.stringify(body.messages.at(-1)!.content);

describe('gcode serve: remember and memory', () => {
  it('asks with the exact text before saving, puts the note in the next prompt, and keeps the prompt bytes while memory holds still', async () => {
    const text = 'Run the tests with pnpm vitest.';
    const { transport, editor, connect, say, home } = await setup([
      answer('Hello.', usage),
      answer('Hello again.', usage),
      toolCall('', [loadTools('remember')], usage),
      toolCall('Noting that.', [{ id: 'tu_r', name: 'remember', input: { text, scope: 'project' } }], usage),
      answer('Noted.', usage),
      answer('Done.', usage),
    ]);

    await connect(async (ctx, sessionId) => {
      await say(ctx, sessionId, 'hi');
      await say(ctx, sessionId, 'hi again');
      await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: 'auto' });
      await say(ctx, sessionId, 'from now on use pnpm vitest');
      await say(ctx, sessionId, 'next');
    });

    const [first, second, third, , , sixth] = transport.requests.map((r) => r.body);
    expect(toolNames(first), 'a client that shows both cards is offered both tools in Ask').toEqual(expect.arrayContaining(['ask_user', 'remember']));
    expect(toolNames(third), 'Auto offers remember but not ask_user').toContain('remember');
    expect(toolNames(third)).not.toContain('ask_user');
    expect(systemOf(second), 'unchanged memory, same prompt bytes').toBe(systemOf(first));
    expect(systemOf(first)).not.toContain('<memory>');

    expect(editor.permissions).toHaveLength(1);
    const asked = editor.permissions[0]!;
    expect(asked.toolCall._meta?.[REMEMBER_META], 'Auto still asks, showing the exact text').toEqual({ text, scope: 'project' });
    expect(asked.toolCall.title).toBe('Remember this in this project?');
    expect(asked.options.map((o) => o.name)).toEqual(['Remember', "Don't remember"]);
    expect(systemOf(sixth)).toContain(`<note scope="project">${text}</note>`);
    expect(JSON.stringify(await readFile(path.join(home, 'memory', 'global.json'), 'utf8').catch(() => 'none'))).toBe('"none"');
  });

  it('saves nothing when the user declines', async () => {
    const { transport, editor, connect, say } = await setup([
      toolCall('', [loadTools('remember')], usage),
      toolCall('Noting that.', [{ id: 'tu_r', name: 'remember', input: { text: 'Never ask before pushing.', scope: 'global' } }], usage),
      answer('Fine.', usage),
    ]);
    editor.remember = 'reject';
    const entries = await connect(async (ctx, sessionId) => {
      await say(ctx, sessionId, 'remember that');
      return (await ctx.request<MemoryResponse>(MEMORY_METHOD, { sessionId })).entries;
    });
    expect(entries).toEqual([]);
    expect(toolResults(transport.requests[2]!.body)).toContain('The user declined. Nothing was saved');
  });

  it('lists, edits and deletes memory for the pane', async () => {
    const { connect, say, home } = await setup([
      toolCall('', [loadTools('remember')], usage),
      toolCall('Noting.', [{ id: 'tu_r', name: 'remember', input: { text: 'Tabs.', scope: 'global' } }], usage),
      answer('Ok.', usage),
    ]);
    await connect(async (ctx, sessionId) => {
      await say(ctx, sessionId, 'remember tabs');
      const [entry] = (await ctx.request<MemoryResponse>(MEMORY_METHOD, { sessionId })).entries;
      expect(entry).toEqual({ id: expect.any(String), text: 'Tabs.', scope: 'global', createdAt: expect.any(String), sessionId });
      expect((await ctx.request<MemoryResponse>(MEMORY_EDIT_METHOD, { sessionId, id: entry!.id, text: 'Spaces.' })).entries.map((e) => e.text)).toEqual(['Spaces.']);
      await expect(ctx.request(MEMORY_EDIT_METHOD, { sessionId, id: entry!.id, text: 'x'.repeat(501) })).rejects.toThrow('a memory holds at most 500 characters');
      expect((await ctx.request<MemoryResponse>(MEMORY_DELETE_METHOD, { sessionId, id: entry!.id })).entries).toEqual([]);
      expect(JSON.parse(await readFile(path.join(home, 'trash', 'memory', `${entry!.id}.json`), 'utf8')).text).toBe('Spaces.');
    });
  });

  it('offers neither user tool to a client that cannot show the cards', async () => {
    const { transport, connect, say } = await setup([answer('Hi.', usage)], false);
    await connect((ctx, sessionId) => say(ctx, sessionId, 'hi'));
    expect(toolNames(transport.requests[0]!.body)).not.toContain('remember');
    expect(toolNames(transport.requests[0]!.body)).not.toContain('ask_user');
  });
});

describe('gcode serve: ask_user', () => {
  it('asks through an ACP form elicitation and returns the answer as the tool result', async () => {
    const { transport, editor, connect, say } = await setup([
      toolCall('Asking.', [{ id: 'tu_q', name: 'ask_user', input: { question: 'Which database?', options: ['Postgres', 'SQLite'] } }], usage),
      answer('SQLite it is.', usage),
    ]);
    editor.elicit = { action: 'accept', content: { choice: 'SQLite' } };
    await connect((ctx, sessionId) => say(ctx, sessionId, 'set up a database'));

    expect(editor.elicitations).toEqual([
      expect.objectContaining({
        mode: 'form',
        toolCallId: 'tu_q',
        message: 'Which database?',
        requestedSchema: expect.objectContaining({ properties: expect.objectContaining({ choice: expect.objectContaining({ oneOf: [{ const: 'Postgres', title: 'Postgres' }, { const: 'SQLite', title: 'SQLite' }] }) }) }),
      }),
    ]);
    expect(toolResults(transport.requests[1]!.body)).toContain('The user answered: SQLite');
  });

  it('cancels the open question when the turn is cancelled', async () => {
    const { editor, connect, say, events } = await setup([toolCall('Asking.', [{ id: 'tu_q', name: 'ask_user', input: { question: 'Which?' } }], usage)]);
    editor.elicit = 'wait';
    const [stop, sessionId] = await connect(async (ctx, sessionId) => {
      const turn = say(ctx, sessionId, 'go');
      while (editor.elicitations.length === 0) await new Promise((r) => setTimeout(r, 10));
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
      return [(await turn).stopReason, sessionId] as const;
    });
    expect(stop).toBe('cancelled');
    expect(editor.cancelled, 'the editor heard the question was cancelled').toBe(1);
    expect((await events(sessionId)).at(-1)).toEqual(expect.objectContaining({ kind: 'error', error: 'abort' }));
  });
});

const TWO_QUESTIONS = {
  questions: [
    {
      id: 'button',
      header: 'Button',
      question: 'Which button style?',
      options: [
        { label: 'Solid', description: 'A filled button.', recommended: true, preview: '```css\n.button { background: black; }\n```' },
        { label: 'Ghost', description: 'Text only until hovered.' },
      ],
    },
    {
      id: 'targets',
      header: 'Targets',
      question: 'Which platforms?',
      multiSelect: true,
      options: [
        { label: 'Web', description: 'The browser build.' },
        { label: 'Desktop', description: 'The Electron build.' },
        { label: 'Mobile', description: 'The React Native build.' },
      ],
    },
  ],
};

describe('gcode serve: ask_user with several questions', () => {
  it('asks two questions in one form, one multi-select and one answered under Other, and returns both answers', async () => {
    const { transport, editor, connect, say, workspace } = await setup([
      toolCall('Two questions.', [{ id: 'tu_q2', name: 'ask_user', input: TWO_QUESTIONS }], usage),
      answer('Pill buttons on the web and mobile.', usage),
    ]);
    editor.elicit = { action: 'accept', content: { 'button.other': 'Pill shaped', targets: ['Web', 'Mobile'] } };
    const sessionId = await connect(async (ctx, sessionId) => (await say(ctx, sessionId, 'style the buttons'), sessionId));

    const [asked] = editor.elicitations;
    expect(asked).toMatchObject({ mode: 'form', toolCallId: 'tu_q2', message: 'Geno has 2 questions: Button, Targets' });
    const schema = (asked as { requestedSchema: { properties: Record<string, Record<string, unknown>> } }).requestedSchema;
    expect(Object.keys(schema.properties), 'each question, then its Other field').toEqual(['button', 'button.other', 'targets', 'targets.other']);
    expect(schema.properties['button']).toMatchObject({ type: 'string', title: 'Button', oneOf: [{ const: 'Solid', title: 'Solid (Recommended)', description: 'A filled button.' }, { const: 'Ghost' }] });
    expect(schema.properties['targets']).toMatchObject({ type: 'array', items: { anyOf: [{ const: 'Web' }, { const: 'Desktop' }, { const: 'Mobile' }] } });
    expect(asked!._meta?.['gcode/ask_user'], 'the request rides along, previews and all, for an editor that shows the card').toEqual({
      questions: [
        { ...TWO_QUESTIONS.questions[0], multiSelect: false },
        TWO_QUESTIONS.questions[1],
      ],
    });
    expect(toolResults(transport.requests[1]!.body)).toContain(
      JSON.stringify(['The user answered:', '- Button (Which button style?): "Pill shaped" (in their own words)', '- Targets (Which platforms?): Web, Mobile'].join('\n')).slice(1, -1),
    );

    editor.updates.length = 0;
    await connect((ctx) => ctx.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] }));
    expect(editor.updates.filter((u) => u.sessionUpdate === 'tool_call').map((u) => (u as { title: string }).title)).toEqual(['ask_user Button, Targets']);
  });

  it('declines when the user cancels the card', async () => {
    const { transport, editor, connect, say } = await setup([toolCall('Asking.', [{ id: 'tu_q2', name: 'ask_user', input: TWO_QUESTIONS }], usage), answer('I will pick.', usage)]);
    editor.elicit = { action: 'cancel' };
    await connect((ctx, sessionId) => say(ctx, sessionId, 'style the buttons'));
    expect(toolResults(transport.requests[1]!.body)).toContain('The user declined to answer. Go on with your best judgment');
  });

  it('gives the model the questions as plain text when the editor cannot show the form', async () => {
    const { transport, editor, connect, say } = await setup([toolCall('Asking.', [{ id: 'tu_q2', name: 'ask_user', input: TWO_QUESTIONS }], usage), answer('Two questions for you.', usage)]);
    editor.elicit = 'fail';
    await connect((ctx, sessionId) => say(ctx, sessionId, 'style the buttons'));
    const result = toolResults(transport.requests[1]!.body);
    expect(result).toContain('The editor cannot show the question card. End your turn now with these questions as plain text');
    expect(result).toContain('1. Button: Which button style?');
    expect(result).toContain('3. Mobile: The React Native build.');
  });

  it('refuses a request that lists Other, without asking the user', async () => {
    const listed = { questions: [{ ...TWO_QUESTIONS.questions[0], options: [...TWO_QUESTIONS.questions[0]!.options, { label: 'Other', description: 'Anything else.' }] }] };
    const { transport, editor, connect, say } = await setup([toolCall('Asking.', [{ id: 'tu_q', name: 'ask_user', input: listed }], usage), answer('Fixed.', usage)]);
    await connect((ctx, sessionId) => say(ctx, sessionId, 'style the buttons'));
    expect(editor.elicitations).toEqual([]);
    expect(toolResults(transport.requests[1]!.body)).toContain(JSON.stringify('invalid input: ✖ question 1, option 3 is "Other". Do not list Other: the card always offers it').slice(1, -1));
  });

  it('replays an old single-question call under its question', async () => {
    const { editor, connect, say, workspace } = await setup([
      toolCall('Asking.', [{ id: 'tu_q', name: 'ask_user', input: { question: 'Which database?', options: ['Postgres', 'SQLite'] } }], usage),
      answer('SQLite it is.', usage),
    ]);
    editor.elicit = { action: 'accept', content: { choice: 'SQLite' } };
    const sessionId = await connect(async (ctx, sessionId) => (await say(ctx, sessionId, 'set up a database'), sessionId));
    editor.updates.length = 0;
    await connect((ctx) => ctx.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] }));
    const updates = editor.updates.filter((u) => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update');
    expect(updates.map((u) => (u.sessionUpdate === 'tool_call' ? u.title : JSON.stringify(u.content)))).toEqual([
      'ask_user Which database?',
      expect.stringContaining('The user answered: SQLite'),
    ]);
  });
});

describe('gcode serve: /rules and /init', () => {
  it('lists the rules the session loaded in load order, and creates the global rules file on request', async () => {
    const { connect, home, workspace } = await setup([]);
    const { rules, globalFile, file } = await connect(async (ctx, sessionId) => {
      const listed = await ctx.request<RulesResponse>(RULES_METHOD, { sessionId });
      return { ...listed, file: (await ctx.request<GlobalRulesResponse>(GLOBAL_RULES_METHOD, { sessionId })).file };
    });
    expect(globalFile).toBe(path.join(home, 'AGENTS.md'));
    expect(rules.map((r) => [r.source, r.file])).toEqual([
      ['global', path.join(home, 'AGENTS.md')],
      ['instructions', path.join(workspace, 'AGENTS.md')],
    ]);
    expect(file).toBe(path.join(home, 'AGENTS.md'));
    expect(await readFile(file, 'utf8'), 'an existing file is left alone').toBe('Answer in British English.\n');
  });

  it('runs /init as one agent turn whose edit to AGENTS.md goes through the editor', async () => {
    const edit = { path: 'AGENTS.md', old_str: 'Use pnpm.\n', new_str: 'Use pnpm.\n\n## Build\n\npnpm build\n' };
    const { transport, editor, connect, say, events, workspace } = await setup([
      toolCall('Reading.', [{ id: 'tu_read', name: 'read', input: { path: 'AGENTS.md' } }], usage),
      toolCall('Adding the build.', [{ id: 'tu_edit', name: 'edit', input: edit }], usage),
      answer('AGENTS.md now covers the build.', usage),
    ]);
    const sessionId = await connect(async (ctx, sessionId) => {
      expect((await say(ctx, sessionId, '/init')).stopReason).toBe('end_turn');
      return sessionId;
    });

    const sent = JSON.stringify(transport.requests[0]!.body.messages);
    expect(sent).toContain('Create or update AGENTS.md at the root of this workspace');
    expect(sent).toContain('keep everything the user wrote, word for word');
    expect(editor.writes.map((w) => [w.path, w.content])).toEqual([[path.join(workspace, 'AGENTS.md'), 'Use pnpm.\n\n## Build\n\npnpm build\n']]);
    const user = (await events(sessionId)).find((e): e is Extract<TurnEvent, { kind: 'user' }> => e.kind === 'user');
    expect(user?.command).toEqual({ name: 'init', args: '' });
  });
});
