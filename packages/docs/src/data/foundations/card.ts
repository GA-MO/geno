import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runFiles, type PayloadView } from '../../scenario/payload.js';
import { mockSchema, type PayloadIn } from '../../scenario/schema.js';
import { siteOptions } from '../../scenario/site.js';

type Spec = Omit<PayloadIn, 'kind'>;

interface IndexEntry {
  readonly dir: string;
  readonly engineCommit?: string;
}

const { repoRoot } = siteOptions();
const runs = runFiles(repoRoot);
const commits = new Map(
  (JSON.parse(readFileSync(path.join(repoRoot, 'docs/results/real-usecases/runs/index.json'), 'utf8')) as IndexEntry[]).map((entry) => [entry.dir, entry.engineCommit]),
);

/**
 * A payload card for a foundations page. A requests.jsonl record was rebuilt from the session log when the run was
 * archived, so the caption says so; a session.jsonl record is what Geno logged. A source that does not resolve fails
 * the build, since docs:check reads only scenario pages.
 */
export function card(spec: Spec): PayloadView {
  const mock = mockSchema.parse({ kind: 'payload', ...spec }) as PayloadIn;
  const result = runs.resolve(mock);
  if (!result.ok) throw new Error(`payload ${spec.source}: ${result.reason}`);
  const file = mock.source.split('#')[0]!;
  const dir = /(runs\/[^/]+\/[^/]+)\//.exec(file)?.[1];
  const commit = dir === undefined ? undefined : commits.get(dir);
  const kind = file.endsWith('/requests.jsonl') ? 'request ที่ engine สร้างใหม่จาก session log ตอนเก็บผล' : 'event ใน session log';
  return { ...result.view, caption: `${result.view.caption} · ${kind}${commit === undefined ? '' : ` · engine ${commit}`}` };
}
