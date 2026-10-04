import type { FimInputs, Snippet } from './completion.js';

export const FIM_TOKENS = {
  repo: '<|repo_name|>',
  file: '<|file_sep|>',
  prefix: '<|fim_prefix|>',
  suffix: '<|fim_suffix|>',
  middle: '<|fim_middle|>',
} as const;

export type FimBudget = {
  readonly prefixTokens: number;
  readonly suffixTokens: number;
  readonly snippetTokens: number;
};

export const DEFAULT_FIM_BUDGET: FimBudget = { prefixTokens: 1024, suffixTokens: 256, snippetTokens: 512 };

// Code runs about 3.5 characters per Qwen token; 3 overestimates so a trimmed prompt never exceeds its budget.
const CHARS_PER_TOKEN = 3;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

const charsFor = (tokens: number): number => Math.max(0, tokens) * CHARS_PER_TOKEN;

/** The last whole lines of `text` that fit; the cursor line is cut from its start only when it alone is too long. */
function keepTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  const cursorLine = lines.pop()!;
  if (cursorLine.length >= maxChars) return cursorLine.slice(cursorLine.length - maxChars);
  let kept = cursorLine;
  for (const line of lines.reverse()) {
    if (kept.length + line.length + 1 > maxChars) break;
    kept = `${line}\n${kept}`;
  }
  return kept;
}

/** The first whole lines of `text` that fit; the cursor line is cut from its end only when it alone is too long. */
function keepHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const [cursorLine, ...lines] = text.split('\n');
  if (cursorLine!.length >= maxChars) return cursorLine!.slice(0, maxChars);
  let kept = cursorLine!;
  for (const line of lines) {
    if (kept.length + line.length + 1 > maxChars) break;
    kept = `${kept}\n${line}`;
  }
  return kept;
}

const fileHeader = (path: string): string => `${FIM_TOKENS.file}${path}\n`;

/** Whole lines from the top of each snippet, most relevant snippet first, until the budget runs out. */
function fitSnippets(snippets: readonly Snippet[], tokens: number): Snippet[] {
  let left = charsFor(tokens);
  const kept: Snippet[] = [];
  for (const snippet of snippets) {
    const room = left - fileHeader(snippet.path).length;
    const lines = snippet.text.replace(/\n$/, '').split('\n');
    let text = '';
    for (const line of lines) {
      if (text.length + line.length + 1 > room) break;
      text += `${line}\n`;
    }
    if (text === '') continue;
    kept.push({ path: snippet.path, text });
    left -= fileHeader(snippet.path).length + text.length;
  }
  return kept;
}

export type FimPrompt = {
  readonly prompt: string;
  /** The inputs as trimmed into the prompt. */
  readonly inputs: FimInputs;
  readonly tokens: number;
  /** Code already sits before the cursor on its line, so only the rest of that line is wanted. */
  readonly singleLine: boolean;
};

/** Qwen2.5-Coder repository-level FIM: other files under <|file_sep|>, then the current file's prefix, suffix, middle. */
export function buildFimPrompt(inputs: FimInputs, budget: FimBudget): FimPrompt {
  const trimmed: FimInputs = {
    repo: inputs.repo,
    path: inputs.path,
    prefix: keepTail(inputs.prefix, charsFor(budget.prefixTokens)),
    suffix: keepHead(inputs.suffix, charsFor(budget.suffixTokens)),
    snippets: fitSnippets(inputs.snippets, budget.snippetTokens),
  };
  // The most relevant snippet goes last, nearest the cursor, where the model attends to it most.
  const context = trimmed.snippets
    .toReversed()
    .map((snippet) => fileHeader(snippet.path) + snippet.text)
    .join('');
  const prompt =
    `${FIM_TOKENS.repo}${trimmed.repo}\n${context}${fileHeader(trimmed.path)}` +
    `${FIM_TOKENS.prefix}${trimmed.prefix}${FIM_TOKENS.suffix}${trimmed.suffix}${FIM_TOKENS.middle}`;
  const cursorLine = inputs.prefix.slice(inputs.prefix.lastIndexOf('\n') + 1);
  return { prompt, inputs: trimmed, tokens: estimateTokens(prompt), singleLine: cursorLine.trim() !== '' };
}
