import type * as acp from '@agentclientprotocol/sdk';
import { TURN_USAGE_META, type ContextUse, type TurnUsage } from '@g-code/core';

/**
 * ACP's usage_update for the context after a model call. ACP requires a window size, so 0 says Geno does not know
 * it. During a turn, the turn's model and cost so far ride under TURN_USAGE_META, the shape the prompt response
 * ends the turn with.
 */
export const usageUpdate = ({ used, window }: ContextUse, turn?: TurnUsage): acp.SessionUpdate => ({
  sessionUpdate: 'usage_update',
  used,
  size: window ?? 0,
  ...(turn === undefined ? {} : { _meta: { [TURN_USAGE_META]: turn } }),
});
