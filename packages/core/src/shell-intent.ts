import path from 'node:path';
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
const REDIRECT = /^(?:&>>?|\d*(?:<<<|>>|>&|>\||>|<&|<))\s*(?:'[^']*'|"[^"]*"|[^\s;&|<>()]+)?/;
const HEREDOC = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/;

/**
 * The steps of a command line, split at the operators outside quotes, groups and substitutions. A heredoc is a
 * redirection as written, such as <<'EOF', and its body is left out. Undefined for a line with an open quote or a
 * heredoc with no end line, which is left to the shell.
 */
export function stepsOf(written: string): Step[] | undefined {
  let command = written;
  const steps: Step[] = [];
  let text = '';
  let redirects: string[] = [];
  let grouped = false;
  let depth = 0;
  let heredocs: { readonly word: string; readonly tabs: boolean }[] = [];
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
    if (ch === '\n' && heredocs.length > 0) {
      // Cut the bodies out, so the newline that starts them ends the step and the line goes on after the last end line.
      let at = i + 1;
      for (const { word, tabs } of heredocs) {
        for (;;) {
          if (at > command.length) return undefined;
          const newline = command.indexOf('\n', at);
          const line = command.slice(at, newline === -1 ? undefined : newline);
          at = newline === -1 ? command.length + 1 : newline + 1;
          if ((tabs ? line.replace(/^\t+/, '') : line) === word) break;
        }
      }
      command = command.slice(0, i + 1) + command.slice(at);
      heredocs = [];
    }
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
    const heredoc = ch === '<' && !command.startsWith('<<<', i) ? HEREDOC.exec(command.slice(i)) : null;
    if (heredoc !== null) {
      heredocs.push({ word: heredoc[2] ?? heredoc[3] ?? heredoc[4]!, tabs: heredoc[1] === '-' });
      redirects.push(heredoc[0].replace(/\s+/g, ''));
      text += ' ';
      i += heredoc[0].length - 1;
      continue;
    }
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
  if (depth > 0 || heredocs.length > 0) return undefined;
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

/** The tools that read, list and search files, which a command line can stand in for. Only a read step is refused. */
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
 * The commands a dedicated tool does as well, by program. Each entry says which tool, given the arguments, or
 * undefined when the arguments ask for more than that tool does. A list, glob or grep step runs, but it looks and
 * changes nothing, so a read after it with && is still a read step.
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

/** A pipeline's text as written, with its redirections. */
const pipelineText = (pipeline: readonly Step[]): string => pipeline.map((step) => [step.text, ...step.redirects].join(' ')).join(' | ');

/**
 * A pipeline of a command line that only reads files, which the read tool does as well, as written. A list, glob or
 * grep step runs in bash: it reads nothing Geno tracks, so only a read is refused, for the edit gate's base, file
 * tracking and hidden-character escapes.
 */
export type FileStep = { readonly text: string; readonly tool: 'read' };

/** The tool a pipeline stands in for: a command from FILE_COMMANDS cut only by head, tail or sort, writing no file and not in the background. */
function fileToolOf([head, ...rest]: readonly Step[]): FileTool | undefined {
  if (head === undefined || [head, ...rest].some((step) => step.grouped || step.redirects.some((r) => !QUIET.has(r)))) return undefined;
  if ((rest.at(-1) ?? head).then === '&' || head.commands.length !== 1 || head.commands[0]!.prefix.length > 0) return undefined;
  const shaped = rest.every(({ commands }) => commands.length === 1 && SHAPERS.has(commands[0]!.program) && operandsOf(commands[0]!.args, { flags: 'nr', valued: ['-n'], count: true })?.length === 0);
  return shaped ? FILE_COMMANDS[head.commands[0]!.program]?.(head.commands[0]!.args) : undefined;
}

/** The words that open a loop or a conditional, as the first word of the step, and the words that close one. */
const OPENERS = new Set(['for', 'select', 'case', 'while', 'until', 'if']);
const CLOSERS = new Set(['done', 'fi', 'esac']);

/**
 * Whether each pipeline is a read step. A read that runs only once a program before it succeeded, as the cat in
 * `npm run gen && cat out.ts`, checks what the program did, which no read called in the same turn can do, so it is
 * not one. A loop or a conditional counts as that program only when something in it is one, so the cat in
 * `for f in *.ts; do wc -l $f; done && cat a.ts` is still a read step.
 */
function pipelineTools(pipelines: readonly Step[][]): ('read' | undefined)[] {
  let afterProgram = false;
  // Whether each loop or conditional open at this point has run a program, innermost last.
  const blocks: boolean[] = [];
  return pipelines.map((pipeline, i) => {
    if (pipelines[i - 1]?.at(-1)!.then !== '&&') afterProgram = false;
    const own = fileToolOf(pipeline);
    const word = /^(?:(?:do|then|else)\s+)*(\w+)/.exec(pipeline[0]!.text)?.[1] ?? '';
    if (OPENERS.has(word)) blocks.push(false);
    // A closer whose opener is not in the line closes a body that may have run anything.
    const program = CLOSERS.has(word) ? (blocks.pop() ?? true) : own === undefined && !isLabel(pipeline) && !onlyLooks(pipeline);
    const tool = own === 'read' && !afterProgram ? own : undefined;
    if (program) {
      blocks.fill(true);
      afterProgram = true;
    }
    return tool;
  });
}

/** Programs that only look and change nothing, so a read after them checks no effect, and the shell's own loop words. */
const LOOKERS = new Set(['wc', 'file', 'stat', 'du', 'tree', 'which', 'test', '[', '[[', 'true', 'false', 'read', 'for', 'select', 'case']);
const GIT_LOOKS = new Set(['status', 'log', 'diff', 'show', 'ls-files', 'branch']);

const onlyLooks = (pipeline: readonly Step[]): boolean =>
  pipeline.every(({ commands }) => commands.every(({ program, args }) => LOOKERS.has(program) || (program === 'git' && GIT_LOOKS.has(args[0] ?? ''))));

/**
 * The pipelines of a command line that only read files, wherever they sit in the line, such as the cat in
 * `cat a.ts; npm test`. A pipeline led by any other program is not one, even one that pipes a file into it.
 */
export function fileStepsOf(command: string): FileStep[] {
  const pipelines = pipelinesIn(command);
  return pipelineTools(pipelines).flatMap((tool, i) => (tool === undefined ? [] : [{ text: pipelineText(pipelines[i]!), tool }]));
}

const pipelinesIn = (command: string): Step[][] => pipelinesOf(stepsOf(command) ?? []);

/**
 * A pipeline of a command line that only puts literal text into workspace files, which edit does, as written: the
 * files as the line names them, and whether it appends to one.
 */
export type WriteStep = { readonly text: string; readonly files: readonly string[]; readonly append: boolean };

/** A redirection of standard output to a file, as stepsOf keeps it, such as >a.txt, >>a.txt or &>a.txt. */
const OUTPUT = /^(?:1?>>?|1?>\||&>>?)(?!&)(.+)$/;
/** Redirections that change neither where text comes from nor where it goes: quiet stderr, text written in the line. */
const HARMLESS = /^(?:2>\/dev\/null|2>&1|\d*>\/dev\/null|\d*>&\d|<<.*)$/;
const unquote = (word: string): string => word.replace(/^(['"])(.*)\1$/, '$2');

type Write = { readonly file: string; readonly append: boolean };

/** The files a pipeline writes, when all it does is put literal text there: echo, printf or cat of a heredoc, into > or tee. */
function literalWrites(pipeline: readonly Step[]): Write[] {
  const writes: Write[] = [];
  for (const [i, step] of pipeline.entries()) {
    // A $ outside single quotes expands to text the line computes, which edit cannot write.
    if (step.grouped || step.commands.length !== 1 || step.text.replace(/'[^']*'/g, '').includes('$')) return [];
    const { program, args } = step.commands[0]!;
    const text = i === 0 && (program === 'echo' || program === 'printf');
    const stdin = program === 'cat' && args.every((arg) => arg === '-');
    const tee = i > 0 && program === 'tee' ? operandsOf(args, { flags: 'a' }) : undefined;
    if (!text && !stdin && tee === undefined) return [];
    for (const file of tee ?? []) writes.push({ file, append: args.includes('-a') });
    for (const redirect of step.redirects) {
      const output = OUTPUT.exec(redirect);
      if (output !== null) writes.push({ file: unquote(output[1]!), append: redirect.includes('>>') });
      else if (!HARMLESS.test(redirect)) return [];
    }
  }
  return writes.filter(({ file }) => file !== '/dev/null');
}

/**
 * Where a file the line names lands, from the directory a cd before it left; undefined where the line does not say, as
 * for $TMPDIR, ~ or a cd to a variable.
 */
const resolvedIn = (cwd: string | undefined, file: string): string | undefined => (cwd === undefined || /^[$~]/.test(file) ? undefined : path.resolve(cwd, file));

const inside = (workspace: string, file: string | undefined): boolean => file !== undefined && (file === workspace || file.startsWith(`${workspace}${path.sep}`));

/** The write step each pipeline is, if any, for a line that starts in `workspace`. */
function pipelineWrites(pipelines: readonly Step[][], workspace: string): (WriteStep | undefined)[] {
  let cwd: string | undefined = workspace;
  return pipelines.map((pipeline) => {
    const [only] = pipeline.length === 1 && !pipeline[0]!.grouped ? pipeline[0]!.commands : [];
    if (only?.program === 'cd') {
      cwd = only.args[0] === undefined || only.args[0] === '-' ? undefined : resolvedIn(cwd, only.args[0]);
      return undefined;
    }
    const writes = literalWrites(pipeline).filter(({ file }) => inside(workspace, resolvedIn(cwd, file)));
    if (writes.length === 0) return undefined;
    return { text: pipelineText(pipeline), files: writes.map(({ file }) => file), append: writes.some(({ append }) => append) };
  });
}

/**
 * The pipelines of a command line that only put literal text into files in `workspace`, which edit does: echo, printf
 * or cat of a heredoc or of standard input, redirected with > or >>, or fed to tee. A program's output written to a
 * file, a copy such as `cat a > b`, and a file in $TMPDIR, /tmp or anywhere else outside the workspace are not.
 */
export function writeStepsOf(command: string, workspace: string): WriteStep[] {
  return pipelineWrites(pipelinesIn(command), workspace).filter((write) => write !== undefined);
}

const listed = (items: readonly string[]): string => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

const isLabel = (pipeline: readonly Step[]): boolean =>
  pipeline.length === 1 && pipeline[0]!.commands.length === 1 && LABELS.has(pipeline[0]!.commands[0]!.program) && pipeline[0]!.redirects.every((r) => QUIET.has(r));

/**
 * The refusal of a command line with a read step or a write step in it, of which Geno runs nothing: it names each
 * step's tool, and the rest of the line to run alone. Undefined for a line with neither. Unlike a read step, a write
 * step after `&&` is refused as well: writing literal text checks nothing the program before it did.
 */
export function fileStepRefusal(command: string, workspace: string): string | undefined {
  const pipelines = pipelinesIn(command);
  const tools = pipelineTools(pipelines);
  const writes = pipelineWrites(pipelines, workspace);
  const jobs = pipelines.flatMap((pipeline, i) => {
    const write = writes[i];
    const how = write?.append === true ? 'read the file, then add the text' : 'create: true with the whole content';
    if (write !== undefined) return [{ tool: 'edit', job: `\`${write.text}\` is the edit tool's job (${how})` }];
    const tool = tools[i];
    return tool === undefined ? [] : [{ tool, job: `\`${pipelineText(pipeline)}\` is the ${tool} tool's job` }];
  });
  if (jobs.length === 0) return undefined;
  // Labels stay beside a program, as a cd before it, and go when nothing else is left.
  const others = pipelines.filter((_, i) => tools[i] === undefined && writes[i] === undefined);
  const kept = others.every(isLabel) ? [] : others;
  const rest = kept.map((pipeline, i) => {
    const then = pipeline.at(-1)!.then;
    return i === kept.length - 1 ? pipelineText(pipeline) : `${pipelineText(pipeline)}${then === ';' ? ';' : ` ${then}`}`;
  });
  const names = [...new Set(jobs.map(({ tool }) => tool))];
  // Reads run beside each other; edits wait their turn.
  const together = !names.includes('edit');
  const then =
    rest.length === 0
      ? `Call ${listed(names)} instead${together ? '; calls in one turn run at the same time' : ''}.`
      : `Run \`${rest.join(' ')}\` alone in bash, and call ${listed(names)}${together ? ' in the same turn; they run at the same time' : ''}.`;
  return `Geno ran nothing: ${listed(jobs.map(({ job }) => job))}. ${then}`;
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
    'If the user will open the server, leave it running and give its URL in your report; otherwise stop it with task_stop when you are done.',
    ...(launchFile === undefined ? [] : [`Or start it with preview_start (load it with tool_search first), which reads ${launchFile} and waits until the server answers.`]),
  ].join(' ');
}
