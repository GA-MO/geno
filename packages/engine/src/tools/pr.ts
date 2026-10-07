import { z } from 'zod';
import { PR_WATCH_LIMITS, prWatchingText, startPrWatch } from '@g-code/core';
import { lookUpPr, prReport, type Gh, type GithubRemote } from '../gh.js';
import { executor, optional, ToolError, type Executor } from './context.js';
import type { SessionWakes } from './wake.js';

export type PrTools = { readonly gh: Gh; readonly githubRemote: GithubRemote };

export const NO_PR_WAKES =
  "nothing would wake this session: auto-wake is off in the settings, or this run ends when its call does, so watch_pr cannot wait. Tell the user to check the PR's checks, or to run gh pr checks --watch in a terminal.";

/** watch_pr: looks once now, then lets `Wakes` poll until CI settles and wake the session with the report. */
export function watchPrExecutor(wakes: SessionWakes | undefined, pr: PrTools | undefined): Executor {
  return executor({
    input: z.strictObject({ timeout_s: optional(z.number().int().positive().max(PR_WATCH_LIMITS.maxTimeoutS)) }),
    describe: () => 'watch_pr',
    async run({ timeout_s = PR_WATCH_LIMITS.defaultTimeoutS }, ctx) {
      if (wakes === undefined || pr === undefined) throw new ToolError(NO_PR_WAKES);
      const { registry, sessionId, secondMs } = wakes;
      const cwd = ctx.workspace;
      const watch = startPrWatch(await lookUpPr(pr.gh, cwd, pr.githubRemote, ctx.signal));
      if (watch.kind === 'ended') {
        const text = await prReport(pr.gh, cwd, watch.end, ctx.signal);
        if (watch.end.kind === 'settled' || watch.end.kind === 'closed') return `${text}\nNothing was set up to wait for.`;
        throw new ToolError(text);
      }
      const running = registry.prWatchOf(sessionId, watch.pr.number);
      if (running !== undefined) return `PR #${watch.pr.number}'s checks are already watched as ${running}. End your turn: Geno wakes you when they finish.`;
      const id = registry.nextId(sessionId, ctx.events());
      registry.pr(sessionId, {
        id,
        toolUseId: ctx.toolUseId ?? `toolu_gcode_${id}`,
        watch,
        timeoutS: timeout_s,
        secondMs,
        look: (signal) => lookUpPr(pr.gh, cwd, pr.githubRemote, signal),
        report: (end, signal) => prReport(pr.gh, cwd, end, signal),
      });
      return prWatchingText(watch.pr, watch.checks, id, timeout_s);
    },
  });
}
