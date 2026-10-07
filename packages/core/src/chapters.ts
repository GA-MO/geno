import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ApprovalMode } from './approval.js';
import type { Parsed } from './ask-user.js';
import type { TurnEvent } from './session.js';

/**
 * Chapters in long chats (U58): where the work moved to another phase, such as from exploring to building. The agent
 * marks one with `mark_chapter`, whose logged result carries it, so a cut, a fork and a replay treat it as they treat
 * the call. The user marks one at the start of a message, an event of its own, since no tool call makes it.
 * `chaptersOf` folds both into the session's chapters, in transcript order. The webview bundles this file, so it
 * imports only types.
 */
export const MARK_CHAPTER_TOOL = 'mark_chapter';

export const CHAPTER_LIMITS = { title: 40, summary: 200 } as const;

export type ChapterMark = { readonly title: string; readonly summary?: string | undefined };

/**
 * The user marked the message at `turnSeq` as a chapter's start, renamed that chapter, or removed it (`mark: null`).
 * The latest event for a message wins. Like a spin-off decision, it is logged at once with no seq.
 */
export type ChapterEvent = { readonly kind: 'chapter'; readonly seq?: number | undefined; readonly at: string; readonly turnSeq: number; readonly mark: ChapterMark | null };

/** Where a chapter starts: at the agent's mark_chapter call, or at the start of one of the user's messages. */
export type ChapterStart = { readonly kind: 'call'; readonly toolUseId: string } | { readonly kind: 'turn'; readonly turnSeq: number };

export type Chapter = ChapterMark & { readonly start: ChapterStart };

/** Key in the client's capabilities `_meta`: true when it draws chapters. */
export const CHAPTER_CAPABILITY = 'gcode/chapters';
/** Key in a mark_chapter call's tool_call_update `_meta`, and in a replayed turn's: a ChapterMark. */
export const CHAPTER_META = 'gcode/chapter';

/** Extension method, sent by the panel: mark, rename or remove the chapter that starts at the message `turnSeq`. */
export const CHAPTER_MARK_METHOD = '_gcode/chapters/mark';
export type ChapterMarkRequest = { readonly sessionId: string; readonly turnSeq: number; readonly mark: ChapterMark | null };
export type ChapterMarkResponse = { readonly mark: ChapterMark | null };

/** Only a session someone watches shows chapters; a non-interactive run has nobody to navigate it. */
export const CHAPTER_MODES: Readonly<Record<ApprovalMode, boolean>> = { plan: true, ask: true, auto: true, 'non-interactive': false };

export const MARK_CHAPTER_SPEC: Tool = {
  name: MARK_CHAPTER_TOOL,
  description: `Mark the start of a new chapter in this session, where the work moves to a different phase: exploration done and implementation starting, a fix landed and verification starting, or the user changing to an unrelated request. The user sees a thin divider with the title at this point and a table of contents to jump between chapters. It changes no file and needs no approval. Use it sparingly: about 3 to 8 chapters in a long session, never one per tool call or per small step, and not for the first message, since the session's start is implicit. title is a short noun phrase of at most ${CHAPTER_LIMITS.title} characters, such as "Codebase exploration", "Parser fix" or "Test verification". summary is one optional line on what the chapter covers.`,
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: CHAPTER_LIMITS.title, description: 'A short noun phrase, such as "Auth bug fix".' },
      summary: { type: 'string', maxLength: CHAPTER_LIMITS.summary, description: 'One optional line on what the chapter covers.' },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

/**
 * Follows the mode's system prompt in a run that offers mark_chapter; fixed text, so the cached prefix holds. A small
 * model rarely reaches for a tool listed by name only unless the prompt says when.
 */
export const CHAPTER_NOTE = `When a long task moves to a different phase, such as from exploring the code to changing it, or from changing it to verifying it, mark a chapter with ${MARK_CHAPTER_TOOL} so the user can jump between phases. Mark a few per session, not one per step.`;

