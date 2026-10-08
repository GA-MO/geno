import { AsyncLocalStorage } from 'node:async_hooks';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageStreamParams } from '@anthropic-ai/sdk/resources/messages/messages';
import type { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import type { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import {
  baseUrlOf,
  missingField,
  providerValues,
  specOf,
  type ProviderName,
} from '@g-code/core';
import { EngineError } from './errors.js';
import { wireLogFetch } from './wire-log.js';
import { openaiWire } from './wire-openai.js';
import { probeHost, redactor, type Wire, type WireConfig } from './wire-shape.js';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The provider's values from `env`. Throws an EngineError naming the first required variable that is not set. With
 * GCODE_WIRE_LOG set, every request goes to that file as well (`wire-log.ts`).
 */
export function wireConfig(provider: ProviderName, env: Env, fetch?: typeof globalThis.fetch): WireConfig {
  const spec = specOf(provider);
  const values = providerValues(spec, env);
  const missing = missingField(spec, values);
  if (missing !== undefined) {
    throw new EngineError(`${missing.env} is not set; put ${missing.id === 'apiKey' ? `your ${provider} API key` : missing.hint} in it`);
  }
  const config: WireConfig = { spec, values, baseUrl: baseUrlOf(spec, values), fetch };
  const log = env['GCODE_WIRE_LOG'];
  return log ? { ...config, fetch: wireLogFetch(log, fetch ?? globalThis.fetch, redactor(config)) } : config;
}

// maxRetries: 0 because retries are the gateway's: the SDK's would retry an exhausted quota, unseen, and never a
// stream that fails after its headers. The AWS and Google clients load on first use, so the engine starts as fast
// for everyone else.
async function anthropicClient({ spec, values, baseUrl, fetch }: WireConfig): Promise<Anthropic | AnthropicBedrockMantle | AnthropicVertex> {
  const common = { maxRetries: 0, fetch, ...(baseUrl === undefined ? {} : { baseURL: baseUrl }) };
  switch (spec.key.kind) {
    case 'aws': {
      const { AnthropicBedrockMantle } = await import('@anthropic-ai/bedrock-sdk');
      return new AnthropicBedrockMantle({
        ...common,
        awsRegion: values.region,
        awsAccessKey: values.accessKeyId ?? null,
        awsSecretAccessKey: values.secretAccessKey ?? null,
        awsSessionToken: values.sessionToken ?? null,
        ...(values.profile === undefined ? {} : { awsProfile: values.profile }),
      });
    }
    case 'google': {
      const { AnthropicVertex } = await import('@anthropic-ai/vertex-sdk');
      if (values.accessToken === undefined) return new AnthropicVertex({ ...common, region: values.region ?? null, projectId: values.project ?? null });
      // The Vertex client authenticates only through a Google auth client, so a bare token goes in one.
      const { OAuth2Client } = await import('google-auth-library');
      const authClient = new OAuth2Client();
      authClient.setCredentials({ access_token: values.accessToken });
      return new AnthropicVertex({ ...common, region: values.region ?? null, projectId: values.project ?? null, authClient });
    }
    case 'header':
      // The unused credential is null, which stops the SDK from also sending an ANTHROPIC_API_KEY or
      // ANTHROPIC_AUTH_TOKEN it finds in the environment.
      return spec.key.header === 'authorization'
        ? new Anthropic({ ...common, authToken: values.apiKey ?? null, apiKey: null })
        : new Anthropic({ ...common, apiKey: values.apiKey ?? null, authToken: null });
  }
}

/** The response with `onBytes` called for each piece of its body as it is read. */
function tapped(response: Response, onBytes: () => void): Response {
  if (response.body === null) return response;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onBytes();
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * The SDK reads the body and drops what it does not pass on, such as the provider's pings, so the bytes are counted in
 * its fetch. The SDK makes the fetch inside the call that started the stream, which is how the fetch finds that call's counter.
 */
const byteCounters = new AsyncLocalStorage<() => void>();

const countingFetch =
  (fetch: typeof globalThis.fetch | undefined): typeof globalThis.fetch =>
  async (input, init) => {
    const response = await (fetch ?? globalThis.fetch)(input, init);
    const onBytes = byteCounters.getStore();
    if (onBytes === undefined) return response;
    onBytes();
    return tapped(response, onBytes);
  };

// Claude Code sets eager_input_streaming on every tool, so a tool's input streams as the model writes it rather than
// after the API has buffered and checked it; the executors check every input themselves. Only Anthropic's API and
// Vertex are known to take the field: older Bedrock deployments refuse it, and another provider's Anthropic endpoint may.
const EAGER_INPUT: ReadonlySet<ProviderName> = new Set(['anthropic', 'vertex']);

const eager = (params: MessageStreamParams): MessageStreamParams =>
  params.tools === undefined ? params : { ...params, tools: params.tools.map((tool) => ('input_schema' in tool ? { ...tool, eager_input_streaming: true } : tool)) };

function anthropicWire(config: WireConfig): Wire {
  let pending: ReturnType<typeof anthropicClient> | undefined;
  const clientOf = () => (pending ??= anthropicClient({ ...config, fetch: countingFetch(config.fetch) }));
  return {
    async stream(params, { signal, headers, onEvent, onAnswered, onBytes = () => {} }) {
      const client = await clientOf();
      const request = EAGER_INPUT.has(config.spec.id) ? eager(params) : params;
      return byteCounters.run(onBytes, () => {
        const stream = client.messages.stream(request, { signal, ...(headers === undefined ? {} : { headers: { ...headers } }) });
        if (onAnswered !== undefined) stream.on('connect', onAnswered);
        stream.on('streamEvent', onEvent);
        return stream.finalMessage();
      });
    },
    async listModels(signal) {
      const client = await clientOf();
      if (!(client instanceof Anthropic)) throw new EngineError(`${config.spec.label} does not list its models`);
      const page = await client.models.list({ limit: 1000 }, { signal });
      return page.data.map((model) => model.id);
    },
    redact: redactor(config),
    probe: async (signal) => probeHost(config.baseUrl ?? (await clientOf()).baseURL, config.fetch, signal),
  };
}

/** The adapter for the provider. Throws an EngineError when a value it needs is not set. */
export function wireFor(provider: ProviderName, env: Env, fetch?: typeof globalThis.fetch): Wire {
  const config = wireConfig(provider, env, fetch);
  return config.spec.adapter === 'anthropic' ? anthropicWire(config) : openaiWire(config);
}
