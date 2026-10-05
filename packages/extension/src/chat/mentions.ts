/**
 * `@file` and `@selection` in the composer, as plain text the user can edit like any other: `@src/a.ts`, or
 * `@"docs/my notes.md"` for a path with spaces, and `@selection` for the active editor's selection when the
 * message is sent. Shared by the webview, which completes them, and the extension, which resolves them.
 */

export const SELECTION = 'selection';

/** One row of the completion list. `label` is what goes after the `@`. */
export type MentionCompletion = { readonly kind: 'file' | 'selection'; readonly label: string; readonly detail: string };

/** The mention being typed just before `caret`: where its `@` is and what follows it so far. */
export function mentionAtCaret(text: string, caret: number): { readonly start: number; readonly query: string } | undefined {
  const match = /(^|\s)@([^\s@"]*)$/.exec(text.slice(0, caret));
  return match === null ? undefined : { start: caret - match[2]!.length - 1, query: match[2]! };
}

export const formatMention = (label: string): string => (/\s|"/.test(label) ? `@"${label.replace(/"/g, '')}"` : `@${label}`);

/** `text` with the mention typed from `start` to `caret` replaced by `label` and a space, and the caret after them. */
export function insertMention(text: string, start: number, caret: number, label: string): { readonly text: string; readonly caret: number } {
  const inserted = `${formatMention(label)} `;
  const rest = text.slice(caret).replace(/^\S*/, '').replace(/^ /, '');
  return { text: text.slice(0, start) + inserted + rest, caret: start + inserted.length };
}

/** Every `@` mention in a message, in order and without repeats. Whether a path names a file is the caller's call. */
export function mentionsIn(text: string): string[] {
  const found = [...text.matchAll(/(?:^|\s)@(?:"([^"]+)"|([^\s@"]+))/g)].map((m) => (m[1] ?? m[2]!).replace(/[.,;:!?)]+$/, ''));
  return [...new Set(found.filter((label) => label !== ''))];
}

const basename = (file: string): string => file.slice(file.lastIndexOf('/') + 1);

function isSubsequence(query: string, text: string): boolean {
  let i = 0;
  for (const char of text) if (char === query[i]) i++;
  return i === query.length;
}

/** How well `file` matches: the file name first, then anywhere in the path, then the query's letters in order. */
function score(file: string, query: string): number | undefined {
  const path = file.toLowerCase();
  const name = basename(path);
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (path.includes(query)) return 2;
  if (isSubsequence(query, path)) return 3;
  return undefined;
}

/** The workspace files (relative, slash-separated) that best match `query`, best first. */
export function rankFiles(files: readonly string[], query: string, limit: number): string[] {
  const q = query.toLowerCase();
  return files
    .flatMap((file) => {
      const s = score(file, q);
      return s === undefined ? [] : [{ file, s }];
    })
    .sort((a, b) => a.s - b.s || a.file.length - b.file.length || (a.file < b.file ? -1 : 1))
    .slice(0, limit)
    .map(({ file }) => file);
}
