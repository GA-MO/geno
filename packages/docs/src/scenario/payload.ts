import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { PayloadSpec } from './schema.js';

/** A long string cut at build: the part kept, where in the string it starts, and how long the string was. */
export interface Long {
  readonly $long: string;
  readonly from: number;
  readonly chars: number;
}
/** The items an array had past the ones kept. */
export interface More {
  readonly $more: number;
}

/**
 * Where a record's bytes come from: `recorded` went over the wire (`wire.jsonl`), `rebuilt` is a request the engine
 * rebuilt from the session log when the run was archived (`requests.jsonl`), `logged` is an event in a session log,
 * and `scripted` went over the wire between the real engine and a scripted model (`src/data/recorded`, written by
 * `pnpm docs:record`).
 */
export type Provenance = 'recorded' | 'rebuilt' | 'logged' | 'scripted';

/**
 * What a card shows, read off the record and never written by the page: a whole request, a stream or one of its
 * events, the request's messages, tools or system prompt, one message, the content blocks of one (tool results, the
 * model's answer, or other request content), one session log event, or an HTTP error the provider answered with.
 */
export type Unit =
  | 'request'
  | 'response'
  | 'stream'
  | 'stream-event'
  | 'messages'
  | 'message'
  | 'tool-result'
  | 'model-output'
  | 'request-content'
  | 'tools'
  | 'tool'
  | 'system'
  | 'log-event'
  | 'editor-request'
  | 'error-response';

/** One content block of the message a card shows, in order: its chip in the summary row. */
export interface BlockChip {
  readonly type: string;
  /** A tool_use block's tool. */
  readonly name?: string;
  /** The block's canonical path in the view's `value`; absent when the card does not show it. */
  readonly at?: string;
}

/** The tool_use a tool result answers, found in the same record or the same file. */
export interface Answer {
  readonly id: string;
  readonly name: string;
}

export interface PayloadView {
  readonly kind: 'payload';
  readonly unit: Unit;
  /** The card's title, from its unit. */
  readonly label: string;
  /** One line on what a log event records. */
  readonly note?: string;
  /** The excerpt, with long strings as `Long` and long arrays ending in a `More`. */
  readonly value: unknown;
  /** Canonical paths into `value`, keys and indexes joined by dots: `content.0.id`. */
  readonly highlight: readonly string[];
  readonly collapse: readonly string[];
  /** Text marked wherever a string in `value` contains it. */
  readonly quote?: string;
  /** The blocks of the message the card shows, when it shows one, its content, or one of its blocks. */
  readonly blocks?: readonly BlockChip[];
  /** For each tool result the card shows, the call it answers. */
  readonly answers?: readonly Answer[];
  readonly caption: string;
  readonly provenance: Provenance;
  /** The engine commit of the run, when the runs index records it. */
  readonly engine?: string;
  readonly file: string;
  readonly url: string;
}

/**
 * `partial` is set when `select` reaches inside a unit (a block, a message, a tool, a log event): the view shows the
 * whole unit with the part highlighted, and docs:check fails with this message so the page selects the unit itself.
 */
export type PayloadResult = { readonly ok: true; readonly view: PayloadView; readonly partial?: string } | { readonly ok: false; readonly reason: string };

export interface RunFiles {
  resolve(mock: PayloadSpec): PayloadResult;
}

const LONG = 240;
const KEPT_CHARS = 160;
const QUOTE_LEAD = 40;
const ITEMS = 6;
const KEPT_ITEMS = 5;

type Key = string | number;

export function parsePath(text: string): Key[] {
  return [...text.matchAll(/([A-Za-z_$][\w$-]*)|\[(-?\d+)\]/g)].map((match) => (match[1] === undefined ? Number(match[2]) : match[1]));
}

type Block = { readonly type: string; readonly name?: unknown; readonly id?: unknown; readonly tool_use_id?: unknown };
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBlock = (value: unknown): value is Block => isObject(value) && typeof value['type'] === 'string';
const isBlocks = (value: unknown): value is readonly Block[] => Array.isArray(value) && value.length > 0 && value.every(isBlock);
const isStream = (value: unknown): value is readonly unknown[] => Array.isArray(value) && value.length > 0 && value.every((item) => isObject(item) && typeof item['event'] === 'string');

