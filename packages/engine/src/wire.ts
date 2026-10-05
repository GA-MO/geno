import Anthropic from '@anthropic-ai/sdk';
import type { Message, MessageStreamEvent, MessageStreamParams } from '@anthropic-ai/sdk/resources/messages/messages';
import type { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import type { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import {
  baseUrlOf,
  missingField,
  providerValues,
  specOf,
  type ProviderName,
  type ProviderSpec,
  type ProviderValues,
} from '@g-code/core';
import { EngineError } from './errors.js';
import { openaiWire } from './wire-openai.js';

type Env = Readonly<Record<string, string | undefined>>;

export type StreamOptions = {
  readonly signal: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  /** Every Messages stream event as it arrives, translated when the provider speaks another format. */
  onEvent(event: MessageStreamEvent): void;
};

/**
 * One provider's adapter: a streamed Messages call and a model listing, whatever the wire format underneath.
 * Failures are thrown as the Anthropic SDK's error classes, so the gateway retries and classifies them alike.
 */
export type Wire = {
  stream(params: MessageStreamParams, options: StreamOptions): Promise<Message>;
  /** The ids the provider offers, for a provider whose row says it lists them. */
  listModels(signal: AbortSignal): Promise<string[]>;
  /** The text with the provider's secrets cut out, for an error that might echo them. */
  redact(text: string): string;
};

export type WireConfig = {
  readonly spec: ProviderSpec;
  readonly values: ProviderValues;
  readonly baseUrl: string | undefined;
  readonly fetch: typeof globalThis.fetch | undefined;
};

/** The provider's values from `env`. Throws an EngineError naming the first required variable that is not set. */
export function wireConfig(provider: ProviderName, env: Env, fetch?: typeof globalThis.fetch): WireConfig {
  const spec = specOf(provider);
  const values = providerValues(spec, env);
  const missing = missingField(spec, values);
  if (missing !== undefined) {
    throw new EngineError(`${missing.env} is not set; put ${missing.id === 'apiKey' ? `your ${provider} API key` : missing.hint} in it`);
  }
  return { spec, values, baseUrl: baseUrlOf(spec, values), fetch };
}

// Shorter values are not worth hunting for, and would cut ordinary words out of a message.
const MIN_SECRET_LENGTH = 8;

export function redactor(config: WireConfig): (text: string) => string {
  const secrets = config.spec.fields.flatMap((field) => {
    const value = config.values[field.id];
    return field.secret && value !== undefined && value.length >= MIN_SECRET_LENGTH ? [value] : [];
  });
  return (text) => secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), text);
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

function anthropicWire(config: WireConfig): Wire {
  let pending: ReturnType<typeof anthropicClient> | undefined;
  const clientOf = () => (pending ??= anthropicClient(config));
  return {
    async stream(params, { signal, headers, onEvent }) {
      const client = await clientOf();
      const stream = client.messages.stream(params, { signal, ...(headers === undefined ? {} : { headers: { ...headers } }) });
      stream.on('streamEvent', onEvent);
      return stream.finalMessage();
    },
    async listModels(signal) {
      const client = await clientOf();
      if (!(client instanceof Anthropic)) throw new EngineError(`${config.spec.label} does not list its models`);
      const page = await client.models.list({ limit: 1000 }, { signal });
      return page.data.map((model) => model.id);
    },
    redact: redactor(config),
  };
}

/** The adapter for the provider. Throws an EngineError when a value it needs is not set. */
export function wireFor(provider: ProviderName, env: Env, fetch?: typeof globalThis.fetch): Wire {
  const config = wireConfig(provider, env, fetch);
  return config.spec.adapter === 'anthropic' ? anthropicWire(config) : openaiWire(config);
}
