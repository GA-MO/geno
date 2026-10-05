import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { BOUNDARIES } from './boundaries.rules.js';

/**
 * One import in the sources. `from` is a repo-relative path. `to` is a repo-relative path when the import resolves to
 * a file in the repo, workspace packages included, and the bare specifier otherwise (`vscode`, `node:fs`, `zod`).
 */
export type Edge = { readonly from: string; readonly to: string; readonly typeOnly: boolean };
export type Violation = { readonly rule: string; readonly message: string };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = /\.m?tsx?$/;
const NODE_BUILTINS = new Set(builtinModules);

export function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || NODE_BUILTINS.has(specifier.split('/')[0] ?? specifier);
}

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function importsOf(file: string): { readonly specifier: string; readonly typeOnly: boolean }[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
  const found: { specifier: string; typeOnly: boolean }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
      const allTypes = clause !== undefined && clause.name === undefined && named !== undefined && named.length > 0 && named.every((element) => element.isTypeOnly);
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: clause?.isTypeOnly === true || allTypes });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0])) {
      found.push({ specifier: node.arguments[0].text, typeOnly: false });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push({ specifier: node.argument.literal.text, typeOnly: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every import in the given source directories, resolved the way `tsc` resolves them. */
export function importGraph(dirs: readonly string[], root = ROOT): Edge[] {
  const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const host = ts.createModuleResolutionCache(root, (name) => name, options);
  const relative = (file: string): string => path.relative(root, file).split(path.sep).join('/');
  return dirs.flatMap((dir) =>
    sourcesUnder(path.join(root, dir)).flatMap((file) =>
      importsOf(file).map(({ specifier, typeOnly }) => {
        const resolved = ts.resolveModuleName(specifier, file, options, ts.sys, host).resolvedModule?.resolvedFileName;
        const inRepo = resolved !== undefined && !relative(resolved).startsWith('..') && !relative(resolved).includes('node_modules/');
        return { from: relative(file), to: inRepo ? relative(resolved) : specifier, typeOnly };
      }),
    ),
  );
}

const under = (file: string, dir: string): boolean => file.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
const packageOf = (file: string): string | undefined => /^packages\/[^/]+/.exec(file)?.[0];

/** Files reachable from the entries along value imports; type-only imports add no code to a bundle. */
function reachable(edges: readonly Edge[], entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const edge of edges) if (edge.from === file && !edge.typeOnly && packageOf(edge.to) !== undefined) stack.push(edge.to);
  }
  return seen;
}

/** Strongly connected components of more than one file, or a file importing itself (Tarjan). */
function cycles(edges: readonly Edge[]): string[][] {
  const next = new Map<string, string[]>();
  for (const edge of edges) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  const visit = (file: string): void => {
    index.set(file, index.size);
    low.set(file, index.get(file)!);
    stack.push(file);
    onStack.add(file);
    for (const to of next.get(file) ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(file, Math.min(low.get(file)!, low.get(to)!));
      } else if (onStack.has(to)) low.set(file, Math.min(low.get(file)!, index.get(to)!));
    }
    if (low.get(file) !== index.get(file)) return;
    const component: string[] = [];
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      onStack.delete(member);
      component.push(member);
      if (member === file) break;
    }
    if (component.length > 1 || (next.get(file) ?? []).includes(file)) found.push(component.sort());
  };
  for (const file of [...next.keys()].sort()) if (!index.has(file)) visit(file);
  return found;
}

/** Checks the import graph against the boundary rules, minus the listed exceptions. */
export function checkBoundaries(edges: readonly Edge[]): Violation[] {
  const rules = BOUNDARIES;
  const excepted = (from: string, to: string): boolean => rules.exceptions.some((exception) => exception.from === from && exception.to === to);
  const violations: Violation[] = [];
  const crossing = (rule: string, edge: Edge, why: string): void => {
    if (!excepted(edge.from, edge.to)) violations.push({ rule, message: `${edge.from} imports ${edge.to}: ${why}` });
  };

  for (const edge of edges) {
    for (const layer of rules.layers) {
      if (!under(edge.from, layer.from)) continue;
      const banned = layer.mayNotImport.find((dir) => under(edge.to, dir));
      if (banned !== undefined) crossing(layer.name, edge, `${layer.from} may not import ${banned}`);
      if (layer.nodeBuiltins !== undefined && isNodeBuiltin(edge.to) && !layer.nodeBuiltins.includes(edge.to.replace(/^node:/, ''))) {
        crossing(layer.name, edge, `${layer.from} may use only ${layer.nodeBuiltins.map((name) => `node:${name}`).join(', ')} from Node`);
      }
    }
    for (const gate of rules.gates) {
      if (under(edge.from, gate.inside) && under(edge.to, gate.within) && !under(edge.to, gate.inside) && !gate.through.includes(edge.to)) {
        crossing(gate.name, edge, `${gate.inside} reaches the rest of ${gate.within} only through ${gate.through.join(', ')}`);
      }
    }
  }

  for (const bundle of rules.bundles) {
    const files = reachable(edges, bundle.entries);
    for (const edge of edges) {
      if (files.has(edge.from) && (edge.to === 'vscode' || isNodeBuiltin(edge.to))) {
        crossing(bundle.name, edge, `it runs in the ${bundle.runsIn}, which has no ${edge.to}`);
      }
    }
  }

  // Type-only imports are erased before anything loads, so only value imports can form a cycle that matters.
  const values = edges.filter((edge) => !edge.typeOnly && packageOf(edge.from) !== undefined && packageOf(edge.from) === packageOf(edge.to));
  for (const component of cycles(values)) violations.push({ rule: 'no-cycles', message: `import cycle among ${component.join(', ')}` });
  return violations;
}

/** The repo's own graph checked against its rules. */
export function checkRepo(): Violation[] {
  return checkBoundaries(importGraph(BOUNDARIES.sources));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const violations = checkRepo();
  for (const { rule, message } of violations) console.error(`${rule}: ${message}`);
  console.log(violations.length === 0 ? 'boundaries: no crossings' : `boundaries: ${violations.length} crossing(s)`);
  process.exitCode = violations.length === 0 ? 0 : 1;
}
