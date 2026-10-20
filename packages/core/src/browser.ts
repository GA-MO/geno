import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_RULES, mcpSubject, withSubject, type ApprovalMode, type BrowserRuleId, type Denial } from './approval.js';
import { MAX_LONG_SIDE } from './attachments.js';
import { domainRuleFor, mcpCallDenial, toolRuleOutcome, type PermissionRule } from './permission-rules.js';

/** The built-in browser server's name, so its tools are `mcp__browser__*`. No configured server may take it. */
export const BROWSER_SERVER = 'browser';
export const BROWSER_PACKAGE = 'chrome-devtools-mcp';
/** An exact version, never a range or `latest`, so what runs is what was reviewed; browser-tools.generated.ts lists its tools. */
export const BROWSER_SERVER_VERSION = '1.10.1';

/** Session/new, session/resume and session/load `_meta` key: the editor's browser settings for the session. */
export const BROWSER_META = 'gcode/browser';
export type BrowserSettings = { readonly enabled: boolean; readonly headless: boolean };
export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = { enabled: false, headless: true };

/**
 * The server's flags. `--isolated` gives each launch a fresh temporary Chrome profile that is deleted when Chrome
 * closes, so the user's cookies and logins are never reachable; without it the server keeps a profile under the home
 * folder. Usage statistics and the CrUX lookup would send page URLs to Google. Structured content is how the engine
 * learns where each page went. The performance and memory tools are left out: they write traces and heap snapshots.
 * `roots` are the folders its file tools may write in: the workspace and the session's scratchpad.
 */
export const browserServerArgs = ({ headless }: Pick<BrowserSettings, 'headless'>, roots: readonly string[]): string[] => [
  '--isolated',
  ...(headless ? ['--headless'] : []),
  '--no-usage-statistics',
  '--no-performance-crux',
  '--experimentalStructuredContent',
  '--categoryPerformance=false',
  '--categoryMemory=false',
  `--screenshotMaxWidth=${MAX_LONG_SIDE}`,
  `--screenshotMaxHeight=${MAX_LONG_SIDE}`,
  ...roots.map((root) => `--filesystemRoot=${root}`),
];

/** Turns off the server's own calls home: the usage statistics and the npm check for a newer version. */
export const BROWSER_SERVER_ENV: Readonly<Record<string, string>> = {
  CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
  CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
};

/** Hosts that name this machine. `*.localhost` resolves to loopback by standard; `.test` is reserved for local use. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOCAL_SUFFIXES = ['.localhost', '.test'];

/** Where a URL points, as far as the browser rules care. `url` is the URL as parsed, which is what the browser will open. */
export type BrowserUrl =
  | { readonly kind: 'local'; readonly url: string }
  | { readonly kind: 'remote'; readonly url: string; readonly host: string }
  | { readonly kind: 'refused'; readonly url: string; readonly why: string };

export const URL_RULES: Readonly<Record<BrowserUrl['kind'], BrowserRuleId>> = {
  local: 'browser-local-url',
  remote: 'browser-remote-url',
  refused: 'browser-refused-url',
};

export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return LOCAL_HOSTS.has(host) || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * Classifies a URL the agent asked the browser to open. The host comes from the WHATWG parser, the same one Chrome
 * uses, so `http://localhost@evil.com` is evil.com and `http://localhost.evil.com` is not local. A `file:` URL must be
 * inside the workspace; the caller resolves symlinks first, so `workspace` and the file are both real paths.
 */
