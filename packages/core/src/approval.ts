import path from 'node:path';

export type CommandScope = {
  readonly workspace: string;
  readonly tempDir: string;
  readonly home: string;
  /**
   * Real paths beyond the workspace a command may name without a question, as Claude Code's working directories: the
   * directories the user added, and those allowed for the session. Absent is none.
   */
  readonly directories?: readonly string[] | undefined;
};

export const DENY_RULE_IDS = [
  'rm-rf-outside-workspace',
  'rm-rf-in-workspace',
  'git-push',
  'git-reset-hard',
  'path-outside-workspace',
  'network-download',
  'cloud-cli',
  'database-cli',
  'secret-path',
  'unlisted',
] as const;
export type DenyRuleId = (typeof DENY_RULE_IDS)[number];

/**
 * One simple command after variable expansion: its program (a basename, wrappers such as sudo or npx removed), every
 * word, and the directory it runs in, or undefined once the command line changes directory.
 */
export type SimpleCommand = {
  readonly program: string;
  /** The program word as written, which may be a path. */
  readonly executable: string;
  /** The assignments, wrappers and their options before the program. */
  readonly prefix: readonly string[];
  readonly args: readonly string[];
  readonly words: readonly string[];
  readonly cwd: string | undefined;
};

/**
 * `plan` reads and runs only what is clearly safe, and changes nothing. `ask` asks the user before every flagged command.
 * `auto` runs what is clearly safe, asks before an `rm -rf` outside the workspace, and lets the classifier judge the
 * rest; what the classifier will not allow is blocked without asking, until the blocks pause Auto (see auto.ts).
 * Non-interactive runs, such as evals, have nobody to ask.
 */
