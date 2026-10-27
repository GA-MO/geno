// Lists every turn of the user's Geno sessions that ended by handing work back: a question, an offer, or a stop the
// user answered with "go on". One JSON line per such turn, so the stalls can be read and replayed.
// usage: node scripts/harness-parity/mine.mjs [sessionsDir] > stalls.jsonl
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = process.argv[2] ?? path.join(os.homedir(), '.g-code', 'sessions');
export const HANDBACK = /(\?|ไหม|มั้ย|หรือเปล่า|หรือไม่|ต้องการให้|อยากให้|บอกได้|บอกผม|เลือก|shall i|should i|want me to|would you like|let me know|do you want)\s*[)*_`.]*\s*$/i;
const GO_ON = /^(ต่อ|ทำต่อ|ลุย|ได้|เอา|ทำ|ok|go|yes|continue|ตามนั้น|ตามที่แนะนำ|เอาตามที่แนะนำ|ทำเลย|ได้เลย|จัดไป)/i;
const textOf = (e) => (Array.isArray(e.content) ? e.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : String(e.content ?? ''));

for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
  const events = readFileSync(path.join(dir, file), 'utf8').trim().split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const start = events.find((e) => e.kind === 'session-start')?.session;
  if (start === undefined) continue;
  let prompt;
  let last;
  let mode;
  for (const e of events) {
    if (e.kind === 'mode') mode = e.mode;
    if (e.kind === 'assistant' && e.stopReason === 'end_turn') last = e;
    if (e.kind !== 'user') continue;
    const next = textOf(e).trim();
    if (last !== undefined && prompt !== undefined) {
      const final = textOf(last).trim();
      const lastLines = final.split('\n').filter((l) => l.trim() !== '').slice(-3).join('\n');
      const asked = HANDBACK.test(lastLines);
      const goOn = next.length < 40 && GO_ON.test(next);
      if (asked || goOn) console.log(JSON.stringify({ session: start.id, at: last.at, workspace: start.workspace, model: last.model ?? start.model, mode, asked, goOn, prompt: prompt.slice(0, 600), final: final.slice(-700), next: next.slice(0, 300) }));
    }
    prompt = next;
    last = undefined;
  }
}
