// Reads one archived run of the real-model campaign (docs/results/real-usecases/runs/<case>/<run>/) for the scripts
// that turn it into a replay recording, an example page or gallery states.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RUNS = path.join(REPO, 'docs/results/real-usecases/runs');

export type LogEvent = { readonly kind: string; readonly seq?: number; readonly at?: string; readonly [field: string]: any };

/** One conversation of a run: Geno's own session, a subagent's, or another chat the step started. */
export type Conversation = {
  readonly file: string;
  readonly events: readonly LogEvent[];
  readonly id: string;
  readonly workspace: string;
  /** The text that opened it: the user's first prompt, or the task a subagent was given. */
  readonly opening: string;
  readonly subagent: boolean;
};

export type ArchivedRun = {
  readonly dir: string;
  /** The run's folder relative to the repository, as links and refresh commands name it. */
  readonly rel: string;
  readonly caseId: string;
  readonly run: number;
  readonly layer: 'A' | 'B';
  readonly spec: any;
  readonly result: any;
  /** The run's own conversation first, then the others in file order. */
  readonly conversations: readonly Conversation[];
  readonly diff: string | undefined;
};

function readText(file: string): string {
  const bytes = readFileSync(file);
  return file.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
}

const readLog = (file: string): LogEvent[] =>
  readText(file)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LogEvent);

const firstFile = (dir: string, name: string): string | undefined => [name, `${name}.gz`].map((n) => path.join(dir, n)).find((f) => existsSync(f));

function conversationOf(file: string, subagent: boolean): Conversation {
  const events = readLog(file);
  const start = events[0];
  if (start?.kind !== 'session-start') throw new Error(`${file} does not start with a session-start event`);
  const user = events.find((e) => e.kind === 'user');
  return { file, events, id: start.session.id, workspace: start.session.workspace, opening: typeof user?.content === 'string' ? user.content : '', subagent };
}

export function readRun(dirArg: string): ArchivedRun {
  const dir = path.resolve(dirArg);
  const spec = JSON.parse(readText(path.join(dir, 'case.json')));
  const result = JSON.parse(readText(path.join(dir, 'result.json')));
  const files = readdirSync(dir).sort();
  const layer: 'A' | 'B' = spec.layer === 'B' ? 'B' : 'A';
  let conversations: Conversation[];
  if (layer === 'A') {
    const main = firstFile(dir, 'session.jsonl');
    if (main === undefined) throw new Error(`${dir} has no session.jsonl`);
    conversations = [conversationOf(main, false), ...files.filter((f) => /^child-.*\.jsonl(\.gz)?$/.test(f)).map((f) => conversationOf(path.join(dir, f), true))];
  } else {
    const named: string[] = spec.sessions ?? [];
    const logs = files.filter((f) => /^session-.*\.jsonl(\.gz)?$/.test(f));
    const idOf = (f: string) => f.replace(/^session-/, '').replace(/\.jsonl(\.gz)?$/, '');
    const ordered = [...named.flatMap((id) => logs.filter((f) => idOf(f) === id)), ...logs.filter((f) => !named.includes(idOf(f)))];
    // A session the step did not start itself is a subagent of one it did.
    conversations = ordered.map((f) => conversationOf(path.join(dir, f), !named.includes(idOf(f))));
  }
  const diffFile = firstFile(dir, 'diff.patch');
  return {
    dir,
    rel: path.relative(REPO, dir).split(path.sep).join('/'),
    caseId: spec.case,
    run: Number(spec.run),
    layer,
    spec,
    result,
    conversations,
    diff: diffFile === undefined ? undefined : readText(diffFile),
  };
}

/** Each workspace path of the run, under both of the names macOS gives a temp folder. */
export function workspacesOf(run: ArchivedRun): string[] {
  const roots = new Set(run.conversations.map((c) => c.workspace));
  for (const root of [...roots]) {
    if (root.startsWith('/private/')) roots.add(root.slice('/private'.length));
    else if (root.startsWith('/var/')) roots.add(`/private${root}`);
  }
  return [...roots].sort((a, b) => b.length - a.length);
}

/** `text` with the run's workspace written relative to itself, so the model's paths work in another checkout. */
export function portable(text: string, workspaces: readonly string[]): string {
  let out = text;
  for (const root of workspaces) out = out.split(`${root}/`).join('').split(root).join('.');
  return out;
}

/** `value` with every string in it made portable. */
export function portableValue<T>(value: T, workspaces: readonly string[]): T {
  if (typeof value === 'string') return portable(value, workspaces) as T;
  if (Array.isArray(value)) return value.map((v) => portableValue(v, workspaces)) as T;
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, portableValue(v, workspaces)])) as T;
}

/** The model's turns of a conversation, in order: each assistant event. */
export const assistantTurns = (conversation: Conversation): LogEvent[] => conversation.events.filter((e) => e.kind === 'assistant');

/** The tool calls of a conversation in order, each with the result the log gave it. */
export function callsOf(conversation: Conversation): { readonly id: string; readonly name: string; readonly input: any; readonly result: LogEvent | undefined }[] {
  const results = new Map(conversation.events.filter((e) => e.kind === 'tool-result').map((e) => [e.toolUseId as string, e]));
  return assistantTurns(conversation).flatMap((turn) =>
    (turn.content as any[]).filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id as string, name: b.name as string, input: b.input, result: results.get(b.id) })),
  );
}
