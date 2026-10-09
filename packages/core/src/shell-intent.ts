import { simpleCommand, splitCommand, type SimpleCommand } from './approval.js';
import { DEV_SCRIPTS } from './browser.js';

/** What ends a step of a command line: the operator after it, or the end of the line. */
export type StepOperator = '&&' | '||' | ';' | '|' | '&' | 'end';

/** One pipeline stage or list item of a command line, as the shell runs it. */
export type Step = {
  /** The step's text with its redirections taken out. */
  readonly text: string;
  readonly commands: readonly SimpleCommand[];
  readonly then: StepOperator;
  /** Each redirection as written, such as 2>/dev/null or >out.txt. */
  readonly redirects: readonly string[];
  /** Whether the step holds a subshell, a brace group or a command substitution. */
  readonly grouped: boolean;
};

const OPERATORS: readonly (readonly [string, StepOperator])[] = [
  ['&&', '&&'],
  ['||', '||'],
  ['|&', '|'],
  [';', ';'],
  ['\n', ';'],
  ['|', '|'],
  ['&', '&'],
];
const REDIRECT = /^(?:&>>?|\d*(?:>>|>&|>\||>|<&|<))\s*(?:'[^']*'|"[^"]*"|[^\s;&|<>()]+)?/;

/**
 * The steps of a command line, split at the operators outside quotes, groups and substitutions; undefined for a line
 * with a heredoc or an open quote, which is left to the shell.
 */
export function stepsOf(command: string): Step[] | undefined {
  const steps: Step[] = [];
  let text = '';
  let redirects: string[] = [];
  let grouped = false;
  let depth = 0;
  const end = (then: StepOperator) => {
    if (text.trim() !== '' || redirects.length > 0) {
      const commands = splitCommand(text).map((words) => simpleCommand(words, undefined));
      steps.push({ text: text.trim(), commands, then, redirects, grouped });
    }
    text = '';
    redirects = [];
    grouped = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== ch) j += ch === '"' && command[j] === '\\' ? 2 : 1;
      if (j >= command.length) return undefined;
      const quoted = command.slice(i, j + 1);
      if (ch === '"' && /\$\(|`/.test(quoted)) grouped = true;
      text += quoted;
      i = j;
      continue;
    }
    if (ch === '\\') {
      text += command.slice(i, i + 2);
      i++;
      continue;
    }
    if (ch === '`') {
      const close = command.indexOf('`', i + 1);
      if (close === -1) return undefined;
      grouped = true;
      text += command.slice(i, close + 1);
      i = close;
      continue;
    }
    const before = command[i - 1];
    const atWord = before === undefined || /[\s;&|(]/.test(before);
    if (ch === '(' || (ch === '{' && atWord && /\s/.test(command[i + 1] ?? ''))) {
      depth++;
      grouped = true;
      text += ch;
      continue;
    }
    if (ch === ')' || (ch === '}' && atWord && depth > 0)) {
      depth = Math.max(0, depth - 1);
      text += ch;
      continue;
    }
    if (command.startsWith('<<', i) && !command.startsWith('<<<', i)) return undefined;
    const fd = /(^|\s)\d$/.test(text) ? text.slice(-1) : '';
    const redirect = ch === '>' || ch === '<' || command.startsWith('&>', i) ? REDIRECT.exec(command.slice(i)) : null;
    if (redirect !== null) {
      text = text.slice(0, text.length - fd.length);
      redirects.push(`${fd}${redirect[0].replace(/\s+/g, '')}`);
      text += ' ';
      i += redirect[0].length - 1;
      continue;
    }
    const operator = depth === 0 ? OPERATORS.find(([op]) => command.startsWith(op, i)) : undefined;
    if (operator !== undefined) {
      end(operator[1]);
      i += operator[0].length - 1;
      continue;
    }
    text += ch;
  }
  if (depth > 0) return undefined;
  end('end');
  return steps;
}

/** The pipelines of a line: runs of steps joined by `|`, each ending with the operator after its last step. */
export function pipelinesOf(steps: readonly Step[]): Step[][] {
  const pipelines: Step[][] = [];
  let current: Step[] = [];
  for (const step of steps) {
    current.push(step);
    if (step.then !== '|') {
      pipelines.push(current);
      current = [];
    }
  }
  if (current.length > 0) pipelines.push(current);
  return pipelines;
}

/** The tools that read, list and search files, which a command line can stand in for. */
export type FileTool = 'read' | 'list' | 'glob' | 'grep';

/** How a program's options read: single-letter flags it may combine, and options that take the next word as a value. */
type Options = { readonly flags: string; readonly valued?: readonly string[]; readonly long?: RegExp; readonly count?: boolean };

/** The operands of `args` under `options`, or undefined when an option is one the dedicated tool cannot stand in for. */
function operandsOf(args: readonly string[], options: Options): string[] | undefined {
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      operands.push(arg);
      continue;
    }
    if (arg.startsWith('--')) {
      if (options.long?.test(arg) !== true) return undefined;
      continue;
    }
    if (options.count === true && /^-\d+$/.test(arg)) continue;
    if (options.valued?.includes(arg)) {
      i++;
      continue;
    }
    const valued = options.valued?.find((option) => arg.startsWith(option) && /^\+?\d+$/.test(arg.slice(option.length)));
    if (valued !== undefined) continue;
    if (![...arg.slice(1)].every((letter) => options.flags.includes(letter))) return undefined;
  }
  return operands;
}

