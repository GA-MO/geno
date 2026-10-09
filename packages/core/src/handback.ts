import type { Tool, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { GENO_NOTE } from './fence.js';
import type { TurnEvent } from './session.js';

/**
 * How a subagent hands its report back, after Claude Code's SubagentHandback: a child-only tool whose call ends the
 * child's run. Only its message is the report, so the narration a model writes between calls stays out of it.
 */

export const REPORT_TOOL = 'report';
/** A workflow schema step's forced last call, after its report, whose input is the step's fields (`workflow.ts`). */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output';

export const REPORT_TOOL_DEFINITION: Tool = {
  name: REPORT_TOOL,
  description:
    'Deliver your final report to the agent that started you. Call it once, when your work is done: the call ends your run, so do everything else first and put everything that agent needs in this one report. It is not a messaging channel: do not use it for progress updates or questions.\n\nOnly the message you pass to report reaches that agent; text you write outside it is not delivered.',
  input_schema: {
    type: 'object',
    properties: { message: { type: 'string', description: 'Your full report for the agent that started you.' } },
    required: ['message'],
    additionalProperties: false,
  },
};

/**
 * A nudge as the log records it; the request renders its text, so the log holds no copy of it. `empty` is the one a
 * run gets when its model ended a turn with no text and no tool call; without it, a child was nudged to report.
 */
export type ReportNudgeEvent = { readonly kind: 'report-nudge'; readonly seq: number; readonly at: string; readonly empty?: true | undefined };

export const REPORT_DELIVERED = 'Report delivered to the agent that started you.';

/** The one nudge a child gets when it ends its turn without calling report, worded after Claude Code's `[handback-send-enforce]`. */
export const REPORT_NUDGE = `${GENO_NOTE} Your report has not been delivered. Call ${REPORT_TOOL}({message: <your full report>}) now; the call ends your run.`;

/** The one nudge after a turn that ended with nothing the user can see, such as thinking alone. */
export const EMPTY_TURN_NUDGE = `${GENO_NOTE} Your last response ended with no text and no tool call, so the user saw nothing and the task is not done. Continue from where you stopped: make the tool call you planned, or write your answer.`;

export const nudgeText = (event: ReportNudgeEvent): string => (event.empty === true ? EMPTY_TURN_NUDGE : REPORT_NUDGE);

/** A report call's message, which the user sees as the child's text; undefined for any other call. */
export function reportMessageOf(use: Pick<ToolUseBlock, 'name' | 'input'>): string | undefined {
  const message = use.name === REPORT_TOOL ? (use.input as { readonly message?: unknown } | null)?.message : undefined;
  return typeof message === 'string' ? message : undefined;
}

/** The message of the newest report call in `events` that went through. */
export function reportedMessage(events: readonly TurnEvent[]): string | undefined {
  const delivered = events.findLast((e) => e.kind === 'tool-result' && e.name === REPORT_TOOL && e.status === 'ok');
  if (delivered?.kind !== 'tool-result') return undefined;
  for (const event of events) {
    if (event.kind !== 'assistant') continue;
    const use = event.content.find((block) => block.type === 'tool_use' && block.id === delivered.toolUseId);
    if (use?.type === 'tool_use') return reportMessageOf(use);
  }
  return undefined;
}

const textsOf = (events: readonly TurnEvent[]): string[] =>
  events.flatMap((e) => (e.kind === 'assistant' ? e.content.flatMap((block) => (block.type === 'text' && block.text.trim() !== '' ? [block.text.trim()] : [])) : []));

/**
 * What a child's run hands back: its report call's message; else, when it finished, its last text; else, when a cap,
 * a failure or a cancel stopped it first, every text it wrote, since its findings may sit in any of them.
 */
export function handedBack(events: readonly TurnEvent[], partial: boolean): string {
  const reported = reportedMessage(events);
  if (reported !== undefined) return reported.trim();
  const texts = textsOf(events);
  return partial ? texts.join('\n\n') : (texts.at(-1) ?? '');
}