const valueAt = (root: unknown, keys: readonly Key[]): unknown => keys.reduce<unknown>((at, key) => (at as Record<Key, unknown>)[key], root);
const pathText = (keys: readonly Key[]): string => keys.map((key, i) => (typeof key === 'number' ? `[${key}]` : i === 0 ? key : `.${key}`)).join('');

/** A whole thing a card may show, by where it sits in its record. */
type Spot = 'request' | 'response' | 'stream' | 'stream-event' | 'messages' | 'message' | 'content' | 'block' | 'tools' | 'tool' | 'system' | 'event' | 'editor-request' | 'error-response';

function rootSpot(record: unknown, logged: boolean): Spot | undefined {
  if (isStream(record)) return 'stream';
  if (!isObject(record)) return undefined;
  if (logged && typeof record['kind'] === 'string') return 'event';
  if (typeof record['acp'] === 'string' && isObject(record['params'])) return 'editor-request';
  if (typeof record['status'] === 'number' && 'body' in record) return 'error-response';
  if (Array.isArray(record['messages'])) return 'request';
  if (record['type'] === 'message') return 'response';
  return undefined;
}

/** The spot one key below a spot, when the value there is a whole thing too. */
function childSpot(spot: Spot, key: Key, value: unknown): Spot | undefined {
  const blocks = key === 'content' && isBlocks(value) ? 'content' : undefined;
  switch (spot) {
    case 'stream':
      return typeof key === 'number' ? 'stream-event' : undefined;
    case 'request':
      return key === 'messages' ? 'messages' : key === 'tools' ? 'tools' : key === 'system' ? 'system' : undefined;
    case 'messages':
      return typeof key === 'number' ? 'message' : undefined;
    case 'tools':
      return typeof key === 'number' ? 'tool' : undefined;
    case 'system':
      return typeof key === 'number' ? 'system' : undefined;
    case 'content':
      return typeof key === 'number' ? 'block' : undefined;
    case 'message':
    case 'response':
    case 'event':
      return blocks;
    default:
      return undefined;
  }
}

interface Spotted {
  readonly spot: Spot;
  /** How many keys of the selection reach it. */
  readonly depth: number;
  /** Whether its blocks are the model's answer: under a response, an assistant event or an assistant message. */
  readonly fromModel: boolean;
}

/** The innermost whole thing the selection reaches; a selection that goes further is a part of it. */
function spotOf(record: unknown, keys: readonly Key[], logged: boolean): Spotted | undefined {
  const root = rootSpot(record, logged);
  if (root === undefined) return undefined;
  let found: Spotted = { spot: root, depth: 0, fromModel: false };
  let at = record;
  for (const [i, key] of keys.entries()) {
    const owner = at as Record<Key, unknown>;
    at = owner[key];
    const next = childSpot(found.spot, key, at);
    if (next === undefined) break;
    const modelOwner = next === 'content' && (found.spot === 'response' || owner['kind'] === 'assistant' || owner['role'] === 'assistant');
    found = { spot: next, depth: i + 1, fromModel: found.fromModel || modelOwner };
  }
  return found;
}

const SPOT_UNITS: Readonly<Record<Exclude<Spot, 'message' | 'content' | 'block' | 'event'>, Unit>> = {
  request: 'request',
  response: 'response',
  stream: 'stream',
  'stream-event': 'stream-event',
  messages: 'messages',
  tools: 'tools',
  tool: 'tool',
  system: 'system',
  'editor-request': 'editor-request',
  'error-response': 'error-response',
};

/** The blocks a card shows, when it shows a message, its content, or one block. */
function shownBlocks(spot: Spot, value: unknown): readonly Block[] {
  if (spot === 'block') return isBlock(value) ? [value] : [];
  if (spot === 'content') return isBlocks(value) ? value : [];
  const content = isObject(value) ? value['content'] : undefined;
  return (spot === 'message' || spot === 'response') && isBlocks(content) ? content : [];
}

function unitOf({ spot, fromModel }: Spotted, value: unknown): Unit {
  if (spot === 'event') return 'log-event';
  if (spot !== 'message' && spot !== 'content' && spot !== 'block') return SPOT_UNITS[spot];
  const blocks = shownBlocks(spot, value);
  if (blocks.length > 0 && blocks.every((block) => block.type === 'tool_result')) return 'tool-result';
  if (spot === 'message') return 'message';
  return fromModel ? 'model-output' : 'request-content';
}

