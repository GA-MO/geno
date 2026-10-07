import { describe, expect, it } from 'vitest';
import {
  AGENT_MODE_TOOLS,
  AGENT_TOOL_DEFINITIONS,
  CHILD_TOOL_NAMES,
  commandLineOf,
  filterLog,
  launchUrlOf,
  mergeLaunchFiles,
  missingLaunchText,
  PAGE_TITLE_MAX,
  pageTitleOf,
  PREVIEW_TOOL_NAMES,
  previewListText,
  previewLogsText,
  previewStartText,
  previewStatusOf,
  type LaunchConfig,
  type PageCheck,
  type PreviewServer,
} from '../src/index.js';

const ESC = '\x1b';
const FAKE_KEY = `sk-${'fAkE0'.repeat(6)}`;

const config = (name: string, file: string, extra: Partial<LaunchConfig> = {}): LaunchConfig => ({
  name,
  runtimeExecutable: 'pnpm',
  runtimeArgs: ['dev'],
  port: 3000,
  url: 'http://localhost:3000',
  file,
  ...extra,
});

const server = (extra: Partial<PreviewServer> = {}): PreviewServer => ({
  name: 'web',
  url: 'http://localhost:3000',
  job: 'bg-1',
  command: 'pnpm dev',
  status: { kind: 'ready' },
  ...extra,
});

