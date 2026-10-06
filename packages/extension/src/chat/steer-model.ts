import type { OutgoingAttachment } from './attachment-model.js';
import type { SteerBlock, Turn, TurnStatus } from './messages.js';

/**
 * Steering a running session (U44): a message that lands at the session's next tool round instead of waiting for
 * its turn to end. The webview bundles this file, so it imports only types.
 */

/** What a steer chunk shows: the user's own words, a message the parent agent sent its child, or a background child reporting back. */
export type SteerShown =
  | { readonly from: 'user'; readonly text: string }
  | { readonly from: 'parent'; readonly text: string }
  | { readonly from: 'child'; readonly agent: string | undefined };

/** Which running session a steer goes to: the shown chat's turn, one of its subagents, or a task in the Tasks pane. */
export type SteerTarget = { readonly kind: 'chat' } | { readonly kind: 'child'; readonly id: string } | { readonly kind: 'task'; readonly sessionId: string };

/** How a steer went: logged in the running turn, run as the next turn because the turn ended first, or refused. */
export type SteerResult = { readonly kind: 'delivered' } | { readonly kind: 'next-turn' } | { readonly kind: 'failed'; readonly message: string };

export type SteerFromView = { readonly type: 'steer'; readonly target: SteerTarget; readonly text: string };
export type SteerToView = { readonly type: 'steered'; readonly target: SteerTarget; readonly result: SteerResult };

/** One key per target, so a result finds the field that sent it. */
export const targetKey = (target: SteerTarget): string => (target.kind === 'chat' ? 'chat' : target.kind === 'child' ? `child:${target.id}` : `task:${target.sessionId}`);

/** A steer as its block, once per seq: a replayed one that live updates repeat stays one. */
export function withSteer(turn: Turn, seq: number, shown: SteerShown): Turn {
  const id = `steer:${seq}`;
  if (turn.blocks.some((block) => block.id === id)) return turn;
  const block: SteerBlock = { kind: 'steer', id, seq, shown };
  return { ...turn, notice: undefined, blocks: [...turn.blocks, block] };
}

/** How each kind of steer reads where it landed: a bubble marked as sent mid-turn, a labelled message, or a muted note. */
export type SteerLook = { readonly kind: 'bubble' | 'message' | 'note'; readonly label: string; readonly text: string | undefined };

const LOOKS: { readonly [K in SteerShown['from']]: (shown: Extract<SteerShown, { from: K }>) => SteerLook } = {
  user: ({ text }) => ({ kind: 'bubble', label: 'Sent mid-turn', text }),
  parent: ({ text }) => ({ kind: 'message', label: 'Message from the parent agent', text }),
  child: ({ agent }) => ({ kind: 'note', label: `${agent ?? 'A subagent'} reported back`, text: undefined }),
};

export const steerLook = (shown: SteerShown): SteerLook => (LOOKS[shown.from] as (s: SteerShown) => SteerLook)(shown);

/**
 * The composer's one follow-up while a turn runs: queued, it goes when the turn finishes; steering, it was sent to
 * land at the next tool round, and the host settles it.
 */
export type Followup = { readonly text: string; readonly attachments: readonly OutgoingAttachment[]; readonly state: 'queued' | 'steering' };

/** What the composer does with a follow-up when its turn ends: send it as the next turn, give it back to the draft, or leave it to the host. */
export type FollowupEffect = 'send' | 'restore' | 'none';

export function followupAtTurnEnd(followup: Followup | undefined, ended: Exclude<TurnStatus, 'streaming'>): { readonly next: Followup | undefined; readonly effect: FollowupEffect } {
  if (followup === undefined) return { next: undefined, effect: 'none' };
  // The engine runs a steer the turn did not take as the next turn, and the host shows it; sending it again would run it twice.
  if (followup.state === 'steering') return { next: followup, effect: 'none' };
  return { next: undefined, effect: ended === 'done' ? 'send' : 'restore' };
}

/** A refused steer goes back to the queue while the turn runs, and back to the draft once it does not. */
export function followupSteered(followup: Followup | undefined, result: SteerResult, running: boolean): { readonly next: Followup | undefined; readonly effect: FollowupEffect } {
  if (followup?.state !== 'steering') return { next: followup, effect: 'none' };
  if (result.kind !== 'failed') return { next: undefined, effect: 'none' };
  return running ? { next: { ...followup, state: 'queued' }, effect: 'none' } : { next: undefined, effect: 'restore' };
}

/** What the draft holds besides its text: attachments and `@` mentions, which only a new turn can carry. */
export type Draft = { readonly text: string; readonly extras: number };

/** The Send now control: absent, ready to steer the queued follow-up or the draft, or held back with the reason. */
export type SendNow = { readonly kind: 'hidden' } | { readonly kind: 'ready'; readonly steers: 'queued' | 'draft' } | { readonly kind: 'blocked'; readonly reason: string };

const EXTRAS_WAIT = 'Attachments and @ mentions go with the next turn, so this one waits in the queue';

export function sendNowOf(running: boolean, followup: Followup | undefined, draft: Draft): SendNow {
  if (!running || followup?.state === 'steering') return { kind: 'hidden' };
  if (followup !== undefined) return followup.attachments.length > 0 || followup.text === '' ? { kind: 'blocked', reason: EXTRAS_WAIT } : { kind: 'ready', steers: 'queued' };
  if (draft.text === '' && draft.extras === 0) return { kind: 'hidden' };
  return draft.extras > 0 || draft.text === '' ? { kind: 'blocked', reason: EXTRAS_WAIT } : { kind: 'ready', steers: 'draft' };
}

export type PillState = { readonly state: Followup['state']; readonly label: string; readonly title: string };

const PILLS: Readonly<Record<Followup['state'], Omit<PillState, 'state'>>> = {
  queued: { label: 'Queued', title: 'Sends when the turn finishes' },
  steering: { label: 'Sending now', title: 'Lands at the next tool round, between the step running now and the model’s next answer' },
};

export const pillOf = (followup: Followup | undefined): PillState | undefined => (followup === undefined ? undefined : { state: followup.state, ...PILLS[followup.state] });

/** What a side view or Tasks field says while its steer is out, and once it settled. */
export type FieldStatus = { readonly tone: 'busy' | 'ok' | 'failed'; readonly text: string };

const FINISHED = /already finished|^no session /i;

export function fieldStatus(result: SteerResult | 'sending', who: string): FieldStatus {
  if (result === 'sending') return { tone: 'busy', text: 'Sending… it lands at the next tool round' };
  if (result.kind === 'delivered') return { tone: 'ok', text: 'Delivered at its next tool round' };
  if (result.kind === 'next-turn') return { tone: 'ok', text: 'Its turn had ended, so it runs as the next turn' };
  const message = result.message.replace(/^Invalid (?:request|params): /, '');
  return { tone: 'failed', text: FINISHED.test(message) ? `${who} already finished` : message };
}
