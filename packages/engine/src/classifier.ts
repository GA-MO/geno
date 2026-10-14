import { APIError } from '@anthropic-ai/sdk';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { z } from 'zod';
import {
  CLASSIFIER_TIMEOUT_MS,
  CLASSIFIER_TOOL,
  classifierChoiceOf,
  classifierRequest,
  classifyModelError,
  costOf,
  isProviderName,
  type ClassifierInput,
  type ClassifierRun,
  type ClassifierVerdict,
} from '@g-code/core';
import { messagesOf, usageOf } from './gateway.js';
import { sandboxDomainsOf } from './sandbox.js';
import { wireFor } from './wire.js';
import type { Wire } from './wire-shape.js';

/** Judges a command Auto cannot settle by rule. Never throws: any failure is an `ask`, which goes to the user. */
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

export function classifierVerdictOf(content: readonly ContentBlock[]): ClassifierVerdict {
  const uses = content.filter((block) => block.type === 'tool_use');
  const [use] = uses;
  if (uses.length !== 1 || use?.name !== CLASSIFIER_TOOL.name) return { verdict: 'ask', reason: 'the classifier gave no verdict' };
  const parsed = answerSchema.safeParse(use.input);
  return parsed.success ? { verdict: parsed.data.verdict, reason: parsed.data.reason } : { verdict: 'ask', reason: 'the classifier gave a malformed verdict' };
}

type Env = Readonly<Record<string, string | undefined>>;

// A bad key, an unknown model or an unpaid bill fails every call alike; a timeout or a 5xx may pass.
const persists = (error: unknown, message: string): boolean =>
  error instanceof APIError && error.status !== undefined && ['fatal', 'quota'].includes(classifyModelError({ status: error.status, message }));

export function commandClassifier(env: Env, fetch?: typeof globalThis.fetch, { timeoutMs = CLASSIFIER_TIMEOUT_MS, onBroken = () => {} }: ClassifierOptions = {}): Classify {
  const { provider, model } = classifierChoiceOf(env);
  const asks = (reason: string, latencyMs = 0, costUsd: number | null = null): ClassifierRun => ({ verdict: 'ask', reason, model: model ?? 'none', latencyMs, costUsd });
  const broken = (problem: string): Classify => async () => {
    onBroken(problem);
    return asks(`the classifier is not set up: ${problem}`);
  };
  const sandboxHosts = sandboxDomainsOf(env);

  if (model === 'off') return async () => asks('the classifier is off');
  if (!isProviderName(provider)) return broken(`unknown classifier provider ${provider}`);
  if (model === undefined) return broken(`${provider} has no default model, so name one in gcode.roles.classifier.model or GCODE_CLASSIFIER_MODEL`);
  let wire: Wire;
  try {
    wire = wireFor(provider, env, fetch);
  } catch (error) {
    return broken(messagesOf(error).join(': '));
  }

  return async (input, signal) => {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const message = await wire.stream(classifierRequest(input, model, sandboxHosts), { signal: AbortSignal.any([signal, timeout]), onEvent: () => {} });
      const costUsd = costOf(provider, model, usageOf(message));
      if (message.stop_reason === 'refusal') return asks('the classifier refused to judge the command', elapsed(), costUsd);
      return { ...classifierVerdictOf(message.content), model, latencyMs: elapsed(), costUsd };
    } catch (error) {
      if (timeout.aborted) return asks(`the classifier timed out after ${timeoutMs / 1000}s`, elapsed());
      const message = wire.redact(messagesOf(error).join(': '));
      if (!signal.aborted && persists(error, message)) onBroken(`${provider} ${model}: ${message.slice(0, 200)}`);
      return asks(`the classifier failed: ${message}`, elapsed());
    }
  };
}