describe('launchUrlOf', () => {
  it('defaults to localhost on the entry port, and keeps a local origin as its origin', () => {
    expect(launchUrlOf(3000, undefined)).toEqual({ ok: true, url: 'http://localhost:3000' });
    expect(launchUrlOf(3000, 'http://127.0.0.1:3000/')).toEqual({ ok: true, url: 'http://127.0.0.1:3000' });
    expect(launchUrlOf(443, 'https://app.localhost')).toEqual({ ok: true, url: 'https://app.localhost' });
  });

  it.each([
    ['http://example.com:3000', /not on this machine/],
    ['http://localhost@example.com:3000', /not on this machine/],
    ['http://localhost:3001', /has port 3001, not the entry's port 3000/],
    ['http://localhost:3000/admin', /origin only/],
    ['localhost:3000', /not http or https|not a full URL/],
    ['file:///tmp/x', /not http or https/],
  ])('refuses %s', (raw, why) => {
    const parsed = launchUrlOf(3000, raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.why).toMatch(why);
  });
});

describe('mergeLaunchFiles', () => {
  it('keeps the first file entry of a name, and says which one lost', () => {
    const merged = mergeLaunchFiles([
      { file: '.g-code/launch.json', configs: [config('web', '.g-code/launch.json', { port: 4000 })], problems: [] },
      { file: '.claude/launch.json', configs: [config('web', '.claude/launch.json'), config('admin', '.claude/launch.json')], problems: ['configurations[2]: port is missing'] },
    ]);
    expect(merged.configs.map((c) => [c.name, c.port])).toEqual([
      ['web', 4000],
      ['admin', 3000],
    ]);
    expect(merged.files).toEqual(['.g-code/launch.json', '.claude/launch.json']);
    expect(merged.problems).toEqual(['.claude/launch.json: configurations[2]: port is missing', '.claude/launch.json: "web" is also in .g-code/launch.json, which wins']);
  });
});

describe('commandLineOf', () => {
  it('writes plain words as typed, so the rules match the line bash would see', () => {
    expect(commandLineOf({ runtimeExecutable: 'pnpm', runtimeArgs: ['--filter', '@app/web', 'dev', '--port=3000'] })).toBe('pnpm --filter @app/web dev --port=3000');
  });

  it('quotes a word the shell would split or expand', () => {
    expect(commandLineOf({ runtimeExecutable: 'node', runtimeArgs: ['my server.js', "it's", '$HOME', 'a;rm'] })).toBe(`node 'my server.js' 'it'\\''s' '$HOME' 'a;rm'`);
    expect(commandLineOf({ runtimeExecutable: 'echo', runtimeArgs: [''] })).toBe(`echo ''`);
  });
});

describe('filterLog', () => {
  const raw = [
    '> next dev',
    `${ESC}[32m✓${ESC}[39m Ready in 1.2s`,
    ' ⚠ Fast Refresh had to perform a full reload',
    `${ESC}[31mTypeError${ESC}[39m: Cannot read properties of undefined`,
    ' ⨯ ./app/page.tsx: Module not found',
    'GET / 200 in 30ms',
    `DATABASE_URI=postgres://payload:hunter2@localhost/db token=${FAKE_KEY}`,
    'GET /admin 500 in 12ms',
  ].join('\r\n');

  it('keeps errors, colored or marked with Next.js ⨯, at level error', () => {
    expect(filterLog(raw, { level: 'error', lines: 50 }).lines).toEqual(['TypeError: Cannot read properties of undefined', ' ⨯ ./app/page.tsx: Module not found']);
  });

  it('adds warnings at level warn', () => {
    expect(filterLog(raw, { level: 'warn', lines: 50 }).lines).toHaveLength(3);
  });

  it('searches ignoring case, and returns the newest lines with the full count', () => {
    expect(filterLog(raw, { level: 'all', search: 'get /', lines: 1 })).toEqual({ lines: ['GET /admin 500 in 12ms'], matched: 2, total: 8 });
  });

  it('redacts secrets before it matches, so a search cannot find one', () => {
    const read = filterLog(raw, { level: 'all', search: 'DATABASE', lines: 50 });
    expect(read.lines).toEqual(['DATABASE_URI=postgres://payload:[redacted]@localhost/db token=[redacted]']);
    expect(filterLog(raw, { level: 'all', search: 'hunter2', lines: 50 }).matched).toBe(0);
  });
});

describe('preview status and texts', () => {
  it('reads a running job as starting or ready by its port, and an ended job as ended whatever the port says', () => {
    expect(previewStatusOf({ status: 'running' }, false)).toEqual({ kind: 'starting' });
    expect(previewStatusOf({ status: 'running' }, true)).toEqual({ kind: 'ready' });
    expect(previewStatusOf({ status: 'exited', exitCode: 1, signal: null }, true)).toEqual({ kind: 'ended', state: { status: 'exited', exitCode: 1, signal: null } });
  });

  it('points a ready server at the browser tools and the error logs', () => {
    const text = previewStartText({ kind: 'started', server: server(), waitedS: 2, tail: '' });
    expect(text).toMatch(/^Started dev server "web" \(`pnpm dev`\) as bg-1\. It answers at http:\/\/localhost:3000\./);
    expect(text).toContain('mcp__browser__new_page');
    expect(text).toContain('mcp__browser__list_console_messages');
    expect(text).toContain('"level": "error"');
  });

  it('adds what the first GET of the page returned, and sends a failing page to the logs', () => {
    const ready = (page: PageCheck) => previewStartText({ kind: 'started', server: server(), waitedS: 1, tail: '', page });
    expect(ready({ kind: 'answered', status: 200, title: 'Payload Admin' })).toContain('GET http://localhost:3000/ returned 200, titled "Payload Admin".');
    expect(ready({ kind: 'answered', status: 307, location: '/admin/login' })).toContain('returned 307, redirecting to /admin/login.');
    expect(ready({ kind: 'answered', status: 500 })).toContain('returned 500. The server failed on the page; read its errors with preview_logs.');
    expect(ready({ kind: 'no-answer', why: 'no response within 30s' })).toContain('GET http://localhost:3000/ got no response: no response within 30s.');
  });

  it('reads a page title on one line, cut to its limit', () => {
    expect(pageTitleOf('<html><head><TITLE lang="en">\n  My   app\n</TITLE>')).toBe('My app');
    expect(pageTitleOf('<title></title>')).toBeUndefined();
    expect(pageTitleOf('x'.repeat(10))).toBeUndefined();
    expect(pageTitleOf(`<title>${'a'.repeat(200)}</title>`)).toHaveLength(PAGE_TITLE_MAX);
  });

  it('says a reused server runs already, a slow one may be compiling, and a dead one ended with its output', () => {
    expect(previewStartText({ kind: 'reused', server: server(), waitedS: 0, tail: '' })).toMatch(/already runs in this session as bg-1\. It answers/);
    expect(previewStartText({ kind: 'started', server: server({ status: { kind: 'starting' } }), waitedS: 60, tail: 'compiling' })).toContain('Nothing answers at http://localhost:3000 after 60s');
    const died = previewStartText({ kind: 'started', server: server({ status: { kind: 'ended', state: { status: 'exited', exitCode: 1, signal: null } } }), waitedS: 1, tail: 'EADDRINUSE' });
    expect(died).toContain('It exited with code 1 before it answered');
    expect(died).toContain('EADDRINUSE');
  });

  it('starts nothing on a port someone else holds', () => {
    expect(previewStartText({ kind: 'taken', config: config('web', '.claude/launch.json') })).toMatch(/^Something already answers at http:\/\/localhost:3000, and this session did not start it, so nothing was started\./);
  });

  it('lists the entries, what was left out, and the servers with their state', () => {
    const launch = mergeLaunchFiles([{ file: '.claude/launch.json', configs: [config('web', '.claude/launch.json', { cwd: 'apps/web' })], problems: ['configurations[1]: name is missing'] }]);
    expect(previewListText(launch, [server({ status: { kind: 'starting' } })])).toBe(
      [
        'Launch entries (.claude/launch.json):',
        '- web: `pnpm dev` in apps/web, http://localhost:3000',
        'Left out:',
        '- .claude/launch.json: configurations[1]: name is missing',
        'Dev servers this session started:',
        '- web (bg-1, `pnpm dev`): runs, but nothing answers at http://localhost:3000 yet',
      ].join('\n'),
    );
    expect(previewListText(mergeLaunchFiles([]), [])).toMatch(/^No launch file: neither \.g-code\/launch\.json nor \.claude\/launch\.json exists/);
  });

  it('counts what a filtered log read matched', () => {
    const read = { lines: ['b error'], matched: 3, total: 10 };
    expect(previewLogsText(server(), read, { level: 'error', lines: 1 })).toBe('web (bg-1) answers at http://localhost:3000.\n3 of its 10 kept lines match level error; the last 1:\nb error');
    expect(previewLogsText(server(), { lines: [], matched: 0, total: 10 }, { level: 'error', search: 'x', lines: 5 })).toContain('None of its 10 kept lines match level error and "x".');
  });

  it('suggests a launch file from the dev script it found, as JSON the model can write', () => {
    const text = missingLaunchText('pnpm dev');
    const json = /\{[\s\S]*\n\}/.exec(text)![0];
    expect(JSON.parse(json)).toEqual({ version: '0.0.1', configurations: [{ name: 'dev', runtimeExecutable: 'pnpm', runtimeArgs: ['dev'], port: 3000 }] });
    expect(missingLaunchText(undefined)).toContain('ask the user which command starts the server');
  });
});

describe('the preview tools by mode', () => {
  it('offers listing and logs in every mode, starting and stopping outside Plan, and nothing to a subagent', () => {
    for (const mode of ['ask', 'auto', 'non-interactive'] as const) expect(AGENT_MODE_TOOLS[mode]).toEqual(expect.arrayContaining([...PREVIEW_TOOL_NAMES]));
    expect(AGENT_MODE_TOOLS.plan).toEqual(expect.arrayContaining(['preview_list', 'preview_logs']));
    expect(AGENT_MODE_TOOLS.plan).not.toContain('preview_start');
    expect(AGENT_MODE_TOOLS.plan).not.toContain('preview_stop');
    for (const name of PREVIEW_TOOL_NAMES) expect(CHILD_TOOL_NAMES).not.toContain(name);
    expect(AGENT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(expect.arrayContaining([...PREVIEW_TOOL_NAMES]));
  });
});
