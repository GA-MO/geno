// Run from the repository root: pnpm tsx packages/engine/test/usage-calibrate.ts [--days 6] [--model qwen3.8-flash]
// Checks the tokenizer estimate against the session logs in $GCODE_HOME (~/.g-code), with no model call. Between two
// requests of one session the system prompt and tools stay the same, so the growth in the provider's input count is
// the conversation added between them, which the estimate of the same growth should match.
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { replayMessages, requestRuns, specOf, type TurnEvent } from '@g-code/core';

const { values } = parseArgs({ options: { days: { type: 'string', default: '6' }, model: { type: 'string', default: 'qwen3.8-flash' } } });
const dir = path.join(process.env['GCODE_HOME'] || path.join(homedir(), '.g-code'), 'sessions');
const since = Date.now() - Number(values.days) * 86_400_000;
const pairs: { readonly reported: number; readonly estimated: number }[] = [];
let sessions = 0;

for (const name of await readdir(dir)) {
  const file = path.join(dir, name);
  if ((await stat(file)).mtimeMs < since) continue;
  let events: TurnEvent[];
  try {
    events = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as TurnEvent);
  } catch {
    continue;
  }
  const start = events[0];
  if (start?.kind !== 'session-start' || start.session.model !== values.model || start.session.backend !== undefined) continue;
  sessions++;
  const adapter = specOf(start.session.provider).adapter;
  const points = events.flatMap((e, i) => {
    if (e.kind !== 'assistant' || e.issuedBy !== undefined) return [];
    const reported = e.usage.input + e.usage.cacheRead + e.usage.cacheWrite;
    if (reported === 0) return [];
    const before = events.slice(0, i);
    const runs = requestRuns({ model: values.model!, max_tokens: 1, messages: replayMessages(before) }, before, adapter);
    return [{ reported, estimated: runs.reduce((s, [, n]) => s + n, 0) }];
  });
  for (let k = 1; k < points.length; k++) {
    const reported = points[k]!.reported - points[k - 1]!.reported;
    // Small steps are mostly framing, whose rounding swamps the ratio.
    if (reported > 200) pairs.push({ reported, estimated: points[k]!.estimated - points[k - 1]!.estimated });
  }
}

const reported = pairs.reduce((s, p) => s + p.reported, 0);
const estimated = pairs.reduce((s, p) => s + p.estimated, 0);
const ratios = pairs.map((p) => p.estimated / p.reported).toSorted((a, b) => a - b);
const at = (q: number) => ratios[Math.floor(ratios.length * q)]?.toFixed(3);
console.log(`${sessions} sessions, ${pairs.length} request pairs, ${reported} tokens reported, ${estimated} estimated`);
console.log(`estimate / reported: ${(estimated / reported).toFixed(3)} overall; p10 ${at(0.1)}, median ${at(0.5)}, p90 ${at(0.9)}`);
