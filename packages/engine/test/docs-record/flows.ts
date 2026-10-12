import * as acp from '@agentclientprotocol/sdk';
import { engineShared, gcodeAgent } from '../../src/serve.js';
import { call, report, say, scripted, sessionIdOf } from '../conformance/scripted.js';
import type { Responder, ScriptEntry } from '../fake-model.js';
import { answer } from '../fake-transport.js';

/** One model request as the engine sent it, and the reply the fake streamed back. */
export type Exchange = { readonly url: string; readonly body: unknown; status: number; response: string };

/** A request the engine sent the editor over ACP, and how many model requests came before it. */
export type EditorRequest = { readonly after: number; readonly method: string; readonly params: unknown };

export type Recording = { readonly exchanges: readonly Exchange[]; readonly editor?: readonly EditorRequest[]; readonly workspace: string; readonly home: string };

export type Flow = { readonly name: string; readonly what: string; readonly run: () => Promise<Recording> };

const VERSION = `export function parseVersion(text: string): [number, number, number] {
  if (text === '') return [0, 0, 0];
  const [major, minor, patch] = text.split('.').map(Number);
  return [major ?? 0, minor ?? 0, patch ?? 0];
}
`;

const files = (modes: readonly string[], extra: Readonly<Record<string, string>> = {}) => ({
  'package.json': `${JSON.stringify({ name: 'shop', private: true, type: 'module', scripts: { test: 'vitest run' } }, null, 2)}\n`,
  'src/version.ts': VERSION,
  'src/cli.ts': `import { parseVersion } from './version.js';\n\nconsole.log(parseVersion(process.argv[2] ?? ''));\n`,
  'src/update.ts': `import { parseVersion } from './version.js';\n\nexport const isNewer = (a: string, b: string) => parseVersion(a)[0] > parseVersion(b)[0];\n`,
  '.gcode.json': `${JSON.stringify({ agentTool: modes })}\n`,
  ...extra,
});

/** Keeps every model request and the bytes of the fake's reply, in the order the requests came. */
function capture(fetch: typeof globalThis.fetch) {
  const exchanges: Exchange[] = [];
  const reading: Promise<void>[] = [];
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if ((init?.method ?? 'GET') !== 'POST') return fetch(input, init);
    const exchange: Exchange = { url: url.replace(/^https:\/\/ws-1\.example\.com\/apps\/anthropic/, '<DASHSCOPE_BASE_URL>'), body: JSON.parse(String(init?.body)), status: 0, response: '' };
    exchanges.push(exchange);
    if (process.env['DOCS_RECORD_DEBUG']) console.error(exchanges.length, JSON.stringify((exchange.body as Body).messages.at(-1)).slice(0, 300));
    const response = await fetch(input, init);
    exchange.status = response.status;
    if (response.body === null) return response;
    const [mine, theirs] = response.body.tee();
    reading.push(
      (async () => {
        const decoder = new TextDecoder();
        try {
          for await (const piece of mine) exchange.response += decoder.decode(piece, { stream: true });
        } catch {
          // A stream the engine aborted keeps what arrived before the abort.
        }
      })(),
    );
    return new Response(theirs, { status: response.status, headers: response.headers });
  };
  return { fetch: wrapped, exchanges, done: () => Promise.all(reading) };
}

type Body = { readonly messages: readonly { readonly role: string; readonly content: unknown }[] };
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : (content as readonly { readonly text?: string; readonly content?: unknown }[]).map((block) => block.text ?? textOf(block.content ?? '')).join('\n');
const firstText = (body: Body): string => textOf(body.messages[0]?.content);
const anyText = (body: Body): string => body.messages.map((message) => textOf(message.content)).join('\n');

/** The next request of the conversation whose first message holds `marker`. */
const to = (marker: string, answer: Responder): ScriptEntry => ({ when: (request) => firstText(request.body).includes(marker), answer });
/** The next request of a fork, whose first messages are its parent's, by a marker anywhere in its conversation. */
const inFork = (answer: Responder): ScriptEntry => ({ when: (request) => anyText(request.body).includes('You are now explore'), answer });
const notFork = (marker: string, answer: Responder): ScriptEntry => ({
  when: (request) => firstText(request.body).includes(marker) && !anyText(request.body).includes('You are now explore'),
  answer,
});

const childIdIn = (body: Body): string => /subagent session ([0-9a-f-]{36})|session="([0-9a-f-]{36})"/.exec(anyText(body))!.slice(1).find(Boolean)!;

const agentCall = (id: string, input: Record<string, unknown>, text = '') => call(text, [{ id, name: 'agent', input }]);
const grep = (id: string, pattern: string) => call('', [{ id, name: 'grep', input: { pattern } }]);
const read = (id: string, file: string) => call('', [{ id, name: 'read', input: { path: file } }]);
const loadMessageAgent = call('', [{ id: 'toolu_load_1', name: 'tool_search', input: { select: ['message_agent'] } }]);

