import type { Message, MessageStreamEvent, MessageStreamParams } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ProviderSpec, ProviderValues } from '@g-code/core';

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

// Shorter values are not worth hunting for, and would cut ordinary words out of a message.
const MIN_SECRET_LENGTH = 8;

export function redactor(config: WireConfig): (text: string) => string {
  const secrets = config.spec.fields.flatMap((field) => {
    const value = config.values[field.id];
    return field.secret && value !== undefined && value.length >= MIN_SECRET_LENGTH ? [value] : [];
  });
  return (text) => secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), text);
}