export const APPROVAL_MODES = ['plan', 'ask', 'auto', 'non-interactive'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
/** The modes a user picks for a session, in the order a picker lists them; non-interactive belongs to a run, not a session. */
export const SESSION_MODES = ['plan', 'ask', 'auto'] as const satisfies readonly ApprovalMode[];
export type SessionMode = (typeof SESSION_MODES)[number];
export const isSessionMode = (raw: string): raw is SessionMode => (SESSION_MODES as readonly string[]).includes(raw);
export const DEFAULT_SESSION_MODE: SessionMode = 'ask';

/** Why a mode refuses whatever it does not allow, when it says more than the rule's own reason. */
export const MODE_REFUSALS: Readonly<Record<ApprovalMode, string | undefined>> = {
  plan: 'Plan mode is read-only; switch to Ask or Auto to make changes',
  ask: undefined,
  auto: undefined,
  'non-interactive': undefined,
};

export type Verdict = 'allow' | 'ask' | 'deny';
/** `classify` hands the command to the classifier, which answers with a Verdict. */
export type RuleVerdict = Verdict | 'classify';
/**
 * What a run in each mode does with a command a rule matches. Plan never asks or classifies: it denies every bash rule,
 * the unlisted one included, so it runs only the safe list, and allows only what an MCP server marks read-only. Nobody
 * is there to ask in non-interactive mode.
 */
export type Verdicts = {
  readonly plan: Exclude<Verdict, 'ask'>;
  readonly ask: Verdict;
  readonly auto: RuleVerdict;
  readonly 'non-interactive': Exclude<Verdict, 'ask'>;
};

type DenyRule = {
  readonly reason: string;
  readonly verdicts: Verdicts;
  matches(command: SimpleCommand, scope: CommandScope): boolean;
};

export type Denial = {
  readonly rule: ApprovalRuleId;
  readonly reason: string;
  readonly command: string;
  readonly verdict: Exclude<RuleVerdict, 'allow'>;
  /** The workspace allow rule the question offers to save: a program and its fixed arguments. */
  readonly offer?: readonly string[];
  /** Any other allow rule the question offers to save for the workspace, as the user would type it: a domain or an MCP tool. */
  readonly keeps?: string;
  /** The directory "Allow this directory for the session" lets the session read, for a read outside every one it may. */
  readonly directory?: string;
};

// What cannot be undone: Auto still asks.
const ALWAYS_ASK: Verdicts = { plan: 'deny', ask: 'ask', auto: 'ask', 'non-interactive': 'deny' };
// What Auto lets the classifier judge. A command still cannot write outside the workspace or reach the network,
// because the sandbox stops it.
const ASK_OR_CLASSIFY: Verdicts = { plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'deny' };

const CLOUD_CLIS = new Set([
  'aws', 'az', 'bq', 'doctl', 'eksctl', 'firebase', 'fly', 'flyctl', 'gcloud', 'gsutil', 'helm', 'heroku',
  'ibmcloud', 'kubectl', 'netlify', 'oci', 'pulumi', 'railway', 'supabase', 'terraform', 'vercel', 'wrangler',
]);
const DATABASE_CLIS = new Set([
  'clickhouse-client', 'cockroach', 'cqlsh', 'mongo', 'mongodump', 'mongorestore', 'mongosh', 'mysql',
  'mysqldump', 'pg_dump', 'pg_restore', 'psql', 'redis-cli', 'sqlcmd',
]);

type DownloaderOptions = {
  readonly flags: string;
  readonly valued: string;
  readonly long: ReadonlySet<string>;
  readonly longValued: ReadonlySet<string>;
};
// Options that only shape the request or where its output goes. Any other option, such as a proxy, --resolve or a
// config file, can send the request to another host.
const DOWNLOADERS: ReadonlyMap<string, DownloaderOptions> = new Map([
  ['curl', {
    flags: 'sSfiILvkN',
    valued: 'oHXdwmAeu',
    long: new Set(['--silent', '--show-error', '--fail', '--fail-with-body', '--include', '--head', '--location', '--verbose', '--insecure', '--compressed', '--no-buffer']),
    longValued: new Set(['--output', '--header', '--request', '--data', '--data-raw', '--data-binary', '--write-out', '--max-time', '--connect-timeout', '--retry', '--user-agent']),
  }],
  ['wget', {
    flags: 'qSv',
    valued: 'OTt',
    long: new Set(['--quiet', '--spider', '--server-response']),
    longValued: new Set(['--output-document', '--timeout', '--tries']),
  }],
]);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// The host must end at a port, a path, a query, a fragment or the end, so `127.0.0.1:3000@example.com` is not local.
const URL_HOST = /^(?:https?:\/\/)?(\[[^\]]*\]|[^/?#:@[\]]*)(?::\d+)?(?:[/?#]|$)/i;

// Read-only system locations a build or test command legitimately names by absolute path.
const SYSTEM_PREFIXES = ['/dev', '/usr', '/bin', '/sbin', '/opt/homebrew', '/tmp', '/private/tmp'];
// Shared temp dirs: what is strictly inside them is scratch, the dirs themselves are not.
const TEMP_ROOTS = ['/tmp', '/private/tmp'];
// An absolute word counts as a path only under a real top-level directory, so `/api/users` in a grep is not one.
const FILESYSTEM_ROOTS = new Set([
  'Applications', 'Library', 'System', 'Users', 'Volumes', 'bin', 'dev', 'etc', 'home', 'mnt', 'nix', 'opt',
  'private', 'proc', 'root', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var',
]);

const within = (root: string, target: string): boolean => target === root || target.startsWith(root + path.sep);
const strictlyWithin = (root: string, target: string): boolean => target !== root && within(root, target);

function pathOf(word: string, scope: CommandScope): string | undefined {
  const value = word.includes('=') && !word.startsWith('=') ? word.slice(word.indexOf('=') + 1) : word;
  if (value === '~' || value.startsWith('~/')) return path.join(scope.home, value.slice(1));
  if (value.startsWith('/')) return FILESYSTEM_ROOTS.has(value.split('/')[1] ?? '') ? path.normalize(value) : undefined;
  if (value === '..' || value.startsWith('../') || value.includes('/../')) return path.resolve(scope.workspace, value);
  return undefined;
}

function isOutside(target: string, scope: CommandScope): boolean {
  const allowed = [scope.workspace, scope.tempDir, ...SYSTEM_PREFIXES, ...(scope.directories ?? [])];
  return !allowed.some((root) => within(root, target));
}

/**
 * What `rm -rf` of this operand can remove: only temp scratch, strictly inside a temp dir; only something strictly
 * inside the workspace but not its .git; or anything else.
 */
type RemovalTarget = 'temp' | 'workspace' | 'protected';

function removalTarget(operand: string, cwd: string | undefined, scope: CommandScope): RemovalTarget {
  // An unset variable expands to nothing, which removes nothing.
  if (operand === '') return 'temp';
  if (/[$`]/.test(operand) || /^~[^/]/.test(operand)) return 'protected';
  const parts = operand.split('/');
  const glob = parts.findIndex((part) => /[*?[{]/.test(part));
  // A glob removes only what is below its literal prefix, so that prefix must itself be removable.
  const literal = glob === -1 ? operand : parts.slice(0, glob).join('/') || (operand.startsWith('/') ? '/' : '.');
  const expanded = literal === '~' || literal.startsWith('~/') ? path.join(scope.home, literal.slice(1)) : literal;
  if (!path.isAbsolute(expanded) && cwd === undefined) return 'protected';
  const target = path.resolve(cwd ?? '/', expanded);
  // The workspace wins over a temp root it may sit in, so the user's project under /tmp is still theirs.
  if (strictlyWithin(scope.workspace, target) && !within(path.join(scope.workspace, '.git'), target)) return 'workspace';
  return [scope.tempDir, ...TEMP_ROOTS].some((root) => strictlyWithin(root, target)) ? 'temp' : 'protected';
}

const removes = ({ program, args, cwd }: SimpleCommand, scope: CommandScope, kind: RemovalTarget): boolean =>
  program === 'rm' && isRecursiveForce(args) && operands(args).some((operand) => removalTarget(operand, cwd, scope) === kind);

function isLocalUrl(word: string): boolean {
  const host = URL_HOST.exec(word)?.[1];
  return host !== undefined && LOCAL_HOSTS.has(host.toLowerCase());
}

function onlyLocalUrls(options: DownloaderOptions, args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const name = arg.split('=')[0]!;
      if (options.longValued.has(name)) {
        if (!arg.includes('=')) i++;
      } else if (!options.long.has(arg)) return false;
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j]!;
        if (options.valued.includes(letter)) {
          if (j === arg.length - 1) i++;
          break;
        }
        if (!options.flags.includes(letter)) return false;
      }
    } else if (!isLocalUrl(arg)) return false;
  }
  return true;
}

const flags = (args: readonly string[]) => args.filter((arg) => arg.startsWith('-'));
const operands = (args: readonly string[]) => args.filter((arg) => !arg.startsWith('-'));

function isRecursiveForce(args: readonly string[]): boolean {
  const short = flags(args).filter((f) => !f.startsWith('--')).join('');
  const recursive = /[rR]/.test(short) || args.includes('--recursive');
  const force = short.includes('f') || args.includes('--force');
  return recursive && force;
}

// git's own options before the subcommand; -C and -c take a value.
function gitSubcommand(args: readonly string[]): { readonly name: string | undefined; readonly rest: readonly string[] } {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-C' || arg === '-c') i++;
    else if (!arg.startsWith('-')) return { name: arg, rest: args.slice(i + 1) };
  }
  return { name: undefined, rest: [] };
}

const always = () => true;

// Options that make an otherwise read-only program run another program, delete or write elsewhere.
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);
const SED_PRINT = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/;
const GIT_READS = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'describe', 'shortlog', 'cat-file',
  'ls-tree', 'merge-base', 'show-ref', 'add',
]);
const GIT_LISTING_FLAGS = new Set(['-a', '-r', '-v', '-vv', '-l', '--all', '--list', '--show-current', '--verbose']);
// The project's own test, lint, type-check and build scripts, by the names projects give them.
const PROJECT_SCRIPT = /^(?:test|t|lint|typecheck|type-check|check|build|format|fmt|tsc)(?::[\w.-]+)?$/;

function safeGit(args: readonly string[]): boolean {
  // Before the subcommand only -C and --no-pager: -c and --config-env can name a program for git to run.
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-C') i++;
    else if (arg !== '--no-pager') return !arg.startsWith('-') && safeGitSubcommand(arg, args.slice(i + 1));
  }
  return false;
}

function safeGitSubcommand(name: string, rest: readonly string[]): boolean {
  if (GIT_READS.has(name)) return true;
  if (name === 'commit') return !rest.includes('--amend');
  if (name === 'branch' || name === 'tag') return rest.every((arg) => GIT_LISTING_FLAGS.has(arg));
  if (name === 'stash') return rest[0] === 'list' || rest[0] === 'show';
  if (name === 'remote') return rest.every((arg) => arg === '-v');
  return false;
}

const safeScript = ([verb, script]: readonly string[]): boolean =>
  verb !== undefined && (PROJECT_SCRIPT.test(verb) || ((verb === 'run' || verb === 'run-script') && script !== undefined && PROJECT_SCRIPT.test(script)));

const safeVerbs =
  (...verbs: string[]) =>
  ([verb]: readonly string[]): boolean =>
    verb !== undefined && verbs.includes(verb);

/** Programs Auto runs without asking: read-only inspection and the project's own checks, each with its safe forms. */
const SAFE_PROGRAMS: ReadonlyMap<string, (args: readonly string[]) => boolean> = new Map<string, (args: readonly string[]) => boolean>([
  ...[
    'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'tree', 'pwd', 'echo', 'printf', 'true', 'false',
    'test', '[', 'stat', 'file', 'du', 'which', 'basename', 'dirname', 'realpath', 'readlink', 'diff', 'cmp', 'sort',
    'uniq', 'cut', 'tr', 'jq', 'nl', 'column', 'date', 'sleep', 'cd', 'pushd', 'popd', 'mkdir', 'touch', 'tee',
    'mktemp', 'comm', 'paste', 'seq', 'od', 'xxd', 'shasum', 'sha256sum', 'md5', 'md5sum',
    'tsc', 'vue-tsc', 'svelte-check', 'vitest', 'jest', 'mocha', 'eslint', 'prettier', 'biome', 'stylelint', 'oxlint',
    'pytest', 'mypy', 'ruff', 'for', 'fi', 'done',
  ].map((program) => [program, always] as const),
  ['find', (args) => !args.some((arg) => FIND_ACTIONS.has(arg))],
  ['rg', (args) => !args.some((arg) => arg === '--pre' || arg.startsWith('--pre='))],
  ['sed', (args) => args.length >= 2 && args[0] === '-n' && SED_PRINT.test(args[1]!) && !args.slice(2).some((arg) => arg.startsWith('-'))],
  ['git', safeGit],
  ['npm', safeScript],
  ['pnpm', safeScript],
  ['yarn', safeScript],
  ['bun', safeScript],
  ['next', safeVerbs('lint', 'build')],
  ['playwright', safeVerbs('test')],
  ['cargo', safeVerbs('test', 'check', 'build', 'clippy', 'fmt')],
  ['go', safeVerbs('test', 'vet', 'build', 'fmt')],
]);

// Wrappers that leave the command as it is; sudo, env, xargs and exec change who runs it or what it receives.
const SAFE_PREFIXES = new Set(['npx', 'bunx', 'time', 'command', 'nohup', 'if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{']);
// Variables that choose which code a program loads or runs.
const CODE_VARIABLES = /^(?:PATH|LD_\w+|DYLD_\w+|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|PS4|PROMPT_COMMAND|IFS|GIT_\w+|npm_config_\w+|PAGER|EDITOR|VISUAL|PYTHON\w*|RUBYOPT|PERL5\w*)=/i;
// Where a project or a home keeps credentials, as a whole path segment, globs included.
const SECRET_PATH =
  /(?:^|[/=@])(?:\.env[^/]*|\.npmrc|\.yarnrc(?:\.yml)?|\.netrc|\.pgpass|\.git-credentials|\.ssh|\.aws|\.gnupg|\.kube|\.docker|id_(?:rsa|dsa|ecdsa|ed25519)[^/]*|[^/]+\.(?:pem|key|p12|pfx|jks|keystore)|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)(?:\/|$)/i;
// A glob over hidden names can reach any of them, such as `.e*`.
const HIDDEN_GLOB = /(?:^|\/)\.[^/]*[*?[]/;

/** Whether a `/`-separated path, or a glob, names a credentials file or a path inside a credentials directory. */
export const isSecretPath = (file: string): boolean => SECRET_PATH.test(file);

/**
 * Where the user's CLIs keep keys and tokens, under the home folder. The sandbox denies them to every command and the
 * read tools take them as credentials files, so neither Auto's classifier nor an added `~` opens them.
 */
export const CREDENTIAL_PATHS = ['.ssh', '.aws', '.azure', '.config/gcloud', '.config/gh', '.docker', '.gnupg', '.kube', '.netrc'] as const;

/** The home's credential places, as absolute paths. */
export const credentialPlaces = (home: string): string[] => CREDENTIAL_PATHS.map((place) => path.join(home, place));

/** Whether an absolute path is one of `places` or inside one. Case does not count, as on macOS. */
export const inCredentialPlace = (places: readonly string[], target: string): boolean =>
  places.some((place) => within(place.toLowerCase(), target.toLowerCase()));

// A search for credentials by name, which a recursive grep answers from any file it reaches, such as .env.
const SECRET_TERM = /api[_-]?key|secret|token|passw(?:or)?d|credential|private[_-]?key/i;
// A write under .git, such as a hook, runs later outside any command the user sees.
const GIT_DIR = /(?:^|\/)\.git(?:\/|$)/;
const UNSAFE_WORD = [SECRET_PATH, HIDDEN_GLOB, SECRET_TERM, GIT_DIR];
const TRUSTED_BIN_DIRS = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin'];

// A program named by path must be a project tool or a system one: `./ls` can be anything the agent wrote.
function trustedExecutable(word: string): boolean {
  if (!word.includes('/')) return true;
  if (/^(?:\.\/)?node_modules\/\.bin\/[^/]+$/.test(word)) return true;
  return TRUSTED_BIN_DIRS.includes(path.dirname(word));
}

function isClearlySafe({ program, executable, prefix, args, words }: SimpleCommand): boolean {
  if (words.some((word) => UNSAFE_WORD.some((pattern) => pattern.test(word)))) return false;
  if (prefix.some((word) => (isAssignment(word) ? CODE_VARIABLES.test(word) : !SAFE_PREFIXES.has(path.basename(word))))) return false;
  // An assignment alone runs nothing; the commands of its substitutions are judged on their own.
  if (executable === '') return prefix.length > 0 && prefix.every(isAssignment);
  if ([executable, ...args].some((word) => /[$`]/.test(word))) return false;
  const safe = SAFE_PROGRAMS.get(program);
  return safe !== undefined && trustedExecutable(executable) && safe(args);
}

export const DENY_RULES: Readonly<Record<DenyRuleId, DenyRule>> = {
  'rm-rf-outside-workspace': {
    reason: 'rm -rf of the workspace, its .git or a path outside it',
    verdicts: ALWAYS_ASK,
    matches: (command, scope) => removes(command, scope, 'protected'),
  },
  // A throwaway eval clone can lose anything, but the user's own project has folders, such as node_modules, that no
  // checkpoint restores.
  'rm-rf-in-workspace': {
    reason: 'rm -rf of a path inside the workspace',
    verdicts: { plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'allow' },
    matches: (command, scope) => removes(command, scope, 'workspace'),
  },
  'git-push': {
    reason: 'git push',
    verdicts: ASK_OR_CLASSIFY,
    matches: ({ program, args }) => program === 'git' && gitSubcommand(args).name === 'push',
  },
  'git-reset-hard': {
    reason: 'git reset --hard',
    verdicts: ASK_OR_CLASSIFY,
    matches: ({ program, args }) => {
      const { name, rest } = gitSubcommand(args);
      return program === 'git' && name === 'reset' && rest.includes('--hard');
    },
  },
  'path-outside-workspace': {
    reason: 'a path outside the workspace',
    verdicts: ASK_OR_CLASSIFY,
    matches: ({ words }, scope) =>
      words.some((word) => {
        const target = pathOf(word, scope);
        return target !== undefined && isOutside(target, scope);
      }),
  },
  'network-download': {
    reason: 'curl or wget',
    verdicts: ASK_OR_CLASSIFY,
    matches: ({ program, args }) => {
      const options = DOWNLOADERS.get(program);
      return options !== undefined && !onlyLocalUrls(options, args);
    },
  },
  'cloud-cli': {
    reason: 'a cloud CLI',
    verdicts: ASK_OR_CLASSIFY,
    matches: ({ program }) => CLOUD_CLIS.has(program),
  },
  'database-cli': {
    reason: 'a database CLI',
    verdicts: ASK_OR_CLASSIFY,
    matches: ({ program }) => DATABASE_CLIS.has(program),
  },
  // read asks under this rule too, and grep and glob leave the same paths out (isSecretPath), so no route sends a secret unasked.
  'secret-path': {
    reason: 'a credentials file such as .env',
    verdicts: ASK_OR_CLASSIFY,
    matches: ({ words }) => words.some((word) => SECRET_PATH.test(word) || HIDDEN_GLOB.test(word)),
  },
  // Plan and Auto act on this: Ask and non-interactive runs run what no other rule flags, as they always have.
  unlisted: {
    reason: 'a command not on the safe list',
    verdicts: { plan: 'deny', ask: 'allow', auto: 'classify', 'non-interactive': 'allow' },
    matches: (command) => !isClearlySafe(command),
  },
};

/**
 * MCP tool calls, which run outside the sandbox in a server the user connected. Ask asks until the user allows the tool
 * for the session; Auto runs what the server marks read-only and lets the classifier judge the rest. A non-interactive
 * run offers MCP tools only when its flag turns them on, which is that run's consent.
 */
export const MCP_RULE_IDS = ['mcp-read-only', 'mcp-tool'] as const;
/** The built-in browser's rules, below. */
export const BROWSER_RULE_IDS = ['browser-local-url', 'browser-remote-url', 'browser-refused-url', 'browser-remote-page', 'browser-risky-tool'] as const;
export type BrowserRuleId = (typeof BROWSER_RULE_IDS)[number];
/** web_fetch and web_search, which web.ts matches. */
export const WEB_RULE_IDS = ['web-local-url', 'web-remote-url', 'web-refused-url', 'web-search'] as const;
export type WebRuleId = (typeof WEB_RULE_IDS)[number];
export type McpRuleId = (typeof MCP_RULE_IDS)[number];
/** An external agent's permission requests, which backends.ts maps. */
export const EXTERNAL_RULE_IDS = ['external-read', 'external-write', 'external-command', 'external-other'] as const;
export type ExternalRuleId = (typeof EXTERNAL_RULE_IDS)[number];
/** A deny rule the user set for the workspace, which permission-rules.ts matches. */
export const WORKSPACE_RULE_IDS = ['workspace-deny', 'workspace-ask'] as const;
export type WorkspaceRuleId = (typeof WORKSPACE_RULE_IDS)[number];
/** A command line judged whole, before its words (`lineRuleOf`). */
export const LINE_RULE_IDS = ['long-command', 'unparsable-command'] as const;
export type LineRuleId = (typeof LINE_RULE_IDS)[number];
// As the unlisted rule: Ask asks where it would have run the line, and a run nobody can ask still runs it in the sandbox.
const LINE_VERDICTS: Verdicts = { plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'allow' };
export const LINE_RULES: Readonly<Record<LineRuleId, { readonly reason: string; readonly verdicts: Verdicts }>> = {
  'long-command': { reason: 'a command over 10,000 characters', verdicts: LINE_VERDICTS },
  'unparsable-command': { reason: 'a command Geno cannot split into simple commands, such as an open quote or a line that ends in &&', verdicts: LINE_VERDICTS },
};
/** A user's PreToolUse hook that asked before a call or denied it (hooks.ts). */
export const HOOK_RULE_IDS = ['hook-ask', 'hook-deny'] as const;
export type HookRuleId = (typeof HOOK_RULE_IDS)[number];
export type ApprovalRuleId = DenyRuleId | McpRuleId | BrowserRuleId | WebRuleId | ExternalRuleId | WorkspaceRuleId | LineRuleId | HookRuleId;
export const APPROVAL_RULE_IDS = [...DENY_RULE_IDS, ...MCP_RULE_IDS, ...BROWSER_RULE_IDS, ...WEB_RULE_IDS, ...EXTERNAL_RULE_IDS, ...WORKSPACE_RULE_IDS, ...LINE_RULE_IDS, ...HOOK_RULE_IDS] as const;

/** The question a PreToolUse hook's ask puts before a call, named by the hook's source as Claude Code labels it. */
export function hookAskDenial({ reason, from }: { readonly reason: string | undefined; readonly from: string }, command: string): Denial {
  return { rule: 'hook-ask', reason: `A PreToolUse hook [${from}] asks first${reason === undefined ? '' : `: ${reason.replace(/\.$/, '')}`}.`, command, verdict: 'ask' };
}

export const isMcpRule = (rule: ApprovalRuleId): rule is McpRuleId => (MCP_RULE_IDS as readonly string[]).includes(rule);

export const MCP_RULES: Readonly<Record<McpRuleId, { readonly reason: string; readonly verdicts: Verdicts }>> = {
  'mcp-read-only': { reason: 'an MCP tool its server marks read-only', verdicts: { plan: 'allow', ask: 'ask', auto: 'allow', 'non-interactive': 'allow' } },
  'mcp-tool': { reason: 'an MCP tool', verdicts: { plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'allow' } },
};

/**
 * The built-in browser's calls, which `browserDenialFor` in browser.ts matches. A page on this machine opens without
 * asking. Any other host asks in Ask mode, and the classifier judges it in Auto, because a page can carry the agent's
 * context out; the answer covers that one navigation. None of these offers "allow for the session".
 */

export const BROWSER_RULES: Readonly<Record<BrowserRuleId, { readonly reason: string; readonly verdicts: Verdicts }>> = {
  'browser-local-url': { reason: 'opening a page on this machine', verdicts: { plan: 'deny', ask: 'allow', auto: 'allow', 'non-interactive': 'allow' } },
  'browser-remote-url': { reason: 'opening a page on another host', verdicts: ASK_OR_CLASSIFY },
  'browser-refused-url': { reason: 'a URL the browser may not open', verdicts: { plan: 'deny', ask: 'deny', auto: 'deny', 'non-interactive': 'deny' } },
  'browser-remote-page': { reason: 'acting on a page from another host the user did not approve', verdicts: ASK_OR_CLASSIFY },
  'browser-risky-tool': {
    reason: 'a browser tool that runs script, uploads a file or fills a form',
    verdicts: { plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'allow' },
  },
};

/**
 * web_fetch and web_search, which run in the engine outside the sandbox. A remote host follows the browser's remote URL
 * rule, except that Plan allows it: a fetch only reads, and the page reaches the model only through a helper's answer.
 * A search sends its query to the search provider, so it is judged the same way.
 */
export const WEB_RULES: Readonly<Record<WebRuleId, { readonly reason: string; readonly verdicts: Verdicts }>> = {
  'web-local-url': { reason: 'fetching a page on this machine', verdicts: { plan: 'allow', ask: 'allow', auto: 'allow', 'non-interactive': 'allow' } },
  'web-remote-url': { reason: 'fetching a page from another host', verdicts: { ...ASK_OR_CLASSIFY, plan: 'allow' } },
  'web-refused-url': { reason: 'a URL web_fetch may not fetch', verdicts: { plan: 'deny', ask: 'deny', auto: 'deny', 'non-interactive': 'deny' } },
  'web-search': { reason: 'a web search, which sends the query to the search provider', verdicts: { ...ASK_OR_CLASSIFY, plan: 'allow' } },
};

/**
 * What settles one MCP call before it runs, or undefined when it runs. A tool the user allowed for the session skips
 * the question and the classifier, but not a mode's denial, so Plan still refuses it.
 */
export function mcpDenialFor(call: { readonly name: string; readonly readOnly: boolean }, mode: ApprovalMode, allowedForSession: boolean): Denial | undefined {
  const rule: McpRuleId = call.readOnly ? 'mcp-read-only' : 'mcp-tool';
  const { reason, verdicts } = MCP_RULES[rule];
  const verdict = verdicts[mode];
  if (verdict === 'allow' || (allowedForSession && verdict !== 'deny')) return undefined;
  return { rule, reason, command: call.name, verdict };
}

const SEPARATORS = ['&&', '||', ';;', ';', '&', '|', '\n', '(', ')'];
const REDIRECTS = ['>>', '>&', '&>', '>', '<'];

type Heredoc = { readonly delimiter: string; readonly quoted: boolean; readonly stripTabs: boolean };

/**
 * Splits a shell command into simple commands of words. Quotes group and are removed. A command substitution stays in
 * its word as text and its commands are split out ahead of it. Heredoc bodies are data, except for the substitutions
 * of an unquoted one.
 */
export function splitCommand(command: string): string[][] {
  return split(command).commands;
}

/** The simple commands, and whether the line leaves a quote, a substitution or an operator open, which a shell refuses to run as written. */
type Split = { readonly commands: string[][]; broken: boolean };

function split(command: string): Split {
  const out: Split = { commands: [], broken: false };
  scan(command, 0, undefined, out);
  return out;
}

/** Longer than Claude Code reads a command word by word. */
export const MAX_RULED_COMMAND = 10_000;

/** Why a line is judged whole rather than word by word, if it is: too long, or not shell Geno can split. */
export function lineRuleOf(command: string): LineRuleId | undefined {
  if (command.length > MAX_RULED_COMMAND) return 'long-command';
  return split(command).broken ? 'unparsable-command' : undefined;
}

// Appends the commands from `start` up to `closer` (or the end) and returns the closer's index.
function scan(src: string, start: number, closer: ')' | '`' | undefined, out: Split): number {
  const { commands } = out;
  let words: string[] = [];
  let word: string | null = null;
  let parens = 0;
  // After `&&`, `||` or `|` with no command yet: a line that ends here is cut short.
  let dangling = false;
  const heredocs: Heredoc[] = [];
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) {
      commands.push(words);
      dangling = false;
    }
    words = [];
  };
  let i = start;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === closer && parens === 0) break;
    if (ch === "'") {
      const close = src.indexOf("'", i + 1);
      if (close === -1) out.broken = true;
      const end = close === -1 ? src.length : close;
      word = (word ?? '') + src.slice(i + 1, end);
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== '"') {
        const substitution = substitutionAt(src, j, out);
        if (substitution !== undefined) {
          text += src.slice(j, substitution + 1);
          j = substitution + 1;
          continue;
        }
        if (src[j] === '\\' && j + 1 < src.length) j++;
        text += src[j];
        j++;
      }
      if (j >= src.length) out.broken = true;
      word = (word ?? '') + text;
      i = j;
      continue;
    }
    if (ch === '\\' && i + 1 < src.length) {
      word = (word ?? '') + src[++i];
      continue;
    }
    const substitution = substitutionAt(src, i, out);
    if (substitution !== undefined) {
      word = (word ?? '') + src.slice(i, substitution + 1);
      i = substitution;
      continue;
    }
    if (src.startsWith('<<', i) && !src.startsWith('<<<', i)) {
      endWord();
      const { heredoc, end } = readHeredoc(src, i + 2);
      heredocs.push(heredoc);
      i = end - 1;
      continue;
    }
    if (ch === '\n' && heredocs.length > 0) {
      endCommand();
      i = skipHeredocBodies(src, i + 1, heredocs.splice(0), out) - 1;
      continue;
    }
    const separator = SEPARATORS.find((op) => src.startsWith(op, i));
    if (separator !== undefined) {
      if (separator === '(') parens++;
      if (separator === ')') parens = Math.max(0, parens - 1);
      endCommand();
      if (separator === '&&' || separator === '||' || separator === '|') dangling = true;
      i += separator.length - 1;
      continue;
    }
    const redirect = REDIRECTS.find((op) => src.startsWith(op, i));
    if (redirect !== undefined) {
      if (word !== null && /^\d$/.test(word)) word = null;
      endWord();
      i += redirect.length - 1;
      continue;
    }
    if (/\s/.test(ch)) {
      endWord();
      continue;
    }
    if (ch === '#' && word === null) {
      const newline = src.indexOf('\n', i);
      i = newline === -1 ? src.length : newline - 1;
      continue;
    }
    word = (word ?? '') + ch;
  }
  endCommand();
  if (dangling) out.broken = true;
  return i;
}

