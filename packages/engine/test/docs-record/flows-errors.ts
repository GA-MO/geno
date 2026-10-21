import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PROMPT_ACTION_META, PROMPT_ACTIONS } from '@g-code/core';
import { engineShared, gcodeAgent } from '../../src/serve.js';
import type { ModelRequest } from '../fake-model.js';
import {
  acp,
  allowOnce,
  answer,
  anyText,
  call,
  capture,
  type Editor,
  type EditorRequest,
  editorFlow,
  files,
  type Flow,
  gate,
  raw,
  type Recording,
  type Responder,
  type ScriptEntry,
  scriptedRun,
  sleep,
  SMALL_WINDOW,
  to,
  until,
  usage,
  VERSION_DOC,
} from './kit.js';

/** A provider that took the request and sends nothing back until the engine gives up on it. */
const HANG = { anthropic: { events: [], hang: true as const } };

/** A prompt the editor sends: its text, the `_meta` a button adds, and whether the engine answers it with an error. */
type Prompt = { readonly text: string; readonly meta?: Readonly<Record<string, unknown>>; readonly rejected?: true };

/** A workspace, its store and the scripted model, made by the conformance harness. */
type Run = Awaited<ReturnType<typeof scriptedRun>>;

/** Stops the session's running turn, as the panel's Stop button does; set once the session exists. */
type Stopper = { stop: () => void };

/**
 * Prompts from an editor over ACP in one session, as `gcode serve` runs them for VS Code. Unlike kit's `editorFlow`, a
 * prompt may carry the `_meta` a panel button sends, the engine may answer a prompt with an error, and `stopper.stop`
 * presses Stop.
 */
async function editorRun(script: readonly ScriptEntry[] | Run, prompts: readonly Prompt[], editor: Editor = {}, env: Record<string, string> = {}, stopper?: Stopper): Promise<Recording> {
  const run = 'workspace' in script ? script : await scriptedRun(script, files(['ask'], editor.files));
  Object.assign(run.env, env);
  const seen = capture(run.io.fetch!);
  const io = { ...run.io, fetch: seen.fetch, ...(process.env['DOCS_RECORD_DEBUG'] ? { err: (line: string) => console.error(line) } : {}) };
  let connection: acp.ClientContext | undefined;
  const asked: EditorRequest[] = [];
  const client = acp
    .client({ name: 'docs-recorder' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      asked.push({ after: seen.exchanges.length, method: 'session/request_permission', params });
      return { outcome: { outcome: 'selected', optionId: editor.permission?.(params) ?? params.options[0]!.optionId } };
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => editor.update?.(params, connection!));
  const engine = engineShared(io);
  try {
    await client.connectWith(gcodeAgent(io, run.store, { maxTurns: 10, maxCostUsd: 1 }, undefined, engine), async (ctx) => {
      connection = ctx;
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { subagents: {} } });
      if (prompts.length === 0) return void (await editor.settled?.(() => seen.exchanges.length, run.workspace));
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: run.workspace, mcpServers: [] });
      await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: 'ask' });
      if (stopper !== undefined) stopper.stop = () => void ctx.notify(acp.methods.agent.session.cancel, { sessionId });
      for (const prompt of prompts) {
        const sent = ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: prompt.text }], ...(prompt.meta === undefined ? {} : { _meta: prompt.meta }) });
        if (prompt.rejected !== true) await sent;
        else if ((await sent.then(() => 'answered', () => 'rejected')) !== 'rejected') throw new Error(`the engine answered "${prompt.text}", which the flow expects it to fail`);
      }
      await editor.settled?.(() => seen.exchanges.length, run.workspace);
    });
  } finally {
    await engine.jobs.kill('engine-exit', 'all');
  }
  await seen.done();
  return { exchanges: seen.exchanges, editor: asked, workspace: run.workspace, home: run.env['HOME']! };
}

/** Presses Stop a moment after `responder`'s request arrives, while the engine waits on its answer. */
const stopOnArrival =
  (stopper: Stopper, responder: Responder): Responder =>
  (request) => {
    setTimeout(() => stopper.stop(), 300);
    return typeof responder === 'function' ? responder(request) : responder;
  };

/** `gcode serve` as one file, so a flow can run an engine in a process of its own and kill it. */
async function engineBundle(): Promise<string> {
  const outfile = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-bundle-')), 'cli.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../../src/embedded.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'error',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  return outfile;
}

