import { describe, expect, it } from 'vitest';
import {
  BROWSER_SERVER_VERSION,
  browserDenialFor,
  browserServerArgs,
  browserUrlOf,
  devServerCommand,
  type BrowserCall,
  type BrowserContext,
  type BrowserUrl,
} from '../src/browser.js';
import { APPROVAL_MODES, type ApprovalMode, type RuleVerdict } from '../src/approval.js';
import type { NewRule, PermissionRule } from '../src/permission-rules.js';

const WORKSPACE = '/Users/me/ws';

const URLS: readonly (readonly [string, BrowserUrl['kind']])[] = [
  ['http://localhost:3000/', 'local'],
  ['http://LOCALHOST:3000/', 'local'],
  ['https://localhost/', 'local'],
  ['http://localhost./', 'local'],
  ['http://127.0.0.1:5173/app', 'local'],
  ['http://[::1]:8080/', 'local'],
  ['http://app.localhost:3000/', 'local'],
  ['http://my-site.test/', 'local'],
  ['about:blank', 'local'],
  [`file://${WORKSPACE}/index.html`, 'local'],
  [`file://${WORKSPACE}/dist/a%20b.html`, 'local'],
  ['https://example.com/', 'remote'],
  ['http://localhost.evil.com/', 'remote'],
  ['http://evil.com/localhost', 'remote'],
  ['http://localhost@evil.com/', 'remote'],
  ['http://localhost:3000@evil.com/', 'remote'],
  ['http://evil.com\\@localhost/', 'remote'],
  ['http://127.0.0.1.nip.io/', 'remote'],
  ['http://evil.localhost.com/', 'remote'],
  ['http://test/', 'remote'],
  ['http://localhost/', 'local'],
  ['http://[::2]/', 'remote'],
  ['http://[::ffff:7f00:1]/', 'remote'],
  ['http://192.168.1.10:3000/', 'remote'],
  ['http://10.0.0.1/', 'remote'],
  ['file:///etc/passwd', 'refused'],
  [`file://${WORKSPACE}/../secret.txt`, 'refused'],
  [`file://${WORKSPACE}-other/x.html`, 'refused'],
  ['file://evil.com/share/x.html', 'refused'],
  [`file://${WORKSPACE}/..%2F..%2Fetc/passwd`, 'refused'],
  ['javascript:alert(1)', 'refused'],
  ['data:text/html,<h1>hi</h1>', 'refused'],
  ['chrome://version', 'refused'],
  ['view-source:https://example.com/', 'refused'],
  ['about:settings', 'refused'],
  ['localhost:3000', 'refused'],
  ['//localhost:3000', 'refused'],
  ['not a url', 'refused'],
];

describe('the browser URL rules', () => {
  it.each(URLS)('%s is %s', (raw, kind) => {
    expect(browserUrlOf(raw, WORKSPACE).kind).toBe(kind);
  });

  it('names the host a remote URL really goes to', () => {
    expect(browserUrlOf('http://localhost@evil.com:8080/x', WORKSPACE)).toEqual({ kind: 'remote', url: 'http://localhost@evil.com:8080/x', host: 'evil.com:8080' });
  });

  it('puts the real host in the question the user answers', () => {
    expect(browserDenialFor(call('new_page', { url: 'http://localhost@evil.com/' }), 'auto', ctx())?.command).toBe('open http://localhost@evil.com/ (host evil.com)');
  });
});

const call = (tool: string, args: Record<string, unknown> = {}, readOnly = false): BrowserCall => ({ name: `mcp__browser__${tool}`, tool, args, readOnly });
const ctx = (over: Partial<BrowserContext> = {}): BrowserContext => ({ workspace: WORKSPACE, allowedForSession: false, page: undefined, ...over });

const verdicts = (c: BrowserCall, context: BrowserContext = ctx()): Record<ApprovalMode, RuleVerdict> =>
  Object.fromEntries(APPROVAL_MODES.map((mode) => [mode, browserDenialFor(c, mode, context)?.verdict ?? 'allow'])) as Record<ApprovalMode, RuleVerdict>;

const remotePage = { url: browserUrlOf('https://evil.example/', WORKSPACE), approved: false };

const ruleOf = (rule: NewRule, i: number): PermissionRule => ({ ...rule, id: `r${i}`, createdAt: '' }) as PermissionRule;
const rulesOf = (...rules: readonly NewRule[]): readonly PermissionRule[] => rules.map(ruleOf);

