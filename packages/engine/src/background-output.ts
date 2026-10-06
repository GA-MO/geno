import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BACKGROUND_OUTPUT_CAP } from '@g-code/core';

/** The last `cap` bytes of `kept` followed by `chunk`. */
export function keepLast(kept: Buffer, chunk: Buffer, cap: number): Buffer {
  if (chunk.length >= cap) return Buffer.from(chunk.subarray(chunk.length - cap));
  const room = cap - chunk.length;
  return Buffer.concat([kept.length > room ? kept.subarray(kept.length - room) : kept, chunk]);
}

/** Output not yet read: what of it is still kept, and how many of its bytes were dropped before anyone read them. */
export type Unread = { readonly text: string; readonly dropped: number };

/**
 * A background command's output: the last `cap` bytes in memory, which every read uses, and the same in a file under
 * the app home. The file is rewritten from memory once it passes a quarter over the cap, so it stays bounded without
 * a rewrite per chunk.
 */
export class CappedOutput {
  private kept: Buffer = Buffer.alloc(0);
  private total = 0;
  private readTo = 0;
  private fileBytes = 0;
  private writing: Promise<void>;

  constructor(
    readonly file: string,
    private readonly cap = BACKGROUND_OUTPUT_CAP,
  ) {
    this.writing = mkdir(path.dirname(file), { recursive: true }).then(() => writeFile(file, ''));
  }

  append(chunk: Buffer): void {
    this.kept = keepLast(this.kept, chunk, this.cap);
    this.total += chunk.length;
    this.fileBytes += chunk.length;
    const rewrite = this.fileBytes > this.cap + this.cap / 4;
    if (rewrite) this.fileBytes = this.kept.length;
    const snapshot = rewrite ? this.kept : chunk;
    this.writing = this.writing.then(() => (rewrite ? writeFile(this.file, snapshot) : appendFile(this.file, snapshot))).catch(() => {});
  }

  /** Bytes the command printed in all, kept or not. */
  get printed(): number {
    return this.total;
  }

  /** The last `lines` lines that are still kept. */
  tail(lines: number): string {
    const text = this.kept.toString('utf8').replace(/\n$/, '');
    return text === '' ? '' : text.split('\n').slice(-lines).join('\n');
  }

  /** What was printed since the last call, and marks it read. */
  unread(): Unread {
    const keptFrom = this.total - this.kept.length;
    const dropped = Math.max(0, keptFrom - this.readTo);
    const from = this.readTo + dropped;
    this.readTo = this.total;
    return { text: this.kept.subarray(from - keptFrom).toString('utf8'), dropped };
  }

  /** Settles once every append so far is on disk. */
  flushed(): Promise<void> {
    return this.writing;
  }
}
