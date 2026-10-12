import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { PayloadSpec } from './schema.js';

/** A long string cut at build: its start, and how long it was. */
export interface Long {
  readonly $long: string;
  readonly chars: number;
}
/** The items an array had past the ones kept. */
export interface More {
  readonly $more: number;
}

/**
 * Where a record's bytes come from: `recorded` went over the wire (`wire.jsonl`), `rebuilt` is a request the engine
 * rebuilt from the session log when the run was archived (`requests.jsonl`), `logged` is an event in a session log.
 */
export type Provenance = 'recorded' | 'rebuilt' | 'logged';

/** One content block of the message a card shows, in order: its chip in the summary row. */
export interface BlockChip {
  readonly type: string;
  /** A tool_use block's tool. */
  readonly name?: string;
  /** The block's canonical path in the view's `value`; absent when the card does not show it. */
  readonly at?: string;
}

export interface PayloadView {
  readonly kind: 'payload';
  readonly direction: PayloadSpec['direction'];
  /** The excerpt, with long strings as `Long` and long arrays ending in a `More`. */
  readonly value: unknown;
  /** Canonical paths into `value`, keys and indexes joined by dots: `content.0.id`. */
  readonly highlight: readonly string[];
  readonly collapse: readonly string[];
  /** The blocks of the model message the card shows, when it shows one, its content, or one of its blocks. */
  readonly blocks?: readonly BlockChip[];
  readonly caption: string;
  readonly provenance: Provenance;
  /** The engine commit of the run, when the runs index records it. */
  readonly engine?: string;
  readonly file: string;
  readonly url: string;
}

/**
 * `cut` is set when `select` reaches inside a content block without the spec's own `cut` reason: the view still shows
 * the whole block, and docs:check fails with this message so the page selects the block itself.
 */
export type PayloadResult = { readonly ok: true; readonly view: PayloadView; readonly cut?: string } | { readonly ok: false; readonly reason: string };

export interface RunFiles {
  resolve(mock: PayloadSpec): PayloadResult;
}

const LONG = 240;
const KEPT_CHARS = 160;
const ITEMS = 6;
const KEPT_ITEMS = 5;

type Key = string | number;

export function parsePath(text: string): Key[] {
  return [...text.matchAll(/([A-Za-z_$][\w$-]*)|\[(-?\d+)\]/g)].map((match) => (match[1] === undefined ? Number(match[2]) : match[1]));
}

type Block = { readonly type: string; readonly name?: unknown };
const isBlock = (value: unknown): value is Block => value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string';
const isBlocks = (value: unknown): value is readonly Block[] => Array.isArray(value) && value.length > 0 && value.every(isBlock);

/** How many of the keys reach the outermost content block they pass through or end at: `content[i]` of a message. */
function blockDepth(root: unknown, keys: readonly Key[]): number | undefined {
  let at = root;
  for (const [i, key] of keys.entries()) {
    if (typeof key === 'number' && keys[i - 1] === 'content' && isBlocks(at)) return i + 1;
    at = (at as Record<Key, unknown>)[key];
  }
  return undefined;
}

const valueAt = (root: unknown, keys: readonly Key[]): unknown => keys.reduce<unknown>((at, key) => (at as Record<Key, unknown>)[key], root);

/** The chip row of a selection: the blocks of its message, each with where the card shows it. */
function chipsOf(root: unknown, keys: readonly Key[], depth: number | undefined): BlockChip[] | undefined {
  const chip = (block: Block, at: string | undefined): BlockChip => ({ type: block.type, ...(typeof block.name === 'string' ? { name: block.name } : {}), ...(at === undefined ? {} : { at }) });
  const shown = (blocks: readonly Block[], prefix: string): BlockChip[] =>
    blocks.map((block, i) => chip(block, blocks.length > ITEMS && i >= KEPT_ITEMS ? undefined : `${prefix}${i}`));
  if (depth !== undefined) {
    const blocks = valueAt(root, keys.slice(0, depth - 1)) as readonly Block[];
    return blocks.map((block, i) => chip(block, i === keys[depth - 1] ? '' : undefined));
  }
  const selected = valueAt(root, keys);
  if (isBlocks(selected) && (keys.length === 0 || keys.at(-1) === 'content')) return shown(selected, '');
  const content = (selected as { content?: unknown } | null)?.content;
  if (typeof selected === 'object' && !Array.isArray(selected) && isBlocks(content)) return shown(content, 'content.');
  return undefined;
}

