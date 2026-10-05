/// <reference lib="dom" />
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

/** Every fence label the panel colors, to the grammar that colors it. */
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

function nodeOf(token: string | Prism.Token): Node {
  if (typeof token === 'string') return document.createTextNode(token);
  const span = document.createElement('span');
  const aliases = token.alias === undefined ? [] : Array.isArray(token.alias) ? token.alias : [token.alias];
  span.className = ['token', token.type, ...aliases].join(' ');
  const content = token.content;
  for (const part of Array.isArray(content) ? content : [content]) span.appendChild(nodeOf(part));
  return span;
}

/** The code as text nodes inside token spans, or as one text node for a language the panel does not color. */
export function highlight(code: string, label: string | undefined): Node[] {
  const name = GRAMMARS[(label ?? '').trim().toLowerCase()];
  const grammar = name === undefined ? undefined : Prism.languages[name];
  return grammar === undefined ? [document.createTextNode(code)] : Prism.tokenize(code, grammar).map(nodeOf);
}
