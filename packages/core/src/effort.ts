import { EFFORTS, IN_CONVERSATION, sessionEffortOf, type Effort, type Session, type ToolResultEvent, type TurnEvent } from './session.js';
import { reportsFailure } from './tools.js';

/**
 * What a model call follows, which is what its effort depends on. Whether a call gives the final answer is known only
 * after it, so that has no kind.
 */
export const TURN_KINDS = ['prompt', 'after-tools', 'after-failure'] as const;
export type TurnKind = (typeof TURN_KINDS)[number];

/** Levels below the session's effort. Never above: the effort the user chose caps what any turn spends. */
export type EffortStep = 0 | -1 | -2;

export type EffortPolicy = Readonly<Record<TurnKind, EffortStep>>;

export const EFFORT_POLICIES = {
  /** Every turn at the session's effort, as before policies existed. */
  flat: { prompt: 0, 'after-tools': 0, 'after-failure': 0 },
  /** One level lower for a follow-up whose tools all succeeded. */
  stepped: { prompt: 0, 'after-tools': -1, 'after-failure': 0 },
} as const satisfies Record<string, EffortPolicy>;

export type EffortPolicyName = keyof typeof EFFORT_POLICIES;
export const isEffortPolicyName = (raw: string): raw is EffortPolicyName => Object.hasOwn(EFFORT_POLICIES, raw);

export const DEFAULT_EFFORT_POLICY: EffortPolicyName = 'flat';

export const effortFor = (base: Effort, step: EffortStep): Effort => EFFORTS[Math.max(0, EFFORTS.indexOf(base) + step)]!;

const failed = (result: ToolResultEvent): boolean =>
  result.status !== 'ok' || ('output' in result ? reportsFailure(result.output) : reportsFailure(result.spill.head) || reportsFailure(result.spill.tail));

/** The kind of the model call the events ask for next. */
export function turnKindOf(events: readonly TurnEvent[]): TurnKind {
  const conversation = events.filter((e) => IN_CONVERSATION[e.kind]);
  const last = conversation.at(-1);
  if (last?.kind === 'assistant') return 'after-tools';
  if (last?.kind !== 'tool-result') return 'prompt';
  const batchStart = conversation.findLastIndex((e) => e.kind !== 'tool-result') + 1;
  const batch = conversation.slice(batchStart) as ToolResultEvent[];
  return batch.some(failed) ? 'after-failure' : 'after-tools';
}

/** The session as the next call sees it: its effort is the one the user chose, moved by the policy's step for the call's kind. */
export const withTurnEffort = (session: Session, events: readonly TurnEvent[], policy: EffortPolicy): Session => ({
  ...session,
  effort: effortFor(sessionEffortOf(session, events), policy[turnKindOf(events)]),
});
