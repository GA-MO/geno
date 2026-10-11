/** Kept apart from map.ts so the island draws hops without bundling elkjs. */

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * The curve for a hop: side to side between columns, out and back on the right within one lane. A hop and its
 * reverse leave from slightly different heights so both stay visible.
 */
export function hopPath(from: Box, to: Box): string {
  const rightward = to.x > from.x;
  const nudge = rightward ? -4 : 4;
  const y1 = from.y + from.h / 2 + nudge;
  const y2 = to.y + to.h / 2 + nudge;
  if (from.x === to.x) {
    const x = from.x + from.w;
    const bulge = 24 + Math.abs(y2 - y1) / 6;
    return `M${x},${y1} C${x + bulge},${y1} ${x + bulge},${y2} ${x},${y2}`;
  }
  const x1 = rightward ? from.x + from.w : from.x;
  const x2 = rightward ? to.x : to.x + to.w;
  const pull = Math.max(30, Math.abs(x2 - x1) / 3);
  return `M${x1},${y1} C${x1 + (rightward ? pull : -pull)},${y1} ${x2 + (rightward ? -pull : pull)},${y2} ${x2},${y2}`;
}
