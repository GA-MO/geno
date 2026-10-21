import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { SCHEDULE_ACT_METHOD, SCHEDULES_CAPABILITY, SCHEDULES_METHOD, TASKS_CAPABILITY, WORKSPACE_TRUST_CAPABILITY, type SchedulesResponse } from '@g-code/core';
import { fakeCheck, fakeGh } from '../fake-gh.js';
import { acp, call, editorFlow, type Flow, say, sleep, to, until } from './kit.js';

/** A wake waits 50ms for arrivals close together, and a second of a delay, a timeout or a poll lasts `secondMs`. */
const wakePolicy = (secondMs: number) => ({ GCODE_WAKE_POLICY: JSON.stringify({ batchMs: 50, secondMs }) });

const BUILD_SCRIPT = `const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
console.log('Building 3 entry points');
await sleep(600);
console.log('dist/cli.js      1.2 kB');
console.log('dist/update.js   0.9 kB');
console.log('dist/version.js  0.6 kB');
console.log('Built in 0.6s');
`;

/** A dev server that compiles for `compileMs`, then serves the shop's home page on port 3000. */
const devServer = (compileMs: number) => `import http from 'node:http';
console.log('Compiling src/cli.ts');
setTimeout(() => {
  const page = '<!doctype html><title>Shop</title><h1>Shop</h1><p>3 products in stock.</p>';
  http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page)).listen(3000, '127.0.0.1', () => console.log('ready on http://localhost:3000'));
}, ${compileMs});
`;
/** The dev server's port must be free, or it dies with EADDRINUSE and the flow records another story. */
const portFree = (port: number) =>
  new Promise<void>((resolve, reject) => {
    const probe = createServer()
      .once('error', (error: NodeJS.ErrnoException) =>
        reject(new Error(error.code === 'EADDRINUSE' ? `port ${port} on 127.0.0.1 is in use; stop whatever holds it (lsof -i :${port}) and record again` : `cannot probe port ${port}: ${error.message}`)),
      )
      .listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
/** A dev server stuck compiling: it waits for src/routes.ts, which the workspace lacks, so it never prints its address. */
const STUCK_DEV = `import { existsSync } from 'node:fs';
console.log('Compiling src/cli.ts');
console.log('Waiting for src/routes.ts to be written');
const wait = setInterval(() => {
  if (!existsSync('src/routes.ts')) return;
  clearInterval(wait);
  console.log('ready on http://localhost:3000');
}, 1000);
`;

/** The shop with build and dev scripts, and a workspace rule in .claude/settings.json that lets `allow` run without asking. */
const shop = (allow: readonly string[], dev = devServer(1500)) => ({
  'package.json': `${JSON.stringify(
    { name: 'shop', private: true, type: 'module', scripts: { build: 'node scripts/build.mjs', dev: 'node scripts/dev.mjs', test: 'vitest run' }, dependencies: { zod: '^3.22.4' }, devDependencies: { typescript: '^5.4.5', vitest: '^1.6.0' } },
    null,
    2,
  )}\n`,
  'scripts/build.mjs': BUILD_SCRIPT,
  'scripts/dev.mjs': dev,
  '.claude/settings.json': `${JSON.stringify({ permissions: { allow: allow.map((command) => `Bash(${command})`) } }, null, 2)}\n`,
});
/** VS Code says the workspace is trusted, so the allow rules of its settings files apply. */
const trusted = { [WORKSPACE_TRUST_CAPABILITY]: true };

/**
 * A `pnpm` on PATH that runs a package script as pnpm does, header and all, without corepack, which would download
 * pnpm into the home folder. Returns the PATH to run under.
 */
async function pnpmOnPath(): Promise<string> {
  const bin = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-pnpm-')), 'bin');
  await mkdir(bin);
  const script = `#!/bin/sh
run=$(node -e 'process.stdout.write(require("./package.json").scripts[process.argv[1]] ?? "")' "$1")
[ -n "$run" ] || { echo " ERR_PNPM_NO_SCRIPT  Missing script: $1" >&2; exit 1; }
printf '\\n> shop@ %s %s\\n> %s\\n\\n' "$1" "$PWD" "$run"
exec sh -c "$run"
`;
  await writeFile(path.join(bin, 'pnpm'), script);
  await chmod(path.join(bin, 'pnpm'), 0o755);
  return `${bin}${path.delimiter}${process.env['PATH'] ?? '/usr/bin:/bin'}`;
}

const load = (id: string, text: string, names: readonly string[]) => call(text, [{ id, name: 'tool_search', input: { select: names } }]);
const readDev = call('I will read the dev script to see what it prints once it is ready.', [{ id: 'toolu_read_1', name: 'read', input: { path: 'scripts/dev.mjs' } }]);
const bashBuild = call('I will run the build in the background.', [{ id: 'toolu_bash_1', name: 'bash', input: { command: 'pnpm build', run_in_background: true, description: 'Build the project' } }]);

const BUILD = 'Build the project and tell me when it is done.';
const DEV = 'Start the dev server and try the home page.';
const STAGING = 'I just deployed to staging. Check https://staging.shop.example/health once it is up; that takes about 10 minutes.';
const CI = 'I pushed the cart total fix. Watch CI on my PR and tell me what fails.';
const CI_DONE = 'Check CI on my PR.';
const DEPS = 'Check outdated deps: read package.json and list each dependency that is behind its latest major version, with the version it pins.';

const CART = `export const total = (prices: readonly number[]) => prices.slice(1).reduce((sum, price) => sum + price, 0);\n`;
const CART_TEST = `import { expect, it } from 'vitest';\nimport { total } from './cart.js';\n\nit('total', () => {\n  expect(total([1, 1, 1])).toBe(3);\n});\n`;
const FAILED_LOG = [
  'test\tRun tests\t2026-10-12T09:00:00.0000000Z FAIL src/cart.test.ts > total',
  'test\tRun tests\t2026-10-12T09:00:00.1000000Z AssertionError: expected 2 to be 3 // Object.is equality',
  'test\tRun tests\t2026-10-12T09:00:00.2000000Z  ❯ src/cart.test.ts:5:31',
  'test\tRun tests\t2026-10-12T09:00:00.3000000Z Test Files  1 failed (1)',
].join('\n');

export const BG: readonly Flow[] = [
  {
    name: 'bg-command-ends-wakes',
    what: 'The model starts pnpm build in the background and ends its turn; the build ends and wakes the session for a new turn.',
    run: async () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to(BUILD, bashBuild),
          to(BUILD, say('The build is running in the background as bg-1. I will tell you when it finishes.')),
          to(BUILD, say('The build passed: pnpm build exited with code 0 and built dist/cli.js, dist/update.js and dist/version.js.')),
        ],
        BUILD,
        { files: shop(['pnpm build']), meta: trusted, settled: (requests) => until(() => requests() === 3, 'the woken turn') },
        { ...wakePolicy(2), PATH: await pnpmOnPath() },
      ),
  },
  {
    name: 'bg-command-ends-wakes-mid-turn',
    what: 'The model starts pnpm build in the background and reads a file meanwhile; the build ends during the turn and the next request carries its note.',
    run: async () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to(BUILD, bashBuild),
          to(BUILD, async () => (await sleep(1500), call('While it builds, I will read package.json to see what the build runs.', [{ id: 'toolu_read_1', name: 'read', input: { path: 'package.json' } }]))),
          to(BUILD, say('The build passed: pnpm build exited with code 0 and built dist/cli.js, dist/update.js and dist/version.js. It runs node scripts/build.mjs, as package.json says.')),
        ],
        BUILD,
        { files: shop(['pnpm build']), meta: trusted, settled: (requests) => until(() => requests() === 3, 'the last answer') },
        { ...wakePolicy(2), PATH: await pnpmOnPath() },
      ),
  },
  {
    name: 'bg-monitor-wakes',
    what: 'The model starts pnpm dev through monitor and ends its turn; the ready line wakes the session and the model fetches the home page.',
    run: async () => {
      await portFree(3000);
      return editorFlow(
        ['ask'],
        'ask',
        [
          to(DEV, readDev),
          to(DEV, load('toolu_load_1', 'I will load monitor to wait for the server, and web_fetch to try the page.', ['monitor', 'web_fetch'])),
          to(DEV, call('I will start the dev server and wait for its ready line.', [{ id: 'toolu_monitor_1', name: 'monitor', input: { command: 'pnpm dev', pattern: 'ready on', timeout_s: 300, description: 'Start the dev server' } }])),
          to(DEV, say('The dev server is starting as bg-1. I will try the home page once it prints "ready on".')),
          to(DEV, call('The dev server is ready. I will open the home page.', [{ id: 'toolu_fetch_1', name: 'web_fetch', input: { url: 'http://localhost:3000/', question: 'What does the home page show?' } }])),
          { when: (request) => !JSON.stringify(request.body.messages[0]).includes(DEV), answer: say('The page is titled "Shop". It shows the heading "Shop" and the line "3 products in stock."') },
          to(DEV, say('The dev server is up on http://localhost:3000, and the home page loads: it shows the heading "Shop" and "3 products in stock."')),
        ],
        DEV,
        { files: shop(['pnpm dev']), meta: trusted, settled: (requests) => until(() => requests() === 7, 'the woken turn') },
        { ...wakePolicy(20), PATH: await pnpmOnPath() },
      );
    },
  },
  {
    name: 'bg-monitor-wakes-already',
    what: 'The model watches a dev server it started earlier with monitor, and the ready line was printed already; nothing waits and the turn goes on.',
    run: async () => {
      await portFree(3000);
      return editorFlow(
        ['ask'],
        'ask',
        [
          to(DEV, readDev),
          to(DEV, call('I will start the dev server in the background.', [{ id: 'toolu_bash_1', name: 'bash', input: { command: 'pnpm dev', run_in_background: true, description: 'Start the dev server' } }])),
          to(DEV, load('toolu_load_1', 'I will load monitor to wait until it is ready.', ['monitor'])),
          to(DEV, async () => (await sleep(1500), call('I will wait for its ready line.', [{ id: 'toolu_monitor_1', name: 'monitor', input: { background_job_id: 'bg-1', pattern: 'ready on', timeout_s: 300 } }]))),
          to(DEV, say('The dev server is already up: bg-1 printed "ready on http://localhost:3000".')),
        ],
        DEV,
        { files: shop(['pnpm dev'], devServer(300)), meta: trusted, settled: (requests) => until(() => requests() === 5, 'the last answer') },
        { ...wakePolicy(20), PATH: await pnpmOnPath() },
      );
    },
  },
  {
    name: 'bg-monitor-wakes-timeout',
    what: 'The model starts pnpm dev through monitor and ends its turn; no line matches before the timeout, which wakes the session, and the model reads the output.',
    run: async () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to(DEV, readDev),
          to(DEV, load('toolu_load_1', 'I will load monitor to wait for the server, and bash_output in case it gets stuck.', ['monitor', 'bash_output'])),
          to(DEV, call('I will start the dev server and wait for its ready line.', [{ id: 'toolu_monitor_1', name: 'monitor', input: { command: 'pnpm dev', pattern: 'ready on', timeout_s: 300, description: 'Start the dev server' } }])),
          to(DEV, say('The dev server is starting as bg-1. I will try the home page once it prints "ready on".')),
          to(DEV, call('The dev server never printed its address. I will read its output.', [{ id: 'toolu_output_1', name: 'bash_output', input: { id: 'bg-1' } }])),
          to(DEV, say('The dev server is still running but never got ready: its last line is "Waiting for src/routes.ts to be written", so it is waiting for that file. Check whether src/routes.ts should exist or a step should generate it.')),
        ],
        DEV,
        { files: shop(['pnpm dev'], STUCK_DEV), meta: trusted, settled: (requests) => until(() => requests() === 6, 'the woken turn') },
        { ...wakePolicy(5), PATH: await pnpmOnPath() },
      ),
  },
  {
    name: 'bg-schedule-wakeup',
    what: 'The model schedules a wake-up in 600 seconds with a reason and ends its turn; when it is due, the session wakes and the model checks staging.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to(STAGING, load('toolu_load_1', 'I will load schedule_wakeup to come back later, and web_fetch to check staging then.', ['schedule_wakeup', 'web_fetch'])),
          to(STAGING, call('Staging needs about 10 minutes, so I will come back then.', [{ id: 'toolu_wake_1', name: 'schedule_wakeup', input: { delay_s: 600, reason: 'check staging health after the deploy' } }])),
          to(STAGING, say('Staging takes about 10 minutes to come up. I will check its health in 10 minutes.')),
          to(STAGING, call('It is time to check staging.', [{ id: 'toolu_fetch_1', name: 'web_fetch', input: { url: 'https://staging.shop.example/health', question: 'Is the service healthy?' } }])),
          to(STAGING, say('I could not reach staging: staging.shop.example does not resolve, so the deploy may not be live yet. Check that its DNS record exists.')),
        ],
        STAGING,
        {
          files: { '.claude/settings.json': `${JSON.stringify({ permissions: { allow: ['WebFetch(domain:staging.shop.example)'] } }, null, 2)}\n` },
          meta: trusted,
          settled: (requests) => until(() => requests() === 5, 'the woken turn'),
        },
        wakePolicy(2),
      ),
  },
  {
    name: 'bg-watch-pr',
    what: 'The model calls watch_pr while a check is pending and ends its turn; Geno polls a fake gh until the test check fails, then wakes the session with its log.',
    run: async () => {
      const gh = await fakeGh({ checks: [fakeCheck('lint', 'pass', 455), fakeCheck('test', 'pending', 456)] });
      const fails = () => sleep(1500).then(() => gh.stage({ checks: [fakeCheck('lint', 'pass', 455), fakeCheck('test', 'fail', 456)], logs: { '456': FAILED_LOG } }));
      return editorFlow(
        ['ask'],
        'ask',
        [
          to(CI, load('toolu_load_1', 'I will load watch_pr to wait for CI.', ['watch_pr'])),
          to(CI, call('I will watch the checks on this branch’s pull request.', [{ id: 'toolu_watch_1', name: 'watch_pr', input: {} }])),
          to(CI, () => (void fails(), say('CI is running on PR #42: one check passed and test is still running. I will look when it finishes.'))),
          to(CI, call('The test check failed on src/cart.test.ts:5. I will open the code it tests.', [{ id: 'toolu_read_1', name: 'read', input: { path: 'src/cart.ts' } }])),
          to(CI, say('CI failed on PR #42: the test check at src/cart.test.ts:5 expected 3 and got 2. src/cart.ts:1 calls prices.slice(1), which drops the first price. Summing all prices fixes it.')),
        ],
        CI,
        { files: { 'src/cart.ts': CART, 'src/cart.test.ts': CART_TEST }, settled: (requests) => until(() => requests() === 5, 'the woken turn') },
        { ...wakePolicy(20), PATH: gh.path },
      );
    },
  },
  {
    name: 'bg-watch-pr-settled',
    what: 'The model calls watch_pr after CI already finished; Geno answers with the report at once and sets nothing up, so the turn goes on.',
    run: async () => {
      const gh = await fakeGh({ checks: [fakeCheck('lint', 'pass', 455), fakeCheck('test', 'pass', 456)] });
      return editorFlow(
        ['ask'],
        'ask',
        [
          to(CI_DONE, load('toolu_load_1', 'I will load watch_pr to check CI.', ['watch_pr'])),
          to(CI_DONE, call('I will look at the checks on this branch’s pull request.', [{ id: 'toolu_watch_1', name: 'watch_pr', input: {} }])),
          to(CI_DONE, say('CI already finished on PR #42: both checks passed.')),
        ],
        CI_DONE,
        { settled: (requests) => until(() => requests() === 3, 'the last answer') },
        { ...wakePolicy(20), PATH: gh.path },
      );
    },
  },
  (() => {
    let connection: acp.ClientContext | undefined;
    return {
      name: 'bg-scheduled-task-fires',
      what: 'The user schedules a read-only task with /schedule and runs it from the Tasks list; it runs in a session of its own in Plan mode and reports.',
      run: () =>
        editorFlow(
          ['ask'],
          'ask',
          [
            to(DEPS, call('I will read package.json to see what it pins.', [{ id: 'toolu_read_1', name: 'read', input: { path: 'package.json' } }])),
            to(
              DEPS,
              say(
                'package.json pins zod ^3.22.4, vitest ^1.6.0 (dev) and typescript ^5.4.5 (dev). I only read the file and did not check the registry, so I cannot say which are outdated; run npm outdated to see. I changed nothing; this run is read-only.',
              ),
            ),
          ],
          `/schedule weekdays at 9:00 --max-cost 0.20 --max-turns 20 ${DEPS}`,
          {
            files: shop([]),
            meta: { [TASKS_CAPABILITY]: true, [SCHEDULES_CAPABILITY]: true },
            update: (_, ctx) => void (connection ??= ctx),
            settled: async (requests) => {
              // The engine resolves a window's folder against its own, which is the workspace.
              const cwd = '.';
              const { tasks } = await connection!.request<SchedulesResponse>(SCHEDULES_METHOD, { cwd });
              await connection!.request(SCHEDULE_ACT_METHOD, { cwd, id: tasks[0]!.id, action: 'run' });
              await until(() => requests() === 2, 'the run');
              const ended = async () => (await connection!.request<SchedulesResponse>(SCHEDULES_METHOD, { cwd })).tasks[0]!.runs.some((run) => run.kind === 'ran' && run.end != null);
              for (let i = 0; !(await ended()); i++) {
                if (i > 200) throw new Error('timed out waiting for the run to end');
                await sleep(50);
              }
            },
          },
        ),
    };
  })(),
];
