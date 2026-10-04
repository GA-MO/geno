type Entry<T> = { readonly prefix: string; readonly suffix: string; readonly value: T };

export type CacheHit<T> = {
  readonly value: T;
  /** What the user typed since the entry's request; the entry's text must start with it to be reused. */
  readonly typed: string;
};

/**
 * Recent completions by the document text around the cursor. A value may be a finished result or one still
 * streaming, so typing that runs ahead of a slow request can wait for it instead of starting another.
 */
export class TabCache<T> {
  readonly #entries: Entry<T>[] = [];

  constructor(readonly capacity: number = 32) {}

  put(prefix: string, suffix: string, value: T): void {
    const existing = this.#entries.findIndex((e) => e.prefix === prefix && e.suffix === suffix);
    if (existing !== -1) this.#entries.splice(existing, 1);
    this.#entries.push({ prefix, suffix, value });
    if (this.#entries.length > this.capacity) this.#entries.shift();
  }

  /** The newest entry this position extends by typing alone: same suffix, prefix grown at the cursor. */
  find(prefix: string, suffix: string): CacheHit<T> | undefined {
    const entry = this.#entries.findLast((e) => e.suffix === suffix && prefix.startsWith(e.prefix));
    return entry && { value: entry.value, typed: prefix.slice(entry.prefix.length) };
  }

  delete(value: T): void {
    const index = this.#entries.findIndex((e) => e.value === value);
    if (index !== -1) this.#entries.splice(index, 1);
  }
}

/** The part of a completion still ahead of the cursor, or undefined when the typing diverged or used it all up. */
export function remainderAfter(text: string, typed: string): string | undefined {
  return text.startsWith(typed) && text.length > typed.length ? text.slice(typed.length) : undefined;
}
