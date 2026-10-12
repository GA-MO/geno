import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { attachmentFileName, type ImageAttachment, type ClassifierInput, type ClassifierRun, type Denial, type SessionMode } from '@g-code/core';
import { openMcpHub, type McpHub, type McpTokens } from '../src/mcp/hub.js';
import { createLane, laneRepoOf } from '../src/lanes.js';
import { openStore } from '../src/store.js';
import { freshAuto, type Approval, type PermissionAnswer } from '../src/tools/agent.js';
import type { ToolContext } from '../src/tools/context.js';
import { fakeMcpServer } from './fake-mcp-server.js';
import { fakeOAuth, type FakeOAuth } from './fake-oauth.js';
import { makeRepo } from './git-fixture.js';
import { runCli } from './helpers.js';

const FIXTURE = fileURLToPath(new URL('./fake-mcp-server.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
const FAKE_KEY = 'sk-geno-fake-parent-key-0123456789';

/** How a config file starts the fake server over stdio. */
const stdioServer = (env: Record<string, string> = {}) => ({ command: process.execPath, args: ['--import', TSX, FIXTURE], env });

const hubs: McpHub[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function setup(files: { readonly mcpJson?: unknown; readonly vscode?: unknown; readonly global?: unknown } = {}) {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-mcp-ws-')));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-mcp-home-'));
  const env = {
    GCODE_HOME: home,
    HOME: home,
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    DASHSCOPE_API_KEY: FAKE_KEY,
    ANTHROPIC_API_KEY: FAKE_KEY,
  };
  const store = openStore(env);
  if (files.mcpJson !== undefined) await writeFile(path.join(workspace, '.mcp.json'), JSON.stringify(files.mcpJson));
  if (files.vscode !== undefined) {
    await mkdir(path.join(workspace, '.vscode'));
    await writeFile(path.join(workspace, '.vscode', 'mcp.json'), JSON.stringify(files.vscode));
  }
  if (files.global !== undefined) await writeFile(store.mcpConfigFile, JSON.stringify(files.global));
  const open = async (acp: Parameters<typeof openMcpHub>[0]['acp'] = [], tokens?: McpTokens) => {
    const hub = await openMcpHub({ store, env, workspace, acp, tokens });
    hubs.push(hub);
    return hub;
  };
  return { workspace, home, env, store, open };
}

type Asked = { readonly denial: Denial; readonly classifier: ClassifierRun | undefined };

function approval(mode: SessionMode, answer: PermissionAnswer, verdict: ClassifierRun['verdict'] = 'allow') {
  const asked: Asked[] = [];
  const classified: ClassifierInput[] = [];
  const value: Approval = {
    kind: 'interactive',
    mode: () => mode,
    approve: async (denial, classifier) => {
      asked.push({ denial, classifier });
      return answer;
    },
    classify: async (input) => {
      classified.push(input);
      return { verdict, reason: `classifier said ${verdict}`, model: 'fake', latencyMs: 1, costUsd: 0 };
    },
    auto: freshAuto(),
  };
  return { value, asked, classified };
}

const ctx = (workspace: string): ToolContext => ({
  workspace,
  spillDir: path.join(workspace, '.spill'), readRoots: [], credentialPlaces: [],
  spillChars: 24_000,
  attachmentsDir: path.join(workspace, '.attachments'),
  rg: 'rg',
  signal: new AbortController().signal,
  files: { read: async () => null, write: async () => 'written', unsaved: async () => [] },
  events: () => [{ kind: 'user', seq: 1, at: '2026-01-01T00:00:00.000Z', content: 'use the fake server' }],
  earlierCalls: async () => {},
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const textOf = (reply: Awaited<ReturnType<import('../src/tools/context.js').Executor['run']>>): string =>
  typeof reply === 'string' ? reply : reply.text;

/** The tools once every server has started, as a session sees them from its second turn on. */
async function toolsetOf(hub: McpHub, value: Approval) {
  await hub.start();
  return (await hub.toolset(value))!;
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('MCP trust', () => {
  it('never spawns a workspace server the user has not approved', async () => {
    const marker = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-mcp-marker-')), 'spawned');
    const { open } = await setup({ mcpJson: { mcpServers: { fake: stdioServer({ MARKER: marker }) } } });
    const hub = await open();

    const toolset = await toolsetOf(hub, approval('ask', 'allow').value);

    expect(toolset.tools).toEqual([]);
    expect(hub.views()).toEqual([expect.objectContaining({ name: 'fake', source: 'mcp-json', state: { status: 'untrusted' } })]);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(existsSync(marker), 'an untrusted workspace server never spawns').toBe(false);
  });

  it('never spawns an untrusted .vscode/mcp.json server either', async () => {
    const marker = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-mcp-marker-')), 'spawned');
    const { open } = await setup({ vscode: { servers: { fake: { type: 'stdio', ...stdioServer({ MARKER: marker }) } } } });
    const hub = await open();
    await toolsetOf(hub, approval('ask', 'allow').value);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(existsSync(marker)).toBe(false);
    expect(hub.views()[0]).toMatchObject({ source: 'vscode-mcp-json', state: { status: 'untrusted' } });
  });

  it('starts a workspace server once approved, and asks again when its definition changes', async () => {
    const marker = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-mcp-marker-')), 'spawned');
    const { open, workspace, store } = await setup({ mcpJson: { mcpServers: { fake: stdioServer({ MARKER: marker }) } } });
    const hub = await open();
    await hub.trust('fake');

    const toolset = await toolsetOf(hub, approval('auto', 'allow').value);
    expect(existsSync(marker), 'a trusted server starts on first need').toBe(true);
    expect(toolset.tools.map((tool) => tool.name)).toContain('mcp__fake__echo');

    const stored = JSON.parse(await readFile(store.mcpTrustFile, 'utf8'));
    expect(stored).toEqual({
      version: 1,
      servers: [{ workspace, name: 'fake', hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), approvedAt: expect.any(String) }],
    });

    await writeFile(path.join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { fake: stdioServer({ MARKER: marker, CHANGED: '1' }) } }));
    const reopened = await open();
    expect(reopened.views()[0]!.state).toEqual({ status: 'untrusted' });
  });

  it("trusts in a lane what the user approved in its main checkout, for the same definition", async () => {
    const { env, store } = await setup();
    const mcpJson = JSON.stringify({ mcpServers: { plain: stdioServer(), rooted: { ...stdioServer(), cwd: '.' } } });
    const main = await realpath(makeRepo('ws', [{ message: 'start', files: { '.mcp.json': mcpJson } }]));
    const inMain = await openMcpHub({ store, env, workspace: main, acp: [] });
    hubs.push(inMain);
    await inMain.trust('plain');
    await inMain.trust('rooted');

    const lane = await createLane(await laneRepoOf(main), 'fix-login', 'head');
    const inLane = await openMcpHub({ store, env, workspace: lane.path, acp: [] });
    hubs.push(inLane);

    expect(inLane.views().map((view) => [view.name, view.state.status])).toEqual([
      ['plain', 'stopped'],
      ['rooted', 'stopped'],
    ]);
  });

  it("asks again in a lane whose .mcp.json differs from the one approved in the main checkout", async () => {
    const { env, store } = await setup();
    const main = await realpath(makeRepo('ws', [{ message: 'start', files: { '.mcp.json': JSON.stringify({ mcpServers: { fake: stdioServer() } }) } }]));
    const inMain = await openMcpHub({ store, env, workspace: main, acp: [] });
    hubs.push(inMain);
    await inMain.trust('fake');

    const lane = await createLane(await laneRepoOf(main), 'fix-login', 'head');
    await writeFile(path.join(lane.path, '.mcp.json'), JSON.stringify({ mcpServers: { fake: stdioServer({ CHANGED: '1' }) } }));
    const inLane = await openMcpHub({ store, env, workspace: lane.path, acp: [] });
    hubs.push(inLane);

    expect(inLane.views()[0]!.state).toEqual({ status: 'untrusted' });
  });

  it("reads a plugin's servers from its .mcp.json and its manifest, named plugin_<plugin>_<server>, and starts none until approved", async () => {
    const marker = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-mcp-marker-')), 'spawned');
    const { open, home } = await setup();
    const docs = path.join(home, 'plugin-cache', 'docs');
    const tools = path.join(home, 'plugin-cache', 'tools');
    const pluginFiles: Record<string, unknown> = {
      [path.join(docs, '.claude-plugin', 'plugin.json')]: { name: 'docs' },
      // Claude Code's own plugins put their servers at the top of the file.
      [path.join(docs, '.mcp.json')]: { fake: { ...stdioServer({ MARKER: marker }), args: [...stdioServer().args, '${CLAUDE_PLUGIN_ROOT}/data'] } },
      [path.join(tools, '.claude-plugin', 'plugin.json')]: { name: 'my.tools', mcpServers: ['./servers.json', { inline: { type: 'http', url: 'https://tools.example/mcp' } }] },
      [path.join(tools, 'servers.json')]: { mcpServers: { wrapped: stdioServer() } },
      [path.join(home, '.claude', 'plugins', 'installed_plugins.json')]: {
        version: 2,
        plugins: { 'docs@market': [{ scope: 'user', installPath: docs }], 'my.tools@market': [{ scope: 'user', installPath: tools }] },
      },
    };
    for (const [file, value] of Object.entries(pluginFiles)) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(value));
    }
    const hub = await open();
    const realDocs = await realpath(docs);

    expect(hub.problems).toEqual([]);
    expect(hub.views().map((view) => [view.name, view.source, view.state.status])).toEqual([
      ['plugin_docs_fake', 'plugin', 'untrusted'],
      ['plugin_my_tools_inline', 'plugin', 'untrusted'],
      ['plugin_my_tools_wrapped', 'plugin', 'untrusted'],
    ]);
    expect(hub.views()[0]!.definition).toMatchObject({ kind: 'stdio', commandLine: expect.stringContaining(`${realDocs}/data`), env: expect.arrayContaining([['CLAUDE_PLUGIN_ROOT', realDocs]]) });
    expect((await toolsetOf(hub, approval('ask', 'allow').value)).tools).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(existsSync(marker), 'an unapproved plugin server never spawns').toBe(false);

    await hub.trust('plugin_docs_fake');
    const toolset = await toolsetOf(hub, approval('auto', 'allow').value);
    expect(existsSync(marker)).toBe(true);
    expect(toolset.tools.map((tool) => tool.name)).toContain('mcp__plugin_docs_fake__echo');
  });

  it('trusts global and editor-provided servers without asking', async () => {
    const { open } = await setup({ global: { mcpServers: { globalfake: stdioServer() } } });
    const hub = await open([{ name: 'editorfake', ...stdioServer(), args: stdioServer().args, env: [] }]);
    expect(hub.views().map((view) => [view.name, view.source, view.state.status])).toEqual([
      ['editorfake', 'acp', 'stopped'],
      ['globalfake', 'global', 'stopped'],
    ]);
  });
});

