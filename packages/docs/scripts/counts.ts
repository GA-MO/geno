import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Choices, Scenario, StepId } from '../src/scenario/model.js';
import { loadSite, siteOptions } from '../src/scenario/site.js';
import { progressAt, walk } from '../src/scenario/tour.js';

/**
 * `pnpm --filter @g-code/docs counts [filter] [--steps]`: the progress counters at the end of every walk of every
 * scenario, one line per walk: page, fork choices, model calls, tool runs. `filter` keeps pages whose href contains it.
 * `--steps` adds the walk with `M:` where a model call begins and `T<n>:` where n tool runs are counted, to check `runs:`.
 */
function* walks(scenario: Scenario, choices: Choices = {}): Generator<{ choices: Choices; path: StepId[] }> {
  const path = walk(scenario, choices);
  const open = path.find((id) => scenario.steps[id]!.flow.kind === 'fork' && choices[id] === undefined);
  if (open === undefined) {
    yield { choices, path };
    return;
  }
  const flow = scenario.steps[open]!.flow;
  if (flow.kind === 'fork') for (const option of flow.options) yield* walks(scenario, { ...choices, [open]: option.id });
}

const verbose = process.argv.includes('--steps');
const filter = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const site = loadSite(siteOptions(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')));
for (const scenario of Object.values(site.scenarios).sort((a, b) => a.href.localeCompare(b.href))) {
  if (filter !== undefined && !scenario.href.includes(filter)) continue;
  for (const { choices, path } of walks(scenario)) {
    const progress = path.map((_, i) => progressAt(scenario, path, i));
    const end = progress.at(-1)!;
    console.log(`${scenario.href.replace('/scenarios/', '')}\t${Object.values(choices).join(',') || '-'}\tmodel ${end.modelCalls}\ttool ${end.toolRuns}`);
    if (!verbose) continue;
    const marks = path.map((id, i) => {
      const calls = progress[i]!.modelCalls - (progress[i - 1]?.modelCalls ?? 0);
      const runs = progress[i]!.toolRuns - (progress[i - 1]?.toolRuns ?? 0);
      const rise = `${calls > 0 ? 'M' : ''}${runs > 0 ? `T${runs}` : ''}`;
      return `${rise === '' ? '' : `${rise}:`}${scenario.steps[id]!.part}[${id}]`;
    });
    console.log(`    ${marks.join(' ')}`);
  }
}
