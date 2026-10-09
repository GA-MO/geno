import type { Transcript } from './messages.js';

/** The files show_files calls in the transcript showed, which the panel may open though they are outside the workspace. */
export const shownPaths = (transcript: Transcript): string[] =>
  transcript.turns.flatMap((turn) => turn.blocks.flatMap((block) => (block.kind === 'tool' ? (block.shown?.files ?? []).flatMap((entry) => (entry.kind === 'shown' ? [entry.path] : [])) : [])));