describe('MCP cold start and per-server controls', () => {
  it('offers only the servers ready now, never waits for one still starting, and adds it once ready', async () => {
    const { open } = await setup({ global: { mcpServers: { slow: stdioServer({ DELAY_MS: '1500' }) } } });
    const hub = await open();
    const starting = hub.start();

    const asked = Date.now();
    const cold = (await hub.toolset(approval('auto', 'allow').value))!;
    expect(Date.now() - asked, 'the toolset does not wait for the cold server').toBeLessThan(500);
    expect(cold.tools).toEqual([]);
    expect(hub.views()[0]!.state).toEqual({ status: 'starting', restarts: 0 });

    await starting;
    const warm = (await hub.toolset(approval('auto', 'allow').value))!;
    expect(warm.tools.map((tool) => tool.name)).toContain('mcp__slow__echo');
  });

  it('shows the exact command it would run, and refuses to trust a definition other than the one shown', async () => {
    const marker = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-mcp-marker-')), 'spawned');
    const { open } = await setup({ mcpJson: { mcpServers: { fake: stdioServer({ MARKER: marker }) } } });
    const hub = await open();
    const [view] = hub.views();
    expect(view!.definition).toEqual({ kind: 'stdio', commandLine: `${process.execPath} --import ${TSX} ${FIXTURE}`, cwd: undefined, env: [['MARKER', marker]] });

    await expect(hub.trust('fake', 'sha256:0000')).rejects.toThrow(/changed since it was shown/);
    expect(hub.views()[0]!.state).toEqual({ status: 'untrusted' });
    await hub.trust('fake', view!.hash);
    expect(hub.views()[0]!.state).toEqual({ status: 'stopped' });
  });

  it('stops a disabled server, keeps it off in the next session of the workspace, and starts it again once enabled', async () => {
    const marker = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-mcp-marker-')), 'pid');
    const { open } = await setup({ global: { mcpServers: { fake: stdioServer({ MARKER: marker }) } } });
    const hub = await open();
    await hub.start();
    const pid = Number(await readFile(marker, 'utf8'));

    await hub.setEnabled('fake', false);
    expect(hub.views()[0]!.state).toEqual({ status: 'disabled', trusted: true });
    expect((await toolsetOf(hub, approval('auto', 'allow').value)).tools).toEqual([]);
    await waitFor(() => !isAlive(pid));

    const next = await open();
    expect(next.views()[0]!.state, 'the choice lasts for the workspace').toEqual({ status: 'disabled', trusted: true });
    await next.setEnabled('fake', true);
    expect((await toolsetOf(next, approval('auto', 'allow').value)).tools.map((tool) => tool.name)).toContain('mcp__fake__echo');
  });
});

