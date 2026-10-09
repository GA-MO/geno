// Prints a case's terminal transcript, without blank lines, for reading a run by eye.
// usage: node scripts/real-usecases/show.mjs <case-prefix> [run] [max-lines]
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SCRATCH } from './env.mjs';

const [prefix, run = '1', max = '60'] = process.argv.slice(2);
const dir = path.join(SCRATCH, 'out');
const name = readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(`-r${run}.txt`));
if (name === undefined) throw new Error(`no transcript for ${prefix} run ${run}`);
const lines = readFileSync(path.join(dir, name), 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('$ gcode'));
console.log(`=== ${name}`);
console.log(lines.slice(0, Number(max)).map((l) => l.slice(0, 260)).join('\n'));
