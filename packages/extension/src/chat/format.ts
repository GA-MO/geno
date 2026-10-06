/** How the panel writes numbers: short enough for a footer, precise where small values matter. */

export { formatTokens, formatUsd as formatCost } from '@g-code/core/spend-view';

/** A time of day as the user's clock reads it, such as 14:05. */
export const clockOf = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(Math.round(ms), 0)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