const ASK_WHERE = 'Where is parseVersion called?';
const EXPLORE_TASK = 'Find every call of parseVersion (defined in src/version.ts) outside that file. Answer with path:line for each call.';
const FOUND = 'src/cli.ts:3 calls parseVersion on the first CLI argument.\nsrc/update.ts:3 calls it twice, in isNewer.';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A CLI run of `gcode agent` per prompt, in one session after the first. */
async function cliFlow(modes: readonly string[], script: readonly ScriptEntry[], prompts: readonly (readonly string[])[], extra: Readonly<Record<string, string>> = {}): Promise<Recording> {
  const run = await scripted('anthropic', script, files(modes, extra));
  const seen = capture(run.io.fetch!);
  let session: string | undefined;
  for (const args of prompts) {
    const where = session === undefined ? ['--workspace', run.workspace] : ['--session', session];
    const result = await run.cli(['agent', ...where, ...args], { fetch: seen.fetch });
    if (result.code !== 0) throw new Error(`gcode agent ${args.join(' ')} exited ${result.code}: ${result.stderr}`);
    session ??= sessionIdOf(result.stdout);
  }
  await seen.done();
  return { exchanges: seen.exchanges, workspace: run.workspace, home: run.env['HOME']! };
}

type Editor = {
  /** Answers a permission request with the option it picks. */
  readonly permission?: (params: acp.RequestPermissionRequest) => string;
  /** Called on each session update, with the connection. */
  readonly update?: (params: acp.SessionNotification, ctx: acp.ClientContext) => void;
  /** Resolves once the run has done what the flow shows, after the prompt's turn ends. */
  readonly settled?: (requests: () => number) => Promise<void>;
};

/** One prompt from an editor over ACP, as `gcode serve` runs it for VS Code. */
async function editorFlow(modes: readonly string[], mode: string, script: readonly ScriptEntry[], prompt: string, editor: Editor = {}, env: Record<string, string> = {}): Promise<Recording> {
  const run = await scripted('anthropic', script, files(modes));
  Object.assign(run.env, env);
  const seen = capture(run.io.fetch!);
  const io = { ...run.io, fetch: seen.fetch };
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
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: run.workspace, mcpServers: [] });
      await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: mode });
      await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: prompt }] });
      await editor.settled?.(() => seen.exchanges.length);
    });
  } finally {
    await engine.jobs.kill('engine-exit', 'all');
  }
  await seen.done();
  return { exchanges: seen.exchanges, editor: asked, workspace: run.workspace, home: run.env['HOME']! };
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A promise and the function that settles it. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const WORKER_TASK =
  'In src/version.ts, make parseVersion throw an Error("empty version") on an empty string instead of returning [0, 0, 0]. Keep its signature. Report the line you changed.';
const editVersion = call('', [
  { id: 'toolu_edit_1', name: 'edit', input: { path: 'src/version.ts', old_str: "  if (text === '') return [0, 0, 0];", new_str: "  if (text === '') throw new Error('empty version');" } },
]);
const WORKER_REPORT = "Changed src/version.ts:2: parseVersion now throws Error('empty version') on an empty string. The signature is unchanged. No test covers it yet.";

