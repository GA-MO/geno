/** How the panel writes numbers: short enough for a footer, precise where small values matter. */

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A turn on a cheap model costs a fraction of a cent, so small amounts keep four decimals. */
export function formatCost(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** A time of day as the user's clock reads it, such as 14:05. */
export const clockOf = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(Math.round(ms), 0)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