describe('MCP stdio servers', () => {
  it('cannot see the API keys in the parent environment, only PATH, HOME, LANG, TMPDIR and its own env', async () => {
    process.env['DASHSCOPE_API_KEY'] = FAKE_KEY;
    try {
      const { open, workspace } = await setup({ global: { mcpServers: { fake: stdioServer({ DECLARED: 'yes' }) } } });
      const hub = await open();
      const { executors } = await toolsetOf(hub, approval('ask', 'allow').value);

      const text = textOf(await executors['mcp__fake__env']!.run({}, ctx(workspace)));
      const seen = JSON.parse(text) as Record<string, string>;

      expect(text).not.toContain(FAKE_KEY);
      expect(Object.keys(seen)).not.toContain('DASHSCOPE_API_KEY');
      expect(Object.keys(seen)).not.toContain('ANTHROPIC_API_KEY');
      expect(Object.keys(seen)).not.toContain('GCODE_HOME');
      expect(seen['DECLARED']).toBe('yes');
      expect(seen['PATH']).toBe(process.env['PATH']);
    } finally {
      delete process.env['DASHSCOPE_API_KEY'];
    }
  });

  it('lists tools sorted under mcp__<server>__<tool>, calls one, and shows images as text', async () => {
    const { open, workspace } = await setup({ global: { mcpServers: { fake: stdioServer() } } });
    const hub = await open();
    const { tools, executors } = await toolsetOf(hub, approval('auto', 'allow').value);

    expect(tools.map((tool) => tool.name)).toEqual(['mcp__fake__crash', 'mcp__fake__echo', 'mcp__fake__env', 'mcp__fake__fail', 'mcp__fake__image', 'mcp__fake__screenshot']);
    expect(tools.find((tool) => tool.name === 'mcp__fake__echo')!.input_schema).toMatchObject({ properties: { text: { type: 'string' } } });
    expect(textOf(await executors['mcp__fake__echo']!.run({ text: 'hi' }, ctx(workspace)))).toBe('echo: hi');
    expect(textOf(await executors['mcp__fake__image']!.run({}, ctx(workspace)))).toBe('here it is\n[image image/png, 7 bytes, not shown]');
    await expect(executors['mcp__fake__fail']!.run({}, ctx(workspace))).rejects.toThrow('it broke');

    const shot = await executors['mcp__fake__screenshot']!.run({}, ctx(workspace));
    expect(shot).toMatchObject({
      text: 'mcp__fake__screenshot image 1 is a 1x1 PNG image (70 B), attached below.',
      images: [expect.objectContaining({ kind: 'image', mediaType: 'image/png', width: 1, height: 1, name: 'mcp__fake__screenshot image 1' })],
    });
    const [image] = (shot as unknown as { images: ImageAttachment[] }).images;
    expect(existsSync(path.join(workspace, '.attachments', attachmentFileName(image!))), 'the image is stored where the next request reads it').toBe(true);
    expect(hub.views()[0]).toMatchObject({ state: { status: 'ready', restarts: 0 }, tools: expect.arrayContaining(['mcp__fake__echo']) });
  });

  it('lists prompts and resources as data', async () => {
    const { open } = await setup({ global: { mcpServers: { fake: stdioServer() } } });
    const hub = await open();
    await toolsetOf(hub, approval('auto', 'allow').value);
    expect(await hub.prompts()).toEqual([{ server: 'fake', name: 'greet', description: 'Say hello.', arguments: ['who'] }]);
    expect(await hub.resources()).toEqual([{ server: 'fake', uri: 'fake://readme', name: 'readme', mimeType: 'text/plain' }]);
  });

  it('restarts a server that crashed, and the next call reaches the new process', async () => {
    const { open, workspace } = await setup({ global: { mcpServers: { fake: stdioServer() } } });
    const hub = await open();
    const { executors } = await toolsetOf(hub, approval('auto', 'allow').value);
    await expect(executors['mcp__fake__crash']!.run({}, ctx(workspace))).rejects.toThrow(/fake/);
    await waitFor(() => hub.views()[0]!.state.status === 'ready' && (hub.views()[0]!.state as { restarts: number }).restarts === 1);

    expect(textOf(await executors['mcp__fake__echo']!.run({ text: 'again' }, ctx(workspace)))).toBe('echo: again');
  });

  it('stops its servers with the session', async () => {
    const { open } = await setup({ global: { mcpServers: { fake: stdioServer() } } });
    const hub = await open();
    await toolsetOf(hub, approval('auto', 'allow').value);
    await hub.stop();
    expect(hub.views()[0]!.state).toEqual({ status: 'stopped' });
  });

  it('reports a server that cannot start as failed with its reason', async () => {
    const { open } = await setup({ global: { mcpServers: { broken: { command: '/nonexistent/mcp-server', args: [] } } } });
    const hub = await open();
    expect((await toolsetOf(hub, approval('auto', 'allow').value)).tools).toEqual([]);
    expect(hub.views()[0]!.state).toMatchObject({ status: 'failed', needsSignIn: false, reason: expect.stringContaining('ENOENT') });
  });

  it('declares every tool directly past 40 tools, for the run to defer, and each one runs', async () => {
    const { open, workspace } = await setup({ global: { mcpServers: { fake: stdioServer({ TOOL_COUNT: '40' }) } } });
    const hub = await open();
    const { tools, executors } = await toolsetOf(hub, approval('auto', 'allow').value);

    expect(tools.map((tool) => tool.name)).toContain('mcp__fake__extra_39');
    expect(tools.find((tool) => tool.name === 'mcp__fake__extra_07')).toMatchObject({ input_schema: { properties: { n: { type: 'number' } } } });
    expect(textOf(await executors['mcp__fake__extra_07']!.run({ n: 3 }, ctx(workspace)))).toBe('extra 7 got 3');
  });
});

