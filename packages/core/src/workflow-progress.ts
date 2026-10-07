import { formatUsd as usd } from './spend-view.js';

/** What a workflow's run comes to: still running, finished, stopped by a cap, a failure or a gate, or cancelled. */
export type WorkflowStatus = 'running' | 'done' | 'stopped' | 'cancelled';

/** What Tasks shows of a running workflow. `step` is 1-based, over the file's steps. */
export type WorkflowProgress = {
  readonly name: string;
  readonly step: number;
  readonly steps: number;
  readonly running: readonly string[];
  readonly spentUsd: number;
  readonly capUsd: number;
  readonly status: WorkflowStatus;
  /** Why it stopped, in words; absent while it runs or once it finished. */
  readonly stop?: string | undefined;
};

/** One line for a Tasks row: "Step 2 of 4: fix · $0.01 of $0.40". */
export function progressLine(progress: WorkflowProgress): string {
  const money = `${usd(progress.spentUsd)} of ${usd(progress.capUsd)}`;
  if (progress.status === 'done') return `Finished ${progress.steps} ${progress.steps === 1 ? 'step' : 'steps'} · ${money}`;
  if (progress.stop !== undefined) return `Step ${progress.step} of ${progress.steps}: ${progress.stop} · ${money}`;
  const what = progress.running.length === 0 ? '' : `: ${progress.running.join(', ')}`;
  return `Step ${progress.step} of ${progress.steps}${what} · ${money}`;
}
