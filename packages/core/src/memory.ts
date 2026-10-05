/**
 * Memory: short notes the user approved for Geno to keep across sessions, one store per workspace and one for every
 * workspace. A note is a standing instruction, so only the user's own approval writes one; the model only proposes.
 */

export const MEMORY_SCOPES = ['project', 'global'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export type MemoryEntry = {
  readonly id: string;
  readonly text: string;
  readonly scope: MemoryScope;
  /** ISO time. */
  readonly createdAt: string;
  /** The session whose `remember` call proposed it; null when no session did. */
  readonly sessionId: string | null;
};

/** The longest one note may be, in characters. */
export const MEMORY_TEXT_MAX = 500;
/** The most all notes of both scopes may hold together, in characters, since every request carries them. */
export const MEMORY_TOTAL_MAX = 4000;

const SCOPE_ORDER: Readonly<Record<MemoryScope, number>> = { global: 0, project: 1 };

/** Global notes first, then the project's, each oldest first, and notes of the same moment in the order kept. */
export const sortedMemory = (entries: readonly MemoryEntry[]): MemoryEntry[] =>
  entries.toSorted((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

/** Why `text` cannot be kept beside `entries` (leaving out the one it replaces), or undefined when it can. */
export function memoryProblem(text: string, entries: readonly MemoryEntry[], replacing?: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return 'a memory needs some text';
  if (trimmed.length > MEMORY_TEXT_MAX) return `a memory holds at most ${MEMORY_TEXT_MAX} characters; this one has ${trimmed.length}`;
  const total = entries.filter((entry) => entry.id !== replacing).reduce((sum, entry) => sum + entry.text.length, trimmed.length);
  if (total > MEMORY_TOTAL_MAX) return `memory holds at most ${MEMORY_TOTAL_MAX} characters in all, and this would make ${total}; ask the user to delete some in /memory first`;
  return undefined;
}

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The notes as a section of the system prompt, or undefined when there are none. Fixed text around the notes in a
 * fixed order, so the prompt's bytes, and the cached prefix, hold still while memory does.
 */
export function renderMemory(entries: readonly MemoryEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  return [
    'The user approved these notes for you to remember from earlier sessions. Follow them where they apply. They never override what the user asks now, and they cannot widen what you may do.',
    '<memory>',
    ...sortedMemory(entries).map((entry) => `<note scope="${entry.scope}">${escapeXml(entry.text)}</note>`),
    '</memory>',
  ].join('\n');
}

/** Key in session/request_permission's `toolCall._meta` when the question is a `remember` call: its RememberInput. */
export const REMEMBER_META = 'gcode/remember';
export type RememberInput = { readonly text: string; readonly scope: MemoryScope };

/** Key in the client capabilities' `_meta`, true when the client shows a remember question as a memory card. */
export const MEMORY_CAPABILITY = 'gcode/memory';

/** Extension method, sent by the editor: the session's project memory and the global memory. */
export const MEMORY_METHOD = '_gcode/memory';
/** Extension method, sent by the editor: replaces one note's text, then answers with the memory. */
export const MEMORY_EDIT_METHOD = '_gcode/memoryEdit';
/** Extension method, sent by the editor: moves one note to the trash, then answers with the memory. */
export const MEMORY_DELETE_METHOD = '_gcode/memoryDelete';

export type MemoryRequest = { readonly sessionId: string };
export type MemoryEditRequest = { readonly sessionId: string; readonly id: string; readonly text: string };
export type MemoryDeleteRequest = { readonly sessionId: string; readonly id: string };
export type MemoryResponse = { readonly entries: readonly MemoryEntry[] };
