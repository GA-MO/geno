import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { themeTokensOf, tokenNamesIn, TOKENS_SETTING, type ParsedTokens, type ThemeTokens } from './tokens.js';

export type TokenSettings = {
  /** The tokens the panel applies now. */
  readonly tokens: () => ThemeTokens;
  /** Reads the setting again, after it changed, and says what it ignored. */
  readonly reread: () => void;
};

/** `gcode.appearance.tokens`, checked against the tokens `stylesheet`, the panel's built CSS, declares. */
export function tokenSettings(stylesheet: string, output: vscode.OutputChannel): TokenSettings {
  let known: ReadonlySet<string> | undefined;
  let parsed: ParsedTokens | undefined;
  const read = (): ParsedTokens => {
    known ??= new Set(tokenNamesIn(readCss(stylesheet, output)));
    parsed = themeTokensOf(vscode.workspace.getConfiguration().get(TOKENS_SETTING), known);
    for (const problem of parsed.problems) output.appendLine(`appearance: ${problem}`);
    const [first, ...rest] = parsed.problems;
    if (first !== undefined) void vscode.window.showWarningMessage(rest.length === 0 ? first : `${first} (and ${rest.length} more in the Geno engine output)`);
    return parsed;
  };
  return { tokens: () => (parsed ?? read()).tokens, reread: () => void read() };
}

function readCss(stylesheet: string, output: vscode.OutputChannel): string {
  try {
    return readFileSync(stylesheet, 'utf8');
  } catch (error) {
    output.appendLine(`appearance: could not read ${stylesheet}, so no theme token applies: ${String(error)}`);
    return '';
  }
}