/** Places a read tool does not read the way cat does: devices, process tables and standard input. */
const SPECIAL = /^(?:-|\/dev\/|\/proc\/|\/sys\/)/;
const plainFiles = (operands: readonly string[] | undefined): boolean =>
  operands !== undefined && operands.length > 0 && operands.every((operand) => !SPECIAL.test(operand));
const plainDirs = (operands: readonly string[] | undefined): boolean => operands !== undefined && operands.every((operand) => !SPECIAL.test(operand));

const FIND_TESTS = new Set(['-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth', '-wholename']);
const FIND_WORDS = new Set(['-prune', '-print', '-o', '-or', '-a', '-and', '-not', '!', '(', ')']);

/** Whether a find only matches names and types, as glob does, and prints them. */
function findsByName(args: readonly string[]): boolean {
  const first = args.findIndex((arg) => arg.startsWith('-') || arg === '!' || arg === '(');
  const tests = first === -1 ? [] : args.slice(first);
  if (!plainDirs(first === -1 ? args : args.slice(0, first))) return false;
  for (let i = 0; i < tests.length; i++) {
    if (FIND_WORDS.has(tests[i]!)) continue;
    if (!FIND_TESTS.has(tests[i]!) || i + 1 >= tests.length) return false;
    i++;
  }
  return true;
}

/** grep's search with the options the grep tool has: a pattern, case, fixed strings, and files or a recursive search. */
function grepsFiles(args: readonly string[]): boolean {
  const operands = operandsOf(args, { flags: 'rRniEFHsIw', valued: ['-e'], long: /^--(?:include|exclude|exclude-dir)=|^--(?:recursive|line-number|ignore-case)$/ });
  if (operands === undefined) return false;
  const recursive = args.some((arg) => /^-[a-zA-Z]*[rR]/.test(arg) || arg === '--recursive');
  const files = args.includes('-e') ? operands : operands.slice(1);
  return plainDirs(files) && (recursive || files.length > 0);
}

/**
 * The commands a dedicated tool does as well, by program: Claude Code's Bash description names the same ones. Each
 * entry says which tool, given the arguments, or undefined when the arguments ask for more than that tool does.
 */
const FILE_COMMANDS: Readonly<Record<string, (args: readonly string[]) => FileTool | undefined>> = {
  cat: (args) => (plainFiles(operandsOf(args, { flags: 'n' })) ? 'read' : undefined),
  head: (args) => (plainFiles(operandsOf(args, { flags: '', valued: ['-n'], count: true })) ? 'read' : undefined),
  tail: (args) => (plainFiles(operandsOf(args, { flags: '', valued: ['-n'], count: true })) ? 'read' : undefined),
  less: (args) => (plainFiles(operandsOf(args, { flags: '' })) ? 'read' : undefined),
  more: (args) => (plainFiles(operandsOf(args, { flags: '' })) ? 'read' : undefined),
  sed: ([flag, script, ...files]) => (flag === '-n' && /^\d+(?:,(?:\d+|\$))?p$/.test(script ?? '') && plainFiles(files) ? 'read' : undefined),
  ls: (args) => (plainDirs(operandsOf(args, { flags: 'aAlhR1FGdp' })) ? 'list' : undefined),
  find: (args) => (findsByName(args) ? 'glob' : undefined),
  grep: (args) => (grepsFiles(args) ? 'grep' : undefined),
  egrep: (args) => (grepsFiles(args) ? 'grep' : undefined),
  rg: (args) => (plainDirs(operandsOf(args, { flags: 'niSFw', valued: ['-g', '--glob', '-e'] })?.slice(args.includes('-e') ? 0 : 1)) ? 'grep' : undefined),
};

