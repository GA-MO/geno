import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { fakeMcpServer } from '../fake-mcp-server.js';
import { mcpSessions } from '../../src/mcp/sessions.js';
import { engineShared, gcodeAgent } from '../../src/serve.js';
import {
  acp,
  agentCall,
  allowOnce,
  answer,
  anyText,
  ASK_WHERE,
  call,
  capture,
  cliFlow,
  editorFlow,
  EXPLORE_TASK,
  type EditorRequest,
  files,
  type Flow,
  FOUND,
  gate,
  inputOf,
  raw,
  type Recording,
  type Responder,
  say,
  type ScriptEntry,
  scriptedRun,
  sleep,
  to,
  usage,
} from './kit.js';

/** A tool call turn with the sentence a model writes before it, since a provider never streams an empty text block. */
const use = (text: string, id: string, name: string, input: Record<string, unknown>) => call(text, [{ id, name, input }]);
const readFile = (text: string, id: string, file: string) => use(text, id, 'read', { path: file });
const reportWith = (text: string, id: string, message: string) => use(text, id, 'report', { message });

const SUMMARY = 'You write the working notes';
const isSummary = (body: { readonly system?: unknown }) => JSON.stringify(body.system ?? '').includes(SUMMARY);
/** The next request of the conversation whose first message holds `marker`, but not the summary call of a compaction. */
const turnOf = (marker: string, answer: Responder): ScriptEntry => ({ when: (request) => !isSummary(request.body) && anyText(request.body).includes(marker), answer });

/**
 * The overflow flow runs on a dated Haiku 4.5 name. Geno has no capability row for it, so it knows no window: it neither
 * lowers `max_tokens` to the room left nor compacts before a call, and only the provider sees the window fill.
 */
const UNLISTED_HAIKU = { GCODE_PROVIDER: 'anthropic', GCODE_MODEL: 'claude-haiku-4-5-20251001', ANTHROPIC_API_KEY: 'sk-fake' };
const HAIKU_WINDOW = 200_000;
/** Stands for context the recording leaves out, so the conversation nears the window without a file that size in it. */
const LEFT_OUT = 190_600;
/** The input the scripted provider counts for a request: the fixed part plus the request's text at four characters a token. */
const countedInput = (body: { readonly system?: unknown; readonly tools?: unknown; readonly messages?: unknown }): number => LEFT_OUT + inputOf(body);
const counted = (text: string, id: string, file: string): Responder => (request) => call(text, [{ id, name: 'read', input: { path: file } }], { input: countedInput(request.body) });
const sayCounted = (text: string): Responder => (request) => raw(answer(text, usage(countedInput(request.body))))(request);

const FIELDS =
  'package.json adds nothing to the flow itself; it describes the package around it. Field by field:\n\n' +
  '- `name` is "shop". npm uses it for the package and for `npm run` output, but no file in src/ reads it, so the version that flows through src/version.ts, src/cli.ts and src/update.ts never touches it.\n' +
  '- `private` is true, so `npm publish` refuses to publish the package. That also means there is no published version to compare against: isNewer in src/update.ts only ever compares the strings it is given.\n' +
  '- `type` is "module", so Node loads src/*.ts (once compiled) as ES modules. That is why src/cli.ts and src/update.ts import parseVersion with the `.js` extension in `./version.js`.\n' +
  '- `scripts.test` runs `vitest run`. There is no test file yet, so nothing checks that parseVersion counts a missing part as 0, or that isNewer compares only the major numbers.\n\n' +
  'What package.json does not have matters as much for the flow:\n\n' +
  '- There is no `version` field. A version string only ever comes from the command line, through process.argv[2] in src/cli.ts, and an empty argument becomes [0, 0, 0].\n' +
  '- There is no `bin` field, so the CLI is not installed as a command; you run it with node on the compiled src/cli.ts.\n' +
  '- There are no `dependencies`, so parseVersion is the only parser in play, and nothing like semver normalizes versions such as "v1.2" or "1.2.3-beta" before they reach it. parseVersion would turn "v1" into NaN, because Number("v1") is NaN, and isNewer would then compare NaN with a number, which is always false.\n' +
  '- There is no `engines` field, so nothing states which Node version the ES modules need.\n\n' +
  'So the flow stays: argument, parseVersion, and isNewer when two versions are compared. To make package.json part of it, the CLI could read the `version` field';

