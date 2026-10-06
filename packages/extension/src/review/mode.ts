export const REVIEW_MODE_SETTING = 'gcode.review.mode';

/**
 * How the user reviews edits the agent already made. `auto` leaves them on disk with one Undo per turn, as Claude
 * Code does; `review` puts each hunk under Keep and Undo in the editor and the chat.
 */
export const REVIEW_MODES = ['auto', 'review'] as const;

export type ReviewMode = (typeof REVIEW_MODES)[number];

export const DEFAULT_REVIEW_MODE: ReviewMode = 'auto';