/** Commands a model puts between reads to label them, which do not need the shell either. */
const LABELS = new Set(['echo', 'printf', 'cd', 'pwd']);

/** Commands that only cut or order what a read printed, after a pipe. */
const SHAPERS = new Set(['head', 'tail', 'sort']);

const QUIET = new Set(['2>/dev/null', '2>&1']);

/**
 * The dedicated tools a command line stands in for, when all it does is read, list or search files: each step a
 * command from FILE_COMMANDS or a label, cut only by head, tail or sort. Empty for a line that needs the shell, such as
 * one that runs a program, pipes into one, writes a file or runs in the background.
 */
export function fileToolsOf(command: string): FileTool[] {
  const steps = stepsOf(command);
  if (steps === undefined || steps.some((step) => step.grouped || step.then === '&' || step.redirects.some((r) => !QUIET.has(r)))) return [];
  const tools = new Set<FileTool>();
  for (const [head, ...rest] of pipelinesOf(steps)) {
    if (head!.commands.length !== 1 || head!.commands[0]!.prefix.length > 0) return [];
    const { program, args } = head!.commands[0]!;
    const tool = FILE_COMMANDS[program]?.(args);
    if (tool === undefined && !LABELS.has(program)) return [];
    if (tool !== undefined) tools.add(tool);
    const shaped = rest.every(({ commands }) => commands.length === 1 && SHAPERS.has(commands[0]!.program) && operandsOf(commands[0]!.args, { flags: 'nr', valued: ['-n'], count: true })?.length === 0);
    if (!shaped) return [];
  }
  return [...tools];
}

/** The line a bash result gains the first time in a session that its command did only what `tool` does. */
export const FILE_TOOL_NOTES: Readonly<Record<FileTool, string>> = {
  read: '[Geno] Next time, read files with the read tool, not cat, head, tail or sed -n: it numbers the lines, pages a long file, and shows the user each step.',
  list: '[Geno] Next time, list a folder with the list tool, not ls.',
  glob: '[Geno] Next time, find files by name with the glob tool, not find.',
  grep: '[Geno] Next time, search file contents with the grep tool, not grep -r or rg.',
};

export type FileToolNoter = { take(tools: readonly FileTool[]): string[] };

/** Hands out each FILE_TOOL_NOTES line once a session; a line already in `earlier`, the session's tool results, is not repeated. */
export function fileToolNoter(earlier: readonly string[]): FileToolNoter {
  const given = new Set((Object.keys(FILE_TOOL_NOTES) as FileTool[]).filter((tool) => earlier.some((text) => text.includes(FILE_TOOL_NOTES[tool]))));
  return {
    take(tools) {
      const fresh = tools.filter((tool) => !given.has(tool));
      for (const tool of fresh) given.add(tool);
      return fresh.map((tool) => FILE_TOOL_NOTES[tool]);
    },
  };
}

/** A package.json's scripts, by name. */
export type Scripts = Readonly<Record<string, string>>;

const serverFile = (args: readonly string[]): boolean => {
  const file = args.find((arg) => !arg.startsWith('-'));
  return file !== undefined && /(?:^|\/)server\.[cm]?[jt]s$/.test(file);
};

const pythonServer = ([first, second]: readonly string[]): boolean =>
  (first === '-m' && second === 'http.server') || (/manage\.py$/.test(first ?? '') && second === 'runserver');

/** Programs that serve until stopped, given their arguments. */
const SERVERS: Readonly<Record<string, (args: readonly string[]) => boolean>> = {
  vite: ([first]) => first === undefined || first.startsWith('-') || ['dev', 'serve', 'preview'].includes(first),
  next: ([first]) => first === 'dev' || first === 'start',
  nodemon: () => true,
  'http-server': () => true,
  'live-server': () => true,
  serve: () => true,
  'webpack-dev-server': () => true,
  webpack: ([first]) => first === 'serve',
  node: serverFile,
  tsx: serverFile,
  'ts-node': serverFile,
  bun: serverFile,
  deno: (args) => serverFile(args.filter((arg) => arg !== 'run')),
  python: pythonServer,
  python3: pythonServer,
  php: ([first]) => first === '-S',
  flask: ([first]) => first === 'run',
  uvicorn: () => true,
  rails: ([first]) => first === 's' || first === 'server',
};

