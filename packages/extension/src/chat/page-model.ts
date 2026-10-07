import { answerTitle, type PageDiagram, type PagePart } from '@g-code/core/share-page';
import type { ToolBlock, Transcript, Turn } from './messages.js';

/** A diagram the panel drew in an answer, by its source, for the answer's page. */
export type DrawnDiagram = PageDiagram & { readonly source: string };

/** What Save as Page saves: a widget by its tool call, or a turn's answer with the diagrams the panel drew in it. */
export type PageSource = { readonly kind: 'widget'; readonly toolId: string } | { readonly kind: 'answer'; readonly turnId: string; readonly diagrams: readonly DrawnDiagram[] };

export type PageFromView = { readonly type: 'save-page'; readonly page: PageSource };

/** A page before its images are read: its title and its parts. */
export type PageDraft = { readonly title: string; readonly parts: readonly PagePart[] };

/** A turn's answer as page parts: its text and its drawn widgets, in order, without its tool steps. */
export const answerParts = (turn: Turn): PagePart[] =>
  turn.blocks.flatMap((block): PagePart[] => {
    if (block.kind === 'text') return block.text.trim() === '' ? [] : [{ kind: 'markdown', text: block.text }];
    if (block.kind === 'tool' && block.widget?.state === 'ready') return [{ kind: 'widget', title: block.widget.title, html: block.widget.html }];
    return [];
  });

/** Whether the message menu offers Save as Page: the turn ended and its answer shows something. */
export const offersPage = (turn: Turn): boolean => turn.status !== 'streaming' && answerParts(turn).length > 0;

/**
 * The page of a widget, or of an answer: named for what the user asked, then the answer. Undefined when the
 * transcript no longer holds it, or the answer has nothing to show.
 */
export function pageDraft(page: PageSource, transcript: Transcript): PageDraft | undefined {
  if (page.kind === 'widget') {
    const widget = transcript.turns.flatMap((turn) => turn.blocks).find((block): block is ToolBlock => block.kind === 'tool' && block.id === page.toolId)?.widget;
    return widget?.state === 'ready' ? { title: widget.title, parts: [{ kind: 'widget', title: widget.title, html: widget.html }] } : undefined;
  }
  const turn = transcript.turns.find((t) => t.id === page.turnId);
  const answer = turn === undefined ? [] : answerParts(turn);
  if (turn === undefined || answer.length === 0) return undefined;
  const text = answer.flatMap((part) => (part.kind === 'markdown' ? [part.text] : [])).join('\n\n');
  const prompt = turn.wake === undefined ? turn.prompt.trim() : '';
  const title = answerTitle(prompt, text);
  // A one-line request is the page's title already.
  const asked = prompt === '' || prompt === title ? [] : [{ kind: 'request', text: prompt } as const];
  return { title, parts: [...asked, ...answer] };
}
