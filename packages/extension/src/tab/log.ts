import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { TabEvent } from '@g-code/core/tab';

export const tabEventsFile = (env: NodeJS.ProcessEnv): string =>
  path.join(path.resolve(env['GCODE_HOME'] || path.join(homedir(), '.g-code')), 'tab-events.jsonl');

export type TabLog = (event: TabEvent) => void;

/** Appends one line per event, in order; a failed write is reported and does not block later ones. */
export function openTabLog(file: string, onError: (error: unknown) => void): TabLog {
  let tail = mkdir(path.dirname(file), { recursive: true }).then(() => undefined, onError);
  return (event) => {
    tail = tail.then(() => appendFile(file, `${JSON.stringify(event)}\n`)).catch(onError);
  };
}
