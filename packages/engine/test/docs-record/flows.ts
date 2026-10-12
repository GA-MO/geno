import * as acp from '@agentclientprotocol/sdk';
import { STEER_META, TASKS_CAPABILITY, WORKFLOWS_CAPABILITY } from '@g-code/core';
import { engineShared, gcodeAgent } from '../../src/serve.js';
import { call, report, say, scripted, sessionIdOf } from '../conformance/scripted.js';
import type { Responder, ScriptEntry } from '../fake-model.js';
import { answer } from '../fake-transport.js';

/** One model request as the engine sent it, and the reply the fake streamed back. */
/** `aborted` is set when the engine aborted the request before any reply came. */
export type Exchange = { readonly url: string; readonly body: unknown; status: number; response: string; aborted?: true };

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
    const response = await fetch(input, init).catch((error: unknown) => {
      if (init?.signal?.aborted === true) exchange.aborted = true;
      throw error;
    });
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
const inFork = (answer: Responder): ScriptEntry => ({ when: (request) => anyText(request.body).includes('You are now plan'), answer });
const notFork = (marker: string, answer: Responder): ScriptEntry => ({
  when: (request) => firstText(request.body).includes(marker) && !anyText(request.body).includes('You are now plan'),
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
  /** Resolves once the run has done what the flow shows, after the last prompt's turn ends. */
  readonly settled?: (requests: () => number) => Promise<void>;
  /** Files the workspace holds besides the shared ones. */
  readonly files?: Readonly<Record<string, string>>;
  /** Capabilities the editor advertises in `_meta`, as VS Code does for Tasks and workflows. */
  readonly meta?: Readonly<Record<string, unknown>>;
};

/** Prompts from an editor over ACP in one session, as `gcode serve` runs them for VS Code. */
async function editorFlow(
  modes: readonly string[],
  mode: string,
  script: readonly ScriptEntry[],
  prompts: string | readonly string[],
  editor: Editor = {},
  env: Record<string, string> = {},
): Promise<Recording> {
  const run = await scripted('anthropic', script, files(modes, editor.files));
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
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { subagents: {}, ...(editor.meta === undefined ? {} : { _meta: editor.meta }) } });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: run.workspace, mcpServers: [] });
      await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: mode });
      for (const text of typeof prompts === 'string' ? [prompts] : prompts) await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
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
const CHECK_TASK = 'Add a "check" script to package.json that runs tsc --noEmit. Use npm pkg set, then read package.json back to confirm. Do not run the script.';
const WORKER_REPORT ="Changed src/version.ts:2: parseVersion now throws Error('empty version') on an empty string. The signature is unchanged. No test covers it yet.";

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
    what: 'The parent forks plan, which starts from a copy of the conversation and reports with its last text.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          notFork('throw on an empty string', read('toolu_read_1', 'src/version.ts')),
          notFork(
            'throw on an empty string',
            agentCall('toolu_agent_1', { agent: 'plan', fork: true, task: 'Plan the change we just discussed: which callers must change, and in what order.' }),
          ),
          inFork(grep('toolu_grep_1', 'parseVersion\\(')),
          inFork(
            say(
              '1. src/version.ts:2: throw Error("empty version") instead of returning [0, 0, 0].\n2. src/cli.ts:3: it passes process.argv[2] ?? "", so print usage when no argument is given before calling parseVersion.\n3. src/update.ts:3 passes its arguments through; leave it.\nRisk: any caller outside src. Check: run the CLI with no argument.',
            ),
          ),
          notFork('throw on an empty string', say('The plan: change src/version.ts:2, then guard src/cli.ts:3 so the CLI prints usage instead of throwing.')),
        ],
        [['--non-interactive', 'Plan how to make parseVersion throw on an empty string without breaking its callers.']],
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
          to('Add a check script', agentCall('toolu_agent_1', { agent: 'worker', task: CHECK_TASK }, 'I will hand this to a worker subagent.')),
          to(CHECK_TASK, read('toolu_read_1', 'package.json')),
          to(CHECK_TASK, call('', [{ id: 'toolu_bash_1', name: 'bash', input: { command: 'npm pkg set scripts.check="tsc --noEmit"' } }])),
          to(CHECK_TASK, read('toolu_read_2', 'package.json')),
          to(CHECK_TASK, report('Ran npm pkg set scripts.check="tsc --noEmit". package.json:7 now has "check": "tsc --noEmit"; I read the file back to confirm. I did not run it.', 'toolu_report_1')),
          to('Add a check script', say('worker added a check script (tsc --noEmit) to package.json:7. It has not run it yet.')),
        ],
        'Add a check script that runs tsc --noEmit to package.json.',
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
      what: 'The parent starts explore in the background and ends its turn; the report wakes the session for a new turn.',
      run: () =>
        editorFlow(
          ['ask'],
          'ask',
          [
            to('in the background', agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK, background: true }, 'Starting explore in the background.')),
            to(EXPLORE_TASK, async () => (await ended.opened, grep('toolu_grep_1', 'parseVersion\\('))),
            to('in the background', () => (ended.open(), say('explore is searching in the background; I will tell you what it finds.'))),
            to(EXPLORE_TASK, report(FOUND, 'toolu_report_1')),
            to('in the background', say('parseVersion is called in src/cli.ts:3 and twice in src/update.ts:3.')),
          ],
          'Find where parseVersion is called, in the background.',
          { settled: (requests) => until(() => requests() === 5, 'the woken turn') },
          { GCODE_WAKE_POLICY: JSON.stringify({ batchMs: 50, secondMs: 20 }) },
        ),
    };
  })(),
  {
    name: 'worktree-lane',
    what: 'The parent runs worker in a lane of its own and waits; the report names the kept lane.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to('in a lane', agentCall('toolu_agent_1', { agent: 'worker', task: WORKER_TASK, isolation: 'worktree' })),
          to(WORKER_TASK, read('toolu_read_1', 'src/version.ts')),
          to(WORKER_TASK, editVersion),
          to(WORKER_TASK, report(WORKER_REPORT, 'toolu_report_1')),
          to('in a lane', say('worker changed src/version.ts:2 in its lane. Review it there, then apply it with gcode lane apply.')),
        ],
        [['--non-interactive', '--allow-worker', 'Make parseVersion throw on an empty string, in a lane.']],
      ),
  },
  {
    name: 'refused-writer',
    what: 'In a non-interactive run without --allow-worker, Geno refuses to start worker, and the parent does the change itself.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to('Make parseVersion', agentCall('toolu_agent_1', { agent: 'worker', task: WORKER_TASK })),
          to('Make parseVersion', read('toolu_read_1', 'src/version.ts')),
          to('Make parseVersion', editVersion),
          to('Make parseVersion', say('worker could not start here, so I changed src/version.ts:2 myself: parseVersion now throws on an empty string.')),
        ],
        [['--non-interactive', 'Make parseVersion throw on an empty string.']],
      ),
  },
  (() => {
    let running = 0;
    const reviewing = gate();
    const REVIEW_TASK = 'Review the uncommitted change to src/version.ts for bugs.';
    const hang = { anthropic: { events: [], hang: true as const } };
    return {
      name: 'parent-stop',
      what: 'The user presses Stop while explore runs blocking and review runs in the background; the next turn shows what the parent model reads of both.',
      run: () =>
        editorFlow(
          ['ask'],
          'ask',
          [
            to('Review my change', agentCall('toolu_agent_1', { agent: 'review', task: REVIEW_TASK, background: true })),
            to(REVIEW_TASK, () => (reviewing.open(), hang)),
            to('Review my change', async () => (await reviewing.opened, agentCall('toolu_agent_2', { agent: 'explore', task: EXPLORE_TASK }))),
            to(EXPLORE_TASK, hang),
            to('Review my change', say('I stopped where you pressed Stop: neither subagent reported. Say if you want me to run them again.')),
          ],
          ['Review my change and find where parseVersion is called.', 'Go on.'],
          {
            update: (params, ctx) => {
              const update = params.update as { sessionUpdate: string; state?: { state: string } };
              if (update.sessionUpdate === 'subagent_update' && update.state?.state === 'running' && ++running === 2) {
                setTimeout(() => void ctx.notify(acp.methods.agent.session.cancel, { sessionId: params.sessionId }), 300);
              }
            },
          },
        ),
    };
  })(),
  (() => {
    let steer = (): Promise<unknown> => Promise.reject(new Error('explore has not started'));
    return {
      name: 'user-steers-child',
      what: "While explore runs, the user types into explore's own conversation; the message reaches explore at its next model call.",
      run: () =>
        editorFlow(
          ['ask'],
          'ask',
          [
            to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK })),
            to(EXPLORE_TASK, async () => (void steer(), await sleep(300), grep('toolu_grep_1', 'parseVersion\\('))),
            to(EXPLORE_TASK, report('src/cli.ts:3 calls parseVersion on the first CLI argument. I skipped src/update.ts, as you asked.', 'toolu_report_1')),
            to(ASK_WHERE, say('parseVersion is called in src/cli.ts:3; explore skipped src/update.ts as you asked.')),
          ],
          ASK_WHERE,
          {
            update: (params, ctx) => {
              const update = params.update as { sessionUpdate: string; sessionId?: string; state?: { state: string } };
              if (update.sessionUpdate !== 'subagent_update' || update.state?.state !== 'running') return;
              steer = () => ctx.request(acp.methods.agent.session.prompt, { sessionId: update.sessionId!, prompt: [{ type: 'text', text: 'Skip src/update.ts.' }], _meta: { [STEER_META]: true } });
            },
          },
        ),
    };
  })(),
  {
    name: 'workflow-run',
    what: 'The user runs /workflow fix-bug; each step runs as a subagent with its prompt filled in, and the run report wakes the chat.',
    run: () =>
      editorFlow(
        ['ask', 'auto'],
        'auto',
        [
          to('Find where', grep('toolu_grep_1', 'parseVersion')),
          to('Find where', report("src/version.ts:2 returns [0, 0, 0] for '' instead of failing.", 'toolu_report_1')),
          to('Fix it.', read('toolu_read_1', 'src/version.ts')),
          to('Fix it.', editVersion),
          to('Fix it.', report(WORKER_REPORT, 'toolu_report_2')),
          { when: (request) => anyText(request.body).includes('Started workflow fix-bug'), answer: say('The workflow fix-bug finished: parseVersion now throws on an empty string (src/version.ts:2).') },
        ],
        '/workflow fix-bug parseVersion accepts an empty string',
        {
          files: {
            '.g-code/workflows/fix-bug.json': `${JSON.stringify(
              {
                description: 'Find where a bug comes from, then fix it.',
                input: 'What is broken',
                steps: [
                  { id: 'reproduce', role: 'explore', prompt: 'Find where this goes wrong: {{input}}. Cite path:line.' },
                  { id: 'fix', role: 'worker', prompt: 'Fix it. What the reproduce step found:\n{{reproduce}}' },
                ],
              },
              null,
              2,
            )}\n`,
          },
          meta: { [TASKS_CAPABILITY]: true, [WORKFLOWS_CAPABILITY]: true },
          settled: (requests) => until(() => requests() === 6, 'the woken turn'),
        },
        { GCODE_WAKE_POLICY: JSON.stringify({ batchMs: 50, secondMs: 20 }) },
      ),
  },
];