// At `$(` or a backtick, appends the substitution's commands and returns the index of its closer.
function substitutionAt(src: string, i: number, out: Split): number | undefined {
  const closer = src.startsWith('$(', i) ? ')' : src[i] === '`' ? '`' : undefined;
  if (closer === undefined) return undefined;
  const end = scan(src, i + (closer === ')' ? 2 : 1), closer, out);
  if (end >= src.length) out.broken = true;
  return end;
}

function readHeredoc(src: string, start: number): { readonly heredoc: Heredoc; readonly end: number } {
  let i = start;
  const stripTabs = src[i] === '-';
  if (stripTabs) i++;
  while (src[i] === ' ' || src[i] === '\t') i++;
  let delimiter = '';
  let quoted = false;
  for (; i < src.length && !/[\s;&|<>()]/.test(src[i]!); i++) {
    const ch = src[i]!;
    if (ch === "'" || ch === '"') {
      const close = src.indexOf(ch, i + 1);
      const end = close === -1 ? src.length : close;
      delimiter += src.slice(i + 1, end);
      quoted = true;
      i = end;
    } else if (ch === '\\' && i + 1 < src.length) {
      delimiter += src[++i];
      quoted = true;
    } else delimiter += ch;
  }
  return { heredoc: { delimiter, quoted, stripTabs }, end: i };
}