const LABELS: Readonly<Record<Unit, string>> = {
  request: 'Request ที่ส่งให้ model',
  response: 'คำตอบของ model',
  stream: 'Stream ที่ model ส่งกลับ',
  'stream-event': 'Event หนึ่งใน stream ของ model',
  messages: 'messages ใน request',
  message: 'ข้อความหนึ่งใน request',
  'tool-result': 'ผลของ tool (block tool_result)',
  'model-output': 'คำตอบของ model',
  'request-content': 'เนื้อหาข้อความใน request',
  tools: 'tool ทั้งหมดใน request',
  tool: 'นิยาม tool',
  system: 'System prompt',
  'log-event': 'บันทึกใน session log',
  'editor-request': 'คำขอที่ Geno ส่งให้ editor (ACP)',
  'error-response': 'คำตอบ error ของ provider (HTTP status, header และ body)',
};

/** What each kind of session log event records, in one line; a kind with no line here gets a generic one. */
const EVENT_NOTES: Readonly<Record<string, string>> = {
  assistant: 'Geno บันทึกคำตอบของ model หนึ่งครั้ง: block ใน content, เหตุที่หยุด, usage และค่าใช้จ่าย',
  'tool-result': 'Geno บันทึกผลของ tool call หนึ่งครั้ง พร้อมสถานะและการตัดสิน permission ถ้ามี ผลนี้ไปถึง model เป็น block tool_result ใน request ถัดไป',
  user: 'ข้อความที่ผู้ใช้ส่ง ตามที่ Geno บันทึก',
  compact: 'Geno บันทึกการ compaction: summary ที่แทนข้อความเก่า ข้อความที่เก็บไว้ และจำนวน token ก่อนและหลัง',
  mode: 'Geno บันทึกการเปลี่ยน permission mode',
  notice: 'Geno บันทึกข้อความแจ้งที่แสดงให้ผู้ใช้เห็น',
  error: 'Geno บันทึก error ที่ทำให้ turn หยุด',
  'hook-context': 'Geno บันทึกข้อความที่ hook เพิ่มเข้าไปใน context',
  'file-changed': 'Geno บันทึกว่าไฟล์ถูกแก้นอก session',
  'child-start': 'Geno บันทึกการเริ่ม subagent',
  'child-end': 'Geno บันทึกการจบของ subagent และรายงานที่ส่งกลับ',
};
const noteOf = (event: string): string => EVENT_NOTES[event] ?? `Geno บันทึก event ชนิด ${event} ใน session log`;

/** The chip row: the blocks of the message the card shows, each with where the card shows it. */
function chipsOf(record: unknown, keys: readonly Key[], spotted: Spotted): BlockChip[] | undefined {
  const chip = (block: Block, at: string | undefined): BlockChip => ({ type: block.type, ...(typeof block.name === 'string' ? { name: block.name } : {}), ...(at === undefined ? {} : { at }) });
  const shown = (blocks: readonly Block[], prefix: string): BlockChip[] => blocks.map((block, i) => chip(block, blocks.length > ITEMS && i >= KEPT_ITEMS ? undefined : `${prefix}${i}`));
  const selected = valueAt(record, keys.slice(0, spotted.depth));
  if (spotted.spot === 'block') {
    const blocks = valueAt(record, keys.slice(0, spotted.depth - 1)) as readonly Block[];
    return blocks.map((block, i) => chip(block, i === keys[spotted.depth - 1] ? '' : undefined));
  }
  if (spotted.spot === 'content' && isBlocks(selected)) return shown(selected, '');
  const content = isObject(selected) ? selected['content'] : undefined;
  if (spotted.spot !== 'messages' && isBlocks(content)) return shown(content, 'content.');
  return undefined;
}

/** Every tool_use block in a value, by id. */
function toolUses(value: unknown, into = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(value)) for (const item of value) toolUses(item, into);
  else if (isObject(value)) {
    if (value['type'] === 'tool_use' && typeof value['id'] === 'string' && typeof value['name'] === 'string') into.set(value['id'], value['name']);
    for (const inner of Object.values(value)) toolUses(inner, into);
  }
  return into;
}

/** The ids of the tool results a card shows: its tool_result blocks, or a logged tool result's toolUseId. */
function resultIds(unit: Unit, value: unknown): string[] {
  if (unit === 'log-event') return isObject(value) && value['kind'] === 'tool-result' && typeof value['toolUseId'] === 'string' ? [value['toolUseId']] : [];
  if (unit !== 'tool-result') return [];
  const blocks = isBlock(value) ? [value] : isBlocks(value) ? value : isObject(value) && isBlocks(value['content']) ? value['content'] : [];
  return blocks.flatMap((block) => (typeof block.tool_use_id === 'string' ? [block.tool_use_id] : []));
}

