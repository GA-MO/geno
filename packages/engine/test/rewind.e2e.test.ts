import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  FORK_AT_META,
  REPLAYED_TURN_META,
  REWIND_PREVIEW_METHOD,
  REWIND_TURN_METHOD,
  SESSION_SUMMARY_META,
  TASKS_METHOD,
  TURN_SEQ_META,
  type ReplayedTurn,
  type RewindChoice,
  type RewindPreviewResponse,
  type RewindTurnResponse,
  type SessionSummaryMeta,
  type TasksResponse,
  type TurnEvent,
} from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, toolCall, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

vi.setConfig({ testTimeout: 20_000 });

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const read = (id: string) => ({ id, name: 'read', input: { path: 'a.ts' } });
const edit = (id: string, from: string, to: string) => ({ id, name: 'edit', input: { path: 'a.ts', old_str: from, new_str: to } });

type Log = { readonly events: readonly TurnEvent[] };

type Editor = {
  readonly ctx: acp.ClientContext;
  readonly sessionId: string;
  readonly workspace: string;
  /** The seq of the second turn's prompt, "make it three". */
  readonly turn2: number;
  prompt(text: string, sessionId?: string): Promise<acp.PromptResponse>;
  rewind(turnSeq: number, choice: RewindChoice, sessionId?: string): Promise<RewindTurnResponse>;
  log(sessionId?: string): Promise<Log>;
  /** The raw log file, which a rewind only ever appends to. */
  file(sessionId?: string): string;
  /** The user's prose in each model request so far, without the loaded context. */
  sent(): string[][];
};

/** Two turns, each an edit of a.ts and an answer; `more` serves the turns the scenario sends after. */
async function serve<T>(more: readonly Reply[], scenario: (editor: Editor, updates: acp.SessionNotification[]) => Promise<T>): Promise<T> {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = "one";\n', 'b.ts': 'export const b = 1;\n' } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = {
    GCODE_HOME: home,
    HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-fake',
    DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  const store = openStore(env);
  const model = fakeTransport([
    toolCall('Making it two.', [read('tu_r1'), edit('tu_1', 'one', 'two')], usage),
    answer('It is two.', usage),
    toolCall('Making it three.', [read('tu_r2'), edit('tu_2', 'two', 'three')], usage),
    answer('It is three.', usage),
    ...more,
  ]);
  const io: Io = { env, cwd: workspace, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: model.fetch };
  const updates: acp.SessionNotification[] = [];
  const client = acp
    .client({ name: 'test-editor' })
    .onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => ({ content: readFileSync(params.path, 'utf8') }))
    .onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => {
      writeFileSync(params.path, params.content);
      return {};
    })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => ({
      outcome: { outcome: 'selected', optionId: (params.options.find((o) => o.kind === 'allow_once') ?? params.options[0]!).optionId },
    }))
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params);
    });
  return client.connectWith(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, _meta: { 'gcode/tasks': true } },
    });
    expect(init.agentCapabilities?.sessionCapabilities?.fork, 'the engine advertises session/fork').toEqual({});
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    const log = (id = sessionId) => readSessionLog(sessionFile(store, id as never));
    const prompt = (text: string, to = sessionId) => ctx.request(acp.methods.agent.session.prompt, { sessionId: to, prompt: [{ type: 'text', text }] });
    const first = await prompt('make it two');
    const second = await prompt('make it three');
    const turn2 = turnSeqOf(await log(), 'make it three');
    expect([first._meta?.[TURN_SEQ_META], second._meta?.[TURN_SEQ_META]], 'each prompt response names its prompt').toEqual([1, turn2]);
    expect(fileOf(workspace)).toContain('"three"');
    return scenario(
      {
        ctx,
        sessionId,
        workspace,
        turn2,
        prompt,
        rewind: (turnSeq, choice, to = sessionId) => ctx.request<RewindTurnResponse>(REWIND_TURN_METHOD, { sessionId: to, turnSeq, choice }),
        log,
        file: (id = sessionId) => readFileSync(sessionFile(store, id as never), 'utf8'),
        sent: () => model.requests.map((r) => prose(r.body)),
      },
      updates,
    );
  });
}

