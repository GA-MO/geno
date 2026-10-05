import path from 'node:path';

export type CommandScope = {
  readonly workspace: string;
  /** The one directory `rm -rf` may target. */
  readonly tempDir: string;
  readonly home: string;
};

export const DENY_RULE_IDS = [
  'rm-rf-outside-temp',
  'git-push',
  'git-reset-hard',
  'path-outside-workspace',
  'network-download',
  'cloud-cli',
  'database-cli',
] as const;
export type DenyRuleId = (typeof DENY_RULE_IDS)[number];

/** One simple command: its program (a basename, wrappers such as sudo or npx removed) and every word. */
export type SimpleCommand = { readonly program: string; readonly args: readonly string[]; readonly words: readonly string[] };

type DenyRule = {
  readonly reason: string;
  denies(command: SimpleCommand, scope: CommandScope): boolean;
};

export type Denial = { readonly rule: DenyRuleId; readonly reason: string; readonly command: string };

const CLOUD_CLIS = new Set([
  'aws', 'az', 'bq', 'doctl', 'eksctl', 'firebase', 'fly', 'flyctl', 'gcloud', 'gsutil', 'helm', 'heroku',
  'ibmcloud', 'kubectl', 'netlify', 'oci', 'pulumi', 'railway', 'supabase', 'terraform', 'vercel', 'wrangler',
]);
const DATABASE_CLIS = new Set([
  'clickhouse-client', 'cockroach', 'cqlsh', 'mongo', 'mongodump', 'mongorestore', 'mongosh', 'mysql',
  'mysqldump', 'pg_dump', 'pg_restore', 'psql', 'redis-cli', 'sqlcmd',
]);
const DOWNLOADERS = new Set(['curl', 'wget']);

// Read-only system locations a build or test command legitimately names by absolute path.
const SYSTEM_PREFIXES = ['/dev', '/usr', '/bin', '/sbin', '/opt/homebrew', '/tmp', '/private/tmp'];
// An absolute word counts as a path only under a real top-level directory, so `/api/users` in a grep is not one.
const FILESYSTEM_ROOTS = new Set([
  'Applications', 'Library', 'System', 'Users', 'Volumes', 'bin', 'dev', 'etc', 'home', 'mnt', 'nix', 'opt',
  'private', 'proc', 'root', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var',
]);

const within = (root: string, target: string): boolean => target === root || target.startsWith(root + path.sep);

function pathOf(word: string, scope: CommandScope): string | undefined {
  const value = word.includes('=') && !word.startsWith('=') ? word.slice(word.indexOf('=') + 1) : word;
  if (value === '~' || value.startsWith('~/')) return path.join(scope.home, value.slice(1));
  if (value.startsWith('/')) return FILESYSTEM_ROOTS.has(value.split('/')[1] ?? '') ? path.normalize(value) : undefined;
  if (value === '..' || value.startsWith('../') || value.includes('/../')) return path.resolve(scope.workspace, value);
  return undefined;
}

