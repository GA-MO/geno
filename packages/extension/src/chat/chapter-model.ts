import { CHAPTER_LIMITS, MARK_CHAPTER_TOOL, type ChapterMark } from '@g-code/core/chapters';
import type { ToolBlock, Transcript } from './messages.js';

/**
 * Chapters in the panel (U58). The agent's chapter lives on its mark_chapter call's step, which draws as a divider;
 * the user's lives on the turn of the message it starts at, drawn above that message. The table of contents is a pure
 * view over both, so a replay and a live session list the same rows. The webview bundles this file, so it imports
 * only types and pure modules.
 */
export type ChapterFromView =
  /** Marks or renames the chapter at the message of `turn`; a null title removes it. */
  { readonly type: 'mark-chapter'; readonly turn: string; readonly title: string | null };

export type ChapterToView = { readonly type: 'chapter-failed'; readonly turn: string; readonly message: string };

/** A mark_chapter call that ran: the panel draws its chapter, not the call. A running or refused one stays a call. */
export type ChapterTool = ToolBlock & { readonly chapter: ChapterMark };
export const isChapterCall = (block: ToolBlock): block is ChapterTool => block.name === MARK_CHAPTER_TOOL && block.chapter !== undefined;

/** The transcript's anchor of a chapter, as its divider's `data-chapter` carries it. */
export const callAnchor = (toolId: string): string => `call:${toolId}`;
export const turnAnchor = (turnId: string): string => `turn:${turnId}`;
/** The top of the chat, the implicit first chapter. */
export const START_ANCHOR = 'start';

export type TocEntry = { readonly anchor: string; readonly title: string; readonly summary: string | undefined; readonly by: 'agent' | 'user' | 'start' };

/**
 * The rows of the table of contents, in transcript order: none for a chat with no chapters, else the chat's start, then
 * each chapter. The start is left out when the user's own chapter already opens the chat.
 */
export function tableOf(transcript: Transcript): TocEntry[] {
  const chapters = transcript.turns.flatMap((turn): TocEntry[] => [
    ...(turn.chapter === undefined ? [] : [{ anchor: turnAnchor(turn.id), title: turn.chapter.title, summary: turn.chapter.summary, by: 'user' as const }]),
    ...turn.blocks.flatMap((block) => (block.kind === 'tool' && isChapterCall(block) ? [{ anchor: callAnchor(block.id), title: block.chapter.title, summary: block.chapter.summary, by: 'agent' as const }] : [])),
  ]);
  if (chapters.length === 0) return [];
  if (transcript.turns[0]?.chapter !== undefined) return chapters;
  return [{ anchor: START_ANCHOR, title: 'Start', summary: undefined, by: 'start' }, ...chapters];
}

/**
 * The row the reader is in. `tops` holds each row's anchor top on screen, `-Infinity` for the start, `undefined` for
 * an anchor not drawn. The current row is the last one whose anchor has passed `line`, the bottom of the stuck request;
 * at the end of the chat, `line` is the transcript's bottom, so a short last chapter still becomes current.
 */
export function currentEntry(tops: readonly (number | undefined)[], line: number): number {
  let current = 0;
  tops.forEach((top, i) => {
    if (top !== undefined && top <= line) current = i;
  });
  return current;
}

/** What the title field starts with: the message's first words, cut at a word to fit a chapter's title. */
export function defaultTitle(prompt: string): string {
  const line = prompt.trim().split('\n')[0]!.replace(/\s+/g, ' ');
  if (line.length <= CHAPTER_LIMITS.title) return line;
  const cut = line.slice(0, CHAPTER_LIMITS.title + 1);
  const space = cut.lastIndexOf(' ');
  return (space > CHAPTER_LIMITS.title / 2 ? cut.slice(0, space) : cut.slice(0, CHAPTER_LIMITS.title)).trimEnd();
}
