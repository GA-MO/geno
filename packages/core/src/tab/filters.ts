export type CursorState = { readonly version: number; readonly offset: number };

export type FilterInput = {
  readonly text: string;
  readonly suffix: string;
  readonly maxLines: number;
  readonly requested: CursorState;
  readonly current: CursorState;
};

const firstLine = (text: string): string => text.trim().split('\n')[0]!.trim();

/** Each predicate returns true to drop the completion. Order is the order they are tried. */
export const FILTERS = {
  stale: ({ requested, current }: FilterInput) =>
    requested.version !== current.version || requested.offset !== current.offset,
  empty: ({ text }: FilterInput) => text.trim() === '',
  'repeats-suffix': ({ text, suffix }: FilterInput) => {
    const line = firstLine(text);
    return line !== '' && suffix.trimStart().startsWith(line);
  },
  'too-many-lines': ({ text, maxLines }: FilterInput) => text.trimEnd().split('\n').length > maxLines,
} as const;

export type FilterName = keyof typeof FILTERS;
export const FILTER_NAMES = Object.keys(FILTERS) as FilterName[];

export const DEFAULT_MAX_LINES = 8;

export const firstFilter = (input: FilterInput): FilterName | undefined =>
  FILTER_NAMES.find((name) => FILTERS[name](input));

/** The model's raw text as it would be inserted: trailing whitespace would leave stray blank lines. */
export const completionText = (raw: string): string => raw.trimEnd();
