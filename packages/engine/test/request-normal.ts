import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

export type Wire = 'anthropic' | 'openai';

/**
 * The parts of a request body that change from run to run without the request meaning anything else. A recording's
 * key and a golden request are both taken after these. A rule that is missing here shows up as a recording that
 * misses or a golden that changes on every run; a rule too broad hides a real change, so each one names what it covers.
 */
const RULES: readonly (readonly [RegExp, string | ((match: string, ...groups: string[]) => string)])[] = [
  // The environment block's machine facts: the tests run on macOS and in a Linux container.
  [/^( - Platform: ).*$/gm, '$1<platform>'],
  [/^( - OS version: ).*$/gm, '$1<os-version>'],
  // Commit hashes in git log output, which change with the commit's time.
  [/^[0-9a-f]{7,40}(?= )/gm, '<commit>'],
  // ISO dates and times: the session's start date, a log's timestamps.
  [/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?\b/g, '<date>'],
];

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// mkdtemp's six random characters after a name that ends in a dash.
const MKDTEMP = /(?<=\/[^/\s]*-)[A-Za-z0-9]{6}(?=\/|$)/g;
const PATH_TAIL = /<tmp>(?:\/[^\s/'"`<>()\]]+)*/g;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function tmpRoots(): RegExp {
  const roots = new Set([tmpdir(), realpathSync(tmpdir())].map((root) => root.replace(/\/$/, '')));
  // Longest first, so /private/var/... is not read as /var/... with a /private left over.
  return new RegExp([...roots].sort((a, b) => b.length - a.length).map(escape).join('|'), 'g');
}

/** A session's scratchpad (`scratchpadOf`), `/tmp/gcode-<uid>/` and the start of its session id, by either spelling of /tmp. */
function scratchpads(): RegExp {
  const roots = [...new Set([realpathSync('/tmp'), '/tmp'])].map((tmp) => escape(`${tmp}/gcode-${process.getuid?.()}/`));
  return new RegExp(`(?:${roots.join('|')})[0-9a-f-]{8,36}`, 'g');
}

function normalizeText(text: string, roots: { readonly scratch: RegExp; readonly tmp: RegExp }, uuids: Map<string, string>): string {
  let out = text.replace(roots.scratch, '<scratchpad>').replace(roots.tmp, '<tmp>').replace(PATH_TAIL, (tail) => tail.replace(MKDTEMP, 'XXXXXX'));
  for (const [pattern, to] of RULES) out = out.replace(pattern, to as string);
  // Numbered by first appearance, so a request that names one session twice stays apart from one naming two.
  return out.replace(UUID, (id) => uuids.get(id.toLowerCase()) ?? uuids.set(id.toLowerCase(), `<uuid-${uuids.size + 1}>`).get(id.toLowerCase())!);
}

/**
 * `body` with the volatile parts replaced: every `cache_control` key dropped (the breakpoint moves to the newest
 * message on each call), a session's scratchpad as `<scratchpad>`, temp-dir paths as `<tmp>` with mkdtemp suffixes as
 * XXXXXX, uuids as `<uuid-N>`, and the rules above. Tool-call ids stay: the script or the recording chose them, so they repeat on every run.
 */
export function normalizeRequest(body: unknown): unknown {
  const roots = { scratch: scratchpads(), tmp: tmpRoots() };
  const uuids = new Map<string, string>();
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return normalizeText(value, roots, uuids);
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, v]) => (key === 'cache_control' ? [] : [[key, walk(v)]])));
  };
  return walk(body);
}

const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, sorted(v)]))
      : value;

type Message = { readonly role: string; readonly content: unknown };

/** The last text of a message's content on either wire: the prompt that opens a conversation, after Geno's own blocks. */
function lastText(content: unknown): string {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? (content as { type?: string; text?: string }[]) : []).findLast((b) => b.type === 'text')?.text ?? '';
}

/**
 * The key of one model turn of a conversation: 8 hex characters of the SHA-256 of the normalized text that opened it
 * (the user's prompt, or a subagent's task), then `#` and how many model turns came before it. A recording made from
 * a real run answers by this key, so a change to the system prompt, the tools or Geno's notices still replays it, and
 * a subagent's turns stay apart from its parent's however they interleave.
 */
export function turnKey(opening: string, turn: number): string {
  const text = normalizeRequest(opening) as string;
  return `${createHash('sha256').update(text).digest('hex').slice(0, 8)}#${turn}`;
}

/** The turn key of a request body on either wire. */
export function requestTurnKey(body: { readonly messages?: readonly Message[] }): string {
  const messages = body.messages ?? [];
  const opening = messages.find((m) => m.role === 'user');
  return turnKey(lastText(opening?.content), messages.filter((m) => m.role === 'assistant').length);
}

/** The stable key of a request on `wire`: 16 hex characters of the SHA-256 of its normalized body, keys sorted. */
export function requestKey(wire: Wire, body: unknown): string {
  return createHash('sha256').update(JSON.stringify(sorted({ wire, body: normalizeRequest(body) }))).digest('hex').slice(0, 16);
}
