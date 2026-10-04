import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { baseOf, EDIT_FORMAT_SPECS, editPrompt, proposeChange, type ApplyResult, type ProposedChange } from './edit.js';
import { addUsage, nextSeq, toolUsesOf, ZERO_USAGE, type TurnEvent, type TurnResult } from './session.js';
import type { Applier, ApplierRun, ApplyOutcome, EditFormat, FirstTry } from './types.js';

/** One model round trip over the conversation so far. The engine binds it to a gateway and a session. */
export type ModelCall = (events: readonly TurnEvent[], tools: readonly Tool[], system: string) => Promise<TurnResult>;

/** Model turns with a failed edit whose errors go back to the model before the applier gives up. */
export const MAX_EDIT_RETRIES = 2;
/** Model calls per edit, so a model that never ends its turn cannot loop forever. */
export const MAX_EDIT_CALLS = 8;

// The agent's prompt promises read, search and shell tools; here the file is in the message and the edit
// tool is the only one, so the model must not go looking for others.
export const EDIT_SYSTEM_PROMPT = `You are g-code's edit applier. You change exactly one file to carry out an instruction from an experienced engineer.

The user's message holds the file's complete current content, every line prefixed with its number and a tab. Those prefixes are not part of the file.

Your only tool is the edit tool you are given. There is no read, search or shell tool, and no other file can be changed. If the instruction also describes changes to other files, make only the part that belongs in this file.

Make the smallest change that carries out the instruction, matching the file's existing style. Leave unrelated lines exactly as they are. When the edit is made, end your turn with one short sentence.`;

type Failure = Extract<ApplyResult, { kind: 'failed' }>;

const ENDS_TURN = new Set(['end_turn', 'stop_sequence']);
const CARRIES_TOOL_USES = new Set(['tool_use', 'end_turn', 'stop_sequence']);

/**
 * Asks the model for an edit in `format` and applies each edit call to the working text. A turn with failed
 * edits sends their errors back so the model can fix them; the change succeeds when the model ends its turn
 * and its last turn of edits had no failure.
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
      let lastTurnFailure: Failure | undefined;
      let firstTry: FirstTry | undefined;
      let retries = 0;
      let calls = 0;
      let usage = ZERO_USAGE;
      let costUsd: number | null = 0;

      const finish = (outcome: ApplyOutcome): ApplierRun => ({
        outcome,
        attempt: {
          model,
          firstTry: firstTry ?? (outcome.kind === 'failed' ? outcome.reason : 'applied'),
          retries,
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
        const result = await call(events, [spec.tool], EDIT_SYSTEM_PROMPT);
        calls++;
        if (result.kind === 'error') return fail({ reason: 'model-error', detail: `${result.error}: ${result.message}` });
        const { turn } = result;
        usage = addUsage(usage, turn.usage);
        costUsd = costUsd === null || turn.costUsd === null ? null : costUsd + turn.costUsd;
        events.push({ kind: 'assistant', seq: nextSeq(events), at: at(), ...turn });
        const stop = turn.stopReason ?? 'no stop reason';

        const uses = toolUsesOf(turn.content);
        if (uses.length > 0 && !CARRIES_TOOL_USES.has(stop)) {
          // A max_tokens stop can cut a tool input short, and a truncated file must never count as applied.
          return fail({ reason: 'model-error', detail: `the model stopped with ${stop} in the middle of a tool call` });
        }
        if (uses.length === 0) {
          firstTry ??= 'no-edit';
          if (!ENDS_TURN.has(stop)) return fail({ reason: 'model-error', detail: `the model stopped with ${stop}` });
          if (lastTurnFailure !== undefined) return fail(lastTurnFailure);
          if (!edited) return fail({ reason: 'no-edit', detail: `the model ended its turn without calling ${spec.tool.name}` });
          return finish({ kind: 'applied', after: text });
        }

        lastTurnFailure = undefined;
        for (const use of uses) {
          const { change, after } =
            use.name === spec.tool.name
              ? proposeChange({ format, raw: use.input, path, base: baseOf(text, null), current: text, turn: null })
              : wrongTool(use.name, spec.tool.name, format, path, use.input);
          changes.push(change);
          if (after !== null) {
            text = after;
            edited = true;
          } else if (change.result.kind === 'failed') {
            lastTurnFailure ??= change.result;
          }
          events.push({
            kind: 'tool-result',
            seq: nextSeq(events),
            at: at(),
            toolUseId: use.id,
            name: use.name,
            status: after === null ? 'error' : 'ok',
            output: change.result.kind === 'failed' ? change.result.detail : `Edited ${path}.`,
          });
        }
        firstTry ??= lastTurnFailure?.reason ?? 'applied';
        if (lastTurnFailure !== undefined) {
          if (retries === MAX_EDIT_RETRIES) return fail(lastTurnFailure);
          retries++;
        }
      }
    },
  };
}

function wrongTool(name: string, expected: string, format: EditFormat, path: string, raw: unknown) {
  const change: ProposedChange = {
    turn: null,
    path,
    base: baseOf(null, null),
    format,
    raw,
    hunks: [],
    result: { kind: 'failed', reason: 'wrong-tool', detail: `there is no tool ${name}; the file is in the message, and ${expected} is the only tool` },
    check: null,
  };
  return { change, after: null };
}