const fileOf = (workspace: string, file = 'a.ts') => readFileSync(path.join(workspace, file), 'utf8');
const turnSeqOf = (log: Log, content: string) => {
  const prompt = log.events.find((e) => e.kind === 'user' && e.content === content);
  if (prompt?.kind !== 'user') throw new Error(`no prompt ${content}`);
  return prompt.seq;
};
const prompts = (log: Log) => log.events.flatMap((e) => (e.kind === 'user' && e.steer !== true ? [e.content] : []));
const prose = (body: { readonly messages: readonly { readonly role: string; readonly content: unknown }[] }): string[] =>
  body.messages.flatMap((m) =>
    m.role !== 'user' || typeof m.content === 'string'
      ? []
      : (m.content as { type: string; text?: string }[]).flatMap((b) => (b.type === 'text' && b.text !== undefined && !b.text.startsWith('<') ? [b.text] : [])),
  );
const restoredNote = /^\[The user rewound the workspace/;

describe('gcode serve: rewind to here', () => {
  it('restores only the files, shows them first with the edits no checkpoint holds, and the next turn hears of it', async () => {
    await serve([answer('Back at two.', usage)], async (editor) => {
      writeFileSync(path.join(editor.workspace, 'b.ts'), 'export const b = 2;\n');
      const preview = await editor.ctx.request<RewindPreviewResponse>(REWIND_PREVIEW_METHOD, { sessionId: editor.sessionId, turnSeq: editor.turn2 });
      const abs = (file: string) => path.join(editor.workspace, file);
      expect(preview).toEqual({ files: [abs('a.ts'), abs('b.ts')], unsaved: [abs('b.ts')] });

      const rewound = await editor.rewind(editor.turn2, { kind: 'files' });
      expect(rewound).toEqual({ files: preview.files, prompt: 'make it three' });
      expect(fileOf(editor.workspace)).toContain('"two"');
      expect(fileOf(editor.workspace, 'b.ts')).toBe('export const b = 1;\n');
      expect(prompts(await editor.log()), 'the conversation stays').toEqual(['make it two', 'make it three']);

      await editor.prompt('what is it now?');
      const last = editor.sent().at(-1)!;
      expect(last[0]).toBe('make it two');
      expect(last).toContain('make it three');
      expect(last.at(-2)).toMatch(restoredNote);
      expect(last.at(-2)).toContain('These files were restored: a.ts, b.ts.');
      expect(last.at(-1)).toBe('what is it now?');
    });
  });

  it('cuts only the conversation, appending a cut to the log, hands back the prompt, and the next turn starts from before it', async () => {
    await serve([answer('Made it 3.', usage)], async (editor, updates) => {
      const before = editor.file();
      const rewound = await editor.rewind(editor.turn2, { kind: 'conversation' });
      expect(rewound).toEqual({ files: [], prompt: 'make it three' });
      expect(fileOf(editor.workspace), 'the files stay').toContain('"three"');
      const after = editor.file();
      expect(after.startsWith(before), 'the log is only appended to').toBe(true);
      expect(JSON.parse(after.slice(before.length))).toMatchObject({ kind: 'cut', turnSeq: editor.turn2 });
      expect(prompts(await editor.log())).toEqual(['make it two']);

      updates.length = 0;
      await editor.ctx.request(acp.methods.agent.session.load, { sessionId: editor.sessionId, cwd: editor.workspace, mcpServers: [] });
      const replayed = updates.flatMap(({ update }) => (update.sessionUpdate === 'user_message_chunk' && update.content.type === 'text' ? [update.content.text] : []));
      expect(replayed, 'the replay shows the session as of the cut').toEqual(['make it two']);

      const response = await editor.prompt('make it 3');
      expect(response._meta?.[TURN_SEQ_META]).toBeGreaterThan(editor.turn2);
      expect(editor.sent().at(-1)).toEqual(['make it two', 'make it 3']);
      expect(prompts(await editor.log())).toEqual(['make it two', 'make it 3']);
    });
  });

  it('restores both, and the next turn sends neither the cut turn nor a restore notice about it', async () => {
    await serve([answer('Made it 3.', usage)], async (editor) => {
      const rewound = await editor.rewind(editor.turn2, { kind: 'both' });
      expect(rewound).toEqual({ files: [path.join(editor.workspace, 'a.ts')], prompt: 'make it three' });
      expect(fileOf(editor.workspace)).toContain('"two"');
      expect(prompts(await editor.log())).toEqual(['make it two']);
      await editor.prompt('make it 3');
      expect(editor.sent().at(-1)).toEqual(['make it two', 'make it 3']);
    });
  });

  it('refuses a turn that is not a prompt', async () => {
    await serve([], async (editor) => {
      await expect(editor.rewind(editor.turn2 + 1, { kind: 'conversation' })).rejects.toThrow(/no prompt at event/);
      await expect(
        editor.ctx.request(acp.methods.agent.session.fork, { sessionId: editor.sessionId, cwd: editor.workspace, _meta: { [FORK_AT_META]: editor.turn2 + 1 } }),
      ).rejects.toThrow(/no prompt at event/);
    });
  });
});

describe('gcode serve: fork from here', () => {
  it('starts a session with the conversation up to that turn and its own checkpoints, listed with its origin, that takes a new turn', async () => {
    await serve([answer('Made it 2.5.', usage)], async (editor, updates) => {
      const before = editor.file();
      const { sessionId: forkId } = await editor.ctx.request(acp.methods.agent.session.fork, {
        sessionId: editor.sessionId,
        cwd: editor.workspace,
        mcpServers: [],
        _meta: { [FORK_AT_META]: 1 },
      });
      expect(forkId).not.toBe(editor.sessionId);
      expect(editor.file(), 'the source is untouched').toBe(before);
      expect(fileOf(editor.workspace), 'a fork changes no files').toContain('"three"');

      const fork = await editor.log(forkId);
      expect(prompts(fork)).toEqual(['make it two']);
      expect(fork.events[0]).toMatchObject({ kind: 'session-start', session: { id: forkId, workspace: editor.workspace }, fork: { sessionId: editor.sessionId, turnSeq: 1, title: 'make it two' } });
      const checkpoints = fork.events.filter((e) => e.kind === 'checkpoint');
      expect(checkpoints.length).toBeGreaterThan(0);
      expect(checkpoints.every((c) => c.kind === 'checkpoint' && c.sessionId === forkId), 'checkpoints on its own lineage').toBe(true);

      const { sessions } = await editor.ctx.request(acp.methods.agent.session.list, { cwd: editor.workspace });
      const row = sessions.find((s) => s.sessionId === forkId);
      expect((row?._meta?.[SESSION_SUMMARY_META] as SessionSummaryMeta | undefined)?.forkedFrom).toEqual({ sessionId: editor.sessionId, turnSeq: 1, title: 'make it two' });

      updates.length = 0;
      await editor.ctx.request(acp.methods.agent.session.load, { sessionId: forkId, cwd: editor.workspace, mcpServers: [] });
      const turns = updates.flatMap(({ update }) => {
        const meta = update.sessionUpdate === 'user_message_chunk' ? (update._meta?.[REPLAYED_TURN_META] as ReplayedTurn | undefined) : undefined;
        return meta === undefined ? [] : [meta.seq];
      });
      expect(turns, 'the fork replays its one turn by its seq').toEqual([1]);

      await editor.prompt('make it 2.5', forkId);
      expect(editor.sent().at(-1)).toEqual(['make it two', 'make it 2.5']);
      const { tasks } = await editor.ctx.request<TasksResponse>(TASKS_METHOD, {});
      expect(tasks.find((t) => t.sessionId === forkId)?.forkedFrom).toEqual({ sessionId: editor.sessionId, turnSeq: 1, title: 'make it two' });

      await editor.rewind(1, { kind: 'files' }, forkId);
      expect(fileOf(editor.workspace), 'the fork rewinds files from its copied checkpoints').toContain('"one"');
      expect(prompts(await editor.log())).toEqual(['make it two', 'make it three']);
    });
  });
});
