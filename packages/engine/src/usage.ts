import { parseArgs } from 'node:util';
import { DEFAULT_BAHT_PER_USD, sessionSpend, sessionSpendView, spendLines, turnSpendView } from '@g-code/core';
import { openSessionLog } from './chat.js';
import { UsageError, type Command } from './command.js';

/** `gcode usage --session <id> [--json]`: the numbers the panel's usage views show, from the same functions. */
export const usage: Command = async (args, { io, store }) => {
  const { values } = parseArgs({ args, options: { session: { type: 'string' }, json: { type: 'boolean' }, 'baht-per-usd': { type: 'string' } }, strict: true });
  if (values.session === undefined) throw new UsageError('--session is required');
  const raw = values['baht-per-usd'];
  const rate = raw === undefined ? DEFAULT_BAHT_PER_USD : Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) throw new UsageError('--baht-per-usd must be a positive number');
  const spend = sessionSpend((await openSessionLog(store, values.session, io)).events);
  if (values.json !== true) {
    for (const line of spendLines(spend, rate)) io.out(line);
    return 0;
  }
  const view = { session: sessionSpendView(spend, rate), turns: spend.turns.map((turn) => ({ seq: turn.seq, ...turnSpendView(turn, rate) })) };
  io.out(JSON.stringify({ ...spend, bahtPerUsd: rate, view }, null, 2));
  return 0;
};