export function browserUrlOf(raw: string, workspace: string): BrowserUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'refused', url: raw, why: 'it is not a full URL; write it out, as in http://localhost:3000' };
  }
  const href = url.href;
  switch (url.protocol) {
    case 'http:':
    case 'https:':
      return isLocalHost(url.hostname) ? { kind: 'local', url: href } : { kind: 'remote', url: href, host: url.host };
    case 'file:': {
      if (url.hostname !== '') return { kind: 'refused', url: href, why: 'a file: URL on another machine' };
      let file: string;
      try {
        file = fileURLToPath(url);
      } catch (error) {
        return { kind: 'refused', url: href, why: `it does not name a file: ${(error as Error).message}` };
      }
      return inside(workspace, file) ? { kind: 'local', url: href } : { kind: 'refused', url: href, why: 'the file is outside the workspace' };
    }
    case 'about:':
      return href === 'about:blank' ? { kind: 'local', url: href } : { kind: 'refused', url: href, why: 'only about:blank is allowed' };
    default:
      return { kind: 'refused', url: href, why: `the browser opens only http, https and workspace file URLs, not ${url.protocol}` };
  }
}

/**
 * How the browser rules treat each tool of the pinned server. `navigates` tools open their `url` argument. `risky`
 * tools run script in the page, send a local file or fill a whole form. `reads-unless-file` tools only read the page
 * unless given a `filePath` to write; the server marks them not read-only for that path alone. Any other tool follows
 * the server's readOnlyHint, as every MCP tool does.
 */
export type BrowserToolKind = 'navigates' | 'risky' | 'reads-unless-file';
export const BROWSER_TOOL_KINDS: Readonly<Record<string, BrowserToolKind>> = {
  new_page: 'navigates',
  navigate_page: 'navigates',
  evaluate_script: 'risky',
  upload_file: 'risky',
  fill_form: 'risky',
  take_screenshot: 'reads-unless-file',
  take_snapshot: 'reads-unless-file',
};

/** One call to a browser tool. `tool` is the server's name for it; `readOnly` is the pinned server's readOnlyHint. */
export type BrowserCall = { readonly name: string; readonly tool: string; readonly args: Readonly<Record<string, unknown>>; readonly readOnly: boolean };

/** The URL a call opens, when it opens one. navigate_page without a url goes back, forward or reloads its page. */
export function navigationTarget(call: Pick<BrowserCall, 'tool' | 'args'>): string | undefined {
  if (BROWSER_TOOL_KINDS[call.tool] !== 'navigates') return undefined;
  const { url } = call.args;
  return typeof url === 'string' ? url : undefined;
}

/**
 * What the engine knows of the page a call acts on. `approved` is true once the user, or the classifier in Auto, allowed
 * opening that host in this session, which is the only way a page of another host is reached on purpose.
 */
export type BrowserPage = { readonly url: BrowserUrl; readonly approved: boolean };

export type BrowserContext = {
  readonly workspace: string;
  /** The user allowed this tool for the session; it skips the tool's question, never a URL's. */
  readonly allowedForSession: boolean;
  readonly page: BrowserPage | undefined;
  /** The workspace's rules: `Browser(domain:...)` and the denies and asks of `WebFetch(domain:...)` on a URL, MCP rules on the tool. */
  readonly rules?: readonly PermissionRule[] | undefined;
};

const effectivelyReadOnly = (call: BrowserCall): boolean =>
  BROWSER_TOOL_KINDS[call.tool] === 'reads-unless-file' ? call.args['filePath'] === undefined || call.args['filePath'] === null : call.readOnly;

function ruleDenial(rule: BrowserRuleId, mode: ApprovalMode, command: string, reason = BROWSER_RULES[rule].reason): Denial | undefined {
  const verdict = BROWSER_RULES[rule].verdicts[mode];
  return verdict === 'allow' ? undefined : { rule, reason, command, verdict };
}

/**
 * What settles one browser call before it runs, or undefined when it runs. A navigation is judged by its URL alone,
 * plus the risky-tool rule when it carries an init script. Any other call that changes a page another host serves,
 * which nobody approved, asks, or goes to the classifier in Auto. Then the risky tools do the same every time; the
 * rest follow the MCP rules.
 */