function isOutside(target: string, scope: CommandScope): boolean {
  const allowed = [scope.workspace, scope.tempDir, ...SYSTEM_PREFIXES];
  return !allowed.some((root) => within(root, target));
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

export const DENY_RULES: Readonly<Record<DenyRuleId, DenyRule>> = {
  'rm-rf-outside-temp': {
    reason: 'rm -rf outside the temp dir',
    denies: ({ program, args }, scope) =>
      program === 'rm' &&
      isRecursiveForce(args) &&
      operands(args).some((target) => !within(scope.tempDir, path.resolve(scope.workspace, target.replace(/^~(?=\/|$)/, scope.home)))),
  },
  'git-push': {
    reason: 'git push',
    denies: ({ program, args }) => program === 'git' && gitSubcommand(args).name === 'push',
  },
  'git-reset-hard': {
    reason: 'git reset --hard',
    denies: ({ program, args }) => {
      const { name, rest } = gitSubcommand(args);
      return program === 'git' && name === 'reset' && rest.includes('--hard');
    },
  },
  'path-outside-workspace': {
    reason: 'a path outside the workspace',
    denies: ({ words }, scope) =>
      words.some((word) => {
        const target = pathOf(word, scope);
        return target !== undefined && isOutside(target, scope);
      }),
  },
  'network-download': {
    reason: 'curl or wget',
    denies: ({ program }) => DOWNLOADERS.has(program),
  },
  'cloud-cli': {
    reason: 'a cloud CLI',
    denies: ({ program }) => CLOUD_CLIS.has(program),
  },
  'database-cli': {
    reason: 'a database CLI',
    denies: ({ program }) => DATABASE_CLIS.has(program),
  },
};

const SEPARATORS = ['&&', '||', ';;', ';', '&', '|', '\n', '(', ')'];
const REDIRECTS = ['>>', '>&', '&>', '>', '<'];

type Heredoc = { readonly delimiter: string; readonly quoted: boolean; readonly stripTabs: boolean };

/**
 * Splits a shell command into simple commands of words. Quotes group and are removed. A command substitution stays in
 * its word as text and its commands are split out ahead of it. Heredoc bodies are data, except for the substitutions
 * of an unquoted one.
 */
export function splitCommand(command: string): string[][] {
  const commands: string[][] = [];
  scan(command, 0, undefined, commands);
  return commands;
}

// Appends the commands from `start` up to `closer` (or the end) and returns the closer's index.
function scan(src: string, start: number, closer: ')' | '`' | undefined, commands: string[][]): number {
  let words: string[] = [];
  let word: string | null = null;
  let parens = 0;
  const heredocs: Heredoc[] = [];
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  let i = start;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === closer && parens === 0) break;
    if (ch === "'") {
      const close = src.indexOf("'", i + 1);
      const end = close === -1 ? src.length : close;
      word = (word ?? '') + src.slice(i + 1, end);
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== '"') {
        const substitution = substitutionAt(src, j, commands);
        if (substitution !== undefined) {
          text += src.slice(j, substitution + 1);
          j = substitution + 1;
          continue;
        }
        if (src[j] === '\\' && j + 1 < src.length) j++;
        text += src[j];
        j++;
      }
      word = (word ?? '') + text;
      i = j;
      continue;
    }
    if (ch === '\\' && i + 1 < src.length) {
      word = (word ?? '') + src[++i];
      continue;
    }
    const substitution = substitutionAt(src, i, commands);
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
      i = skipHeredocBodies(src, i + 1, heredocs.splice(0), commands) - 1;
      continue;
    }
    const separator = SEPARATORS.find((op) => src.startsWith(op, i));
    if (separator !== undefined) {
      if (separator === '(') parens++;
      if (separator === ')') parens = Math.max(0, parens - 1);
      endCommand();
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
  return i;
}

// At `$(` or a backtick, appends the substitution's commands and returns the index of its closer.
function substitutionAt(src: string, i: number, commands: string[][]): number | undefined {
  if (src.startsWith('$(', i)) return scan(src, i + 2, ')', commands);
  if (src[i] === '`') return scan(src, i + 1, '`', commands);
  return undefined;
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
function skipHeredocBodies(src: string, start: number, heredocs: readonly Heredoc[], commands: string[][]): number {
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
    if (!quoted) substitutionsIn(src.slice(bodyStart, bodyEnd), commands);
  }
  return i;
}

function substitutionsIn(text: string, commands: string[][]): void {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else i = substitutionAt(text, i, commands) ?? i;
  }
}

// Programs that run the next word as the command, and shell keywords that start a command.
const WRAPPERS = new Set([
  'sudo', 'env', 'command', 'exec', 'time', 'nohup', 'npx', 'bunx', 'xargs', 'nice',
  'if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{',
]);
const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

export function simpleCommand(words: readonly string[]): SimpleCommand {
  let i = 0;
  for (;;) {
    while (i < words.length && (isAssignment(words[i]!) || words[i]!.startsWith('-'))) i++;
    if (i < words.length && WRAPPERS.has(path.basename(words[i]!))) i++;
    else break;
  }
  return { program: path.basename(words[i] ?? ''), args: words.slice(i + 1), words };
}

export function denialFor(command: string, scope: CommandScope): Denial | undefined {
  for (const words of splitCommand(command)) {
    const simple = simpleCommand(words);
    for (const rule of DENY_RULE_IDS) {
      if (DENY_RULES[rule].denies(simple, scope)) return { rule, reason: DENY_RULES[rule].reason, command: words.join(' ') };
    }
  }
  return undefined;
}
