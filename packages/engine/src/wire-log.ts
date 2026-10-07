import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from '@g-code/core';

/** Every string in `value` with `redact` applied, so a secret is cut out of a value without breaking the JSON around it. */
function scrubbed(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redactSecrets(redact(value));
  if (Array.isArray(value)) return value.map((item) => scrubbed(item, redact));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubbed(item, redact)]));
  return value;
}

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * `fetch` that appends each request with a body, and then its answer, to `file` as JSON lines: `{id, at, url,
 * request}` before it goes out, `{id, at, status, response}` once the answer is read. Headers are never written, and
 * the provider's secrets and other keys are cut out of every string. For `GCODE_WIRE_LOG`.
 */
export function wireLogFetch(file: string, fetch: typeof globalThis.fetch, redact: (text: string) => string): typeof globalThis.fetch {
  let next = 0;
  let queue: Promise<void> = mkdir(path.dirname(file), { recursive: true }).then(() => {});
  const append = (entry: Record<string, unknown>): Promise<void> => (queue = queue.then(() => appendFile(file, `${JSON.stringify(scrubbed(entry, redact))}\n`)));
  return async (input, init) => {
    if (typeof init?.body !== 'string') return fetch(input, init);
    const id = ++next;
    const url = input instanceof Request ? input.url : String(input);
    await append({ id, at: new Date().toISOString(), url, request: parsed(init.body) });
    const response = await fetch(input, init);
    // The answer streams to the caller; the log reads a copy, and a copy cut short by a stop is not worth an error.
    void response
      .clone()
      .text()
      .then((text) => append({ id, at: new Date().toISOString(), status: response.status, response: text }))
      .catch(() => {});
    return response;
  };
}