export function browserDenialFor(call: BrowserCall, mode: ApprovalMode, ctx: BrowserContext): Denial | undefined {
  const target = navigationTarget(call);
  if (target === undefined) return withSubject(pageDenial(call, mode, ctx), mcpSubject(BROWSER_SERVER, call.tool, call.args));
  const url = browserUrlOf(target, ctx.workspace);
  const denial = navigationDenial(call, url, mode, ctx);
  return url.kind === 'refused' ? denial : withSubject(denial, { kind: 'browse', url: url.url, host: new URL(url.url).hostname });
}

function navigationDenial(call: BrowserCall, url: BrowserUrl, mode: ApprovalMode, ctx: BrowserContext): Denial | undefined {
  const script = typeof call.args['initScript'] === 'string' && call.args['initScript'] !== '';
  const command = `open ${url.url}${url.kind === 'remote' ? ` (host ${url.host})` : ''}${script ? ' with a script that runs on every page it loads' : ''}`;
  const reason = url.kind === 'refused' ? `${BROWSER_RULES[URL_RULES.refused].reason}: ${url.why}` : undefined;
  const risky = () => (script ? ruleDenial('browser-risky-tool', mode, command) : undefined);
  const ruled = url.kind === 'refused' ? undefined : toolRuleOutcome(domainRuleFor('browser', new URL(url.url).hostname, ctx.rules ?? []), mode, command);
  if (ruled !== undefined) return ruled.kind === 'allowed' ? risky() : ruled.denial;
  return ruleDenial(URL_RULES[url.kind], mode, command, reason) ?? risky();
}

function pageDenial(call: BrowserCall, mode: ApprovalMode, ctx: BrowserContext): Denial | undefined {
  const readOnly = effectivelyReadOnly(call);
  const page = ctx.page;
  if (!readOnly && page !== undefined && page.url.kind !== 'local' && !page.approved) {
    const denial = ruleDenial('browser-remote-page', mode, `${call.tool} on ${page.url.url}`, `acting on ${page.url.url}, a page from another host the user did not approve`);
    if (denial !== undefined) return denial;
  }
  if (BROWSER_TOOL_KINDS[call.tool] === 'risky') return ruleDenial('browser-risky-tool', mode, call.name);
  return mcpCallDenial({ name: call.name, server: BROWSER_SERVER, tool: call.tool, readOnly, args: call.args }, mode, ctx.allowedForSession, ctx.rules ?? []);
}

/** The package.json scripts that start a dev server by name. */
export const DEV_SCRIPTS = ['dev', 'start', 'serve', 'preview'] as const;
const LOCKFILES: readonly (readonly [string, string])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
];

/**
 * The command that starts the workspace's dev server, from package.json's scripts and the lockfile beside it, or
 * undefined when it has none of the usual scripts. preview_start offers it as the entry of a launch file to write.
 */
export function devServerCommand(packageJson: unknown, files: ReadonlySet<string>): string | undefined {
  const scripts = typeof packageJson === 'object' && packageJson !== null ? (packageJson as { scripts?: unknown }).scripts : undefined;
  if (typeof scripts !== 'object' || scripts === null) return undefined;
  const script = DEV_SCRIPTS.find((name) => typeof (scripts as Record<string, unknown>)[name] === 'string');
  if (script === undefined) return undefined;
  const manager = LOCKFILES.find(([file]) => files.has(file))?.[1] ?? 'npm';
  if (manager === 'npm') return script === 'start' ? 'npm start' : `npm run ${script}`;
  return manager === 'bun' ? `bun run ${script}` : `${manager} ${script}`;
}

/** Chrome's errors for a local address where nothing listens. */
export const NOTHING_LISTENS = /net::ERR_(?:CONNECTION_REFUSED|CONNECTION_RESET|EMPTY_RESPONSE|ADDRESS_UNREACHABLE)/;

export const devServerHint = (url: string): string =>
  `Nothing answers at ${url}. Start the project's dev server with preview_start, which reads its launch file and waits until the server answers, then open the page again. Without a launch file, preview_start says how to write one.`;
