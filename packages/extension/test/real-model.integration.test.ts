// Layer B of the real-model campaign (docs/results/real-usecases): the chat panel driven against the real Model Studio
// model. It calls a paid model, so it runs only with GCODE_REAL_MODEL=1:
//   GCODE_REAL_MODEL=1 pnpm test:vscode packages/extension/test/real-model.integration.test.ts
// The key comes from the main checkout's .env and is never printed. Each step reports its outcome instead of failing
// the file, so one broken step does not hide the rest; the report lands in scratchpad/real-usecases/layer-b.jsonl.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { setUp } from './launch.js';
import { captureWindow } from './screenshot.js';
import { leaseWindow } from './pool/client.js';
import { FILES, MCP_SERVER, STEPS } from './suite/real-model-fixture.js';

const REAL = process.env['GCODE_REAL_MODEL'] === '1';
const EXTENSION = 'g-code.g-code';
/** GCODE_REAL_RUN numbers a run, so a retry keeps the earlier run's shots and logs. */
const RUN = process.env['GCODE_REAL_RUN'] ?? '1';
/** GCODE_REAL_STEPS, comma-separated, runs only those steps of the suite. */
const STEPS_CHOSEN = process.env['GCODE_REAL_STEPS']?.split(',').map((s) => s.trim());
const SHOTS = path.resolve('docs/results/real-usecases/shots', `r${RUN}`);
const SCRATCH = path.resolve('scratchpad/real-usecases');
const KEPT = path.join(SCRATCH, `layer-b-r${RUN}`);
const CAP_USD = 2.8;
const MCP_FIXTURE = path.resolve('packages/engine/test/fake-mcp-server.ts');
const TSX = pathToFileURL(createRequire(path.resolve('package.json')).resolve('tsx')).href;

function mainCheckoutEnv(): Record<string, string | undefined> {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  return parseEnv(readFileSync(process.env['GCODE_ENV_FILE'] ?? path.join(path.dirname(common), '.env'), 'utf8'));
}

/** The provider the main checkout's .env names, Model Studio's qwen3.8-flash or Anthropic's Claude, with only its own key. */
function providerEnv(env: Record<string, string | undefined>): Record<string, string> {
  if (env['GCODE_PROVIDER'] === 'anthropic') {
    const key = env['ANTHROPIC_API_KEY'];
    if (!key) throw new Error('the main checkout .env needs ANTHROPIC_API_KEY');
    return { GCODE_PROVIDER: 'anthropic', GCODE_MODEL: env['GCODE_MODEL'] || 'claude-sonnet-5-5', ANTHROPIC_API_KEY: key };
  }
  const key = env['DASHSCOPE_API_KEY'];
  const baseUrl = env['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the main checkout .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');
  return { GCODE_PROVIDER: 'modelstudio', GCODE_MODEL: 'qwen3.8-flash', DASHSCOPE_API_KEY: key, DASHSCOPE_BASE_URL: baseUrl };
}

const spent = (): number => {
  const ledger = path.join(SCRATCH, 'ledger.jsonl');
  if (!existsSync(ledger)) return 0;
  return readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).reduce((sum, line) => sum + (JSON.parse(line) as { costUsd: number }).costUsd, 0);
};

/** What every session under `home` cost, children included: each logs its own model calls. */
function costUnder(home: string): number {
  const dir = path.join(home, 'sessions');
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const file of readdirSync(dir, { recursive: true }) as string[]) {
    if (!file.endsWith('.jsonl')) continue;
    for (const line of readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line.includes('"costUsd"')) continue;
      const event = JSON.parse(line) as { kind: string; costUsd?: number };
      if (event.kind === 'assistant') total += event.costUsd ?? 0;
    }
  }
  return total;
}

type Report = { step: string; ok: boolean | null; detail: string; [key: string]: unknown };
const reports: Report[] = [];
let debugPort = 0;
let window: Window | undefined;

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const view = async () => webview((window ??= await connectWindow(debugPort)), EXTENSION, '.transcript');

