import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TurnEvent } from '@g-code/core';
import { runAgent } from './agent.js';
import { startSession, totalOf } from './chat.js';
import type { Io } from './command.js';
import type { AgentAdapter } from './eval-run.js';
import { NON_INTERACTIVE } from './tools/agent.js';

export const EVAL_MAX_TURNS = 40;

const finalText = (events: readonly TurnEvent[]): string => {
  const last = events.findLast((e) => e.kind === 'assistant');
  return last?.kind === 'assistant' ? last.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim() : '';
};

/**
 * Our agent, in-process and non-interactive, so a command the deny list flags is refused, not asked about. Its console
 * output goes to a log in the run dir.
 */
export const gcodeAdapter: AgentAdapter = {
  async run(input, { io, store }) {
    const lines: string[] = [];
    let partial = '';
    const quiet: Io = {
      ...io,
      cwd: input.workspace,
      out: (line) => {
        lines.push(partial + line);
        partial = '';
      },
      err: (line) => lines.push(`! ${line}`),
      write: (text) => {
        partial += text;
      },
    };
    const opened = await startSession(store, quiet, { workspace: input.workspace, provider: undefined, model: input.model, effort: undefined });
    const result = await runAgent(quiet, store, opened, input.task.prompt, {
      limits: { maxTurns: EVAL_MAX_TURNS, maxCostUsd: input.maxCostUsd },
      check: input.check,
      checkAfterEdit: input.checkAfterEdit,
      effortPolicy: input.effortPolicy,
      promptTier: input.promptTier,
      agentTool: input.agentTool,
      approval: NON_INTERACTIVE,
    });
    await writeFile(path.join(input.runDir, `${input.task.id}.gcode.log`), [...lines, partial].join('\n'));
    const thisRun = result.events.filter((e) => e.kind !== 'session-start' && e.seq !== undefined && e.seq >= result.run.firstSeq);
    const total = totalOf(thisRun);
    // A subagent's calls and spend are logged in its own session; the parent's log has them on the child's end.
    const children = thisRun.flatMap((e) => (e.kind === 'child-end' ? [e] : []));
    const costUsd = total.costUsd === null || children.some((c) => c.costUsd === null) ? null : children.reduce((n, c) => n + (c.costUsd ?? 0), total.costUsd);
    return {
      stop: result.reason,
      turns: children.reduce((n, c) => n + c.turns, total.turns),
      usage: total.usage,
      costUsd,
      reportedCostUsd: costUsd,
      denials: thisRun.filter((e) => e.kind === 'tool-result' && e.status === 'denied').length,
      finalMessage: finalText(thisRun),
      transcript: opened.log.file,
    };
  },
};