const pathText = (keys: readonly Key[]): string => keys.map((key, i) => (typeof key === 'number' ? `[${key}]` : i === 0 ? key : `.${key}`)).join('');

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
      if (at === null || typeof at !== 'object' || Array.isArray(at) || !(key in at)) return { ok: false, reason: `no key "${key}" at "${canonical.join('.') || '(root)'}"` };
      at = (at as Record<string, unknown>)[key];
      canonical.push(key);
    }
  }
  return { ok: true, value: at, keys: canonical };
}

export function trim(value: unknown): unknown {
  if (typeof value === 'string') return value.length > LONG ? ({ $long: value.slice(0, KEPT_CHARS), chars: value.length } satisfies Long) : value;
  if (Array.isArray(value)) {
    const kept = value.length > ITEMS ? value.slice(0, KEPT_ITEMS) : value;
    return [...kept.map(trim), ...(value.length > ITEMS ? [{ $more: value.length - KEPT_ITEMS } satisfies More] : [])];
  }
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, trim(inner)]));
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
 * body through `responseOf`; any other line stays as it is.
 */
export function readRecords(lines: readonly unknown[]): Records {
  const last = new Map<string, Record<string, unknown>>();
  const byLine: unknown[] = [];
  const bySeq = new Map<number, unknown>();
  for (const entry of lines as { seq?: unknown; url?: string; request?: Record<string, unknown>; response?: unknown }[]) {
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
      record = responseOf(entry.response);
    }
    byLine.push(record);
    if (typeof entry.seq === 'number') bySeq.set(entry.seq, record);
  }
  return { byLine, bySeq };
}

export function provenanceOf(file: string): Provenance {
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
  let engines: ReadonlyMap<string, string> | undefined;
  const engineOf = (file: string): string | undefined => {
    engines ??= new Map(
      existsSync(path.join(repoRoot, INDEX))
        ? (JSON.parse(readFileSync(path.join(repoRoot, INDEX), 'utf8')) as { dir: string; engineCommit?: string }[]).flatMap((entry) =>
            entry.engineCommit === undefined ? [] : [[entry.dir, entry.engineCommit] as const],
          )
        : [],
    );
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
      let selected: unknown = mock.json;
      let blocks = mock.json === undefined ? undefined : chipsOf(mock.json, [], undefined);
      let inner: Key[] = [];
      let cut: string | undefined;
      if (mock.json === undefined) {
        const keys = parsePath(mock.select ?? '');
        const picked = follow(record, keys);
        if (!picked.ok) return { ok: false, reason: `select ${mock.select}: ${picked.reason}` };
        const depth = blockDepth(record, picked.keys);
        const below = depth !== undefined && depth < picked.keys.length;
        if (below && mock.cut === undefined) {
          inner = picked.keys.slice(depth);
          const block = valueAt(record, picked.keys.slice(0, depth)) as Block;
          selected = block;
          const marked = (mock.highlight ?? ['']).map((text) => pathText([...inner, ...parsePath(text)]));
          cut = `select ${mock.select} shows part of a ${block.type} block, which hides its type, id and name: select ${pathText(keys.slice(0, depth))} and highlight [${marked.join(', ')}], or give cut: <why only this part> to show the part alone`;
        } else {
          if (!below && mock.cut !== undefined) return { ok: false, reason: `cut: select ${mock.select ?? '(the whole record)'} does not reach inside a content block, so drop cut` };
          selected = picked.value;
        }
        blocks = below && mock.cut !== undefined ? undefined : chipsOf(record, picked.keys, depth);
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
      const [, runCase, run] = /runs\/([^/]+)\/([^/]+)\//.exec(file) ?? [];
      const label = (runCase ?? '').replace(/^([A-Z]\d+)-/, '$1 ');
      const model = modelOf(file, record);
      const engine = engineOf(file);
      return {
        ok: true,
        view: {
          kind: 'payload',
          direction: mock.direction,
          value: trim(selected),
          highlight: highlight.paths,
          collapse: collapse.paths,
          ...(blocks === undefined ? {} : { blocks }),
          caption: `${label}${run === '1' || run === undefined ? '' : ` (run ${run})`}${model === undefined ? '' : `, ${model}`}`,
          provenance: provenanceOf(file),
          ...(engine === undefined ? {} : { engine }),
          file,
          url: `vscode://file${path.join(repoRoot, file)}`,
        },
        ...(cut === undefined ? {} : { cut }),
      };
    },
  };
}