/** The chapter tool a run offers: none unless the mode allows it and a client draws chapters. */
export const chapterToolDefinitions = (mode: ApprovalMode, attached: boolean): readonly Tool[] => (attached && CHAPTER_MODES[mode] ? [MARK_CHAPTER_SPEC] : []);

const fail = (problem: string): Parsed<never> => ({ ok: false, problem });
const isRecord = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw);

const FIELDS: readonly (keyof ChapterMark)[] = ['title', 'summary'];

/** A mark from the model's input or across a process boundary, or what is wrong with it, in words the model can act on. */
export function parseChapterMark(raw: unknown): Parsed<ChapterMark> {
  if (!isRecord(raw)) return fail(`${MARK_CHAPTER_TOOL} takes an object with a title`);
  const extra = Object.keys(raw).find((key) => !(FIELDS as readonly string[]).includes(key));
  if (extra !== undefined) return fail(`${MARK_CHAPTER_TOOL} has an unknown field "${extra}"`);
  const { title, summary } = raw;
  if (typeof title !== 'string' || title.trim() === '') return fail(`${MARK_CHAPTER_TOOL} needs a title`);
  if (title.trim().length > CHAPTER_LIMITS.title) return fail(`title is ${title.trim().length} characters; keep it to ${CHAPTER_LIMITS.title}, as a short noun phrase`);
  if (summary !== undefined && typeof summary !== 'string') return fail('summary must be text');
  const line = summary?.trim().replace(/\s+/g, ' ');
  if (line !== undefined && line.length > CHAPTER_LIMITS.summary) return fail(`summary is ${line.length} characters; keep it to ${CHAPTER_LIMITS.summary}`);
  return { ok: true, value: { title: title.trim().replace(/\s+/g, ' '), ...(line === undefined || line === '' ? {} : { summary: line }) } };
}

const sameTitle = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The agent's new chapter, or why it is refused: it would repeat the chapter the session is in now. */
export function newChapterOf(mark: ChapterMark, chapters: readonly Chapter[]): Parsed<ChapterMark> {
  const current = chapters.at(-1);
  if (current !== undefined && sameTitle(current.title, mark.title)) return fail(`"${current.title}" is already the current chapter; mark a new one only when the work moves to another phase`);
  return { ok: true, value: mark };
}

export const markedText = (mark: ChapterMark): string =>
  `Chapter "${mark.title}" starts here. The user sees it as a divider and in the chapter list. Go on with the work, and mark the next chapter only when the work moves to another phase.`;

/** A prompt that starts a turn, as `startsTurn` in steer.ts says, without that file's runtime imports. */
const isPromptAt = (event: TurnEvent, turnSeq: number): boolean => event.kind === 'user' && event.steer !== true && event.seq === turnSeq;

/**
 * Every chapter of a session, in transcript order. Pass the session as its cut view shows it: a cut drops the cut
 * turns' calls with their results, and a user's chapter whose message is no longer in the view is left out, though the
 * cut keeps the event.
 */
export function chaptersOf(events: readonly TurnEvent[]): readonly Chapter[] {
  const placed: { readonly at: number; readonly chapter: Chapter }[] = [];
  const marks = new Map<number, ChapterMark | null>();
  events.forEach((event, at) => {
    if (event.kind === 'tool-result' && event.status === 'ok' && event.chapter !== undefined) placed.push({ at, chapter: { ...event.chapter, start: { kind: 'call', toolUseId: event.toolUseId } } });
    if (event.kind === 'chapter') marks.set(event.turnSeq, event.mark);
  });
  for (const [turnSeq, mark] of marks) {
    const at = events.findIndex((event) => isPromptAt(event, turnSeq));
    if (mark !== null && at !== -1) placed.push({ at, chapter: { ...mark, start: { kind: 'turn', turnSeq } } });
  }
  return placed.toSorted((a, b) => a.at - b.at).map(({ chapter }) => chapter);
}

export const userChapterAt = (chapters: readonly Chapter[], turnSeq: number): Chapter | undefined =>
  chapters.find((chapter) => chapter.start.kind === 'turn' && chapter.start.turnSeq === turnSeq);