/** Follows a path, resolving negative indexes; returns the canonical keys or why it failed. */
function follow(root: unknown, keys: readonly Key[]): { readonly ok: true; readonly value: unknown; readonly keys: readonly Key[] } | { readonly ok: false; readonly reason: string } {
  let at: unknown = root;
  const canonical: Key[] = [];
  for (const key of keys) {
    if (typeof key === 'number') {
      if (!Array.isArray(at)) return { ok: false, reason: `[${key}] is not an index of an array at "${canonical.join('.') || '(root)'}"` };
      const index = key < 0 ? at.length + key : key;
      if (index < 0 || index >= at.length) return { ok: false, reason: `index ${key} is outside "${canonical.join('.') || '(root)'}", which has ${at.length} item(s)` };
      at = at[index];
      canonical.push(index);
    } else {
      if (!isObject(at) || !(key in at)) return { ok: false, reason: `no key "${key}" at "${canonical.join('.') || '(root)'}"` };
      at = at[key];
      canonical.push(key);
    }
  }
  return { ok: true, value: at, keys: canonical };
}

/** Cuts long strings and arrays; a long string that holds `quote` keeps the stretch around it rather than its start. */
export function trim(value: unknown, quote?: string): unknown {
  if (typeof value === 'string') {
    if (value.length <= LONG) return value;
    const at = quote === undefined ? -1 : value.indexOf(quote);
    const length = Math.max(KEPT_CHARS, (quote?.length ?? 0) + 2 * QUOTE_LEAD);
    const from = at < 0 ? 0 : Math.max(0, Math.min(at - QUOTE_LEAD, value.length - length));
    return { $long: value.slice(from, from + length), from, chars: value.length } satisfies Long;
  }
  if (Array.isArray(value)) {
    const kept = value.length > ITEMS ? value.slice(0, KEPT_ITEMS) : value;
    return [...kept.map((item) => trim(item, quote)), ...(value.length > ITEMS ? [{ $more: value.length - KEPT_ITEMS } satisfies More] : [])];
  }
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, trim(inner, quote)]));
  return value;
}

/** Whether trimming keeps the value at these canonical keys visible. */
function survivesTrim(root: unknown, keys: readonly Key[]): boolean {
  let at = root;
  for (const key of keys) {
    if (Array.isArray(at) && at.length > ITEMS && typeof key === 'number' && key >= KEPT_ITEMS) return false;
    at = (at as Record<Key, unknown>)[key];
  }
  return true;
}

/** Whether a string the trimmed card shows contains the quote. */
function shows(value: unknown, quote: string): boolean {
  if (typeof value === 'string') return value.includes(quote);
  if (Array.isArray(value)) return value.some((item) => shows(item, quote));
  if (isObject(value)) return '$long' in value ? String(value['$long']).includes(quote) : Object.values(value).some((inner) => shows(inner, quote));
  return false;
}

/** A run file's records, by line (from 0) and by `seq`. */
export interface Records {
  readonly byLine: readonly unknown[];
  readonly bySeq: ReadonlyMap<number, unknown>;
}

/** An SSE body as its events, each `data` parsed when it is JSON; any other body parsed as JSON, or kept as text. */
export function responseOf(body: string): unknown {
  if (!/^(?:event|data):/m.test(body)) {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }
  return body
    .split(/\r?\n\r?\n/)
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const field = (name: string): string =>
        lines
          .filter((line) => line.startsWith(`${name}:`))
          .map((line) => line.slice(name.length + 1).replace(/^ /, ''))
          .join('\n');
      const data = field('data');
      try {
        return { event: field('event'), data: JSON.parse(data) as unknown };
      } catch {
        return { event: field('event'), data };
      }
    });
}

/**
 * A run file's lines as records. A request line (`requests.jsonl`, `wire.jsonl`) becomes its body with `$prefix` and
 * `$same` expanded the way docs/results/real-usecases/runs/README.md says; a `wire.jsonl` response line becomes its
 * body through `responseOf`, or, when its status is not 200, the status, the headers if the line kept them, and that
 * body; any other line stays as it is.
 */