// Returns the index just past the last body's delimiter line.
function skipHeredocBodies(src: string, start: number, heredocs: readonly Heredoc[], out: Split): number {
  let i = start;
  for (const { delimiter, quoted, stripTabs } of heredocs) {
    const bodyStart = i;
    let bodyEnd = src.length;
    while (i < src.length) {
      const newline = src.indexOf('\n', i);
      const lineEnd = newline === -1 ? src.length : newline;
      const line = src.slice(i, lineEnd);
      const next = newline === -1 ? src.length : newline + 1;
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) {
        bodyEnd = i;
        i = next;
        break;
      }
      i = next;
    }
    if (!quoted) substitutionsIn(src.slice(bodyStart, bodyEnd), out);
  }
  return i;
}

function substitutionsIn(text: string, out: Split): void {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else i = substitutionAt(text, i, out) ?? i;
  }
}

// Programs that run the next word as the command, and shell keywords that start a command.
const WRAPPERS = new Set([
  'sudo', 'env', 'command', 'exec', 'time', 'nohup', 'npx', 'bunx', 'xargs', 'nice',
  'if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{',
]);
const CWD_CHANGERS = new Set(['cd', 'pushd', 'popd']);
const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

export function simpleCommand(words: readonly string[], cwd: string | undefined): SimpleCommand {
  let i = 0;
  for (;;) {
    while (i < words.length && (isAssignment(words[i]!) || words[i]!.startsWith('-'))) i++;
    if (i < words.length && WRAPPERS.has(path.basename(words[i]!))) i++;
    else break;
  }
  const executable = words[i] ?? '';
  return { program: path.basename(executable), executable, prefix: words.slice(0, i), args: words.slice(i + 1), words, cwd };
}

