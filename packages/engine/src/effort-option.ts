import * as acp from '@agentclientprotocol/sdk';
import { EFFORTS, isEffort, type Effort } from '@g-code/core';

/** The session config option that carries the effort the user chose, which each turn's policy steps from. */
export const EFFORT_CONFIG_ID = 'effort';

const EFFORT_NAMES: Readonly<Record<Effort, string>> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

export const effortConfigOptions = (current: Effort): acp.SessionConfigOption[] => [
  {
    id: EFFORT_CONFIG_ID,
    name: 'Effort',
    description: 'How hard the model thinks before it answers. Higher is slower and costs more.',
    category: 'thought_level',
    type: 'select',
    currentValue: current,
    options: EFFORTS.map((value) => ({ value, name: EFFORT_NAMES[value] })),
  },
];

/** The effort a session/set_config_option request chooses; any other option or value is an invalid request. */
export function chosenEffort(params: acp.SetSessionConfigOptionRequest): Effort {
  if (params.configId !== EFFORT_CONFIG_ID) throw acp.RequestError.invalidParams({ configId: params.configId }, `unknown config option ${params.configId}; the options are ${EFFORT_CONFIG_ID}`);
  const { value } = params;
  if (typeof value !== 'string' || !isEffort(value)) throw acp.RequestError.invalidParams({ value }, `unknown effort ${String(value)}; the efforts are ${EFFORTS.join(', ')}`);
  return value;
}