/** An editor connection to an engine's Unix socket, once the engine listens there. */
async function dial(socket: string): Promise<acp.ClientContext> {
  const client = acp.client({ name: 'docs-recorder' });
  for (;;) {
    const wire = await new Promise<ReturnType<typeof connect> | undefined>((resolve) => {
      const s = connect(socket);
      s.once('connect', () => resolve(s));
      s.once('error', () => resolve(undefined));
    });
    if (wire !== undefined) return client.connect(acp.ndJsonStream(Writable.toWeb(wire) as WritableStream<Uint8Array>, Readable.toWeb(wire) as ReadableStream<Uint8Array>)).agent;
    await sleep(25);
  }
}

const SUMMARY_MARK = 'You write the working notes a coding agent continues from';
const isSummary = (request: ModelRequest): boolean => JSON.stringify(request.body.system ?? '').includes(SUMMARY_MARK);
/** A request of the agent's own conversation, not the compaction's summary call. */
const turnOf = (marker: string, answer: Responder): ScriptEntry => ({ when: (request) => !isSummary(request) && anyText(request.body).includes(marker), answer });

const EXPLAIN = 'Explain what src/version.ts does.';
const READ_VERSION = call('I will read src/version.ts first.', [{ id: 'toolu_read_1', name: 'read', input: { path: 'src/version.ts' } }], { input: 9_800 });
const EXPLAINED =
  'src/version.ts exports parseVersion. It returns [0, 0, 0] for an empty string; otherwise it splits the text on dots and reads major, minor and patch as numbers, with 0 for a missing part.';

/** Anthropic's own API, so an error reply has the shape and headers Anthropic sends. */
const ANTHROPIC = { GCODE_PROVIDER: 'anthropic', GCODE_MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: 'sk-fake' };
/** An HTTP error as Anthropic answers one: its JSON error body, with the request id in the body and a header. */
const anthropicError = (status: number, type: string, message: string, requestId: string, headers: Record<string, string> = {}) =>
  raw({ events: [], failure: { status, body: { type: 'error', error: { type, message }, request_id: requestId }, headers: { 'request-id': requestId, 'x-should-retry': 'true', ...headers } } });
const OVERLOADED = anthropicError(529, 'overloaded_error', 'Overloaded', 'req_011CUNwQ7p3Hc2xZbV8sKmRt');
/** A 429 with the reset Anthropic sends: `retry-after` in seconds, and the request bucket at zero with its reset time. */
const RATE_LIMITED = () =>
  anthropicError(
    429,
    'rate_limit_error',
    'This request would exceed the rate limit for your organization of 50 requests per minute. For details, refer to: https://docs.claude.com/en/api/rate-limits. You can see the response headers for current usage. Please reduce the prompt length or the maximum tokens requested, or try again later.',
    'req_011CUNwRkT5mJd9aYc4eLqPw',
    {
      'retry-after': '3',
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-requests-remaining': '0',
      'anthropic-ratelimit-requests-reset': new Date(Math.ceil(Date.now() / 1000) * 1000 + 3000).toISOString().replace('.000Z', 'Z'),
    },
  )();

const UNTESTED = 'สำรวจว่าโมดูลไหนไม่มีเทสต์';
const UNTESTED_TASK = 'List the modules under src/ that have no test file next to them or under test/. Answer with each path.';