/**
 * An answer that stops because the conversation filled the window while the model wrote it: as much of the answer as
 * fits between the request's input and the window, at four characters a token, then the stop reason.
 */
const windowFull: Responder = (request) => {
  const input = countedInput(request.body);
  const output = HAIKU_WINDOW - input;
  if (output < 100 || output * 4 > FIELDS.length) throw new Error(`the overflow flow leaves ${output} tokens of room; tune LEFT_OUT`);
  const reply = answer(FIELDS.slice(0, output * 4), usage(input), { stopReason: 'model_context_window_exceeded', chunk: 64 });
  const events = reply.events.map((e) => (e.type === 'message_delta' ? { ...e, usage: { output_tokens: output } } : e));
  return raw({ ...reply, events })(request);
};

const FAKE_MCP = fileURLToPath(new URL('../fake-mcp-server.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');

/**
 * Prompts from an editor over ACP in one session whose editor hands it the test MCP server as `fake`, as VS Code
 * passes the user's servers in `session/new`; the turn starts once the server is ready.
 */
async function mcpEditorFlow(
  mode: string,
  script: readonly ScriptEntry[],
  prompt: string,
  permission: (params: acp.RequestPermissionRequest) => string,
  server: () => Promise<acp.McpServer> = async () => ({ name: 'fake', command: process.execPath, args: ['--import', TSX, FAKE_MCP], env: [] }),
): Promise<Recording> {
  const run = await scriptedRun(script, files(['ask']));
  const seen = capture(run.io.fetch!);
  const io = { ...run.io, fetch: seen.fetch };
  const asked: EditorRequest[] = [];
  const client = acp
    .client({ name: 'docs-recorder' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      asked.push({ after: seen.exchanges.length, method: 'session/request_permission', params });
      return { outcome: { outcome: 'selected', optionId: permission(params) } };
    })
    .onNotification(acp.methods.client.session.update, () => {});
  const engine = engineShared(io);
  const mcp = mcpSessions(run.store, run.env);
  try {
    await client.connectWith(gcodeAgent(io, run.store, { maxTurns: 10, maxCostUsd: 1 }, mcp, engine), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, {
        cwd: run.workspace,
        mcpServers: [await server()],
      });
      for (const deadline = Date.now() + 30_000; ; ) {
        const { servers } = await ctx.request<{ servers: { state: { status: string } }[] }, { sessionId: string }>('_gcode/mcpServers', { sessionId });
        if (servers.every((server) => server.state.status === 'ready')) break;
        if (Date.now() > deadline) throw new Error('the MCP server did not start');
        await sleep(100);
      }
      await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: mode });
      await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: prompt }] });
    });
  } finally {
    await engine.jobs.kill('engine-exit', 'all');
    await mcp.stopAll();
  }
  await seen.done();
  return { exchanges: seen.exchanges, editor: asked, workspace: run.workspace, home: run.env['HOME']! };
}

/**
 * The test MCP server over streamable HTTP, which answers 401 to every tools/call, as a hosted server does once the
 * user's sign-in has expired. It connects and lists its tools as usual. `close` stops it.
 */
async function expiringServer(): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const message = body === '' ? undefined : (JSON.parse(body) as { method?: string });
      if (message?.method === 'tools/call') {
        res.writeHead(401, { 'www-authenticate': 'Bearer error="invalid_token", error_description="The access token expired"' }).end();
        return;
      }
      const mcp = fakeMcpServer();
      const transport = new StreamableHTTPServerTransport({});
      res.on('close', () => void transport.close().then(() => mcp.close()));
      // The SDK's transports predate exactOptionalPropertyTypes.
      void mcp.connect(transport as Transport).then(() => transport.handleRequest(req, res, message));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