describe('MCP approval', () => {
  it('asks in Ask mode until the user allows the tool for the session', async () => {
    const { open, workspace } = await setup({ global: { mcpServers: { fake: stdioServer() } } });
    const hub = await open();
    const once = approval('ask', 'allow');
    const { executors } = await toolsetOf(hub, once.value);
    const reply = await executors['mcp__fake__echo']!.run({ text: 'a' }, ctx(workspace));
    expect(reply).toMatchObject({ text: 'echo: a', approval: { rule: 'mcp-read-only', decidedBy: 'user', verdict: 'allow' } });
    await executors['mcp__fake__echo']!.run({ text: 'b' }, ctx(workspace));
    expect(once.asked).toHaveLength(2);

    const session = approval('ask', 'allow-session');
    const again = await toolsetOf(hub, session.value);
    await again.executors['mcp__fake__echo']!.run({ text: 'c' }, ctx(workspace));
    expect(await again.executors['mcp__fake__echo']!.run({ text: 'd' }, ctx(workspace))).toBe('echo: d');
    expect(session.asked.map(({ denial }) => denial.command)).toEqual(['mcp__fake__echo']);
    await again.executors['mcp__fake__env']!.run({}, ctx(workspace));
    expect(session.asked.map(({ denial }) => denial.command), 'the allowance is per tool').toEqual(['mcp__fake__echo', 'mcp__fake__env']);
  });

  it('refuses a call the user rejects, without calling the server', async () => {
    const marker = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-mcp-marker-')), 'crashed');
    const { open, workspace } = await setup({ global: { mcpServers: { fake: stdioServer({ MARKER: marker }) } } });
    const hub = await open();
    const { executors } = await toolsetOf(hub, approval('ask', 'reject').value);
    await expect(executors['mcp__fake__crash']!.run({}, ctx(workspace))).rejects.toThrow(/^The user rejected `mcp__fake__crash`, so it did not run\. STOP/);
    expect(hub.views()[0]!.state).toEqual({ status: 'ready', restarts: 0 });
  });

  it('runs read-only tools in Auto and sends the others to the classifier as a fenced MCP call', async () => {
    const { open, workspace } = await setup({ global: { mcpServers: { fake: stdioServer() } } });
    const hub = await open();
    const auto = approval('auto', 'reject', 'deny');
    const { executors } = await toolsetOf(hub, auto.value);

    expect(await executors['mcp__fake__echo']!.run({ text: 'x' }, ctx(workspace))).toBe('echo: x');
    expect(auto.classified).toEqual([]);

    await expect(executors['mcp__fake__env']!.run({}, ctx(workspace))).rejects.toThrow(/refused by the safety classifier/);
    expect(auto.classified).toEqual([
      expect.objectContaining({ request: 'use the fake server', flagged: expect.objectContaining({ rule: 'mcp-tool' }), mcp: { server: 'fake', tool: 'env', arguments: '{}' } }),
    ]);
    expect(auto.asked).toEqual([]);
  });

  it('offers no MCP tools to a non-interactive run unless it turns them on', async () => {
    const { open } = await setup({ global: { mcpServers: { fake: stdioServer() } } });
    const hub = await open();
    expect(await hub.toolset({ kind: 'non-interactive' })).toBeUndefined();
    expect(hub.views()[0]!.state, 'nothing started').toEqual({ status: 'stopped' });
    expect((await toolsetOf(hub, { kind: 'non-interactive', mcp: true })).tools.length).toBeGreaterThan(0);
  });
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('MCP HTTP servers', () => {
  it('lists and calls a streamable HTTP server', async () => {
    const url = await listen(async (req, res) => {
      const transport = new StreamableHTTPServerTransport({});
      await fakeMcpServer().connect(transport as Transport);
      await transport.handleRequest(req, res);
    });
    const { open, workspace } = await setup({ global: { mcpServers: { web: { type: 'http', url: `${url}/mcp` } } } });
    const hub = await open();
    const { executors } = await toolsetOf(hub, approval('auto', 'allow').value);
    expect(textOf(await executors['mcp__web__echo']!.run({ text: 'over http' }, ctx(workspace)))).toBe('echo: over http');
  });

  it('falls back to legacy SSE when streamable HTTP is refused', async () => {
    const transports = new Map<string, SSEServerTransport>();
    const url = await listen(async (req, res) => {
      const { pathname, searchParams } = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', res);
        transports.set(transport.sessionId, transport);
        await fakeMcpServer().connect(transport);
      } else if (req.method === 'POST' && pathname === '/messages') {
        await transports.get(searchParams.get('sessionId') ?? '')?.handlePostMessage(req, res);
      } else {
        res.writeHead(405).end();
      }
    });
    const { open, workspace } = await setup({ global: { mcpServers: { legacy: { type: 'http', url: `${url}/sse` } } } });
    const hub = await open();
    const { executors } = await toolsetOf(hub, approval('auto', 'allow').value);
    expect(textOf(await executors['mcp__legacy__echo']!.run({ text: 'over sse' }, ctx(workspace)))).toBe('echo: over sse');
  });

  it('reports a server that wants OAuth as needing sign-in', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"' }).end();
    });
    const { open } = await setup({ global: { mcpServers: { private: { type: 'http', url: `${url}/mcp` } } } });
    const hub = await open();
    await toolsetOf(hub, approval('auto', 'allow').value);
    expect(hub.views()[0]!.state).toMatchObject({ status: 'failed', needsSignIn: true });
  });
});

