import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { jobEndText, type EndedJobState, type JobId, type JobState } from './background.js';
import { isLocalHost } from './browser.js';
import { redactSecrets } from './redact.js';
import { cleanTerminalOutput } from './terminal.js';

/**
 * Dev server preview (U59). The project names its dev servers in a launch file; preview_start runs one as a background
 * command (U45) under bash's approval and sandbox, waits until its port answers, and the browser tools open its page.
 */

/** Where launch files live, workspace-relative. An entry in an earlier file wins over one of the same name in a later. */
export const LAUNCH_FILES = ['.g-code/launch.json', '.claude/launch.json'] as const;

/** One launch entry as the engine parsed it: what to run, where, and where it answers. */
export type LaunchConfig = {
  readonly name: string;
  readonly runtimeExecutable: string;
  readonly runtimeArgs: readonly string[];
  readonly port: number;
  /** The server's origin: the entry's url, or http://localhost:<port>. */
  readonly url: string;
  /** Workspace-relative folder the command runs in; the workspace root when absent. */
  readonly cwd?: string | undefined;
  /** The launch file it came from, workspace-relative. */
  readonly file: string;
};

/** One launch file as read: its usable entries, and why each other entry was left out. */
export type LaunchFile = { readonly file: string; readonly configs: readonly LaunchConfig[]; readonly problems: readonly string[] };

/** The workspace's launch entries, by name, from every file found. `files` is empty when the workspace has none. */
export type LaunchConfigs = { readonly configs: readonly LaunchConfig[]; readonly files: readonly string[]; readonly problems: readonly string[] };

/** The files in LAUNCH_FILES order, so a name defined twice keeps its first entry. */
export function mergeLaunchFiles(files: readonly LaunchFile[]): LaunchConfigs {
  const configs = new Map<string, LaunchConfig>();
  const problems: string[] = [];
  for (const file of files) {
    problems.push(...file.problems.map((problem) => `${file.file}: ${problem}`));
    for (const config of file.configs) {
      const first = configs.get(config.name);
      if (first === undefined) configs.set(config.name, config);
      else problems.push(`${file.file}: "${config.name}" is also in ${first.file}, which wins`);
    }
  }
  return { configs: [...configs.values()], files: files.map((file) => file.file), problems };
}

/** The entry's url as the origin preview_start probes and the browser opens, or why it cannot be one. */
export function launchUrlOf(port: number, raw: string | undefined): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly why: string } {
  if (raw === undefined) return { ok: true, url: `http://localhost:${port}` };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, why: `url ${raw} is not a full URL, such as http://localhost:${port}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, why: `url ${raw} is not http or https` };
  if (!isLocalHost(url.hostname)) return { ok: false, why: `url ${raw} is not on this machine; use localhost, 127.0.0.1, [::1] or a name under .localhost or .test` };
  const urlPort = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (urlPort !== port) return { ok: false, why: `url ${raw} has port ${urlPort}, not the entry's port ${port}` };
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return { ok: false, why: `url ${raw} must be the server's origin only, with no path` };
  return { ok: true, url: url.origin };
}

const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