const optionOf = (kind: string) => (params: acp.RequestPermissionRequest) => params.options.find((option) => option.optionId === kind)!.optionId;

const DATE = 'export const isLeapYear = (year: number) => year % 4 === 0;\n';
const TIME = 'export const daysInFebruary = (year: number) => (year % 4 === 0 ? 29 : 28);\n';
const SPINOFF_PROMPT = 'Fix the leap-year bug in src/date.ts: 1900 is not a leap year.';
const LANE_PROMPT = 'In a lane, check that parseVersion counts a missing patch number as 0, and fix it only if it does not.';
const LANE_TASK = 'Check that parseVersion returns 0 for a missing patch number, as in "1.2". Change it only if it does not. Report what you found.';
const TESTS_TASK = 'Find the test files that cover parseVersion. Answer with their paths.';
const ARGS_TASK = 'Find where the CLI in src/ reads its command-line arguments. Answer with path:line.';
const DOCS_TASK = 'Find any Markdown file that mentions parseVersion. Answer with their paths.';
const BUDGET_PROMPT = 'Where is parseVersion called, which tests cover it, where does the CLI read its arguments, and which docs mention it?';
const OVERFLOW_FIRST = 'Read src/version.ts, src/cli.ts and src/update.ts, and tell me how a version flows through them.';
const OVERFLOW_NEXT = 'Now read package.json and explain, field by field, what it adds to that flow.';

