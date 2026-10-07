import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A gh call as the fake recorded it: its argv, the names of the variables it saw, and when it ran. */
export type GhCallSeen = { readonly args: readonly string[]; readonly env: readonly string[]; readonly at: number };

export type FakeGhStage = { readonly pr?: object | undefined; readonly checks: readonly object[]; readonly logs?: Readonly<Record<string, string>> | undefined };

export const FAKE_PR = {
  number: 42,
  title: 'Add the cart total',
  url: 'https://github.com/sam/shop/pull/42',
  state: 'OPEN',
  isDraft: false,
  reviewDecision: 'REVIEW_REQUIRED',
  headRefName: 'cart-total',
};

export const fakeCheck = (name: string, bucket: string, job: number) => ({ name, workflow: 'CI', bucket, link: `https://github.com/sam/shop/actions/runs/7/job/${job}` });

/**
 * A `gh` on PATH that answers from `stage.json` beside it, as `gh pr view`, `gh pr checks` (exit 8 while a check is
 * pending, as gh does) and `gh run view --job N --log-failed` do, and logs each call. Anything else exits 2.
 */
export async function fakeGh(first: FakeGhStage) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gcode-fake-gh-'));
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  const stageFile = path.join(dir, 'stage.json');
  const callsFile = path.join(dir, 'calls.jsonl');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args, env: Object.keys(process.env), at: Date.now() }) + '\\n');
const stage = JSON.parse(fs.readFileSync(${JSON.stringify(stageFile)}, 'utf8'));
const is = (...want) => want.length === args.length && want.every((w, i) => w === args[i]);
if (is('pr', 'view', '--json', 'number,title,url,state,isDraft,reviewDecision,headRefName')) {
  if (stage.pr === undefined) { process.stderr.write('no pull requests found for branch "cart-total"\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(stage.pr));
  process.exit(0);
}
if (is('pr', 'checks', '--json', 'name,workflow,bucket,link')) {
  if (stage.checks.length === 0) { process.stderr.write("no checks reported on the 'cart-total' branch\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify(stage.checks));
  process.exit(stage.checks.some((c) => c.bucket === 'pending') ? 8 : stage.checks.some((c) => c.bucket === 'fail') ? 1 : 0);
}
if (args.length === 5 && is('run', 'view', '--job', args[3], '--log-failed') && stage.logs && args[3] in stage.logs) {
  process.stdout.write(stage.logs[args[3]]);
  process.exit(0);
}
process.stderr.write('fake gh: unexpected call ' + JSON.stringify(args) + '\\n');
process.exit(2);
`;
  await writeFile(path.join(bin, 'gh'), script);
  await chmod(path.join(bin, 'gh'), 0o755);
  const stage = (next: FakeGhStage) => writeFile(stageFile, JSON.stringify(next));
  await stage({ pr: FAKE_PR, ...first });
  return {
    bin,
    /** PATH with the fake first. */
    path: `${bin}${path.delimiter}${process.env['PATH'] ?? '/usr/bin:/bin'}`,
    stage: (next: FakeGhStage) => stage({ pr: FAKE_PR, ...next }),
    calls: async (): Promise<GhCallSeen[]> =>
      (await readFile(callsFile, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as GhCallSeen),
  };
}
