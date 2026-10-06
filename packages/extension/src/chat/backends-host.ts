import type * as vscode from 'vscode';
import { EXTERNAL_BACKEND_IDS, EXTERNAL_BACKENDS, type BackendEnvResponse, type ExternalBackendId } from '@g-code/core';
import type { BackendLabels } from './lanes-model.js';

/** Each external agent's name, from the engine's registry, for the panes the webview draws without it. */
export const BACKEND_LABELS: BackendLabels = Object.fromEntries(EXTERNAL_BACKEND_IDS.map((id) => [id, EXTERNAL_BACKENDS[id].label]));

/** Where the settings keep the API key the user chose for an agent, as the Agents section stores it. */
export const backendKeyName = (id: ExternalBackendId): string => `gcode.agents.${id}.apiKey`;

/**
 * The engine's BACKEND_ENV_METHOD: the user's key for an agent, under the variable the agent reads it from, or
 * nothing when the user chose none. The key goes to the engine only, never to the webview or a log.
 */
export async function backendEnv(secrets: Pick<vscode.SecretStorage, 'get'>, id: ExternalBackendId): Promise<BackendEnvResponse> {
  const { keyEnv } = EXTERNAL_BACKENDS[id];
  if (keyEnv === undefined) return { env: {} };
  const key = await secrets.get(backendKeyName(id));
  return { env: key === undefined || key === '' ? {} : { [keyEnv]: key } };
}
