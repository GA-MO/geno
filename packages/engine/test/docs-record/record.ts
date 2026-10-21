/**
 * Records the subagent flows the docs tours show: the real engine runs each flow against the conformance harness's
 * fake provider, and every model request and the fake's streamed reply are written, as sent, to
 * packages/docs/src/data/recorded/<flow>.jsonl. Run `pnpm docs:record`; a second run writes the same bytes except the
 * engine commit.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLOWS, type Flow, type Recording } from './flows.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const RECORDED = 'packages/docs/src/data/recorded';

// Fixture commits and their hashes, which the engine shows the model, come out the same on every run.
for (const name of ['GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE']) process.env[name] = '2026-10-01T09:00:00Z';

const FIXED_AT = '2026-10-12T09:00:00.000Z';
const NORMALIZED = 'temp paths, session ids, Geno-made call ids, timestamps, the session date, process ids and subagent durations';

/** Replaces what differs between runs: temp paths, session and call ids, clock times, dates, pids and durations. */
function normalizer(roots: { readonly workspace: string; readonly home: string; readonly tmp: string; readonly scratch: RegExp }) {
  const ids = new Map<string, string>();
  const idFor = (found: string, make: (n: number) => string): string => {
    let id = ids.get(found);
    if (id === undefined) {
      id = make(ids.size + 1);
      ids.set(found, id);
    }
    return id;
  };
  const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
  // Each pid becomes 4001, 4002 and so on, whatever its length; a pid already replaced stays.
  const pids = new Map<string, string>();
  const pidFor = (pid: string): string => {
    if ([...pids.values()].includes(pid)) return pid;
    if (!pids.has(pid)) pids.set(pid, String(4000 + pids.size + 1));
    return pids.get(pid)!;
  };
  return (text: string): string => {
    let out = text.replace(roots.scratch, (_, start: string) => `/tmp/gcode-1000/${idFor(start, (n) => hex(n, 8))}`);
    out = out.replaceAll(roots.workspace, '/home/dev/shop').replaceAll(roots.home, '/home/dev').replaceAll(roots.tmp, '/tmp');
    out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (found) => idFor(found, (n) => `${hex(n, 8)}-0000-4000-8000-${hex(n, 12)}`));
    for (const [found, id] of ids) if (found.includes('-')) out = out.replaceAll(`-${found.slice(0, 8)}`, `-${id.slice(0, 8)}`);
    out = out.replace(/toolu_gcode_[0-9a-f]{32}/g, (found) => idFor(found, (n) => `toolu_gcode_${hex(n, 32)}`));
    out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, FIXED_AT);
    out = out.replace(/Date: \d{4}-\d{2}-\d{2}/g, `Date: ${FIXED_AT.slice(0, 10)}`);
    out = out.replace(/\(pid (\d+)\)/g, (_, pid: string) => `(pid ${pidFor(pid)})`);
    return out.replace(/duration=(\\?)"\d+s/g, 'duration=$1"1s');
  };
}

/**
 * A reply streams a tool's input in pieces, which can split an id the normalizer replaces. Normalizes each block's
 * input whole and cuts it back at the same places, which holds because a replaced id keeps its length.
 */
function joinedInputs(line: string, normalize: (text: string) => string): string {
  const record = JSON.parse(line) as { response?: string };
  if (typeof record.response !== 'string' || !record.response.includes('input_json_delta')) return line;
  type Event = { readonly event: string; readonly data: { index?: number; delta?: { type: string; partial_json?: string } } };
  const events: Event[] = record.response
    .split('\n\n')
    .filter((block) => block !== '')
    .map((block) => {
      const [event, data] = block.split('\n') as [string, string];
      return { event: event.slice('event: '.length), data: JSON.parse(data.slice('data: '.length)) };
    });
  const blocks = new Set(events.flatMap((e) => (e.data.delta?.type === 'input_json_delta' ? [e.data.index] : [])));
  for (const index of blocks) {
    const deltas = events.flatMap((e) => (e.data.index === index && e.data.delta?.type === 'input_json_delta' ? [e.data.delta] : []));
    const whole = deltas.map((delta) => delta.partial_json!).join('');
    const fixed = normalize(whole);
    if (fixed.length !== whole.length) throw new Error(`normalizing a streamed tool input changed its length: ${whole}`);
    let at = 0;
    for (const delta of deltas) {
      const length = delta.partial_json!.length;
      delta.partial_json = fixed.slice(at, at + length);
      at += length;
    }
  }
  const response = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return JSON.stringify({ ...record, response });
}

/**
 * Each request line holds the body as sent, and the next line the reply the fake streamed for it. A request the engine
 * sent the editor follows the reply it came after.
 */
function lines(flow: Flow, { exchanges, editor = [] }: Recording, engineCommit: string): string[] {
  const header = { recorded: { flow: flow.name, what: flow.what, engineCommit, model: 'scripted (conformance fake provider)', wire: 'anthropic', normalized: NORMALIZED } };
  const asked = (after: number) => editor.filter((request) => request.after === after).map(({ method, params }) => ({ acp: method, params }));
  return [
    header,
    ...asked(0),
    ...exchanges.flatMap((exchange, i) => [{ id: i + 1, url: exchange.url, request: exchange.body }, exchange.aborted === true ? { id: i + 1, aborted: "the engine aborted this request before any reply came" } : { id: i + 1, status: exchange.status, ...(exchange.headers === undefined ? {} : { headers: exchange.headers }), response: exchange.response }, ...asked(i + 1)]),
  ].map((line) => JSON.stringify(line));
}

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const engineCommit = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  mkdirSync(path.join(REPO, RECORDED), { recursive: true });
  const tmp = await realpath(tmpdir());
  // A session's scratchpad (`scratchpadOf`): this user's folder under /tmp, then the start of the session id.
  const scratch = new RegExp(`${await realpath('/tmp')}/gcode-${process.getuid?.()}/([0-9a-f]{8,})`, 'g');
  for (const flow of FLOWS) {
    if (only.length > 0 && !only.includes(flow.name)) continue;
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${flow.name}: no end after 60s`)), 60_000).unref());
    const recording = await Promise.race([flow.run(), timeout]);
    const { exchanges, workspace, home } = recording;
    // The fake answers a request its script has no answer for with a 400 that names itself; a flow's own HTTP errors stay.
    const missed = exchanges.findIndex((exchange) => exchange.status !== 200 && exchange.response.includes('fake model: '));
    if (missed >= 0) throw new Error(`${flow.name}: request ${missed + 1} got HTTP ${exchanges[missed]!.status}: ${exchanges[missed]!.response.slice(0, 400)}`);
    const normalize = normalizer({ workspace, home, tmp, scratch });
    const text = `${normalize(lines(flow, recording, engineCommit).join('\n'))
      .split('\n')
      .map((line) => joinedInputs(line, normalize))
      .join('\n')}\n`;
    writeFileSync(path.join(REPO, RECORDED, `${flow.name}.jsonl`), text);
    console.log(`${flow.name}: ${exchanges.length} requests`);
  }
}

await main();
process.exit(0);