export const ERRORS: readonly Flow[] = [
  {
    name: 'err-transient-retried',
    what: 'The provider takes the second request and sends nothing for the first-byte limit (2s here, set by GCODE_STREAM_FIRST_BYTE_TIMEOUT_MS); Geno gives up on it, waits 1s, and sends the same conversation again, which is answered.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [to(EXPLAIN, READ_VERSION), to(EXPLAIN, HANG), to(EXPLAIN, raw(answer(EXPLAINED, usage(10_100))))],
        EXPLAIN,
        {},
        { GCODE_STREAM_FIRST_BYTE_TIMEOUT_MS: '2000' },
      ),
  },
  {
    name: 'err-overloaded-retried',
    what: "Anthropic answers the second request with 529 overloaded_error; Geno retries it as a transient failure after 1s, and the same conversation sent again is answered.",
    run: () => editorFlow(['ask'], 'ask', [to(EXPLAIN, READ_VERSION), to(EXPLAIN, OVERLOADED), to(EXPLAIN, raw(answer(EXPLAINED, usage(10_100))))], EXPLAIN, {}, ANTHROPIC),
  },
  {
    name: 'err-rate-limited-waits',
    what: 'Anthropic answers the second request with 429 rate_limit_error and retry-after 3; Geno waits for that reset, plus up to 3s, then sends the same conversation again, which is answered.',
    run: () => editorFlow(['ask'], 'ask', [to(EXPLAIN, READ_VERSION), to(EXPLAIN, RATE_LIMITED), to(EXPLAIN, raw(answer(EXPLAINED, usage(10_100))))], EXPLAIN, {}, ANTHROPIC),
  },
  {
    name: 'err-exception-escapes',
    what: "On the Anthropic wire, the answer's stream closes cleanly after part of the text and before message_stop; the error escapes the loop and the prompt request fails.",
    run: () => {
      const whole = answer('This file has one function, parseVersion. It reads a version such as "1.2.3" and returns', usage(10_100));
      // The connection closes after the sixth piece of text: no content_block_stop, message_delta or message_stop.
      const firstText = whole.events.findIndex((e) => e.type === 'content_block_delta' && e['index'] === 0);
      const torn = { ...whole, events: whole.events.slice(0, firstText + 6) };
      return editorRun([to(EXPLAIN, READ_VERSION), to(EXPLAIN, raw(torn))], [{ text: EXPLAIN, rejected: true }], {}, SMALL_WINDOW);
    },
  },
  (() => {
    const stopper: Stopper = { stop: () => {} };
    let pressed = false;
    return {
      name: 'ctl-stop-while-tools-run',
      what: 'The model asks for node --test and a read in one answer; the user presses Stop while node --test runs; the next prompt carries the answers Geno wrote for both calls.',
      run: () =>
        editorRun(
          [
            to(
              'Run the tests',
              call(
                'I will run the tests, then read src/date.ts.',
                [
                  { id: 'toolu_bash_1', name: 'bash', input: { command: 'node --test', description: 'Run the tests' } },
                  { id: 'toolu_read_1', name: 'read', input: { path: 'src/date.ts' } },
                ],
                { input: 9_800 },
              ),
            ),
            to('Run the tests', raw(answer('You stopped node --test before it finished, so I have no result from it, and src/date.ts was not read. Say if you want me to run them again.', usage(10_100)))),
          ],
          [{ text: 'Run the tests and check src/date.ts.' }, { text: 'What happened?' }],
          {
            permission: allowOnce,
            update: (params) => {
              const update = params.update as { sessionUpdate: string; status?: string };
              if (!pressed && update.sessionUpdate.startsWith('tool_call') && update.status === 'in_progress') {
                pressed = true;
                setTimeout(() => stopper.stop(), 1500);
              }
            },
            files: {
              // A slow suite, so the run is still going when the user presses Stop.
              'test/date.test.mjs': "import { test } from 'node:test';\n\ntest('today is a date', async () => {\n  await new Promise((resolve) => setTimeout(resolve, 30_000));\n});\n",
              'src/date.ts': 'export const today = (): string => new Date().toISOString().slice(0, 10);\n',
            },
          },
          {},
          stopper,
        ),
    };
  })(),
  (() => {
    const stopper: Stopper = { stop: () => {} };
    return {
      name: 'ctl-stop-during-compaction',
      what: 'The context passes the compaction threshold (lowered with GCODE_COMPACT_AT so a short session reaches it); the user presses Stop while the summary call is out, and the turn ends stopped.',
      run: () =>
        editorRun(
          [
            turnOf(
              'Read docs/version.md',
              call(
                'I will read both docs.',
                [
                  { id: 'toolu_read_1', name: 'read', input: { path: 'docs/version.md' } },
                  { id: 'toolu_read_2', name: 'read', input: { path: 'docs/cases.md' } },
                ],
                { input: 9_800 },
              ),
            ),
            turnOf('Read docs/version.md', raw(answer('Both docs list 180 cases of parseVersion. Each says that a missing part of a version counts as 0.', usage(21_000)))),
            turnOf('Now read src/cli.ts', call('I will read src/cli.ts.', [{ id: 'toolu_read_3', name: 'read', input: { path: 'src/cli.ts' } }], { input: 21_100 })),
            { when: isSummary, answer: stopOnArrival(stopper, HANG) },
          ],
          [{ text: 'Read docs/version.md and docs/cases.md and tell me what they cover.' }, { text: 'Now read src/cli.ts and tell me how it calls parseVersion.' }],
          { files: { 'docs/version.md': VERSION_DOC(180), 'docs/cases.md': VERSION_DOC(180) } },
          { GCODE_COMPACT_AT: '21100' },
          stopper,
        ),
    };
  })(),
  (() => {
    const stopper: Stopper = { stop: () => {} };
    return {
      name: 'mstop-no-reply-continue-retry',
      what: 'The user presses Stop before the model answers, then presses Continue; the new turn sends the unanswered prompt, the stopped-turn note and the Continue note in one user message.',
      run: () =>
        editorRun(
          [to(EXPLAIN, stopOnArrival(stopper, HANG)), to(EXPLAIN, raw(answer(EXPLAINED, usage(9_900))))],
          [{ text: EXPLAIN }, { text: PROMPT_ACTIONS.continue, meta: { [PROMPT_ACTION_META]: 'continue' } }],
          {},
          {},
          stopper,
        ),
    };
  })(),
  {
    name: 'ctl-stop-while-held',
    what: 'In the CLI, the model starts explore in the background and ends its answer; the turn stays open for the report; Ctrl-C stops the turn, and Geno stops explore while its model call is out.',
    run: async () => {
      const childCalling = gate();
      const parentAnswered = gate();
      const run = await scriptedRun([
        to(UNTESTED, call('I will have explore look for modules without tests in the background.', [{ id: 'toolu_agent_1', name: 'agent', input: { agent: 'explore', task: UNTESTED_TASK, background: true } }], { input: 9_700 })),
        to(UNTESTED_TASK, call('I will start with the files under src/.', [{ id: 'toolu_list_1', name: 'list', input: { directory: 'src' } }], { input: 2_300 })),
        to(UNTESTED, (request) => (parentAnswered.open(), raw(answer('ผมให้ explore สำรวจอยู่ เดี๋ยวสรุปให้เมื่อได้ผล', usage(10_300)))(request))),
        to(UNTESTED_TASK, () => (childCalling.open(), HANG)),
      ], files(['non-interactive']));
      const seen = capture(run.io.fetch!);
      let interrupt: AbortController | undefined;
      const held = Promise.all([childCalling.opened, parentAnswered.opened]).then(async () => {
        await until(() => interrupt !== undefined, 'the CLI to write');
        await sleep(300);
        interrupt!.abort();
      });
      const result = await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', UNTESTED], {
        fetch: seen.fetch,
        onWrite: (_, controller) => (interrupt = controller),
        onErr: (_, controller) => (interrupt = controller),
      });
      await held;
      if (result.code !== 130) throw new Error(`gcode agent exited ${result.code}, not 130: ${result.stderr}`);
      await seen.done();
      return { exchanges: seen.exchanges, workspace: run.workspace, home: run.env['HOME']! };
    },
  },
  {
    name: 'err-engine-crash-restart',
    what: 'An engine in its own process finds the provider unreachable and logs an offline wait; it is killed; the next engine for the folder takes up the wait, finds the host up, and sends the call. Only the second engine reaches the scripted model, so only its request is recorded.',
    run: async () => {
      const run = await scriptedRun([to(EXPLAIN, raw(answer(EXPLAINED, usage(9_900))))], files(['ask']));
      const socket = path.join(await mkdtemp('/tmp/gs-'), 'e.sock');
      // Nothing listens on port 9, so the first engine's call is refused before any byte, as when the network is down.
      const first = spawn(process.execPath, [await engineBundle(), 'serve', '--socket', socket], {
        cwd: run.workspace,
        env: { ...run.env, DASHSCOPE_BASE_URL: 'http://127.0.0.1:9/apps/anthropic' },
        stdio: 'ignore',
      });
      try {
        const window = await dial(socket);
        await window.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
        const { sessionId } = await window.request(acp.methods.agent.session.new, { cwd: run.workspace, mcpServers: [] });
        await window.request(acp.methods.agent.session.setMode, { sessionId, modeId: 'ask' });
        void window.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: EXPLAIN }] }).catch(() => {});
        const log = path.join(run.store.sessionsDir, `${sessionId}.jsonl`);
        const logged = async () => (await readFile(log, 'utf8').catch(() => '')).includes('"kind":"wait"');
        for (let at = Date.now(); !(await logged()); await sleep(50)) if (Date.now() - at > 20_000) throw new Error('the first engine logged no wait');
      } finally {
        const exited = new Promise((resolve) => first.once('exit', resolve));
        first.kill('SIGKILL');
        await exited;
      }
      // The next engine for the folder, as VS Code opens it a second later; it takes the wait up on its first connection.
      return editorRun(run, [], {
        settled: async (requests) => {
          await until(() => requests() === 1, 'the call after the wait');
          await sleep(500);
        },
      });
    },
  },
];