export const EXT: readonly Flow[] = [
  {
    name: 'ext-slash-template',
    what: 'The user types /fix-issue 42; Geno fills the command file in and the model answers the filled-in text.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to(
            'Read issue #42',
            say('Before I change anything I need the issue itself. Which GitHub repository is issue #42 in? Then I can read it with `gh issue view 42 --repo <owner>/<repo>`; or paste its text here.'),
          ),
        ],
        '/fix-issue 42',
        { files: { '.claude/commands/fix-issue.md': 'Read issue #$1 with gh, find the cause, and fix it.\n' } },
      ),
  },
  {
    name: 'ext-memory-write',
    what: 'The model proposes a project note with remember; the user picks Don’t remember, and the model goes on with the task.',
    run: () =>
      editorFlow(
        ['ask', 'auto'],
        'auto',
        [
          to('pnpm', use('This is a preference worth keeping for later chats. I will load remember first.', 'toolu_load_1', 'tool_search', { select: ['remember'] })),
          to(
            'pnpm',
            use('You said this project uses pnpm. I will ask to remember that for later chats.', 'toolu_remember_1', 'remember', {
              text: 'ใช้ pnpm ไม่ใช่ npm ในโปรเจกต์นี้',
              scope: 'project',
            }),
          ),
          to('pnpm', readFile('Now I read package.json to see the test script.', 'toolu_read_1', 'package.json')),
          to('pnpm', say('The test script is `vitest run`, so run it with `pnpm test`. I did not save the note.')),
        ],
        'โปรเจกต์นี้ใช้ pnpm อย่าใช้ npm แล้วบอกหน่อยว่ารันเทสต์ยังไง',
        { meta: { 'gcode/memory': true }, permission: (params) => params.options.find((option) => option.kind === 'reject_once')!.optionId },
      ),
  },
  {
    name: 'wf-spinoff',
    what: 'While fixing src/date.ts the model suggests the same fix in src/time.ts with spawn_task, then goes on with its own task.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to(SPINOFF_PROMPT, readFile('I will read src/date.ts first.', 'toolu_read_1', 'src/date.ts')),
          to(SPINOFF_PROMPT, use('I will check whether other files use the same rule.', 'toolu_grep_1', 'grep', { pattern: 'year % 4' })),
          to(SPINOFF_PROMPT, use('src/time.ts has the same bug, outside this fix. I will load spawn_task to suggest it as its own task.', 'toolu_load_1', 'tool_search', { select: ['spawn_task'] })),
          to(
            SPINOFF_PROMPT,
            use('I will suggest the src/time.ts fix as a separate task.', 'toolu_spawn_1', 'spawn_task', {
              title: 'Fix the same leap-year bug in src/time.ts',
              tldr: 'daysInFebruary treats every year divisible by 4 as a leap year, so it gives February 1900 29 days.',
              prompt:
                'In src/time.ts, daysInFebruary(year) returns 29 for every year divisible by 4. Use the Gregorian rule: a year divisible by 4 is a leap year, except one divisible by 100 that is not divisible by 400. 1900 must give 28 and 2000 must give 29. Keep the signature.',
            }),
          ),
          to(
            SPINOFF_PROMPT,
            use('Now I fix src/date.ts.', 'toolu_edit_1', 'edit', {
              path: 'src/date.ts',
              old_str: 'year % 4 === 0;',
              new_str: 'year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);',
            }),
          ),
          to(SPINOFF_PROMPT, say('Fixed src/date.ts:1: isLeapYear now follows the Gregorian rule, so 1900 is not a leap year and 2000 is. I suggested the same fix in src/time.ts as a separate task.')),
        ],
        SPINOFF_PROMPT,
        { files: { 'src/date.ts': DATE, 'src/time.ts': TIME }, meta: { 'gcode/spinoffs': true }, permission: allowOnce },
      ),
  },
  {
    name: 'sub-worktree-lane',
    what: 'The parent runs worker in a lane; worker finds nothing to change, so Geno removes the lane and the report has no lane note.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to(LANE_PROMPT, agentCall('toolu_agent_1', { agent: 'worker', task: LANE_TASK, isolation: 'worktree' }, 'I will hand this check to a worker in a lane of its own.')),
          to(LANE_TASK, readFile('I will read src/version.ts.', 'toolu_read_1', 'src/version.ts')),
          to(
            LANE_TASK,
            reportWith('It already does, so I change nothing.', 'toolu_report_1', 'src/version.ts:4 already counts a missing patch as 0: `patch ?? 0`. "1.2" gives [1, 2, 0]. I changed nothing.'),
          ),
          to(LANE_PROMPT, say('worker found that parseVersion already counts a missing patch as 0 (src/version.ts:4), so nothing changed and there is no lane to review.')),
        ],
        [['--non-interactive', '--allow-worker', LANE_PROMPT]],
      ),
  },
  (() => {
    const steered = gate();
    const told = gate();
    return {
      name: 'sub-message-child',
      what: 'The parent steers a background explore with message_agent, tells the user it passed the message on, and the report arrives later.',
      run: () =>
        cliFlow(
          ['non-interactive'],
          [
            to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK, background: true }, 'I will start explore in the background to find the calls.')),
            to(ASK_WHERE, use('Test files would only add noise. I will load message_agent to tell explore.', 'toolu_load_1', 'tool_search', { select: ['message_agent'] })),
            to(ASK_WHERE, (request) => {
              steered.open();
              const child = /subagent session ([0-9a-f-]{36})|session="([0-9a-f-]{36})"/.exec(anyText(request.body))!.slice(1).find(Boolean)!;
              return use('I will tell explore to skip test files.', 'toolu_msg_1', 'message_agent', { agent_session: child, text: 'Skip test files.' });
            }),
            to(ASK_WHERE, () => (told.open(), say('I told explore to skip test files. It is still searching; I will tell you what it finds when its report arrives.'))),
            to(EXPLORE_TASK, async () => (await steered.opened, await sleep(300), use('I will search for the calls.', 'toolu_grep_1', 'grep', { pattern: 'parseVersion\\(' }))),
            to(EXPLORE_TASK, async () => (await told.opened, reportWith('I skip test files, as the parent asked.', 'toolu_report_1', FOUND))),
            to(ASK_WHERE, say('explore found two callers: src/cli.ts:3, and src/update.ts:3, which calls it twice. It skipped test files.')),
          ],
          [['--non-interactive', ASK_WHERE]],
        ),
    };
  })(),
  (() => {
    const refused = gate();
    const found = gate();
    const tested = gate();
    const read = gate();
    return {
      name: 'sub-refused',
      what: 'With --max-cost 0.05, three background explores hold the whole child budget while they run, so Geno refuses a fourth and the model does that part itself.',
      run: () =>
        cliFlow(
          ['non-interactive'],
          [
            to(BUDGET_PROMPT, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK, background: true }, 'I will start one explore per question, in the background.')),
            to(BUDGET_PROMPT, agentCall('toolu_agent_2', { agent: 'explore', task: TESTS_TASK, background: true }, 'Now the tests.')),
            to(BUDGET_PROMPT, agentCall('toolu_agent_3', { agent: 'explore', task: ARGS_TASK, background: true }, 'Now the CLI arguments.')),
            to(BUDGET_PROMPT, agentCall('toolu_agent_4', { agent: 'explore', task: DOCS_TASK }, 'Last, the docs.')),
            to(BUDGET_PROMPT, async () => {
              refused.open();
              await read.opened;
              await sleep(300);
              return use('No budget is left for a fourth explore, so I will look for docs myself.', 'toolu_glob_1', 'glob', { pattern: '**/*.md' });
            }),
            to(
              BUDGET_PROMPT,
              say('parseVersion is called in src/cli.ts:3 and twice in src/update.ts:3. No test file covers it. The CLI reads its version from process.argv[2] (src/cli.ts:3). No Markdown file mentions it.'),
            ),
            to(EXPLORE_TASK, async () => (await refused.opened, use('I will search for the calls.', 'toolu_grep_1', 'grep', { pattern: 'parseVersion\\(' }))),
            to(EXPLORE_TASK, () => (found.open(), reportWith('Found both callers.', 'toolu_report_1', FOUND))),
            to(TESTS_TASK, async () => (await found.opened, await sleep(300), use('I will list the test files.', 'toolu_glob_2', 'glob', { pattern: '**/*.{test,spec}.ts' }))),
            to(TESTS_TASK, () => (tested.open(), reportWith('There are none.', 'toolu_report_2', 'No test file covers parseVersion: the repository has no *.test.ts or *.spec.ts file.'))),
            to(ARGS_TASK, async () => (await tested.opened, await sleep(300), use('I will search for process.argv.', 'toolu_grep_2', 'grep', { pattern: 'process\\.argv' }))),
            to(ARGS_TASK, () => (read.open(), reportWith('Found it.', 'toolu_report_3', 'src/cli.ts:3 reads process.argv[2] and passes it, or an empty string, to parseVersion.'))),
          ],
          [['--non-interactive', '--max-cost', '0.05', BUDGET_PROMPT]],
        ),
    };
  })(),
  {
    name: 'ctx-compaction-auto',
    what: 'The context has passed GCODE_COMPACT_AT, but the prompt, the tools and the newest round hold most of it, so Geno skips the summary and sends the full conversation.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to('Explain how src/cli.ts', call('I will read src/cli.ts.', [{ id: 'toolu_read_1', name: 'read', input: { path: 'src/cli.ts' } }], { input: 9_500 })),
          to('Explain how src/cli.ts', raw(answer('src/cli.ts:3 passes the first command-line argument, or an empty string, to parseVersion and prints the result.', usage(9_560)))),
        ],
        'Explain how src/cli.ts uses parseVersion.',
        {},
        { GCODE_COMPACT_AT: '8000' },
      ),
  },
  {
    name: 'ctx-overflow-compact-resend',
    what: 'On a model name Geno has no window for, an answer fills the window and stops with model_context_window_exceeded; Geno compacts once and sends the request again, the answer stops the same way, so the turn fails.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          turnOf(OVERFLOW_FIRST, counted('I will read src/version.ts.', 'toolu_read_1', 'src/version.ts')),
          turnOf(OVERFLOW_FIRST, counted('Now src/cli.ts.', 'toolu_read_2', 'src/cli.ts')),
          turnOf(OVERFLOW_FIRST, counted('Now src/update.ts.', 'toolu_read_3', 'src/update.ts')),
          turnOf(OVERFLOW_FIRST, sayCounted('src/cli.ts:3 passes the CLI argument to parseVersion (src/version.ts:1), which splits it into three numbers; src/update.ts:3 compares the major numbers of two versions.')),
          turnOf(OVERFLOW_NEXT, counted('I will read package.json.', 'toolu_read_4', 'package.json')),
          turnOf(OVERFLOW_NEXT, windowFull),
          {
            when: (request) => isSummary(request.body),
            answer: (request) =>
              raw(
                answer(
                  '## Goal\nExplain how a version flows through src/version.ts, src/cli.ts and src/update.ts, then read package.json and explain, field by field, what it adds.\n\n## Progress\n### Done\nRead the three files and explained the flow.\n### In progress\nRead package.json; the field-by-field answer was cut off.',
                  usage(Math.ceil(JSON.stringify([request.body.system, request.body.messages]).length / 4)),
                ),
              )(request),
          },
          turnOf(OVERFLOW_NEXT, windowFull),
        ],
        [OVERFLOW_FIRST, OVERFLOW_NEXT],
        {},
        UNLISTED_HAIKU,
      ),
  },
  {
    name: 'ext-mcp-tool-call',
    what: 'The model loads the test MCP server’s echo tool with tool_search and calls it; in Ask mode the user allows it for the session, and Geno sends the result back.',
    run: () =>
      mcpEditorFlow(
        'ask',
        [
          use('The echo tool is listed by name only. I will load it first.', 'toolu_load_1', 'tool_search', { select: ['mcp__fake__echo'] }),
          use('I will call echo with the text.', 'toolu_echo_1', 'mcp__fake__echo', { text: 'Login is slow' }),
          say('The fake server echoed it back: "echo: Login is slow".'),
        ],
        'Use the fake server’s echo tool to echo "Login is slow".',
        optionOf('allow-session'),
      ),
  },
  {
    name: 'ext-mcp-server-down',
    what: 'The test MCP server’s process exits during a call; the call gets an error and the model tells the user the server is down.',
    run: () =>
      mcpEditorFlow(
        'ask',
        [
          use('The crash tool is listed by name only. I will load it first.', 'toolu_load_1', 'tool_search', { select: ['mcp__fake__crash'] }),
          use('I will call the crash tool.', 'toolu_crash_1', 'mcp__fake__crash', {}),
          say('The fake MCP server closed the connection while it ran the call ("MCP error -32000: Connection closed"), so the call has no result. Ask me to try again if you want another attempt.'),
        ],
        'Call the fake server’s crash tool.',
        optionOf('allow-session'),
      ),
  },
  (() => {
    let close = async () => {};
    return {
      name: 'ext-mcp-server-signin',
      what: 'The test MCP server over HTTP answers 401 to a tool call, as a hosted server does once its sign-in expires; the call gets an error and the model asks the user to sign in.',
      run: async () => {
        try {
          return await mcpEditorFlow(
            'ask',
            [
              use('The echo tool is listed by name only. I will load it first.', 'toolu_load_1', 'tool_search', { select: ['mcp__fake__echo'] }),
              use('I will call echo with the text.', 'toolu_echo_1', 'mcp__fake__echo', { text: 'Login is slow' }),
              say('The fake MCP server needs you to sign in again before I can use it. Sign in to it in the MCP servers view, then ask me again. I cannot sign in for you.'),
            ],
            'Use the fake server’s echo tool to echo "Login is slow".',
            optionOf('allow-session'),
            async () => {
              const http = await expiringServer();
              close = http.close;
              return { type: 'http', name: 'fake', url: http.url, headers: [] };
            },
          );
        } finally {
          await close();
        }
      },
    };
  })(),
];