describe('B/B-63 domain and MCP rules in the browser', () => {
  const open = call('new_page', { url: 'https://docs.example.com/guide' });

  it('opens an allowed host without asking, and still asks about an init script', () => {
    const rules = rulesOf({ effect: 'allow', tool: 'browser', domain: '*.example.com' });
    expect(verdicts(open, ctx({ rules }))).toEqual({ plan: 'deny', ask: 'allow', auto: 'allow', 'non-interactive': 'deny' });
    expect(browserDenialFor(call('new_page', { url: 'https://docs.example.com/', initScript: 'x()' }), 'ask', ctx({ rules }))?.rule).toBe('browser-risky-tool');
  });

  it('takes no allow from WebFetch(domain:...), but its deny and ask hold for the browser too', () => {
    expect(verdicts(open, ctx({ rules: rulesOf({ effect: 'allow', tool: 'web_fetch', domain: 'docs.example.com' }) })).ask).toBe('ask');
    expect(verdicts(open, ctx({ rules: rulesOf({ effect: 'deny', tool: 'web_fetch', domain: 'docs.example.com' }) }))).toEqual({ plan: 'deny', ask: 'deny', auto: 'deny', 'non-interactive': 'deny' });
    expect(browserDenialFor(open, 'auto', ctx({ rules: rulesOf({ effect: 'ask', tool: 'web_fetch', domain: '*.example.com' }) }))).toMatchObject({ rule: 'workspace-ask', verdict: 'ask' });
  });

  it('lets an MCP allow on the browser server skip a tool question, never a URL rule or Plan', () => {
    const click = call('click', { uid: '1' });
    const rules = rulesOf({ effect: 'allow', mcp: 'mcp__browser' });
    expect(verdicts(click, ctx({ rules }))).toEqual({ plan: 'deny', ask: 'allow', auto: 'allow', 'non-interactive': 'allow' });
    expect(verdicts(open, ctx({ rules })).ask).toBe('ask');
    expect(browserDenialFor(click, 'ask', ctx())?.keeps).toBe('mcp__browser__click');
  });
});

describe('what a browser question asks about', () => {
  it('names the host a navigation opens, without its port, and the tool any other call uses', () => {
    expect(browserDenialFor(call('new_page', { url: 'https://docs.example.com:8443/guide' }), 'ask', ctx())?.subject).toEqual({ kind: 'browse', url: 'https://docs.example.com:8443/guide', host: 'docs.example.com' });
    expect(browserDenialFor(call('click', { uid: '1' }), 'ask', ctx())?.subject).toEqual({ kind: 'mcp', server: 'browser', tool: 'click', arguments: '{\n  "uid": "1"\n}' });
    expect(browserDenialFor(call('click', { uid: '1' }), 'ask', ctx({ page: remotePage }))).toMatchObject({ rule: 'browser-remote-page', reason: 'acting on https://evil.example/, a page from another host the user did not approve', subject: { kind: 'mcp', server: 'browser', tool: 'click' } });
  });
});

