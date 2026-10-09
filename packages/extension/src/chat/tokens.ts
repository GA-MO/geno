/**
 * Theme tokens (`gcode.appearance.tokens`): the user's values for the panel's own custom properties, such as `--muted`
 * or `--glass-base`, per VS Code theme kind. VS Code's `--vscode-*` variables are never touched. A high contrast kind
 * takes values only when the setting names it, so a theme written for dark or light never weakens high contrast.
 * The webview bundles this file, so it stays pure.
 */

export const TOKENS_SETTING = 'gcode.appearance.tokens';

/** The page's style element that holds the tokens' stylesheet. */
export const TOKENS_STYLE_ID = 'geno-tokens';

export const THEME_KINDS = ['dark', 'light', 'highContrast', 'highContrastLight'] as const;
export type ThemeKind = (typeof THEME_KINDS)[number];

/** Token name, with its leading `--`, to a CSS value. */
export type TokenValues = Readonly<Record<string, string>>;
export type ThemeTokens = Readonly<Partial<Record<ThemeKind, TokenValues>>>;

/** The body classes VS Code sets for each kind; high contrast light carries both high contrast classes. */
const KIND_SELECTORS: Readonly<Record<ThemeKind, string>> = {
  dark: 'body.vscode-dark',
  light: 'body.vscode-light',
  highContrast: 'body.vscode-high-contrast:not(.vscode-high-contrast-light)',
  highContrastLight: 'body.vscode-high-contrast-light',
};

const NAME = /^--[a-zA-Z][\w-]*$/;

/** Every custom property the stylesheet `css` declares, apart from VS Code's own, sorted. */
export function tokenNamesIn(css: string): string[] {
  const names = new Set<string>();
  for (const [, name] of css.matchAll(/(?<![\w-])(--[a-zA-Z][\w-]*)\s*:/g)) if (!name!.startsWith('--vscode-')) names.add(name!);
  return [...names].sort();
}

/**
 * Why `value` cannot be a token's value, or undefined when it can. A value is written into a stylesheet, so anything
 * that could end the declaration or the rule is refused, and so is `url(`, which would load something.
 */
export function tokenValueProblem(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'is not a string';
  const text = value.trim();
  if (text === '') return 'is empty';
  if (text.length > 300) return 'is longer than 300 characters';
  if (/[;{}<>\\!]/.test(text)) return 'holds one of ; { } < > \\ !';
  if (/url\s*\(|image-set\s*\(|@import|expression\s*\(/i.test(text)) return 'loads a resource';
  let depth = 0;
  let quote: string | undefined;
  for (const char of text) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth < 0) return 'closes a bracket it never opened';
  }
  if (quote !== undefined) return 'leaves a quote open';
  if (depth !== 0) return 'leaves a bracket open';
  return undefined;
}

export type ParsedTokens = { readonly tokens: ThemeTokens; readonly problems: readonly string[] };

/** The setting's value as the panel applies it: unknown kinds, unknown tokens and unusable values are left out, each with a problem. */
export function themeTokensOf(raw: unknown, known: ReadonlySet<string>): ParsedTokens {
  if (raw === undefined || raw === null) return { tokens: {}, problems: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { tokens: {}, problems: [`${TOKENS_SETTING} must be an object keyed by theme kind: ${THEME_KINDS.join(', ')}.`] };
  const problems: string[] = [];
  const tokens: Partial<Record<ThemeKind, TokenValues>> = {};
  for (const [kind, values] of Object.entries(raw)) {
    if (!(THEME_KINDS as readonly string[]).includes(kind)) {
      problems.push(`${TOKENS_SETTING}: "${kind}" is not a theme kind; use ${THEME_KINDS.join(', ')}.`);
      continue;
    }
    if (typeof values !== 'object' || values === null || Array.isArray(values)) {
      problems.push(`${TOKENS_SETTING}.${kind} must be an object of token names to CSS values.`);
      continue;
    }
    const kept: Record<string, string> = {};
    for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
      if (name.startsWith('--vscode-')) problems.push(`${TOKENS_SETTING}.${kind}: ${name} is VS Code's own variable, which Geno leaves to the color theme.`);
      else if (!NAME.test(name) || !known.has(name)) problems.push(`${TOKENS_SETTING}.${kind}: ${name} is not a Geno token, so it is ignored.`);
      else {
        const problem = tokenValueProblem(value);
        if (problem === undefined) kept[name] = (value as string).trim();
        else problems.push(`${TOKENS_SETTING}.${kind}: the value of ${name} ${problem}, so it is ignored.`);
      }
    }
    if (Object.keys(kept).length > 0) tokens[kind as ThemeKind] = kept;
  }
  return { tokens, problems };
}

/**
 * The stylesheet that applies `tokens`, as `themeTokensOf` checked them. Each value is set on the document and on every element, marked important, so
 * it wins over the panel's own declarations, a style's or a component's among them, and tokens built from it follow.
 */
export function tokenStyle(tokens: ThemeTokens | undefined): string {
  if (tokens === undefined) return '';
  return THEME_KINDS.flatMap((kind) => {
    const values = Object.entries(tokens[kind] ?? {});
    if (values.length === 0) return [];
    const scope = `:root:has(> ${KIND_SELECTORS[kind]})`;
    return [`${scope}, ${scope} * { ${values.map(([name, value]) => `${name}: ${value} !important;`).join(' ')} }`];
  }).join('\n');
}

/** The kind of the theme whose body classes are `classes`. */
export function themeKindOf(classes: { contains(name: string): boolean }): ThemeKind {
  if (classes.contains('vscode-high-contrast-light')) return 'highContrastLight';
  if (classes.contains('vscode-high-contrast')) return 'highContrast';
  return classes.contains('vscode-light') ? 'light' : 'dark';
}
