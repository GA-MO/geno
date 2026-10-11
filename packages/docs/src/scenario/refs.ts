import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { CodeRef } from './model.js';

export type Resolution = { readonly ok: true; readonly ref: CodeRef } | { readonly ok: false; readonly reason: string };

export interface SourceIndex {
  resolve(ref: string): Resolution;
  literalExists(text: string): boolean;
}

interface Declaration {
  readonly name: string;
  readonly within: readonly string[];
  readonly line: number;
  readonly overload: boolean;
}

const LITERAL_SOURCES = ['packages/core/src', 'packages/engine/src', 'packages/extension/src'];

function nameOf(node: ts.Node): ts.Identifier | ts.StringLiteral | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isVariableDeclaration(node)
  ) {
    return node.name !== undefined && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name : undefined;
  }
  return undefined;
}

function declarationsOf(file: string, text: string): Declaration[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Declaration[] = [];
  const visit = (node: ts.Node, within: readonly string[]): void => {
    const name = nameOf(node);
    if (name !== undefined) {
      const overload = ts.isFunctionDeclaration(node) && node.body === undefined;
      found.push({ name: name.text, within, line: source.getLineAndCharacterOfPosition(name.getStart(source)).line + 1, overload });
    }
    const inner = name === undefined ? within : [...within, name.text];
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(source, []);
  return found;
}

const containsInOrder = (within: readonly string[], outer: readonly string[]): boolean => {
  let at = 0;
  for (const name of within) if (name === outer[at]) at += 1;
  return at === outer.length;
};

function findDeclaration(declarations: readonly Declaration[], dotted: string): number | string {
  const names = dotted.split('.');
  const name = names.pop()!;
  const candidates = declarations.filter((declaration) => declaration.name === name && containsInOrder(declaration.within, names));
  const bodies = candidates.filter((declaration) => !declaration.overload);
  const distinct = bodies.length > 0 ? bodies : candidates;
  const shallowest = Math.min(...distinct.map((declaration) => declaration.within.length));
  const chosen = distinct.filter((declaration) => declaration.within.length === shallowest);
  if (chosen.length === 1) return chosen[0]!.line;
  if (chosen.length === 0) return `no declaration named ${dotted}`;
  return `${dotted} is declared ${chosen.length} times (lines ${chosen.map((declaration) => declaration.line).join(', ')}); qualify it as Outer.${name} or quote a line`;
}

export function sourceIndex(repoRoot: string): SourceIndex {
  const texts = new Map<string, string | undefined>();
  const declarations = new Map<string, Declaration[]>();
  let corpus: string | undefined;

  const textOf = (file: string): string | undefined => {
    if (!texts.has(file)) {
      const absolute = path.join(repoRoot, file);
      texts.set(file, existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined);
    }
    return texts.get(file);
  };

  return {
    resolve(ref) {
      const hash = ref.indexOf('#');
      const file = ref.slice(0, hash);
      const anchor = ref.slice(hash + 1);
      const text = textOf(file);
      if (text === undefined) return { ok: false, reason: `${file} does not exist` };
      let line: number | string;
      if (anchor.startsWith('"')) {
        const literal = anchor.slice(1, -1);
        const hits = text.split('\n').flatMap((content, i) => (content.includes(literal) ? [i + 1] : []));
        line = hits.length === 1 ? hits[0]! : hits.length === 0 ? `no line contains ${anchor}` : `${anchor} is on ${hits.length} lines (${hits.join(', ')}); quote more of the line`;
      } else {
        if (!declarations.has(file)) declarations.set(file, declarationsOf(file, text));
        line = findDeclaration(declarations.get(file)!, anchor);
      }
      if (typeof line === 'string') return { ok: false, reason: `${file}: ${line}` };
      return { ok: true, ref: { path: file, anchor, line, url: `vscode://file${path.join(repoRoot, file)}:${line}` } };
    },
    literalExists(text) {
      corpus ??= LITERAL_SOURCES.flatMap((dir) =>
        readdirSync(path.join(repoRoot, dir), { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && /\.(m?ts|tsx|js)$/.test(entry.name))
          .map((entry) => readFileSync(path.join(entry.parentPath, entry.name), 'utf8')),
      ).join('\n');
      return corpus.includes(text);
    },
  };
}