const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** The package.json script a command runs, such as dev for npm run dev or pnpm dev. */
function scriptOf({ program, args }: SimpleCommand): string | undefined {
  if (!SCRIPT_RUNNERS.has(program)) return undefined;
  if (program === 'npm') return args[0] === 'start' ? 'start' : args[0] === 'run' || args[0] === 'run-script' ? args[1] : undefined;
  return args[0] === 'run' ? args[1] : program === 'bun' ? undefined : args[0];
}

/**
 * Whether a command starts a server. A script counts by its name when it is a dev, serve or preview script, or by its
 * body. `start` names a server only when its body runs one, or when the line backgrounds it, since a start script may
 * also run a program that ends.
 */
function startsServer(command: SimpleCommand, scripts: Scripts, background: boolean): boolean {
  const script = scriptOf(command);
  if (script !== undefined) {
    const body = scripts[script];
    if (body !== undefined && (stepsOf(body) ?? []).some((step) => step.commands.some((c) => scriptOf(c) === undefined && startsServer(c, {}, false)))) return true;
    return script === 'start' ? background : (DEV_SCRIPTS as readonly string[]).includes(script);
  }
  return SERVERS[command.program]?.(command.args) === true;
}

/** A server a command line starts itself, as written, and whether the line puts it in the background. */
export type ServerStart = { readonly server: string; readonly background: boolean; readonly rest: string };

/**
 * The server a command line starts with &, nohup or ( … ) &, or in the foreground, where a background job is what
 * runs it: either way bash would leave it running past the call or hold the call until the timeout.
 */
export function serverStartOf(command: string, scripts: Scripts): ServerStart | undefined {
  const steps = stepsOf(command);
  if (steps === undefined) return undefined;
  const pipelines = pipelinesOf(steps);
  const index = pipelines.findIndex((pipeline) => {
    const background = pipeline.at(-1)!.then === '&';
    return pipeline.some((step) => step.commands.some((c) => startsServer(c, scripts, background) || (background && c.prefix.includes('nohup'))));
  });
  if (index === -1) return undefined;
  const join = (pipeline: readonly Step[]) => pipeline.map((step) => step.text).join(' | ');
  const rest = pipelines.filter((_, i) => i !== index).map((pipeline) => `${join(pipeline)}${pipeline.at(-1)!.then === ';' ? ';' : ` ${pipeline.at(-1)!.then}`}`);
  return {
    server: join(pipelines[index]!),
    background: pipelines[index]!.at(-1)!.then === '&',
    rest: rest.join(' ').replace(/\s*(?:&&|\|\||;|&|end)$/, ''),
  };
}

/** How the model can wait for a server: monitor where something wakes the session, a foreground until-loop elsewhere. */
export type ServerWait = { readonly monitor: boolean; readonly launchFile?: string | undefined };

/** The refusal of a server started by a plain bash call, which says how to start it in the background and wait for it. */
export function serverRefusal({ server, background, rest }: ServerStart, { monitor, launchFile }: ServerWait): string {
  const url = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s'"`;|&)]*/.exec(rest)?.[0] ?? 'http://localhost:<port>/';
  const why = background ? 'with & it would keep running after this call and this session' : 'in the foreground it would hold this call until the timeout kills it';
  const wait = monitor
    ? 'Then wait for it with monitor (load it with tool_search first) on that job id, with a pattern for its ready line such as "listening|ready|Local:", and end your turn: Geno wakes you on that line.'
    : `Then wait for it with one foreground bash command that ends when it answers, such as until curl -sf ${url} >/dev/null; do sleep 0.5; done, with timeout_seconds as its limit.`;
  return [
    `Blocked: \`${server}\` starts a server, and ${why}. Start it on its own instead: call bash with {"command": ${JSON.stringify(server.replace(/^nohup\s+/, ''))}, "run_in_background": true}. That returns a job id such as bg-1 at once, and Geno stops the job when the session ends.`,
    wait,
    ...(rest === '' ? [] : [`Run the rest of this line, \`${rest}\`, after that, without the & job and its sleep or kill.`]),
    'Stop the server with task_stop when you are done.',
    ...(launchFile === undefined ? [] : [`Or start it with preview_start (load it with tool_search first), which reads ${launchFile} and waits until the server answers.`]),
  ].join(' ');
}
