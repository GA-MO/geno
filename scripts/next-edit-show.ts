// Prints the next-edit prompt and target for one replay moment, to read what the model sees.
// Usage: pnpm tsx scripts/next-edit-show.ts <moment-id> [history N]
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { buildNextEditPrompt, editMoments } from '../packages/core/src/tab/index.ts';

const [id, history = '6'] = process.argv.slice(2);
if (id === undefined) throw new Error('usage: next-edit-show.ts <moment-id> [history N]');
const dir = path.join(process.env['GCODE_HOME'] || path.join(homedir(), '.g-code'), 'evals', 'apply');
const tripleId = id.slice(0, id.lastIndexOf('#'));
const triple = JSON.parse(await readFile(path.join(dir, `${tripleId}.json`), 'utf8')) as {
  path: string;
  before: string;
  expected: string;
};
const moment = editMoments({ id: tripleId, path: triple.path, before: triple.before, after: triple.expected }, Number(history)).find(
  (m) => m.id === id,
);
if (moment === undefined) throw new Error(`no moment ${id}`);
const { prompt, inputs } = buildNextEditPrompt(moment.history, { path: moment.path, text: moment.document }, moment.cursor, []);
console.log(prompt);
console.log('\n--- target: replace', JSON.stringify(moment.document.slice(moment.target.start, moment.target.end)), 'with', JSON.stringify(moment.target.text));
console.log('--- region', inputs.region.start, inputs.region.end, 'target', moment.target.start, moment.target.end);
