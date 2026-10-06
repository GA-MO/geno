/** The external ACP agents the settings page signs in to and updates, and the states of each one's account. */

export type AgentId = 'cursor';

/** A command of the agent's own CLI that Geno runs for the user. */
export type AgentAction = 'login' | 'logout' | 'update';

/** What the agent's status command says, once parsed. */
export type StatusReport = { readonly version: string | undefined } & (
  | { readonly signedIn: false }
  | { readonly signedIn: true; readonly account: string | undefined }
);

/** One external agent's CLI: the names it installs under, where its installer puts it, and its own commands. */
export type ExternalAgent = {
  readonly id: AgentId;
  readonly label: string;
  readonly binaries: readonly string[];
  /** Folders under the home folder, which the PATH of a VS Code started from the Dock may lack. */
  readonly homeDirs: readonly string[];
  readonly status: readonly string[];
  readonly commands: Readonly<Record<AgentAction, readonly string[]>>;
  readonly parseStatus: (output: string) => StatusReport | undefined;
  /** The environment variable the CLI reads an API key from. */
  readonly keyEnv: string;
  /**
   * The official installer, from the agent's docs. Geno never runs it: the card shows the command to copy and
   * links the page it comes from, and the user installs the CLI themselves.
   */
  readonly install: { readonly command: string; readonly url: string };
};

export type CliFound = { readonly path: string; readonly version: string | undefined };

/** How the CLI's processes sign in: its own browser login, or a key Geno keeps and passes in their env. */
export type AuthSource = { readonly kind: 'browser'; readonly account: string | undefined } | { readonly kind: 'api-key' };

/** How the last command ended, shown under the account until the next one. */
export type Outcome = { readonly ok: boolean; readonly text: string; readonly output: string };

export type AgentState =
  | { readonly kind: 'checking'; readonly last?: Outcome }
  | { readonly kind: 'missing' }
  | { readonly kind: 'signed-out'; readonly cli: CliFound; readonly last?: Outcome }
  | { readonly kind: 'signed-in'; readonly cli: CliFound; readonly auth: AuthSource; readonly last?: Outcome }
  /** `link` names the sign-in page the CLI printed; the address itself stays in the extension. */
  | { readonly kind: 'signing-in'; readonly cli: CliFound; readonly output: string; readonly link: string | undefined }
  | { readonly kind: 'signing-out'; readonly cli: CliFound; readonly output: string }
  | { readonly kind: 'updating'; readonly cli: CliFound; readonly output: string }
  /** The status command failed or printed something Geno cannot read. */
  | { readonly kind: 'error'; readonly cli: CliFound; readonly text: string; readonly output: string };

export type CheckResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'found'; readonly path: string; readonly report: StatusReport; readonly apiKey: boolean }
  | { readonly kind: 'failed'; readonly path: string; readonly text: string; readonly output: string };

export type AgentEvent =
  | { readonly type: 'check' }
  | { readonly type: 'checked'; readonly result: CheckResult }
  | { readonly type: 'start'; readonly action: AgentAction }
  | { readonly type: 'output'; readonly output: string; readonly link?: string }
  | { readonly type: 'exit'; readonly code: number | null; readonly cancelled: boolean };

export type AgentsToView = { readonly type: 'agent'; readonly id: AgentId; readonly state: AgentState };

export type AgentsFromView =
  | { readonly type: 'agents-check' }
  | { readonly type: 'agents-run'; readonly id: string; readonly action: AgentAction }
  | { readonly type: 'agents-cancel'; readonly id: string }
  | { readonly type: 'agents-copy-install'; readonly id: string }
  | { readonly type: 'agents-key'; readonly id: string; readonly key: string }
  | { readonly type: 'agents-remove-key'; readonly id: string }
  | { readonly type: 'agents-open'; readonly id: string; readonly target: 'sign-in' | 'install' };

// The terminal's cursor and erase codes, which the CLI draws its spinner with.
const ESCAPES = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

/** Output as a page shows it: no terminal codes, and only what a carriage return left standing on each line. */
export function plainText(raw: string): string {
  return raw
    .replace(ESCAPES, '')
    .split('\n')
    .map((line) => line.split('\r').filter((part) => part !== '').at(-1) ?? '')
    .join('\n');
}

const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  // A query string can carry a login challenge or a code.
  [/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1?…'],
  [/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g, '[redacted]'],
  [/\b(token|secret|password|passwd|api[_-]?key|auth(?:orization)?|bearer|cookie|session)(\s*[:=]\s*)("?)[^\s"]+\3/gi, '$1$2[redacted]'],
  [/\b(?:sk|pk|crsr|ghp|gho|xox[a-z])[-_][\w-]{12,}/gi, '[redacted]'],
  // A long run of letters and digits with no word breaks, the shape of a key, a hash or a token.
  [/(?<![\w/.-])(?=[\w+-]*\d)(?=[\w+-]*[A-Za-z])[\w+-]{32,}={0,2}(?![\w/.-])/g, '[redacted]'],
];