export function readRecords(lines: readonly unknown[]): Records {
  const last = new Map<string, Record<string, unknown>>();
  const byLine: unknown[] = [];
  const bySeq = new Map<number, unknown>();
  for (const entry of lines as { seq?: unknown; url?: string; request?: Record<string, unknown>; status?: unknown; headers?: unknown; response?: unknown }[]) {
    let record: unknown = entry;
    const request = entry.request;
    if (request?.['messages'] !== undefined) {
      const kind = `${entry.url ?? ''}|${request['tools'] === undefined ? 'no-tools' : 'tools'}|${request['tool_choice'] === undefined ? '' : 'forced'}`;
      const previous = last.get(kind);
      const messages = request['messages'] as unknown[] | { $prefix: number; tail: unknown[] };
      const expanded: Record<string, unknown> = { ...request };
      if (!Array.isArray(messages)) expanded['messages'] = [...((previous?.['messages'] as unknown[] | undefined) ?? []).slice(0, messages.$prefix), ...messages.tail];
      if ((request['system'] as { $same?: boolean } | undefined)?.$same === true) expanded['system'] = previous?.['system'];
      if ((request['tools'] as { $same?: boolean } | undefined)?.$same === true) expanded['tools'] = previous?.['tools'];
      last.set(kind, expanded);
      record = expanded;
    } else if (typeof entry.response === 'string') {
      record =
        typeof entry.status === 'number' && entry.status !== 200
          ? { status: entry.status, ...(entry.headers === undefined ? {} : { headers: entry.headers }), body: responseOf(entry.response) }
          : responseOf(entry.response);
    }
    byLine.push(record);
    if (typeof entry.seq === 'number') bySeq.set(entry.seq, record);
  }
  return { byLine, bySeq };
}

/** Where `pnpm docs:record` writes its flows. */
export const RECORDED_DIR = 'packages/docs/src/data/recorded/';

export function provenanceOf(file: string): Provenance {
  if (file.startsWith(RECORDED_DIR)) return 'scripted';
  const name = path.basename(file).replace(/\.gz$/, '');
  return name === 'wire.jsonl' ? 'recorded' : name === 'requests.jsonl' ? 'rebuilt' : 'logged';
}

const INDEX = 'docs/results/real-usecases/runs/index.json';

