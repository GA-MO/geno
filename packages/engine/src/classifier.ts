import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { z } from 'zod';
import {
  CLASSIFIER_TIMEOUT_MS,
  CLASSIFIER_TOOL,
  classifierRequest,
  costOf,
  DEFAULT_CLASSIFIER_MODEL,
  isProviderName,
  type ClassifierInput,
  type ClassifierRun,
  type ClassifierVerdict,
  type ProviderName,
} from '@g-code/core';
import { messagesOf, usageOf } from './gateway.js';
import { sandboxDomainsOf } from './sandbox.js';
import { wireFor } from './wire.js';
import type { Wire } from './wire-shape.js';

/** Judges a command Auto cannot settle by rule. Never throws: any failure is an `ask`. */
export type Classify = (input: ClassifierInput, signal: AbortSignal) => Promise<ClassifierRun>;

/** The settings that choose the classifier; GCODE_CLASSIFIER_MODEL=off turns it off, so Auto blocks every gray command until the blocks pause it. */
export const CLASSIFIER_ENV = { provider: 'GCODE_CLASSIFIER_PROVIDER', model: 'GCODE_CLASSIFIER_MODEL' } as const;
const DEFAULT_CLASSIFIER_PROVIDER: ProviderName = 'modelstudio';

const answerSchema = z.strictObject({ reason: z.string().trim().min(1), verdict: z.enum(['allow', 'ask', 'deny']) });

export function classifierVerdictOf(content: readonly ContentBlock[]): ClassifierVerdict {
  const uses = content.filter((block) => block.type === 'tool_use');
  const [use] = uses;
  if (uses.length !== 1 || use?.name !== CLASSIFIER_TOOL.name) return { verdict: 'ask', reason: 'the classifier gave no verdict' };
  const parsed = answerSchema.safeParse(use.input);
  return parsed.success ? { verdict: parsed.data.verdict, reason: parsed.data.reason } : { verdict: 'ask', reason: 'the classifier gave a malformed verdict' };
}

type Env = Readonly<Record<string, string | undefined>>;

export function commandClassifier(env: Env, fetch?: typeof globalThis.fetch, timeoutMs: number = CLASSIFIER_TIMEOUT_MS): Classify {
  const provider = env[CLASSIFIER_ENV.provider] || DEFAULT_CLASSIFIER_PROVIDER;
  const model = env[CLASSIFIER_ENV.model] || DEFAULT_CLASSIFIER_MODEL;
  const asks = (reason: string, latencyMs = 0, costUsd: number | null = null): ClassifierRun => ({ verdict: 'ask', reason, model, latencyMs, costUsd });
  const always = (reason: string): Classify => async () => asks(reason);
  const sandboxHosts = sandboxDomainsOf(env);

  if (model === 'off') return always('the classifier is off');
  if (!isProviderName(provider)) return always(`unknown classifier provider ${provider}`);
  let wire: Wire;
  try {
    wire = wireFor(provider, env, fetch);
  } catch (error) {
    return always(`the classifier is not set up: ${messagesOf(error).join(': ')}`);
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
      return asks(`the classifier failed: ${wire.redact(messagesOf(error).join(': '))}`, elapsed());
    }
  };
}