/** Takes out anything in a CLI's output that looks like a credential, so it never reaches the page or a log. */
export function redact(text: string): string {
  return REDACTIONS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

const OUTPUT_LIMIT = 4000;

/** A command's output for the page: plain, redacted and cut to its last few thousand characters. */
export function shownOutput(raw: string): string {
  const text = redact(plainText(raw)).replace(/\n{3,}/g, '\n\n').trim();
  return text.length > OUTPUT_LIMIT ? `…${text.slice(-OUTPUT_LIMIT)}` : text;
}

/** The first web address in raw output, the sign-in page a login prints. */
export function firstLink(raw: string): string | undefined {
  const match = /https:\/\/[^\s"'<>\u001b]+/.exec(raw.replace(ESCAPES, ''));
  return match?.[0].replace(/[).,;]+$/, '');
}

/** What the page calls a sign-in address: its host, never its query. */
export function linkLabel(href: string): string | undefined {
  try {
    return new URL(href).host;
  } catch {
    return undefined;
  }
}

/**
 * Reads `agent about`, a table of labelled rows. Recorded from CLI 2026.01.23: "CLI Version" holds the version and
 * "User Email" the account, or "Not logged in". Without the account row the output is not one Geno knows.
 */
export function parseCursorAbout(output: string): StatusReport | undefined {
  const rows = new Map<string, string>();
  for (const line of plainText(output).split('\n')) {
    const row = /^\s*([A-Za-z][A-Za-z ]*?)\s{2,}(\S.*?)\s*$/.exec(line);
    if (row !== null) rows.set(row[1]!.toLowerCase(), row[2]!);
  }
  const account = rows.get('user email');
  if (account === undefined) return undefined;
  const version = rows.get('cli version');
  if (/^not logged in$/i.test(account)) return { version, signedIn: false };
  return { version, signedIn: true, account: account === '' ? undefined : account };
}

/** The environment of one of the CLI's processes. The key goes only here, never into argv or the engine's env. */
export function agentEnv(
  agent: ExternalAgent,
  base: Readonly<Record<string, string | undefined>>,
  key: string | undefined,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> {
  return key === undefined ? { ...base, ...extra } : { ...base, ...extra, [agent.keyEnv]: key };
}

export const EXTERNAL_AGENTS: readonly ExternalAgent[] = [
  {
    id: 'cursor',
    label: 'Cursor',
    binaries: ['agent', 'cursor-agent'],
    homeDirs: ['.local/bin'],
    status: ['about'],
    commands: { login: ['login'], logout: ['logout'], update: ['update'] },
    parseStatus: parseCursorAbout,
    keyEnv: 'CURSOR_API_KEY',
    install: { command: 'curl https://cursor.com/install -fsS | bash', url: 'https://cursor.com/docs/cli/installation' },
  },
];

export const agentOf = (id: string): ExternalAgent | undefined => EXTERNAL_AGENTS.find((agent) => agent.id === id);

const RUNNING = { login: 'signing-in', logout: 'signing-out', update: 'updating' } as const satisfies Record<AgentAction, AgentState['kind']>;

/** Which commands each resting state offers. */
export const ACTIONS: Readonly<Partial<Record<AgentState['kind'], readonly AgentAction[]>>> = {
  'signed-out': ['login', 'update'],
  'signed-in': ['logout', 'update'],
  error: ['update'],
};

const ENDED: Readonly<Record<(typeof RUNNING)[AgentAction], { readonly ok: string; readonly failed: string; readonly cancelled: string }>> = {
  'signing-in': { ok: 'Sign-in finished.', failed: 'Sign-in failed', cancelled: 'Sign-in cancelled.' },
  'signing-out': { ok: 'Signed out.', failed: 'Sign-out failed', cancelled: 'Sign-out cancelled.' },
  updating: { ok: 'Update finished.', failed: 'Update failed', cancelled: 'Update cancelled.' },
};

function settled(result: Extract<CheckResult, { kind: 'found' }>, last: { readonly last?: Outcome }): AgentState {
  const cli = { path: result.path, version: result.report.version };
  if (result.apiKey) return { kind: 'signed-in', cli, auth: { kind: 'api-key' }, ...last };
  if (!result.report.signedIn) return { kind: 'signed-out', cli, ...last };
  return { kind: 'signed-in', cli, auth: { kind: 'browser', account: result.report.account }, ...last };
}

/** Whether a resting state offers `action`. A key signs in each process, so there is no login to sign out of. */
const offers = (state: AgentState, action: AgentAction): state is Extract<AgentState, { cli: CliFound }> =>
  (ACTIONS[state.kind] ?? []).includes(action) && 'cli' in state && !(action === 'logout' && state.kind === 'signed-in' && state.auth.kind === 'api-key');

/** How an agent's state moves. An event that does not fit the state leaves it as it is. */
export function agentReducer(state: AgentState, event: AgentEvent): AgentState {
  switch (event.type) {
    case 'check':
      return state.kind === 'checking' || state.kind === 'signing-in' || state.kind === 'signing-out' || state.kind === 'updating' ? state : { kind: 'checking' };
    case 'checked': {
      if (state.kind !== 'checking') return state;
      const { result } = event;
      if (result.kind === 'missing') return { kind: 'missing' };
      if (result.kind === 'failed') return { kind: 'error', cli: { path: result.path, version: undefined }, text: result.text, output: result.output };
      return settled(result, state.last === undefined ? {} : { last: state.last });
    }
    case 'start':
      if (!offers(state, event.action)) return state;
      if (event.action === 'login') return { kind: 'signing-in', cli: state.cli, output: '', link: undefined };
      return { kind: RUNNING[event.action], cli: state.cli, output: '' };
    case 'output':
      if (state.kind === 'signing-in') return { ...state, output: event.output, link: event.link ?? state.link };
      if (state.kind === 'signing-out' || state.kind === 'updating') return { ...state, output: event.output };
      return state;
    case 'exit': {
      if (state.kind !== 'signing-in' && state.kind !== 'signing-out' && state.kind !== 'updating') return state;
      const words = ENDED[state.kind];
      const last: Outcome = event.cancelled
        ? { ok: false, text: words.cancelled, output: '' }
        : event.code === 0
          ? { ok: true, text: words.ok, output: state.output }
          : { ok: false, text: `${words.failed} (${event.code === null ? 'stopped' : `exit code ${event.code}`}).`, output: state.output };
      return { kind: 'checking', last };
    }
  }
}