/** The values each variable may hold anywhere in the command line; a variable missing here could hold anything. */
type Bindings = ReadonlyMap<string, readonly string[]>;

// Names the environment or the shell may set, so an assignment here is not their only possible value.
const INHERITED = new Set(['PATH', 'LANG', 'TERM', 'TMPDIR', 'PWD', 'OLDPWD', 'IFS', 'CDPATH']);
const MKTEMP_DIR = /^\$\(mktemp(?:\s+-[dqu]+)*\s*\)$/;
const VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const MAX_VARIANTS = 256;

// Order and control flow are ignored: a variable may hold any value assigned to it anywhere in the line, or nothing,
// which stays sound across loops, conditionals and subshells.
function bindings(commands: readonly (readonly string[])[], scope: CommandScope): Bindings {
  const values = new Map<string, string[]>([['HOME', [scope.home]]]);
  const unknown = new Set(INHERITED);
  const bind = (name: string, value: string) => {
    if (value.includes('`') || (value.includes('$') && !MKTEMP_DIR.test(value))) unknown.add(name);
    // mktemp makes a new directory that nothing else owns, so it stands in as a child of the temp dir.
    const resolved = MKTEMP_DIR.test(value) ? path.join(scope.tempDir, 'mktemp') : value;
    values.set(name, [...(values.get(name) ?? ['']), resolved]);
  };
  for (const words of commands) {
    for (const word of words.filter(isAssignment)) bind(word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1));
    const { program, args } = simpleCommand(words, undefined);
    if (program === 'for' && args[1] === 'in') for (const value of args.slice(2)) bind(args[0]!, value);
  }
  return new Map([...values].filter(([name]) => !unknown.has(name)));
}

