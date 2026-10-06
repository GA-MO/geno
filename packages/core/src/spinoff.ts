import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ApprovalMode } from './approval.js';
import type { Parsed } from './ask-user.js';
import type { TurnEvent } from './session.js';
import type { Brand } from './types.js';

/**
 * Spin-off tasks: while it works, the agent suggests a separate task for an issue outside the current change. Geno
 * starts nothing; the panel shows a card, and the user starts the task in its own lane or dismisses it. The offer and
 * the agent's withdrawal ride on tool results, the user's decisions are events of their own, and `spinoffsOf` folds
 * both into each suggestion's state. The webview bundles this file, so it imports only types.
 */
export const SPAWN_TASK_TOOL = 'spawn_task';
export const DISMISS_TASK_TOOL = 'dismiss_task';
export const SPINOFF_TOOLS = [SPAWN_TASK_TOOL, DISMISS_TASK_TOOL] as const;

/** Short enough for a model to copy back: `task_` and 8 hex digits. */
export type SpinoffId = Brand<string, 'SpinoffId'>;

export type SpinoffOffer = { readonly id: SpinoffId; readonly title: string; readonly tldr: string; readonly prompt: string };

export type SpinoffState =
  | { readonly kind: 'offered' }
  /** The user started it: a new session in its own lane. */
  | { readonly kind: 'started'; readonly sessionId: string; readonly lane: string }
  | { readonly kind: 'dismissed' }
  /** The agent took it back, such as after fixing the issue itself. */
  | { readonly kind: 'withdrawn' };

/** One suggestion and where it stands. `toolUseId` is the spawn_task call that offered it, whose step shows the card. */
export type Spinoff = SpinoffOffer & { readonly toolUseId: string; readonly state: SpinoffState };

/** What a spawn_task or dismiss_task result carries in the session log. */
export type SpinoffNote = { readonly kind: 'offered'; readonly offer: SpinoffOffer } | { readonly kind: 'withdrawn'; readonly id: SpinoffId };

/** What the user decided about a suggestion, logged as its own event. */
export type SpinoffDecision = { readonly kind: 'started'; readonly sessionId: string; readonly lane: string } | { readonly kind: 'dismissed' };

/** Like a mode switch, a decision made while a turn runs is logged beside it with no seq. */
export type SpinoffEvent = { readonly kind: 'spinoff'; readonly seq?: number | undefined; readonly at: string; readonly id: SpinoffId; readonly decision: SpinoffDecision };

/** Any move after the offer: the agent's withdrawal or the user's decision. Each is allowed only from `offered`. */
export type SpinoffMove = Extract<SpinoffNote, { kind: 'withdrawn' }> | SpinoffDecision;

export const SPINOFF_LIMITS = { title: 60, tldr: 400, prompt: 8000, open: 10 } as const;

/** Key in the client's capabilities `_meta`: true when it shows suggestions and can start them. */
export const SPINOFF_CAPABILITY = 'gcode/spinoffs';
/** Key in a tool_call_update's `_meta`: a SpinoffShown. */
export const SPINOFF_META = 'gcode/spinoff';

/**
 * What the panel is told about a suggestion: the whole of it from the call that offered it, or a move by id from
 * anywhere else, such as a dismiss_task call or the user's Start. The panel keeps the card on the offering call's step.
 */
export type SpinoffShown = { readonly kind: 'offer'; readonly spinoff: Spinoff } | { readonly kind: 'move'; readonly id: SpinoffId; readonly state: SpinoffState };
/** Extension methods, sent by the panel: start a suggestion as a lane task, or dismiss it. Each answers with the Spinoff. */
export const SPINOFF_START_METHOD = '_gcode/spinoffs/start';
export const SPINOFF_DISMISS_METHOD = '_gcode/spinoffs/dismiss';
export type SpinoffRequest = { readonly sessionId: string; readonly id: string; readonly mode?: string | undefined };
export type SpinoffResponse = { readonly spinoff: Spinoff };

/** Only a session someone watches can show a card; a non-interactive run has nobody to start one. */
export const SPINOFF_MODES: Readonly<Record<ApprovalMode, boolean>> = { plan: true, ask: true, auto: true, 'non-interactive': false };

