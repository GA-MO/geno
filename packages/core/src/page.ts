// Portions ported from Pi (https://github.com/earendil-works/pi) at b2b5c42, Copyright (c) 2025 Mario Zechner, MIT License.

import { PAGE_MAX_CHARS, PAGE_MAX_LINES } from './tools.js';

const formatCount = (n: number): string => n.toLocaleString('en-US');

/**
 * Lines `first` to `last` (1-based, inclusive; `last` undefined means to the end) of `lines`, numbered as the read
 * tool shows them. A range past PAGE_MAX_LINES or PAGE_MAX_CHARS stops early and ends with the exact start_line
 * that continues it. The whole file comes back bare; any part of it says which lines it is.
 */
export function numberedPage(lines: readonly string[], first: number, last: number | undefined): string {
  const total = lines.length;
  const wanted = Math.min(last ?? total, total);
  const width = String(Math.min(wanted, first + PAGE_MAX_LINES - 1)).length;
  const shown: string[] = [];
  let chars = 0;
  let line = first;
  for (; line <= wanted && shown.length < PAGE_MAX_LINES; line++) {
    const numbered = `${String(line).padStart(width)}\t${lines[line - 1]!}`;
    if (chars + numbered.length + 1 > PAGE_MAX_CHARS) {
      if (shown.length > 0) break;
      const cut = numbered.slice(0, PAGE_MAX_CHARS);
      const more = line < total ? ` Read again with start_line=${line + 1} to continue.` : '';
      return `${cut}\n[line ${line} of ${total} is ${formatCount(lines[line - 1]!.length)} characters; this shows its start.${more}]`;
    }
    shown.push(numbered);
    chars += numbered.length + 1;
  }
  const end = line - 1;
  const body = shown.join('\n');
  if (end < wanted) {
    return `${body}\n[lines ${first}-${end} of ${total}. One read returns at most ${formatCount(PAGE_MAX_LINES)} lines or ${formatCount(
      PAGE_MAX_CHARS,
    )} characters; read again with start_line=${end + 1} to continue.]`;
  }
  return first === 1 && end === total ? body : `${body}\n[lines ${first}-${end} of ${total}]`;
}

/** A file's text as lines, without the empty line after a final newline. */
export function linesOf(text: string): string[] {
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}
