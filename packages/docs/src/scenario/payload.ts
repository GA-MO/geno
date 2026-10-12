import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { PayloadIn } from './schema.js';

/** A long string cut at build: its start, and how long it was. */
export interface Long {
  readonly $long: string;
  readonly chars: number;
}
/** The items an array had past the ones kept. */
export interface More {
  readonly $more: number;
}

export interface PayloadView {
  readonly kind: 'payload';
  readonly direction: PayloadIn['direction'];
  /** The excerpt, with long strings as `Long` and long arrays ending in a `More`. */
  readonly value: unknown;
  /** Canonical paths into `value`, keys and indexes joined by dots: `content.0.id`. */
  readonly highlight: readonly string[];
  readonly collapse: readonly string[];
  readonly caption: string;
  readonly file: string;
  readonly url: string;
}

export type PayloadResult = { readonly ok: true; readonly view: PayloadView } | { readonly ok: false; readonly reason: string };

export interface RunFiles {
  resolve(mock: PayloadIn): PayloadResult;
}

const LONG = 240;
const KEPT_CHARS = 160;
const ITEMS = 6;
const KEPT_ITEMS = 5;

type Key = string | number;

export function parsePath(text: string): Key[] {
  return [...text.matchAll(/([A-Za-z_$][\w$-]*)|\[(-?\d+)\]/g)].map((match) => (match[1] === undefined ? Number(match[2]) : match[1]));
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

/** Expands `$prefix` and `$same` the way docs/results/real-usecases/runs/README.md says. */
export function expandRequests(lines: readonly unknown[]): Map<number, Record<string, unknown>> {
  const last = new Map<string, Record<string, unknown>>();
  const bySeq = new Map<number, Record<string, unknown>>();
  for (const entry of lines as { seq?: number; url?: string; request?: Record<string, unknown> }[]) {
    const request = entry.request;
    if (request?.['messages'] === undefined) continue;
    const kind = `${entry.url ?? ''}|${request['tools'] === undefined ? 'no-tools' : 'tools'}|${request['tool_choice'] === undefined ? '' : 'forced'}`;
    const previous = last.get(kind);
    const messages = request['messages'] as unknown[] | { $prefix: number; tail: unknown[] };
    const expanded: Record<string, unknown> = { ...request };
    if (!Array.isArray(messages)) expanded['messages'] = [...((previous?.['messages'] as unknown[] | undefined) ?? []).slice(0, messages.$prefix), ...messages.tail];
    if ((request['system'] as { $same?: boolean } | undefined)?.$same === true) expanded['system'] = previous?.['system'];
    if ((request['tools'] as { $same?: boolean } | undefined)?.$same === true) expanded['tools'] = previous?.['tools'];
    last.set(kind, expanded);
    if (entry.seq !== undefined) bySeq.set(entry.seq, expanded);
  }
  return bySeq;
}

export function runFiles(repoRoot: string): RunFiles {
  const records = new Map<string, Map<number, unknown>>();
  const recordsOf = (file: string): Map<number, unknown> => {
    let found = records.get(file);
    if (found === undefined) {
      const lines = readFileSync(path.join(repoRoot, file), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as unknown);
      found = file.endsWith('/requests.jsonl') ? expandRequests(lines) : new Map(lines.map((line) => [(line as { seq?: number }).seq ?? -1, line]));
      records.set(file, found);
    }
    return found;
  };
  const modelOf = (file: string, record: unknown): string | undefined => {
    const own = (record as { model?: unknown }).model;
    if (typeof own === 'string') return own;
    const session = path.join(path.dirname(file), 'session.jsonl');
    if (!existsSync(path.join(repoRoot, session))) return undefined;
    const start = [...recordsOf(session).values()].find((line) => (line as { kind?: string }).kind === 'session-start') as { session?: { model?: string } } | undefined;
    return start?.session?.model;
  };

  return {
    resolve(mock) {
      const [file, anchor] = mock.source.split('#') as [string, string];
      if (!existsSync(path.join(repoRoot, file))) return { ok: false, reason: `${file} does not exist` };
      const seq = Number(anchor.slice('seq='.length));
      const record = recordsOf(file).get(seq);
      if (record === undefined) return { ok: false, reason: `${file} has no record with seq ${seq}` };
      let selected: unknown = mock.json;
      if (mock.json === undefined) {
        const picked = follow(record, parsePath(mock.select ?? ''));
        if (!picked.ok) return { ok: false, reason: `select ${mock.select}: ${picked.reason}` };
        selected = picked.value;
      }
      const marks = (paths: readonly string[] | undefined, name: string): { readonly ok: true; readonly paths: string[] } | { readonly ok: false; readonly reason: string } => {
        const out: string[] = [];
        for (const text of paths ?? []) {
          const found = follow(selected, parsePath(text));
          if (!found.ok) return { ok: false, reason: `${name} ${text}: ${found.reason}` };
          if (!survivesTrim(selected, found.keys)) return { ok: false, reason: `${name} ${text}: the build folds this item into "… more"; select something narrower` };
          out.push(found.keys.join('.'));
        }
        return { ok: true, paths: out };
      };
      const highlight = marks(mock.highlight, 'highlight');
      if (!highlight.ok) return highlight;
      const collapse = marks(mock.collapse, 'collapse');
      if (!collapse.ok) return collapse;
      const [, runCase, run] = /runs\/([^/]+)\/([^/]+)\//.exec(file) ?? [];
      const label = (runCase ?? '').replace(/^([A-Z]\d+)-/, '$1 ');
      const model = modelOf(file, record);
      return {
        ok: true,
        view: {
          kind: 'payload',
          direction: mock.direction,
          value: trim(selected),
          highlight: highlight.paths,
          collapse: collapse.paths,
          caption: `${label}${run === '1' || run === undefined ? '' : ` (run ${run})`}${model === undefined ? '' : `, ${model}`}`,
          file,
          url: `vscode://file${path.join(repoRoot, file)}`,
        },
      };
    },
  };
}