export const SPINOFF_SPECS: Readonly<Record<(typeof SPINOFF_TOOLS)[number], Tool>> = {
  [DISMISS_TASK_TOOL]: {
    name: DISMISS_TASK_TOOL,
    description:
      'Withdraw a task you suggested with spawn_task, by its task_id, once it is no longer worth doing: you fixed the issue yourself in this session, it turned out wrong, or a newer suggestion replaces it. A task the user already started or dismissed stays as it is.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'The id spawn_task returned, such as task_1a2b3c4d.' } },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  [SPAWN_TASK_TOOL]: {
    name: SPAWN_TASK_TOOL,
    description: `Suggest a separate task for an issue you noticed that is outside the current change. The user sees it as a card and can start it in its own lane with one click; nothing runs until they do, so it needs no approval and you keep working on the current task. Use it when you notice, while working, something worth fixing that the user did not ask for: dead code, stale docs, a missing test, a TODO you confirmed, or a security issue you saw in passing. Do not use it for a vague code-smell impression or a guess you have not checked, and do not use it for something small enough to fix as part of the current change. title is an imperative phrase under ${SPINOFF_LIMITS.title} characters, such as "Remove the unused formatDate helper". tldr is one or two plain sentences on what you noticed and why it is worth doing now. prompt is the first message of the new task, which does not see this conversation: make it self-contained, with the file paths, what is wrong, and how to check the fix. Returns the task_id, which dismiss_task takes.`,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: SPINOFF_LIMITS.title, description: 'An imperative phrase, such as "Delete the stale setup section of README.md".' },
        tldr: { type: 'string', description: 'One or two plain sentences: what you noticed and why it is worth doing now.' },
        prompt: { type: 'string', description: 'The new task\'s first message: self-contained, with file paths, the problem and how to check the fix.' },
      },
      required: ['title', 'tldr', 'prompt'],
      additionalProperties: false,
    },
  },
};

/** The spin-off tools a run offers: none unless the mode allows them and a client shows the cards. Sorted, for a stable prefix. */
export const spinoffToolDefinitions = (mode: ApprovalMode, attached: boolean): readonly Tool[] =>
  attached && SPINOFF_MODES[mode] ? [SPINOFF_SPECS[DISMISS_TASK_TOOL], SPINOFF_SPECS[SPAWN_TASK_TOOL]] : [];

const fail = (problem: string): Parsed<never> => ({ ok: false, problem });
const isRecord = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw);

const extraField = (raw: Record<string, unknown>, fields: readonly string[]): string | undefined => Object.keys(raw).find((key) => !fields.includes(key));

export type SpawnTaskInput = { readonly title: string; readonly tldr: string; readonly prompt: string };

const SPAWN_FIELDS: readonly (keyof SpawnTaskInput)[] = ['title', 'tldr', 'prompt'];

/** The model's spawn_task input, or what is wrong with it, in words the model can act on. */
export function parseSpawnTask(raw: unknown): Parsed<SpawnTaskInput> {
  if (!isRecord(raw)) return fail(`${SPAWN_TASK_TOOL} takes an object with title, tldr and prompt`);
  const extra = extraField(raw, SPAWN_FIELDS);
  if (extra !== undefined) return fail(`${SPAWN_TASK_TOOL} has an unknown field "${extra}"`);
  const input: Record<string, string> = {};
  for (const field of SPAWN_FIELDS) {
    const value = raw[field];
    if (typeof value !== 'string' || value.trim() === '') return fail(`${SPAWN_TASK_TOOL} needs ${field}`);
    const limit = SPINOFF_LIMITS[field];
    if (value.trim().length > limit) return fail(`${field} is ${value.trim().length} characters; keep it to ${limit}`);
    input[field] = value.trim();
  }
  return { ok: true, value: input as SpawnTaskInput };
}