function expand(word: string, vars: Bindings): string[] {
  let results = [''];
  let last = 0;
  for (const match of word.matchAll(VARIABLE)) {
    const text = word.slice(last, match.index);
    const values = vars.get(match[1] ?? match[2]!);
    results = values === undefined ? results.map((r) => r + text + match[0]) : results.flatMap((r) => values.map((v) => r + text + v));
    last = match.index + match[0].length;
  }
  return results.map((r) => r + word.slice(last));
}

// Every combination of the words' possible values; past the cap the words stay unexpanded, which rules treat as unknown.
function variants(words: readonly string[], vars: Bindings): readonly (readonly string[])[] {
  const expanded = words.map((word) => expand(word, vars));
  if (expanded.reduce((count, values) => count * values.length, 1) > MAX_VARIANTS) return [words];
  return expanded.reduce<string[][]>((combos, values) => combos.flatMap((combo) => values.map((v) => [...combo, v])), [[]]);
}

/** One simple command of a line: its words as written, and every value they may take once variables expand. */
export type ParsedCommand = { readonly words: readonly string[]; readonly variants: readonly SimpleCommand[] };

const movesCwd = (commands: readonly (readonly string[])[]): boolean => commands.some((words) => CWD_CHANGERS.has(simpleCommand(words, undefined).program));