/** One word of a command line, quoted for the shell only when it needs it, so `pnpm dev` reads and matches as typed. */
export const shellWord = (word: string): string => (PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/** The command line an entry runs, which the approval rules judge exactly as they judge the same line in bash. */
export const commandLineOf = (config: Pick<LaunchConfig, 'runtimeExecutable' | 'runtimeArgs'>): string =>
  [config.runtimeExecutable, ...config.runtimeArgs].map(shellWord).join(' ');

/** Carried by the background job a preview_start ran, so the job reads as that dev server everywhere it shows. */
export type PreviewTag = { readonly name: string; readonly url: string };

/** A dev server's state: its job runs and the port does not answer yet, its job runs and the port answers, or its job ended. */
export type PreviewStatus = { readonly kind: 'starting' } | { readonly kind: 'ready' } | { readonly kind: 'ended'; readonly state: EndedJobState };

export const previewStatusOf = (state: JobState, answers: boolean): PreviewStatus =>
  state.status !== 'running' ? { kind: 'ended', state } : answers ? { kind: 'ready' } : { kind: 'starting' };

/** A dev server this session started, as preview_list and preview_start report it. */
export type PreviewServer = PreviewTag & { readonly job: JobId; readonly command: string; readonly status: PreviewStatus };

/**
 * What one GET of the server's origin returned, once its port answered: the status, with the page title or the
 * redirect target, or why no response came. A redirect is never followed, since it may lead off this machine.
 */
export type PageCheck =
  | { readonly kind: 'answered'; readonly status: number; readonly title?: string | undefined; readonly location?: string | undefined }
  | { readonly kind: 'no-answer'; readonly why: string };

/**
 * What a preview_start did: started the server, found it already running in this session, or found its port taken
 * by something this session did not start, in which case nothing runs. `tail` is the end of the server's output;
 * `page` is set once the server is ready.
 */
export type PreviewStart =
  | { readonly kind: 'started' | 'reused'; readonly server: PreviewServer; readonly waitedS: number; readonly tail: string; readonly page?: PageCheck | undefined }
  | { readonly kind: 'taken'; readonly config: LaunchConfig };

/** Characters of a page title kept. */
export const PAGE_TITLE_MAX = 120;

/** The `<title>` of an HTML page, on one line and cut to PAGE_TITLE_MAX, or undefined when it has none. */
export function pageTitleOf(html: string): string | undefined {
  const raw = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim();
  if (raw === undefined || raw === '') return undefined;
  return raw.length > PAGE_TITLE_MAX ? `${raw.slice(0, PAGE_TITLE_MAX - 1)}…` : raw;
}

const pageText = (url: string, page: PageCheck | undefined): string => {
  if (page === undefined) return '';
  if (page.kind === 'no-answer') return ` GET ${url}/ got no response: ${page.why}.`;
  const then = page.location !== undefined ? `, redirecting to ${page.location}` : page.title !== undefined ? `, titled "${page.title}"` : '';
  const failed = page.status >= 500 ? ' The server failed on the page; read its errors with preview_logs.' : '';
  return ` GET ${url}/ returned ${page.status}${then}.${failed}`;
};

/** Seconds preview_start waits for the port to answer before it reports the server as still starting. */
export const PREVIEW_READY_TIMEOUT_S = 60;

/** Seconds the first GET of a ready server may take; a dev server compiles the page on it. */
export const PREVIEW_PAGE_TIMEOUT_S = 30;

export const PREVIEW_LOG_LEVELS = ['all', 'warn', 'error'] as const;
export type PreviewLogLevel = (typeof PREVIEW_LOG_LEVELS)[number];

export const PREVIEW_LOG_LINES = { default: 50, max: 500 } as const;

const ERROR_LINE = /error|exception|failed|fatal|uncaught|unhandled|panic|⨯/i;
const WARN_LINE = /warn|⚠|deprecat/i;

const LEVEL_MATCHES: Readonly<Record<PreviewLogLevel, (line: string) => boolean>> = {
  all: () => true,
  warn: (line) => WARN_LINE.test(line) || ERROR_LINE.test(line),
  error: (line) => ERROR_LINE.test(line),
};

export type LogFilter = { readonly level: PreviewLogLevel; readonly search?: string | undefined; readonly lines: number };

/** A filtered read of a server's output: the newest matching lines, how many matched, and how many lines were kept in all. */
export type LogRead = { readonly lines: readonly string[]; readonly matched: number; readonly total: number };

/**
 * The output cleaned of terminal escapes and redacted before any line is matched, so a search never finds a secret
 * and a colored "Error" still reads as one.
 */
export function filterLog(raw: string, filter: LogFilter): LogRead {
  const clean = redactSecrets(cleanTerminalOutput(raw));
  const all = clean === '' ? [] : clean.split('\n');
  const needle = filter.search?.toLowerCase();
  const matching = all.filter((line) => LEVEL_MATCHES[filter.level](line) && (needle === undefined || line.toLowerCase().includes(needle)));
  return { lines: matching.slice(-filter.lines), matched: matching.length, total: all.length };
}

export const PREVIEW_TOOL_NAMES = ['preview_list', 'preview_logs', 'preview_start', 'preview_stop'] as const;
export type PreviewToolName = (typeof PREVIEW_TOOL_NAMES)[number];

const OPEN_HINT = (url: string, name: string) =>
  `To see it, open ${url} with the browser tool mcp__browser__new_page, then mcp__browser__take_screenshot, and mcp__browser__list_console_messages for the page's console errors; load them with tool_search first. preview_logs with { "name": "${name}", "level": "error" } reads the server's own errors.`;

const statusText = (server: PreviewServer): string => {
  switch (server.status.kind) {
    case 'ready':
      return `answers at ${server.url}`;
    case 'starting':
      return `runs, but nothing answers at ${server.url} yet`;
    case 'ended':
      return `${jobEndText(server.status.state)}`;
  }
};

const tailText = (tail: string): string => (tail === '' ? 'It printed nothing.' : `The end of its output:\n${tail}`);

/** What preview_start returns. */
export function previewStartText(outcome: PreviewStart): string {
  if (outcome.kind === 'taken') {
    const { config } = outcome;
    return `Something already answers at ${config.url}, and this session did not start it, so nothing was started. It may be the user's own dev server or one another chat started. Open ${config.url} as it is; if it is not this project, ask the user to free port ${config.port}.`;
  }
  const { server, waitedS, tail } = outcome;
  const what = `dev server "${server.name}" (\`${server.command}\`)`;
  const head = outcome.kind === 'started' ? `Started ${what} as ${server.job}.` : `The ${what} already runs in this session as ${server.job}.`;
  switch (server.status.kind) {
    case 'ready':
      return `${head} It answers at ${server.url}.${pageText(server.url, outcome.page)} ${OPEN_HINT(server.url, server.name)}`;
    case 'starting':
      return `${head} Nothing answers at ${server.url} after ${waitedS}s; it may still be compiling. Read its output with preview_logs, or call preview_start again to wait longer. ${tailText(tail)}`;
    case 'ended':
      return `${head} It ${jobEndText(server.status.state)} before it answered at ${server.url}. ${tailText(tail)}`;
  }
}

/** What preview_list returns: the launch entries, then the servers this session started. */
export function previewListText(launch: LaunchConfigs, servers: readonly PreviewServer[]): string {
  const entries =
    launch.configs.length === 0
      ? [launch.files.length === 0 ? `No launch file: neither ${LAUNCH_FILES.join(' nor ')} exists. preview_start explains how to add one.` : `No usable launch entry in ${launch.files.join(' or ')}.`]
      : [`Launch entries (${launch.files.join(', ')}):`, ...launch.configs.map((config) => `- ${config.name}: \`${commandLineOf(config)}\`${config.cwd === undefined ? '' : ` in ${config.cwd}`}, ${config.url}`)];
  const problems = launch.problems.length === 0 ? [] : ['Left out:', ...launch.problems.map((problem) => `- ${problem}`)];
  const running =
    servers.length === 0
      ? ['No dev server was started in this session.']
      : ['Dev servers this session started:', ...servers.map((server) => `- ${server.name} (${server.job}, \`${server.command}\`): ${statusText(server)}`)];
  return [...entries, ...problems, ...running].join('\n');
}

/** What preview_logs returns. */
export function previewLogsText(server: PreviewServer, read: LogRead, filter: LogFilter): string {
  const which = [filter.level === 'all' ? undefined : `level ${filter.level}`, filter.search === undefined ? undefined : `"${filter.search}"`].filter((part) => part !== undefined);
  const head = `${server.name} (${server.job}) ${statusText(server)}.`;
  if (read.total === 0) return `${head}\nIt printed nothing yet.`;
  const count = which.length === 0 ? `Its last ${read.lines.length} of ${read.total} kept lines:` : `${read.matched} of its ${read.total} kept lines match ${which.join(' and ')}${read.matched > read.lines.length ? `; the last ${read.lines.length}` : ''}:`;
  return read.matched === 0 ? `${head}\nNone of its ${read.total} kept lines match ${which.join(' and ')}.` : `${head}\n${count}\n${read.lines.join('\n')}`;
}

/**
 * What preview_start says when the workspace has no launch file: the format, and an entry built from the dev script it
 * found, so the model can write the file with edit under the usual approval.
 */
export function missingLaunchText(command: string | undefined): string {
  const [runtimeExecutable = 'npm', ...runtimeArgs] = command?.split(' ') ?? ['npm', 'run', 'dev'];
  const example = JSON.stringify({ version: '0.0.1', configurations: [{ name: 'dev', runtimeExecutable, runtimeArgs, port: 3000 }] }, null, 2);
  return [
    `This workspace has no launch file: neither ${LAUNCH_FILES.join(' nor ')} exists. Create .claude/launch.json with edit (create: true), then call preview_start again. For example:`,
    example,
    `name is what preview_start takes. runtimeExecutable and runtimeArgs are the command, run from the workspace root, or from cwd, a workspace-relative folder, when given. port is where it listens; 3000 is Next.js's default, so check the dev script and the project's config. url is optional and defaults to http://localhost:<port>; it must be on this machine.${command === undefined ? ' package.json has no dev, start, serve or preview script, so ask the user which command starts the server.' : ''}`,
  ].join('\n');
}

export const unknownLaunchText = (name: string, launch: LaunchConfigs): string =>
  `No launch entry is named "${name}" in ${launch.files.join(' or ')}. Its entries: ${launch.configs.map((config) => config.name).join(', ') || 'none'}.`;

export const notStartedText = (name: string, servers: readonly PreviewServer[]): string =>
  `No dev server named "${name}" was started in this session; Geno stops and reads only the servers it started. ${servers.length === 0 ? 'None was started.' : `Started here: ${servers.map((server) => server.name).join(', ')}.`}`;

const nameProperty = (what: string) => ({ type: 'string', description: `The launch entry's name, ${what}.` });

export const PREVIEW_TOOL_SPECS: Readonly<Record<PreviewToolName, Tool>> = {
  preview_start: {
    name: 'preview_start',
    description: `Start the project's dev server from its launch file (${LAUNCH_FILES[1]} or ${LAUNCH_FILES[0]}), or reuse it if it already runs. The command runs in the background like bash with run_in_background, under the same approval, and this call waits up to ${PREVIEW_READY_TIMEOUT_S}s for its port to answer. Returns the URL to open with the browser tools. Without a launch file it explains how to write one.`,
    input_schema: {
      type: 'object',
      properties: { name: nameProperty('such as "web"; omit it when the launch file has one entry') },
      additionalProperties: false,
    },
  },
  preview_list: {
    name: 'preview_list',
    description: 'List the launch entries and the dev servers this session started, with whether each answers at its URL. It only reads.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  preview_logs: {
    name: 'preview_logs',
    description: `Read a dev server's stdout and stderr: its last lines, or only the lines at a level or containing a search text. level "error" keeps lines that mention an error, exception, failure or fatal; "warn" adds warnings. Secrets are replaced with [redacted]. It only reads.`,
    input_schema: {
      type: 'object',
      properties: {
        name: nameProperty('of a server preview_start started; omit it when this session started one'),
        level: { type: 'string', enum: [...PREVIEW_LOG_LEVELS], description: 'Which lines to keep. Defaults to all.' },
        search: { type: 'string', description: 'Keep only lines that contain this text, ignoring case.' },
        lines: { type: 'integer', minimum: 1, maximum: PREVIEW_LOG_LINES.max, description: `How many of the newest matching lines to return. Defaults to ${PREVIEW_LOG_LINES.default}.` },
      },
      additionalProperties: false,
    },
  },
  preview_stop: {
    name: 'preview_stop',
    description: 'Stop a dev server this session started with preview_start: SIGTERM, then SIGKILL a few seconds later. Servers Geno did not start are never stopped.',
    input_schema: { type: 'object', properties: { name: nameProperty('of a server preview_start started') }, required: ['name'], additionalProperties: false },
  },
};
