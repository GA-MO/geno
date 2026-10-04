import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { baseOf, EDIT_FORMAT_SPECS, editPrompt, proposeChange, type ApplyResult, type ProposedChange } from './edit.js';
import { nextSeq, toolUsesOf, type TokenUsage, type TurnEvent, type TurnResult } from './session.js';
import type { Applier, ApplierRun, ApplyOutcome, EditFormat, FirstTry } from './types.js';

/** One model round trip over the conversation so far. The engine binds it to a gateway and a session. */
export type ModelCall = (events: readonly TurnEvent[], tools: readonly Tool[]) => Promise<TurnResult>;

/** Failed edits whose error goes back to the model before the applier gives up. */
export const MAX_EDIT_RETRIES = 2;
/** Model calls per edit, so a model that never ends its turn cannot loop forever. */
export const MAX_EDIT_CALLS = 8;

const ZERO_USAGE: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output,
});

type Failure = Extract<ApplyResult, { kind: 'failed' }>;

const ENDS_TURN = new Set(['end_turn', 'stop_sequence']);

/**
 * Asks the model for an edit in `format` and applies each edit call to the working text. A failed edit goes
 * back as an error result so the model can fix it; the change succeeds when the model ends its turn with no
 * failure left unfixed by a later edit.
 */
export function modelApplier(format: EditFormat, model: string, call: ModelCall): Applier {
  const spec = EDIT_FORMAT_SPECS[format];
  return {
    name: format,
    async apply({ path, before, instruction }): Promise<ApplierRun> {
      const at = () => new Date().toISOString();
      const events: TurnEvent[] = [{ kind: 'user', seq: 1, at: at(), content: editPrompt(format, path, before, instruction) }];
      const changes: ProposedChange[] = [];
      let text = before;
      let edited = false;
      let unresolved: Failure | undefined;
      let firstTry: FirstTry | undefined;
      let failures = 0;
      let calls = 0;
      let usage = ZERO_USAGE;
      let costUsd: number | null = 0;

      const finish = (outcome: ApplyOutcome): ApplierRun => ({
        outcome,
        attempt: {
          model,
          firstTry: firstTry ?? (outcome.kind === 'failed' ? outcome.reason : 'applied'),
          retries: Math.min(failures, MAX_EDIT_RETRIES),
          calls,
          usage,
          costUsd,
          changes,
        },
      });
      const fail = (failure: Pick<Failure, 'reason' | 'detail'>) => finish({ kind: 'failed', ...failure });

      for (;;) {
        if (calls === MAX_EDIT_CALLS) {
          return fail({ reason: 'model-error', detail: `the model did not end its turn within ${MAX_EDIT_CALLS} calls` });
        }
        const result = await call(events, [spec.tool]);
        calls++;
        if (result.kind === 'error') return fail({ reason: 'model-error', detail: `${result.error}: ${result.message}` });
        const { turn } = result;
        usage = addUsage(usage, turn.usage);
        costUsd = costUsd === null || turn.costUsd === null ? null : costUsd + turn.costUsd;
        events.push({ kind: 'assistant', seq: nextSeq(events), at: at(), ...turn });

        const uses = toolUsesOf(turn.content);
        if (uses.length === 0) {
          firstTry ??= 'no-edit';
          if (!ENDS_TURN.has(turn.stopReason ?? '')) {
            return fail({ reason: 'model-error', detail: `the model stopped with ${turn.stopReason ?? 'no stop reason'}` });
          }
          if (unresolved !== undefined) return fail(unresolved);
          if (!edited) return fail({ reason: 'no-edit', detail: `the model ended its turn without calling ${spec.tool.name}` });
          return finish({ kind: 'applied', after: text });
        }

        let firstFailure: Failure | undefined;
        for (const use of uses) {
          const { change, after } =
            use.name === spec.tool.name
              ? proposeChange({ format, raw: use.input, path, base: baseOf(text, null), current: text, turn: null })
              : unknownTool(use.name, spec.tool.name, format, path, use.input);
          changes.push(change);
          const ok = after !== null;
          if (ok) {
            text = after;
            edited = true;
            unresolved = undefined;
          } else if (change.result.kind === 'failed') {
            unresolved = change.result;
            firstFailure ??= change.result;
            failures++;
          }
          events.push({
            kind: 'tool-result',
            seq: nextSeq(events),
            at: at(),
            toolUseId: use.id,
            name: use.name,
            status: ok ? 'ok' : 'error',
            output: change.result.kind === 'failed' ? change.result.detail : `Edited ${path}.`,
          });
        }
        firstTry ??= firstFailure?.reason ?? 'applied';
        if (failures > MAX_EDIT_RETRIES && unresolved !== undefined) return fail(unresolved);
      }
    },
  };
}

function unknownTool(name: string, expected: string, format: EditFormat, path: string, raw: unknown) {
  const change: ProposedChange = {
    turn: null,
    path,
    base: baseOf(null, null),
    format,
    raw,
    hunks: [],
    result: { kind: 'failed', reason: 'parse-error', detail: `there is no tool ${name}; use ${expected}` },
    check: null,
  };
  return { change, after: null };
}