/** The model's dismiss_task input: the id it was given. */
export function parseDismissTask(raw: unknown): Parsed<SpinoffId> {
  if (!isRecord(raw) || typeof raw['task_id'] !== 'string' || raw['task_id'].trim() === '') return fail(`${DISMISS_TASK_TOOL} takes an object with the task_id spawn_task returned`);
  const extra = extraField(raw, ['task_id']);
  if (extra !== undefined) return fail(`${DISMISS_TASK_TOOL} has an unknown field "${extra}"`);
  return { ok: true, value: raw['task_id'].trim() as SpinoffId };
}

/** FNV-1a over the text, as 8 hex digits: the same call always gets the same id, live and in a replay. */
function hash8(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The id of the suggestion a call offers, unique among the session's suggestions. */
export function spinoffIdOf(toolUseId: string, taken: readonly Spinoff[]): SpinoffId {
  const used = new Set<string>(taken.map((spinoff) => spinoff.id));
  for (let salt = 0; ; salt++) {
    const id = `task_${hash8(salt === 0 ? toolUseId : `${toolUseId}#${salt}`)}`;
    if (!used.has(id)) return id as SpinoffId;
  }
}

export const isOpen = (spinoff: Spinoff): boolean => spinoff.state.kind === 'offered';

const sameTitle = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A new suggestion from a spawn_task call, or why it is refused: a duplicate of an open one, or too many open. */
export function offerOf(input: SpawnTaskInput, toolUseId: string, spinoffs: readonly Spinoff[]): Parsed<SpinoffOffer> {
  const open = spinoffs.filter(isOpen);
  const twin = open.find((spinoff) => sameTitle(spinoff.title, input.title));
  if (twin !== undefined) return fail(`${twin.id} already suggests "${twin.title}"; it is still open, so there is nothing to add`);
  if (open.length >= SPINOFF_LIMITS.open) return fail(`${open.length} suggestions are open; withdraw stale ones with ${DISMISS_TASK_TOOL} before suggesting more`);
  return { ok: true, value: { id: spinoffIdOf(toolUseId, spinoffs), ...input } };
}

/** Why a suggestion that is no longer open takes no more moves. */
const SETTLED: { readonly [K in Exclude<SpinoffState['kind'], 'offered'>]: (state: Extract<SpinoffState, { kind: K }>) => string } = {
  started: ({ lane }) => `the user already started it as a task in lane ${lane}`,
  dismissed: () => 'the user already dismissed it',
  withdrawn: () => 'it was already withdrawn',
};

const settledWhy = (state: SpinoffState): string | undefined =>
  state.kind === 'offered' ? undefined : (SETTLED[state.kind] as (state: SpinoffState) => string)(state);

const STATE_OF: { readonly [K in SpinoffMove['kind']]: (move: Extract<SpinoffMove, { kind: K }>) => SpinoffState } = {
  started: ({ sessionId, lane }) => ({ kind: 'started', sessionId, lane }),
  dismissed: () => ({ kind: 'dismissed' }),
  withdrawn: () => ({ kind: 'withdrawn' }),
};

/** The suggestion after one move. Every move leaves `offered` for good, so any second move is refused with the reason. */
export function moveSpinoff(spinoff: Spinoff, move: SpinoffMove): Parsed<Spinoff> {
  const why = settledWhy(spinoff.state);
  if (why !== undefined) return fail(`${spinoff.id} cannot change: ${why}`);
  return { ok: true, value: { ...spinoff, state: (STATE_OF[move.kind] as (move: SpinoffMove) => SpinoffState)(move) } };
}

/** The open suggestion `id` names among `spinoffs`, or why there is none: no such id, or it is settled. */
export function openSpinoffNamed(spinoffs: readonly Spinoff[], id: string): Parsed<Spinoff> {
  const found = spinoffs.find((spinoff) => spinoff.id === id);
  if (found === undefined) return fail(spinoffs.length === 0 ? `no task ${id}; nothing was suggested in this session` : `no task ${id}; the suggested ones are ${spinoffs.map((s) => s.id).join(', ')}`);
  const why = settledWhy(found.state);
  return why === undefined ? { ok: true, value: found } : fail(`${found.id} cannot change: ${why}`);
}

/** The move an event makes, if any: an offer, the agent's withdrawal, or the user's decision. A refused call moves nothing. */
function moveOf(event: TurnEvent): { readonly offer: Spinoff } | { readonly id: string; readonly move: SpinoffMove } | undefined {
  if (event.kind === 'spinoff') return { id: event.id, move: event.decision };
  if (event.kind !== 'tool-result' || event.status !== 'ok' || event.spinoff === undefined) return undefined;
  const note = event.spinoff;
  return note.kind === 'offered' ? { offer: { ...note.offer, toolUseId: event.toolUseId, state: { kind: 'offered' } } } : { id: note.id, move: note };
}

/** The list after one more event; a move that names no suggestion, or one already settled, changes nothing. */
export function reduceSpinoffs(spinoffs: readonly Spinoff[], event: TurnEvent): readonly Spinoff[] {
  const moved = moveOf(event);
  if (moved === undefined) return spinoffs;
  if ('offer' in moved) return [...spinoffs, moved.offer];
  const at = spinoffs.findIndex((spinoff) => spinoff.id === moved.id);
  if (at === -1) return spinoffs;
  const next = moveSpinoff(spinoffs[at]!, moved.move);
  return next.ok ? spinoffs.with(at, next.value) : spinoffs;
}

/** Every suggestion of a session, in the order offered. Pass the session as its cut view shows it. */
export const spinoffsOf = (events: readonly TurnEvent[]): readonly Spinoff[] => events.reduce(reduceSpinoffs, []);

export const offeredText = (offer: SpinoffOffer): string =>
  `Suggested ${offer.id} "${offer.title}". The user sees it as a card and can start it in its own lane; nothing was started. Go on with the current task. If it stops being worth doing, withdraw it with ${DISMISS_TASK_TOOL}.`;

export const withdrawnText = (spinoff: Spinoff): string => `Withdrew ${spinoff.id} "${spinoff.title}"; its card is gone.`;

const STATE_KINDS: readonly SpinoffState['kind'][] = ['offered', 'started', 'dismissed', 'withdrawn'];

function parseState(raw: unknown): SpinoffState | undefined {
  if (!isRecord(raw) || !STATE_KINDS.includes(raw['kind'] as SpinoffState['kind'])) return undefined;
  if (raw['kind'] !== 'started') return { kind: raw['kind'] as Exclude<SpinoffState['kind'], 'started'> };
  return typeof raw['sessionId'] === 'string' && typeof raw['lane'] === 'string' ? { kind: 'started', sessionId: raw['sessionId'], lane: raw['lane'] } : undefined;
}

/**
 * What a logged spawn_task or dismiss_task result tells the panel. `now` is the session's suggestions as they stand,
 * which a replay passes so the card shows where it ended; live, an offer is still open.
 */
export function spinoffShownOf(toolUseId: string, note: SpinoffNote, now: readonly Spinoff[] = []): SpinoffShown {
  if (note.kind === 'withdrawn') return { kind: 'move', id: note.id, state: { kind: 'withdrawn' } };
  return { kind: 'offer', spinoff: now.find((spinoff) => spinoff.id === note.offer.id) ?? { ...note.offer, toolUseId, state: { kind: 'offered' } } };
}

/** A SpinoffShown from a tool update's `_meta`, checked, since it crossed the process boundary. */
export function parseSpinoffShown(raw: unknown): SpinoffShown | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw['kind'] === 'offer') {
    const spinoff = parseSpinoff(raw['spinoff']);
    return spinoff === undefined ? undefined : { kind: 'offer', spinoff };
  }
  const state = parseState(raw['state']);
  return raw['kind'] === 'move' && typeof raw['id'] === 'string' && state !== undefined ? { kind: 'move', id: raw['id'] as SpinoffId, state } : undefined;
}

/** A Spinoff that crossed a process boundary, such as in a request's answer, checked field by field. */
export function parseSpinoff(raw: unknown): Spinoff | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, title, tldr, prompt, toolUseId } = raw;
  const state = parseState(raw['state']);
  if (typeof id !== 'string' || typeof title !== 'string' || typeof tldr !== 'string' || typeof prompt !== 'string' || typeof toolUseId !== 'string' || state === undefined) return undefined;
  return { id: id as SpinoffId, title, tldr, prompt, toolUseId, state };
}