/** Whether a command line runs cd, pushd or popd anywhere in it. */
export const changesDirectory = (command: string): boolean => movesCwd(splitCommand(command));

export function parseCommandLine(command: string, scope: CommandScope): readonly ParsedCommand[] {
  const commands = splitCommand(command);
  const vars = bindings(commands, scope);
  // A cd may sit in a loop or a subshell, so after one anywhere the directory of any command is unknown.
  const cwd = movesCwd(commands) ? undefined : scope.workspace;
  return commands.map((words) => ({ words, variants: variants(words, vars).map((variant) => simpleCommand(variant, cwd)) }));
}

// Programs that run the file named by their first operand; an option such as -c or -e runs code from the line instead.
const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'source', '.', 'node', 'deno', 'bun', 'tsx', 'ts-node', 'python', 'python3', 'ruby', 'perl', 'php']);
const INLINE_CODE = new Set(['-c', '-e', '-m', '-p', '--eval', '--print']);

/** The script one simple command runs: the program itself when named by path, or the file it hands an interpreter. */
function scriptOf({ program, executable, args }: SimpleCommand): string | undefined {
  if (executable.includes('/') && !trustedExecutable(executable)) return executable;
  if (!INTERPRETERS.has(program)) return undefined;
  const operands = (program === 'deno' || program === 'bun') && args[0] === 'run' ? args.slice(1) : args;
  const first = operands.findIndex((arg) => !arg.startsWith('-'));
  if (first === -1 || operands.slice(0, first).some((arg) => INLINE_CODE.has(arg))) return undefined;
  return operands[first];
}

