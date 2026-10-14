import { specOf, type FieldId, type ProviderName, type Session } from '@g-code/core';

export class EngineError extends Error {}

/** A value the provider needs that the engine's environment lacks, such as its API key. */
export class MissingCredential extends EngineError {
  constructor(
    readonly provider: ProviderName,
    readonly field: FieldId,
    message: string,
  ) {
    super(message);
  }
}

/** A session whose provider lacks a value: it keeps its provider and model, so it cannot run here until the value is set. */
export class SessionUnreachable extends EngineError {
  readonly provider: ProviderName;
  readonly model: string;
  readonly field: FieldId;

  constructor(session: Pick<Session, 'provider' | 'model'>, missing: MissingCredential) {
    super(`this session ran on ${specOf(session.provider).label} · ${session.model}, and ${missing.message}`);
    this.provider = session.provider;
    this.model = session.model;
    this.field = missing.field;
  }
}
