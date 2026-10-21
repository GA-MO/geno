import { APIError } from '@anthropic-ai/sdk';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { z } from 'zod';
import {
  CLASSIFIER_TIMEOUT_MS,
  CLASSIFIER_TOOL,
  classifierChoiceOf,
  capabilitiesOf,
  classifierRequest,
  classifyModelError,
  costOf,
  isProviderName,
  type ClassifierInput,
  type ClassifierFailure,
  type ClassifierRun,
  type ClassifierVerdict,
} from '@g-code/core';
import { messagesOf, usageOf } from './gateway.js';
import { sandboxDomainsOf } from './sandbox.js';
import { wireFor } from './wire.js';
import type { Wire } from './wire-shape.js';

/**
 * Judges a command Auto cannot settle by rule. Never throws: any failure is an `ask` whose `failure` says how it
 * failed, which Auto refuses as a block or, for a classifier that cannot judge anything, asks the user about. A call
 * that timed out or gave no verdict is tried once more first; a real `ask` or `deny` is not.
 */
export type Classify = (input: ClassifierInput, signal: AbortSignal) => Promise<ClassifierRun>;

export type ClassifierOptions = {
  readonly timeoutMs?: number;
  /**
   * Hears, at each call that fails for it, that the classifier cannot judge anything: it is not set up, or the
   * provider refused the call for a reason that will not pass, such as a bad key or an unknown model. A timeout or
   * a server error is not one of them.
   */
  readonly onBroken?: (problem: string) => void;
};

/** What the user is told, once, when the classifier cannot judge anything. */
export const brokenClassifierNotice = (problem: string): string =>
  `Auto mode's classifier is not working (${problem.replace(/\.$/, '')}), so commands it would judge ask you instead.`;

const answerSchema = z.strictObject({ reason: z.string().trim().min(1), verdict: z.enum(['allow', 'ask', 'deny']) });

/** What the classifier's answer holds: a verdict, or why it holds none. */
export type ClassifierAnswer = { readonly kind: 'verdict'; readonly verdict: ClassifierVerdict } | { readonly kind: 'no-verdict'; readonly reason: string };

export function classifierAnswerOf(content: readonly ContentBlock[]): ClassifierAnswer {
  const uses = content.filter((block) => block.type === 'tool_use');
  const [use] = uses;
  if (uses.length !== 1 || use?.name !== CLASSIFIER_TOOL.name) return { kind: 'no-verdict', reason: 'the classifier gave no verdict' };
  const parsed = answerSchema.safeParse(use.input);
  return parsed.success ? { kind: 'verdict', verdict: { verdict: parsed.data.verdict, reason: parsed.data.reason } } : { kind: 'no-verdict', reason: 'the classifier gave a malformed verdict' };
}

/**
 * One call to the classifier. `transient` is a timeout or an answer with no verdict, which another call may not repeat.
 * `failed` is every other error, such as a refused key, a server error or a stopped turn, and is not tried again.
 */
type Attempt = { readonly kind: 'verdict' | 'transient' | 'failed'; readonly run: ClassifierRun };

// A timed-out call has no usage, so its cost is unknown rather than zero; the total is unknown only when both are.
const addCosts = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

type Env = Readonly<Record<string, string | undefined>>;

// A bad key, an unknown model or an unpaid bill fails every call alike; a timeout or a 5xx may pass.
const persists = (error: unknown, message: string): boolean =>
  error instanceof APIError && error.status !== undefined && ['fatal', 'quota'].includes(classifyModelError({ status: error.status, message }));

export function commandClassifier(env: Env, fetch?: typeof globalThis.fetch, { timeoutMs = CLASSIFIER_TIMEOUT_MS, onBroken = () => {} }: ClassifierOptions = {}): Classify {
  const { provider, model } = classifierChoiceOf(env);
  const asks = (failure: ClassifierFailure, reason: string, latencyMs = 0, costUsd: number | null = null): ClassifierRun => ({ verdict: 'ask', reason, model: model ?? 'none', latencyMs, costUsd, failure });
  const broken = (problem: string): Classify => async () => {
    onBroken(problem);
    return asks('unavailable', `the classifier is not set up: ${problem}`);
  };
  const sandboxHosts = sandboxDomainsOf(env);

  if (model === 'off') return async () => asks('unavailable', 'the classifier is off');
  if (!isProviderName(provider)) return broken(`unknown classifier provider ${provider}`);
  if (model === undefined) return broken(`${provider} has no default model, so name one in gcode.roles.classifier.model or GCODE_CLASSIFIER_MODEL`);
  let wire: Wire;
  try {
    wire = wireFor(provider, env, fetch);
  } catch (error) {
    return broken(messagesOf(error).join(': '));
  }

  const attempt = async (input: ClassifierInput, signal: AbortSignal): Promise<Attempt> => {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const message = await wire.stream(classifierRequest(input, model, sandboxHosts, capabilitiesOf(provider, model)), { signal: AbortSignal.any([signal, timeout]), onEvent: () => {} });
      const costUsd = costOf(provider, model, usageOf(message));
      // Claude refuses to judge a command it reads as an attack, such as one that sends .env out, so a refusal is a deny.
      if (message.stop_reason === 'refusal') return { kind: 'verdict', run: { verdict: 'deny', reason: 'the classifier refused to judge the command as harmful', model, latencyMs: elapsed(), costUsd } };
      const answer = classifierAnswerOf(message.content);
      return answer.kind === 'verdict'
        ? { kind: 'verdict', run: { ...answer.verdict, model, latencyMs: elapsed(), costUsd } }
        : { kind: 'transient', run: asks('unevaluated', answer.reason, elapsed(), costUsd) };
    } catch (error) {
      if (timeout.aborted) return { kind: 'transient', run: asks('unevaluated', `the classifier timed out after ${timeoutMs / 1000}s`, elapsed()) };
      const message = wire.redact(messagesOf(error).join(': '));
      const lasting = !signal.aborted && persists(error, message);
      if (lasting) onBroken(`${provider} ${model}: ${message.slice(0, 200)}`);
      return { kind: 'failed', run: asks(lasting ? 'unavailable' : 'unevaluated', `the classifier failed: ${message}`, elapsed()) };
    }
  };

  return async (input, signal) => {
    const first = await attempt(input, signal);
    if (first.kind !== 'transient' || signal.aborted) return first.run;
    const { run } = await attempt(input, signal);
    return { ...run, latencyMs: first.run.latencyMs + run.latencyMs, costUsd: addCosts(first.run.costUsd, run.costUsd) };
  };
}