export const FLOWS: readonly Flow[] = [
  {
    name: 'worker-blocking',
    what: 'The parent hands worker a change and waits for its report in the same call.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to('Make parseVersion', agentCall('toolu_agent_1', { agent: 'worker', task: WORKER_TASK }, 'I will hand this change to a worker subagent.')),
          to(WORKER_TASK, read('toolu_read_1', 'src/version.ts')),
          to(WORKER_TASK, editVersion),
          to(WORKER_TASK, report(WORKER_REPORT, 'toolu_report_1')),
          to('Make parseVersion', say('parseVersion now throws on an empty string (src/version.ts:2). Nothing tests that yet.')),
        ],
        [['--non-interactive', '--allow-worker', 'Make parseVersion throw on an empty string.']],
      ),
  },
  {
    name: 'explore',
    what: 'The parent asks the read-only explore subagent where a function is called.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK })),
          to(EXPLORE_TASK, grep('toolu_grep_1', 'parseVersion\\(')),
          to(EXPLORE_TASK, report(FOUND, 'toolu_report_1')),
          to(ASK_WHERE, say('parseVersion is called in src/cli.ts:3 and twice in src/update.ts:3.')),
        ],
        [['--non-interactive', ASK_WHERE]],
      ),
  },
  {
    name: 'report-nudge',
    what: 'explore ends a turn with text and no report call; Geno nudges it once, and it reports.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK })),
          to(EXPLORE_TASK, grep('toolu_grep_1', 'parseVersion\\(')),
          to(EXPLORE_TASK, say(FOUND)),
          to(EXPLORE_TASK, report(FOUND, 'toolu_report_1')),
          to(ASK_WHERE, say('parseVersion is called in src/cli.ts:3 and twice in src/update.ts:3.')),
        ],
        [['--non-interactive', ASK_WHERE]],
      ),
  },
  {
    name: 'report-forced',
    what: "explore uses its turns on searches; Geno forces its last call to be report.",
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK })),
          to(EXPLORE_TASK, grep('toolu_grep_1', 'parseVersion')),
          to(EXPLORE_TASK, read('toolu_read_1', 'src/cli.ts')),
          to(EXPLORE_TASK, read('toolu_read_2', 'src/update.ts')),
          to(EXPLORE_TASK, report(FOUND, 'toolu_report_1')),
          to(ASK_WHERE, say('parseVersion is called in src/cli.ts:3 and twice in src/update.ts:3.')),
        ],
        [['--non-interactive', ASK_WHERE]],
      ),
  },
  {
    name: 'project-agent',
    what: "The parent starts an agent the project defines in .claude/agents/release-notes.md.",
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to('Draft a release note', agentCall('toolu_agent_1', { agent: 'release-notes', task: 'Write a one-line release note for the change to parseVersion in src/version.ts.' })),
          to('Write a one-line release note', read('toolu_read_1', 'src/version.ts')),
          to('Write a one-line release note', report('- parseVersion now returns [0, 0, 0] for an empty string.', 'toolu_report_1')),
          to('Draft a release note', say('Release note: parseVersion now returns [0, 0, 0] for an empty string.')),
        ],
        [['--non-interactive', 'Draft a release note for parseVersion.']],
        {
          '.claude/agents/release-notes.md':
            '---\nname: release-notes\ndescription: Writes a short release note for a change.\ntools: Read, Grep\nmaxTurns: 3\n---\nYou write release notes. Read the changed code, then report one Markdown bullet in plain words a user understands. No file paths.\n',
        },
      ),
  },
  {
    name: 'fork',
    what: 'The parent forks explore, which starts from a copy of the conversation.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          notFork('Which of these', read('toolu_read_1', 'src/version.ts')),
          notFork(
            'Which of these',
            agentCall('toolu_agent_1', { agent: 'explore', fork: true, task: 'Find which callers of the function we just read would break if it threw on an empty string.' }),
          ),
          inFork(grep('toolu_grep_1', 'parseVersion\\(')),
          inFork(say('src/cli.ts:3 passes process.argv[2] ?? "", so it would throw when no argument is given. src/update.ts:3 passes its arguments through.')),
          notFork('Which of these', say('Only src/cli.ts:3 can pass an empty string, when the CLI gets no argument.')),
        ],
        [['--non-interactive', 'Which of these callers could break if parseVersion threw on an empty string?']],
      ),
  },
  {
    name: 'at-mention',
    what: 'The user types @explore in the prompt; Geno makes the agent call itself, with no parent model call first.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [to(ASK_WHERE, grep('toolu_grep_1', 'parseVersion\\(')), to(ASK_WHERE, report(FOUND, 'toolu_report_1'))],
        [['--non-interactive', `@explore ${ASK_WHERE}`]],
      ),
  },
  {
    name: 'message-finished',
    what: 'In a later turn the parent sends message_agent to explore, which had finished; Geno resumes it from its own log.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK })),
          to(EXPLORE_TASK, report(FOUND, 'toolu_report_1')),
          to(ASK_WHERE, say('parseVersion is called in src/cli.ts:3 and twice in src/update.ts:3.')),
          to(ASK_WHERE, loadMessageAgent),
          to(ASK_WHERE, (request) => call('', [{ id: 'toolu_msg_1', name: 'message_agent', input: { agent_session: childIdIn(request.body), text: 'Which of those calls can pass an empty string?' } }])),
          to(EXPLORE_TASK, report('src/cli.ts:3 can: it passes process.argv[2] ?? "". src/update.ts:3 passes its own arguments through.', 'toolu_report_2')),
          to(ASK_WHERE, say('Only src/cli.ts:3 can pass an empty string.')),
        ],
        [['--non-interactive', ASK_WHERE], ['--non-interactive', 'Which of them can pass an empty string?']],
      ),
  },
  (() => {
    const steered = gate();
    const reported = gate();
    return {
      name: 'background-steer',
      what: 'The parent starts explore in the background, steers it with message_agent while it runs, and its report arrives during the parent’s turn.',
      run: () =>
        cliFlow(
          ['non-interactive'],
          [
            to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK, background: true })),
            to(ASK_WHERE, loadMessageAgent),
            to(ASK_WHERE, (request) => (steered.open(), call('', [{ id: 'toolu_msg_1', name: 'message_agent', input: { agent_session: childIdIn(request.body), text: 'Skip test files.' } }]))),
            to(ASK_WHERE, async () => {
              await reported.opened;
              await sleep(300);
              return read('toolu_read_1', 'package.json');
            }),
            to(EXPLORE_TASK, async () => (await steered.opened, await sleep(300), grep('toolu_grep_1', 'parseVersion\\('))),
            to(EXPLORE_TASK, () => (reported.open(), report(FOUND, 'toolu_report_1'))),
            to(ASK_WHERE, say('parseVersion is called in src/cli.ts:3 and twice in src/update.ts:3, and the package has no test files to skip.')),
          ],
          [['--non-interactive', ASK_WHERE]],
        ),
    };
  })(),
  (() => {
    const waiting = gate();
    return {
      name: 'cli-holds',
      what: 'The parent starts explore in the background and ends its turn; the CLI holds the turn open until the report wakes it.',
      run: () =>
        cliFlow(
          ['non-interactive'],
          [
            to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK, background: true })),
            to(ASK_WHERE, () => (waiting.open(), say('explore is searching in the background; I will answer when its report comes.'))),
            to(EXPLORE_TASK, async () => (await waiting.opened, grep('toolu_grep_1', 'parseVersion\\('))),
            to(EXPLORE_TASK, report(FOUND, 'toolu_report_1')),
            to(ASK_WHERE, say('parseVersion is called in src/cli.ts:3 and twice in src/update.ts:3.')),
          ],
          [['--non-interactive', ASK_WHERE]],
        ),
    };
  })(),
  {
    name: 'child-permission',
    what: 'In Ask mode worker asks to run a command off the safe list; the editor shows the card and the user picks Allow.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to('test script', agentCall('toolu_agent_1', { agent: 'worker', task: 'Add a "test" script that runs vitest to package.json, using npm pkg set.' })),
          to('Add a "test" script', call('', [{ id: 'toolu_bash_1', name: 'bash', input: { command: 'npm pkg set scripts.check="tsc --noEmit"' } }])),
          to('Add a "test" script', report('Ran npm pkg set scripts.check="tsc --noEmit"; package.json now has a check script.', 'toolu_report_1')),
          to('test script', say('worker added the check script to package.json.')),
        ],
        'Add a test script to package.json.',
        { permission: (params) => params.options.find((option) => option.kind === 'allow_once')!.optionId },
      ),
  },
  {
    name: 'child-cancelled',
    what: 'The user cancels explore from its row while it streams; the parent gets the partial report.',
    run: () => {
      let cancelled = false;
      return editorFlow(
        ['ask'],
        'ask',
        [
          to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK })),
          to(EXPLORE_TASK, { anthropic: { ...answer('src/cli.ts:3 calls parseVersion. Still checking src/update.ts', { input: 1000, cacheRead: 0, cacheWrite: 0 }), stallAfter: 12 } }),
          to(ASK_WHERE, say('I stopped explore before it finished. It had found src/cli.ts:3 so far.')),
        ],
        ASK_WHERE,
        {
          update: (params, ctx) => {
            const update = params.update as { sessionUpdate: string; sessionId?: string; state?: { state: string } };
            if (update.sessionUpdate === 'subagent_update' && update.state?.state === 'running' && !cancelled) {
              cancelled = true;
              setTimeout(() => void ctx.notify(acp.methods.agent.session.cancel, { sessionId: update.sessionId! }), 300);
            }
          },
        },
      );
    },
  },
  (() => {
    const ended = gate();
    return {
      name: 'background-wake',
      what: 'The parent starts worker in the background in a lane and ends its turn; the report wakes the session for a new turn.',
      run: () =>
        editorFlow(
          ['ask', 'auto'],
          'auto',
          [
            to('in the background', agentCall('toolu_agent_1', { agent: 'worker', task: WORKER_TASK, background: true, isolation: 'worktree' }, 'Starting a worker in a lane.')),
            to('in the background', () => (ended.open(), say('The worker runs in its own lane; I will read its report when it comes.'))),
            to(WORKER_TASK, async () => (await ended.opened, read('toolu_read_1', 'src/version.ts'))),
            to(WORKER_TASK, editVersion),
            to(WORKER_TASK, report(WORKER_REPORT, 'toolu_report_1')),
            to('in the background', say('The worker changed src/version.ts:2 in its lane. Review it with gcode lane apply.')),
          ],
          'Make parseVersion throw on an empty string, in the background.',
          { settled: (requests) => until(() => requests() === 6, 'the woken turn') },
          { GCODE_WAKE_POLICY: JSON.stringify({ batchMs: 50, secondMs: 20 }) },
        ),
    };
  })(),
];
