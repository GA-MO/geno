// prismjs' main file brings markup, css, clike and javascript; each component below needs the ones before it.
import Prism from 'prismjs';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-jsx.js';
import 'prismjs/components/prism-tsx.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-yaml.js';
import 'prismjs/components/prism-rust.js';
import 'prismjs/components/prism-go.js';
import 'prismjs/components/prism-diff.js';

/** Every fence label Geno colors, to the grammar that colors it. */
const GRAMMARS: Readonly<Record<string, string>> = {
  ts: 'typescript',
  typescript: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'json',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  py: 'python',
  python: 'python',
  yml: 'yaml',
  yaml: 'yaml',
  rs: 'rust',
  rust: 'rust',
  go: 'go',
  diff: 'diff',
  patch: 'diff',
  css: 'css',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
};

/** Code as text and Prism's token spans; `classes` is the span's class attribute, such as `token keyword`. */
export type CodeToken = string | { readonly classes: string; readonly content: readonly CodeToken[] };

function tokenOf(token: string | Prism.Token): CodeToken {
  if (typeof token === 'string') return token;
  const aliases = token.alias === undefined ? [] : Array.isArray(token.alias) ? token.alias : [token.alias];
  const content = token.content;
  return { classes: ['token', token.type, ...aliases].join(' '), content: (Array.isArray(content) ? content : [content]).map(tokenOf) };
}

/** The code as tokens, or as one string for a language Geno does not color. */
export function codeTokens(code: string, label: string | undefined): readonly CodeToken[] {
  const name = GRAMMARS[(label ?? '').trim().toLowerCase()];
  const grammar = name === undefined ? undefined : Prism.languages[name];
  return grammar === undefined ? [code] : Prism.tokenize(code, grammar).map(tokenOf);
}