describe('MCP sign-in', () => {
  const oauths: FakeOAuth[] = [];
  afterEach(async () => {
    await Promise.all(oauths.splice(0).map((oauth) => oauth.close()));
  });

  /**
   * A server that wants a bearer token, and the editor's side as the hub sees it: `next` answers each ask in turn,
   * and every ask is kept with the server it named and whether the last token was refused.
   */
  async function signedIn(next: (rejected: boolean) => string | undefined) {
    const oauth = await fakeOAuth();
    oauths.push(oauth);
    const asked: { name: string; url: string; rejected: boolean }[] = [];
    const tokens: McpTokens = async (server, rejected) => {
      asked.push({ ...server, rejected });
      return next(rejected);
    };
    const { open, workspace } = await setup({ global: { mcpServers: { docs: { type: 'http', url: oauth.mcpUrl } } } });
    return { oauth, asked, hub: await open([], tokens), workspace };
  }

  it('needs sign-in while the editor holds no token, and asks it only after the 401', async () => {
    const { hub, asked, oauth } = await signedIn(() => undefined);
    const { tools } = await toolsetOf(hub, approval('auto', 'allow').value);
    expect(hub.views()[0]!.state).toEqual({ status: 'failed', reason: 'the server needs sign-in', needsSignIn: true });
    expect(tools).toEqual([]);
    expect(asked).toEqual([{ name: 'docs', url: oauth.mcpUrl, rejected: false }]);
  });

  it('sends the access token as a bearer, and the tools work', async () => {
    let oauth: FakeOAuth | undefined;
    const { hub, workspace, ...rest } = await signedIn(() => oauth!.mint().accessToken);
    oauth = rest.oauth;
    const { executors } = await toolsetOf(hub, approval('auto', 'allow').value);
    expect(textOf(await executors['mcp__docs__echo']!.run({ text: 'signed in' }, ctx(workspace)))).toBe('echo: signed in');
    expect(rest.asked.map((ask) => ask.rejected), 'one ask for the whole connection').toEqual([false]);
  });

  it('asks for a refreshed token when the server refuses an expired one, at the start and in the middle of a session', async () => {
    let oauth: FakeOAuth | undefined;
    let stale: string | undefined;
    const { hub, workspace, asked, ...rest } = await signedIn((rejected) => {
      if (!rejected && stale !== undefined) return stale;
      return oauth!.mint().accessToken;
    });
    oauth = rest.oauth;
    stale = oauth.mint().accessToken;
    oauth.expireAccess();
    const { executors } = await toolsetOf(hub, approval('auto', 'allow').value);
    expect(asked.map((ask) => ask.rejected), 'the expired token was refused, then refreshed').toEqual([false, true]);
    expect(textOf(await executors['mcp__docs__echo']!.run({ text: 'one' }, ctx(workspace)))).toBe('echo: one');

    oauth.expireAccess();
    expect(textOf(await executors['mcp__docs__echo']!.run({ text: 'two' }, ctx(workspace)))).toBe('echo: two');
    expect(asked.map((ask) => ask.rejected)).toEqual([false, true, true]);
  });

  it('turns to needing sign-in when the editor has no token left for a refused one, and again after a reconnect', async () => {
    let oauth: FakeOAuth | undefined;
    let signedOut = false;
    const { hub, workspace, ...rest } = await signedIn(() => (signedOut ? undefined : oauth!.mint().accessToken));
    oauth = rest.oauth;
    const { executors } = await toolsetOf(hub, approval('auto', 'allow').value);
    signedOut = true;
    oauth.revokeAll();
    await expect(executors['mcp__docs__echo']!.run({ text: 'gone' }, ctx(workspace))).rejects.toThrow(
      "the MCP server docs needs sign-in; ask the user to sign in to it in the editor's MCP servers view",
    );
    expect(hub.views()[0]!.state).toMatchObject({ status: 'failed', needsSignIn: true });
    expect((await hub.toolset(approval('auto', 'allow').value))!.tools, 'its tools left').toEqual([]);

    await hub.reconnect('docs');
    await hub.start();
    expect(hub.views()[0]!.state).toMatchObject({ status: 'failed', needsSignIn: true });
  });

  it('never asks for a token for a server whose definition sets its own credential', async () => {
    const oauth = await fakeOAuth();
    oauths.push(oauth);
    const asked: boolean[] = [];
    const { open } = await setup({ global: { mcpServers: { docs: { type: 'http', url: oauth.mcpUrl, headers: { Authorization: 'Bearer fake-own' } } } } });
    const hub = await open([], async (_server, rejected) => (asked.push(rejected), oauth.mint().accessToken));
    await toolsetOf(hub, approval('auto', 'allow').value);
    expect(hub.views()[0]!.state).toMatchObject({ status: 'failed', needsSignIn: true });
    expect(asked).toEqual([]);
  });
});

describe('gcode mcp', () => {
  it('lists the servers with their state, and trusts one by name', async () => {
    const marker = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-mcp-marker-')), 'spawned');
    const { env, workspace, store } = await setup({ mcpJson: { mcpServers: { fake: stdioServer({ MARKER: marker }) } } });

    const listed = await runCli(['mcp', 'list'], env, { cwd: workspace });
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(/fake\s+\.mcp\.json\s+untrusted/);

    const trusted = await runCli(['mcp', 'trust', 'fake'], env, { cwd: workspace });
    expect(trusted.code).toBe(0);
    expect(JSON.parse(await readFile(store.mcpTrustFile, 'utf8')).servers).toEqual([expect.objectContaining({ workspace, name: 'fake' })]);
    expect(existsSync(marker), 'trusting does not start the server').toBe(false);

    const after = await runCli(['mcp', 'list'], env, { cwd: workspace });
    expect(after.stdout).toMatch(/fake\s+\.mcp\.json\s+stopped/);

    const unknown = await runCli(['mcp', 'trust', 'nope'], env, { cwd: workspace });
    expect(unknown.code).toBe(1);
  });
});