/** The files a command line runs as programs or hands to an interpreter, such as `bash x.sh` or `./x.sh`, as absolute paths. */
export function filesRun(command: string, scope: CommandScope): string[] {
  const files = parseCommandLine(command, scope).flatMap(({ variants }) =>
    variants.flatMap((simple) => {
      const script = scriptOf(simple);
      if (script === undefined || script === '' || /[$`]/.test(script)) return [];
      const expanded = script === '~' || script.startsWith('~/') ? path.join(scope.home, script.slice(1)) : script;
      return [path.resolve(simple.cwd ?? scope.workspace, expanded)];
    }),
  );
  return [...new Set(files)];
}

/** A rule that flags one simple command of the line, which `at` indexes. */
export type Flag = Denial & { readonly rule: DenyRuleId; readonly at: number };

/** A rule that denies outright in this mode ends the scan; else every rule that asks or classifies. */
export type Flags = { readonly kind: 'deny'; readonly denial: Denial } | { readonly kind: 'flagged'; readonly flags: readonly Flag[] };

export function flagsOf(parsed: readonly ParsedCommand[], scope: CommandScope, mode: ApprovalMode): Flags {
  const flags: Flag[] = [];
  for (const [at, { words, variants }] of parsed.entries()) {
    for (const simple of variants) {
      for (const rule of DENY_RULE_IDS) {
        const { reason, verdicts, matches } = DENY_RULES[rule];
        const verdict = verdicts[mode];
        if (verdict === 'allow' || !matches(simple, scope)) continue;
        const denial = { rule, reason, command: words.join(' '), verdict };
        if (verdict === 'deny') return { kind: 'deny', denial };
        flags.push({ ...denial, at });
      }
    }
  }
  return { kind: 'flagged', flags };
}

/**
 * A question about every flagged command when any rule asks, since the classifier must never let a line through that
 * a rule keeps for the user. Else the flagged commands for the classifier.
 */
export function mergedDenial(command: string, flags: readonly Flag[]): Denial | undefined {
  const [first] = flags;
  if (first === undefined) return undefined;
  const { at: _at, ...lead } = flags.find((d) => d.verdict === 'ask') ?? first;
  // One yes runs the whole line, so a question about several flagged commands must show all of them.
  if (new Set(flags.map((d) => d.command)).size === 1) return lead;
  return { ...lead, command: command.trim(), reason: [...new Set(flags.map((d) => d.reason))].join('; ') };
}

/** What a read of a credentials file meets in this mode: the rule that makes `cat .env` ask, for `read <shown>`. */
export function secretReadDenial(shown: string, mode: ApprovalMode): Denial | undefined {
  const { reason, verdicts } = DENY_RULES['secret-path'];
  const verdict = verdicts[mode];
  return verdict === 'allow' ? undefined : { rule: 'secret-path', reason, command: `read ${shown}`, verdict };
}

/**
 * What a read tool meets on `target`, an absolute path outside every directory it may read: the rule that makes `cat`
 * of the path ask. The question offers `directory` for the session, unless the path names credentials, by name or as
 * one of the home's `places`, which the read then asks about on its own.
 */
export function outsideReadDenial(command: string, target: string, directory: string, mode: ApprovalMode, places: readonly string[]): Denial | undefined {
  const { reason, verdicts } = DENY_RULES['path-outside-workspace'];
  const verdict = verdicts[mode];
  if (verdict === 'allow') return undefined;
  return { rule: 'path-outside-workspace', reason, command, verdict, ...(isSecretPath(target) || inCredentialPlace(places, target) ? {} : { directory }) };
}

/** What the line rule that judges `command` whole does in this mode; undefined when none does, or it lets the line run. */
export function lineDenial(command: string, mode: ApprovalMode): Denial | undefined {
  const rule = lineRuleOf(command);
  if (rule === undefined) return undefined;
  const { reason, verdicts } = LINE_RULES[rule];
  const verdict = verdicts[mode];
  return verdict === 'allow' ? undefined : { rule, reason, command: command.trim(), verdict };
}

/** The first command in the line a rule denies in this mode, else the line's own question, else the merged question or classification. */
export function denialFor(command: string, scope: CommandScope, mode: ApprovalMode): Denial | undefined {
  const flags = flagsOf(parseCommandLine(command, scope), scope, mode);
  return flags.kind === 'deny' ? flags.denial : (lineDenial(command, mode) ?? mergedDenial(command, flags.flags));
}

/** The rules that flag one simple command on its own in this mode. */
export const flaggingRules = (simple: SimpleCommand, scope: CommandScope, mode: ApprovalMode): ReadonlySet<DenyRuleId> =>
  new Set(DENY_RULE_IDS.filter((rule) => DENY_RULES[rule].verdicts[mode] !== 'allow' && DENY_RULES[rule].matches(simple, scope)));

const PUSH_REWRITES = /^(?:-f|--force|--force-with-lease(?:=.*)?|--force-if-includes|--mirror|--delete|-d|--prune|--all|--tags)$/;
// A push to a URL or an scp-style address rather than a named remote can send the repository anywhere.
const PUSH_ADDRESS = /:\/\/|^[^/\s]+@[^/\s]+:/;
const HARD_WORDS = [SECRET_PATH, HIDDEN_GLOB, GIT_DIR];

/**
 * What no workspace rule may pre-allow: an `rm -rf` the workspace cannot spare, a push that rewrites or deletes remote
 * history or goes to an address, and any command that names credentials, a hidden glob or a path under .git.
 */
export function isHardAsk(simple: SimpleCommand, scope: CommandScope): boolean {
  if (removes(simple, scope, 'protected')) return true;
  // An option's value counts as its own word, so `--out=.git/hooks/x` names .git.
  const values = simple.words.flatMap((word) => (word.includes('=') ? [word, word.slice(word.indexOf('=') + 1)] : [word]));
  if (values.some((word) => HARD_WORDS.some((pattern) => pattern.test(word)))) return true;
  if (simple.program !== 'git') return false;
  const { name, rest } = gitSubcommand(simple.args);
  return name === 'push' && rest.some((arg) => PUSH_REWRITES.test(arg) || /^[+:]/.test(arg) || PUSH_ADDRESS.test(arg));
}