export function runFiles(repoRoot: string): RunFiles {
  const records = new Map<string, Records>();
  const recordsOf = (file: string): Records => {
    let found = records.get(file);
    if (found === undefined) {
      const bytes = readFileSync(path.join(repoRoot, file));
      found = readRecords(
        (file.endsWith('.gz') ? gunzipSync(bytes) : bytes)
          .toString('utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line) as unknown),
      );
      records.set(file, found);
    }
    return found;
  };
  const callsOf = new Map<string, Map<string, string>>();
  const fileCalls = (file: string): Map<string, string> => {
    let found = callsOf.get(file);
    if (found === undefined) {
      found = toolUses(recordsOf(file).byLine);
      callsOf.set(file, found);
    }
    return found;
  };
  let engines: ReadonlyMap<string, string> | undefined;
  const engineOf = (file: string): string | undefined => {
    engines ??= new Map(
      existsSync(path.join(repoRoot, INDEX))
        ? (JSON.parse(readFileSync(path.join(repoRoot, INDEX), 'utf8')) as { dir: string; engineCommit?: string }[]).flatMap((entry) =>
            entry.engineCommit === undefined ? [] : [[entry.dir, entry.engineCommit] as const],
          )
        : [],
    );
    if (file.startsWith(RECORDED_DIR)) return (recordsOf(file).byLine[0] as { recorded?: { engineCommit?: string } }).recorded?.engineCommit?.slice(0, 8);
    const dir = /(runs\/[^/]+\/[^/]+)\//.exec(file)?.[1];
    return dir === undefined ? undefined : engines.get(dir);
  };
  const modelOf = (file: string, record: unknown): string | undefined => {
    const own = (record as { model?: unknown } | null)?.model;
    if (typeof own === 'string') return own;
    const session = ['session.jsonl', 'session.jsonl.gz'].map((name) => path.join(path.dirname(file), name)).find((candidate) => existsSync(path.join(repoRoot, candidate)));
    if (session === undefined) return undefined;
    const start = recordsOf(session).byLine.find((line) => (line as { kind?: string }).kind === 'session-start') as { session?: { model?: string } } | undefined;
    return start?.session?.model;
  };

  return {
    resolve(mock) {
      const [file, anchor] = mock.source.split('#') as [string, string];
      if (!existsSync(path.join(repoRoot, file))) return { ok: false, reason: `${file} does not exist` };
      const [by, n] = anchor.split('=') as ['seq' | 'line', string];
      const { byLine, bySeq } = recordsOf(file);
      const record = by === 'seq' ? bySeq.get(Number(n)) : byLine[Number(n) - 1];
      if (record === undefined) return { ok: false, reason: by === 'seq' ? `${file} has no record with seq ${n}` : `${file} has no line ${n}; it has ${byLine.length}` };
      const provenance = provenanceOf(file);
      const picked = follow(record, parsePath(mock.select ?? ''));
      if (!picked.ok) return { ok: false, reason: `select ${mock.select}: ${picked.reason}` };
      const spotted = spotOf(record, picked.keys, provenance === 'logged');
      if (spotted === undefined) return { ok: false, reason: `${mock.source} is not a request, a response, a stream, a session log event, an editor request or an HTTP error, so no card can say what it is` };
      const outer = picked.keys.slice(0, spotted.depth);
      const inner = picked.keys.slice(spotted.depth);
      const selected = valueAt(record, outer);
      const unit = unitOf(spotted, selected);
      let partial: string | undefined;
      if (inner.length > 0) {
        const marked = (mock.highlight ?? ['']).map((text) => pathText([...inner, ...parsePath(text)]));
        partial = `select ${mock.select} shows part of a ${unit} (${LABELS[unit]}), which hides what it is: ${outer.length === 0 ? 'drop select' : `select ${pathText(outer)}`} and highlight [${marked.join(', ')}]`;
      }
      const marks = (paths: readonly string[] | undefined, name: string): { readonly ok: true; readonly paths: string[] } | { readonly ok: false; readonly reason: string } => {
        const out: string[] = [];
        for (const text of paths ?? []) {
          const found = follow(selected, [...inner, ...parsePath(text)]);
          if (!found.ok) return { ok: false, reason: `${name} ${text}: ${found.reason}` };
          if (!survivesTrim(selected, found.keys)) return { ok: false, reason: `${name} ${text}: the build folds this item into "… more"; select something narrower` };
          out.push(found.keys.join('.'));
        }
        return { ok: true, paths: out };
      };
      const highlight = marks(mock.highlight ?? (inner.length === 0 ? [] : ['']), 'highlight');
      if (!highlight.ok) return highlight;
      const collapse = marks(mock.collapse, 'collapse');
      if (!collapse.ok) return collapse;
      const value = trim(selected, mock.quote);
      if (mock.quote !== undefined && !shows(value, mock.quote)) return { ok: false, reason: `quote "${mock.quote}" is not in a string the card shows` };
      const calls = toolUses(record);
      const answers = resultIds(unit, selected).flatMap((id): Answer[] => {
        const name = calls.get(id) ?? fileCalls(file).get(id);
        return name === undefined ? [] : [{ id, name }];
      });
      const blocks = chipsOf(record, picked.keys, spotted);
      const [, runCase, run] = /runs\/([^/]+)\/([^/]+)\//.exec(file) ?? [];
      const label = provenance === 'scripted' ? path.basename(file, '.jsonl') : (runCase ?? '').replace(/^([A-Z]\d+)-/, '$1 ');
      const model = provenance === 'scripted' ? undefined : modelOf(file, record);
      const engine = engineOf(file);
      return {
        ok: true,
        view: {
          kind: 'payload',
          unit,
          label: LABELS[unit],
          ...(unit === 'log-event' ? { note: noteOf(String((selected as { kind: unknown }).kind)) } : {}),
          value,
          highlight: highlight.paths,
          collapse: collapse.paths,
          ...(mock.quote === undefined ? {} : { quote: mock.quote }),
          ...(blocks === undefined ? {} : { blocks }),
          ...(answers.length === 0 ? {} : { answers }),
          caption: `${label}${run === '1' || run === undefined ? '' : ` (run ${run})`}${model === undefined ? '' : `, ${model}`}`,
          provenance,
          ...(engine === undefined ? {} : { engine }),
          file,
          url: `vscode://file${path.join(repoRoot, file)}`,
        },
        ...(partial === undefined ? {} : { partial }),
      };
    },
  };
}