describe('the browser approval table', () => {
  it('opens a local page without asking in Ask and Auto, for new_page and navigate_page alike', () => {
    for (const tool of ['new_page', 'navigate_page']) {
      expect(verdicts(call(tool, { url: 'http://localhost:3000/' }))).toEqual({ plan: 'deny', ask: 'allow', auto: 'allow', 'non-interactive': 'allow' });
    }
  });

  it('asks before any other host in Ask, lets the classifier judge it in Auto, and refuses it in a non-interactive run', () => {
    for (const tool of ['new_page', 'navigate_page']) {
      expect(verdicts(call(tool, { url: 'https://example.com/' }))).toEqual({ plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'deny' });
      expect(verdicts(call(tool, { url: 'http://localhost@evil.com/' }))).toEqual({ plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'deny' });
    }
  });

  it('a tool allowed for the session still asks about another host, or sends it to the classifier in Auto', () => {
    const navigate = call('navigate_page', { url: 'https://example.com/' });
    expect(browserDenialFor(navigate, 'ask', ctx({ allowedForSession: true }))?.verdict).toBe('ask');
    expect(browserDenialFor(navigate, 'auto', ctx({ allowedForSession: true }))).toMatchObject({ verdict: 'classify', rule: 'browser-remote-url' });
  });

  it('refuses file: URLs outside the workspace and other schemes in every mode', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://version']) {
      expect(verdicts(call('new_page', { url }))).toEqual({ plan: 'deny', ask: 'deny', auto: 'deny', 'non-interactive': 'deny' });
    }
    expect(browserDenialFor(call('new_page', { url: 'file:///etc/passwd' }), 'auto', ctx())?.reason).toContain('the file is outside the workspace');
  });

  it('opens a workspace file: URL like a local page', () => {
    expect(verdicts(call('new_page', { url: `file://${WORKSPACE}/index.html` }))).toEqual({ plan: 'deny', ask: 'allow', auto: 'allow', 'non-interactive': 'allow' });
  });

  it('treats an init script on a local navigation as a risky tool', () => {
    expect(verdicts(call('navigate_page', { url: 'http://localhost/', initScript: 'fetch("https://evil")' }))).toEqual({
      plan: 'deny',
      ask: 'ask',
      auto: 'classify',
      'non-interactive': 'allow',
    });
  });

  it('asks before evaluate_script, upload_file and fill_form every time in Ask, and classifies them in Auto', () => {
    for (const tool of ['evaluate_script', 'upload_file', 'fill_form']) {
      expect(verdicts(call(tool))).toEqual({ plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'allow' });
      expect(browserDenialFor(call(tool), 'ask', ctx({ allowedForSession: true }))?.rule, `${tool} skips no question for the session`).toBe('browser-risky-tool');
    }
  });

  it('lets read-only tools follow readOnlyHint as every MCP tool does', () => {
    for (const tool of ['list_console_messages', 'list_network_requests', 'list_pages']) {
      expect(verdicts(call(tool, {}, true))).toEqual({ plan: 'allow', ask: 'ask', auto: 'allow', 'non-interactive': 'allow' });
    }
  });

  it('treats a snapshot or screenshot as read-only unless it writes a file', () => {
    for (const tool of ['take_snapshot', 'take_screenshot']) {
      expect(verdicts(call(tool, { pageId: 1 }))).toEqual({ plan: 'allow', ask: 'ask', auto: 'allow', 'non-interactive': 'allow' });
      expect(verdicts(call(tool, { pageId: 1, filePath: 'shot.png' }))).toEqual({ plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'allow' });
    }
  });

  it('asks before acting on a page of another host nobody approved, or sends it to the classifier in Auto, even for a tool allowed for the session', () => {
    expect(verdicts(call('click', { uid: '1_2' }), ctx({ page: remotePage, allowedForSession: true }))).toEqual({
      plan: 'deny',
      ask: 'ask',
      auto: 'classify',
      'non-interactive': 'deny',
    });
    expect(browserDenialFor(call('click', { uid: '1_2' }), 'auto', ctx({ page: remotePage }))?.rule).toBe('browser-remote-page');
  });

  it('lets reads of such a page through, and acts on an approved host as on any page', () => {
    expect(browserDenialFor(call('take_snapshot', {}), 'auto', ctx({ page: remotePage }))).toBeUndefined();
    expect(browserDenialFor(call('click', {}), 'auto', ctx({ page: { ...remotePage, approved: true } }))?.rule).toBe('mcp-tool');
  });
});

describe('the browser server flags', () => {
  it('always isolates the profile and never names a profile, a running Chrome or the user data dir', () => {
    for (const headless of [true, false]) {
      const args = browserServerArgs({ headless }, WORKSPACE);
      expect(args).toContain('--isolated');
      expect(args.some((arg) => /^--(?:user-?data-?dir|autoConnect|auto-connect|browserUrl|browser-url|wsEndpoint|ws-endpoint|channel|executablePath|config)\b/i.test(arg))).toBe(false);
      expect(args.includes('--headless')).toBe(headless);
    }
  });

  it('pins an exact version', () => {
    expect(BROWSER_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('the dev server command', () => {
  it('reads it from package.json and the lockfile', () => {
    expect(devServerCommand({ scripts: { dev: 'next dev' } }, new Set(['pnpm-lock.yaml']))).toBe('pnpm dev');
    expect(devServerCommand({ scripts: { dev: 'vite' } }, new Set())).toBe('npm run dev');
    expect(devServerCommand({ scripts: { start: 'node server.js' } }, new Set())).toBe('npm start');
    expect(devServerCommand({ scripts: { serve: 'x' } }, new Set(['yarn.lock']))).toBe('yarn serve');
    expect(devServerCommand({ scripts: { test: 'vitest' } }, new Set())).toBeUndefined();
    expect(devServerCommand(null, new Set())).toBeUndefined();
  });
});