const UI: Readonly<Record<string, (action: any) => Promise<unknown>>> = {
  eval: async ({ expression }) => evaluate(await view(), expression),
  click: async ({ selector, text }) => click(await view(), selector, text),
  type: async ({ text }) => typeText(await view(), text),
  press: async ({ key, modifiers }) => press(await view(), key, modifiers),
  screenshot: async ({ name }) => {
    const file = path.join(SHOTS, `${name}.png`);
    await captureWindow(debugPort, file);
    // Keeps the committed shots small: 1100 px on the long side.
    spawnSync('sips', ['-Z', '1100', file], { stdio: 'ignore' });
  },
  report: async (action) => {
    const { do: _, ...rest } = action;
    reports.push(rest as Report);
    appendFileSync(path.join(SCRATCH, 'layer-b.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), run: RUN, ...rest })}\n`);
  },
};

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (`${req.method} ${req.url}` !== 'POST /ui') return void res.writeHead(404).end();
  void bodyOf(req).then(async (body) => {
    try {
      const result = await UI[(JSON.parse(body) as { do: string }).do]!(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' }).end(result === undefined ? '' : JSON.stringify(result));
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
});

beforeAll(() => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)));
afterAll(() => {
  window?.browser.close();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

describe.skipIf(!REAL)('the chat panel on the real model', () => {
  it('runs approval cards, review, lanes, a subagent, MCP trust, stop and Thai on the .env provider', async () => {
    if (spent() >= CAP_USD) throw new Error(`the campaign already spent $${spent().toFixed(2)}`);
    const provider = providerEnv(mainCheckoutEnv());
    mkdirSync(SHOTS, { recursive: true });
    rmSync(KEPT, { recursive: true, force: true });
    mkdirSync(KEPT, { recursive: true });
    const mcpServer = { type: 'stdio', command: process.execPath, args: ['--import', TSX, MCP_FIXTURE], env: { MARKER: path.join(SCRATCH, 'mcp-ran') } };
    const { workspace, work, home, suite } = await setUp(
      'real-model',
      { ...FILES, '.vscode/mcp.json': JSON.stringify({ servers: { [MCP_SERVER]: mcpServer } }) },
      { 'gcode.approvalMode': 'ask', 'gcode.chat.detail': 'full', 'gcode.review.mode': 'review', 'chat.mcp.enabled': false, 'chat.mcp.access': 'none', 'chat.mcp.autostart': 'never' },
    );
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', ...args], { cwd: workspace });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-qm', 'Initial commit');

    const vscodeWindow = await leaseWindow();
    debugPort = vscodeWindow.debugPort;
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let failure: unknown;
    try {
      await vscodeWindow.run(suite, { workspace, work }, {
        GCODE_HOME: home,
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        ...provider,
        // Only the suite reads this, for the /ui route; the engine never sees a fake model.
        GCODE_FAKE_MODEL: url,
        GCODE_WIRE_LOG: path.join(KEPT, 'wire.jsonl'),
        ...(STEPS_CHOSEN === undefined ? {} : { GCODE_REAL_STEPS: STEPS_CHOSEN.join(',') }),
      });
    } catch (error) {
      failure = error;
    }
    const costUsd = costUnder(home);
    // The pool removes its temp dir when the run ends; the logs are kept for scripts/real-usecases/archive-b.mjs.
    if (existsSync(path.join(home, 'sessions'))) cpSync(path.join(home, 'sessions'), path.join(KEPT, 'sessions'), { recursive: true });
    git('add', '-A');
    writeFileSync(path.join(KEPT, 'diff.patch'), execFileSync('git', ['diff', '--cached', 'HEAD'], { cwd: workspace, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    appendFileSync(path.join(SCRATCH, 'ledger.jsonl'), `${JSON.stringify({ layer: 'B', case: 'real-model.integration', costUsd })}\n`);
    appendFileSync(path.join(SCRATCH, 'layer-b.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), run: RUN, step: 'cost', costUsd, home })}\n`);
    if (failure !== undefined) throw failure;
    expect(reports.map((r) => r.step), 'every step reported').toEqual(STEPS.filter((s) => STEPS_CHOSEN === undefined || STEPS_CHOSEN.includes(s)));
  }, 3_600_000);
});
