/// <reference lib="dom" />
import { codeTokens, type CodeToken } from '@g-code/core/code-tokens';

function nodeOf(token: CodeToken): Node {
  if (typeof token === 'string') return document.createTextNode(token);
  const span = document.createElement('span');
  span.className = token.classes;
  for (const part of token.content) span.appendChild(nodeOf(part));
  return span;
}

/** The code as text nodes inside token spans, or as one text node for a language the panel does not color. */
export function highlight(code: string, label: string | undefined): Node[] {
  return codeTokens(code, label).map(nodeOf);
}
