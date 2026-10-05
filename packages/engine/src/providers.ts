import { parseArgs } from 'node:util';
import { costOf, isProviderName, missingField, PROVIDERS, providerValues, specOf, type ProviderName } from '@g-code/core';
import { UsageError, type Command, type Io } from './command.js';
import { EngineError } from './errors.js';
import { messagesOf, usageOf } from './gateway.js';
import { wireFor } from './wire.js';
import type { Wire } from './wire-shape.js';

/** Long enough for a cold model, short enough that the settings page's button does not hang. */
const TEST_TIMEOUT_MS = 30_000;
const TEST_PROMPT = 'Reply with the word OK.';

function providerArg(positionals: readonly string[]): ProviderName {
  const [raw, ...extra] = positionals;
  if (raw === undefined || extra.length > 0) throw new UsageError('expected exactly one provider');
  if (!isProviderName(raw)) throw new UsageError(`unknown provider: ${raw}; one of ${PROVIDERS.join(', ')}`);
  return raw;
}

/** A failure as one line, with any secret the provider's error echoed cut out. */
const failureText = (error: unknown, wire: Wire | undefined): string => {
  const text = messagesOf(error).join(': ');
  return wire === undefined ? text : wire.redact(text);
};

type Report = { readonly ok: boolean; readonly provider: ProviderName } & Record<string, unknown>;

function emit(io: Io, json: boolean, report: Report, human: string): number {
  io.out(json ? JSON.stringify(report) : human);
  return report.ok ? 0 : 1;
}

const list: Command = async (args, { io }) => {
  parseArgs({ args, options: {}, strict: true });
  for (const id of PROVIDERS) {
    const spec = specOf(id);
    const missing = missingField(spec, providerValues(spec, io.env));
    io.out(`${id.padEnd(14)}${spec.adapter.padEnd(11)}${missing === undefined ? 'ready' : `needs ${missing.env}`}`);
  }
  return 0;
};

const models: Command = async (args, { io }) => {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { json: { type: 'boolean', default: false } } });
  const provider = providerArg(positionals);
  let wire: Wire | undefined;
  try {
    if (!specOf(provider).listsModels) throw new EngineError(`${specOf(provider).label} does not list its models`);
    wire = wireFor(provider, io.env, io.fetch);
    const ids = await wire.listModels(AbortSignal.timeout(TEST_TIMEOUT_MS));
    return emit(io, values.json, { ok: true, provider, models: ids }, ids.join('\n'));
  } catch (error) {
    const message = failureText(error, wire);
    return emit(io, values.json, { ok: false, provider, error: message }, `error: ${message}`);
  }
};

/** One tiny call to the provider, which proves the key, the endpoint and the model together. */
const test: Command = async (args, { io }) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { model: { type: 'string' }, json: { type: 'boolean', default: false } },
  });
  const provider = providerArg(positionals);
  const model = values.model ?? specOf(provider).defaultModel;
  let wire: Wire | undefined;
  try {
    if (model === undefined) throw new EngineError(`${specOf(provider).label} has no default model; pass --model`);
    wire = wireFor(provider, io.env, io.fetch);
    const started = performance.now();
    const message = await wire.stream(
      { model, max_tokens: 16, messages: [{ role: 'user', content: TEST_PROMPT }] },
      { signal: AbortSignal.timeout(TEST_TIMEOUT_MS), onEvent: () => {} },
    );
    const latencyMs = Math.round(performance.now() - started);
    const reply = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('').trim().slice(0, 80);
    const usage = usageOf(message);
    const costUsd = costOf(provider, model, usage);
    return emit(io, values.json, { ok: true, provider, model, latencyMs, reply, usage, costUsd }, `ok: ${provider} ${model} answered in ${latencyMs}ms: ${reply}`);
  } catch (error) {
    const message = failureText(error, wire);
    return emit(io, values.json, { ok: false, provider, error: message }, `error: ${message}`);
  }
};

export const providerCommands: Record<string, Command> = { list, models, test };
