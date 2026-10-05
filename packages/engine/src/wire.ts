import Anthropic from '@anthropic-ai/sdk';
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
import { openaiWire } from './wire-openai.js';
import { redactor, type Wire, type WireConfig } from './wire-shape.js';

type Env = Readonly<Record<string, string | undefined>>;

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
