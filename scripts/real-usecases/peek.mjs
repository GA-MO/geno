// Prints the last events of the newest session log in the campaign's GCODE_HOME, to follow a run that is still going.
// usage: node scripts/real-usecases/peek.mjs [count]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { HOME } from './env.mjs';

const dir = path.join(HOME, 'sessions');
const newest = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ f, at: statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at)[0];
const events = readFileSync(path.join(dir, newest.f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
console.log(newest.f, `${events.length} events`);
for (const e of events.slice(-Number(process.argv[2] ?? 12))) {
  const tools = (Array.isArray(e.content) ? e.content : []).filter((b) => b.type === 'tool_use').map((b) => `${b.name}(${JSON.stringify(b.input).length}ch)`).join(',');
  console.log(e.seq, e.kind, e.status ?? '', tools, e.costUsd ?? '', (e.message ?? e.output ?? '').toString().slice(0, 160).replace(/\n/g, ' '));
}
