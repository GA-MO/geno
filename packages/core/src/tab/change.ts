import type { OutcomeKind } from './completion.js';

/** A completion on screen: the text still ahead of the cursor, starting at `offset`. */
export type ShownCompletion = { readonly offset: number; readonly text: string };

export type DocumentEdit = { readonly offset: number; readonly removed: number; readonly inserted: string };

export type ChangeVerdict =
  | { readonly kind: 'pending'; readonly shown: ShownCompletion }
  | { readonly kind: 'settled'; readonly outcome: Extract<OutcomeKind, 'partial' | 'rejected' | 'typed-over'> }
  /** The whole text went in; the accept command, not the edit, records the outcome. */
  | { readonly kind: 'inserted' };

/**
 * How the next edit after a shown completion settles it. The stable API reports neither partial accepts nor
 * dismissals, so they are inferred: one typed character that matches keeps the completion alive, a longer
 * matching insert is a word or line accept, a mismatching insert is typing over it, and anything else rejects it.
 */
export function classifyEdit(shown: ShownCompletion, edit: DocumentEdit): ChangeVerdict {
  if (edit.offset !== shown.offset || edit.removed !== 0 || edit.inserted === '') {
    return { kind: 'settled', outcome: 'rejected' };
  }
  if (edit.inserted === shown.text) return { kind: 'inserted' };
  if (!shown.text.startsWith(edit.inserted)) return { kind: 'settled', outcome: 'typed-over' };
  if (edit.inserted.length > 1) return { kind: 'settled', outcome: 'partial' };
  return {
    kind: 'pending',
    shown: { offset: shown.offset + edit.inserted.length, text: shown.text.slice(edit.inserted.length) },
  };
}
