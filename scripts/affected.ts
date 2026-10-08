/** Which VS Code integration files a change can break, and why. selectVscode is pure; readSuites reads the suites from disk. */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** One integration file: its name, every file of its suite (repo-relative), and their joined text. */
export type Suite = { readonly name: string; readonly files: readonly string[]; readonly text: string };
export type Pick = { readonly file: string; readonly reasons: readonly string[] };

const ALL_REASON = 'test harness or dependencies changed';
const HARNESS = [
  /^vitest\.config\.ts$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^packages\/extension\/package\.json$/,
  /^packages\/extension\/build\.mts$/,
  /^packages\/extension\/test\/(launch|vscode-setup|media)\.ts$/,
  /^packages\/extension\/test\/pool\/(broker|client|host|protocol)\.ts$/,
  /^packages\/extension\/test\/suite\/(index|mac-only|shooting)\.ts$/,
  /^docker\/vscode-tests/,
  /^scripts\/(test-tmp|test-vscode|test-vscode-docker|vscode-workers|flakes)\.(ts|sh)$/,
];
/** Engine and core changes reach the panel through the protocol: these suites drive whole turns end to end. */
const ENGINE_SMOKE = ['chat', 'panel', 'working'];
/**
 * Core and engine files that shape what the model receives or what a turn logs: the opening and its environment and
 * memory, Geno's notices and arrivals, the prompt and tools each mode offers, tool result text, and the turn loop.
 */
const REQUEST_SHAPERS = [
  /^packages\/core\/src\/(agent|agent-prompts|approval|background|compaction|context|environment|fence|hidden|loop|memory|notice|request|session|subagent|terminal|tools|wake)\.ts$/,
  /^packages\/engine\/src\/(agent|background|chat|drive|environment|memory|serve|sessions|subagents|wakes)\.ts$/,
  /^packages\/engine\/src\/tools\//,
];
/** A suite that reads a request's messages, system prompt, tools or tool choice, or a session's log. */
const READS_REQUESTS = /\.(messages|system|tools|tool_choice)\b|\bofferedTools\(|['"]sessions['"]/;
/** A panel change that names nothing a suite checks still runs the suites that cover the panel at large. */
const PANEL_SMOKE = ['panel', 'chat', 'composer'];

/**
 * Whether a change to the root package.json touches only its `scripts`, which no VS Code suite runs: adding a
 * script once ran all 53 files. Anything else, a dependency or a test setting, may change what the suites run on.
 */
export function onlyScriptsChanged(before: string, after: string): boolean {
  try {
    const { scripts: _before, ...restBefore } = JSON.parse(before) as Record<string, unknown>;
    const { scripts: _after, ...restAfter } = JSON.parse(after) as Record<string, unknown>;
    return JSON.stringify(restBefore) === JSON.stringify(restAfter);
  } catch {
    return false;
  }
}

export const integrationFile =(name: string) => `packages/extension/test/${name}.integration.test.ts`;

/** Class names, data values, message types and command ids that the changed lines of panel code name. */
export function tokensOf(diff: string): Set<string> {
  const tokens = new Set<string>();
  for (const line of diff.split('\n')) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
    for (const m of line.matchAll(/\.([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/g)) tokens.add(m[1]!);
    for (const m of line.matchAll(/['"`]([a-z][a-z0-9]*(?:-[a-z0-9]+)+)['"`]/g)) tokens.add(m[1]!);
    for (const m of line.matchAll(/\btype: '([a-z][a-z-]{3,})'/g)) tokens.add(m[1]!);
    for (const m of line.matchAll(/\b(gcode\.[A-Za-z][A-Za-z.]*)/g)) tokens.add(m[1]!);
  }
  return tokens;
}

/**
 * The integration files to run for a change, each with why. `changed` are repo-relative paths and `panelDiff` is the
 * diff of `packages/extension/src`. A token that most suites mention says nothing about which one it breaks.
 */
export function selectVscode(changed: readonly string[], panelDiff: string, suites: readonly Suite[]): Pick[] {
  const reasons = new Map<string, Set<string>>();
  const add = (name: string, why: string) => {
    if (!suites.some((s) => s.name === name)) return;
    (reasons.get(name) ?? reasons.set(name, new Set()).get(name)!).add(why);
  };

  if (changed.some((path) => HARNESS.some((rule) => rule.test(path)))) for (const s of suites) add(s.name, ALL_REASON);
  for (const path of changed) for (const s of suites) if (s.files.includes(path)) add(s.name, `its test changed (${path})`);

  const engine = changed.filter((p) => /^packages\/(engine|core)\/src\//.test(p));
  if (engine.length > 0) for (const name of ENGINE_SMOKE) add(name, `engine or core changed (${engine.length} files)`);
  const shapers = changed.filter((p) => REQUEST_SHAPERS.some((rule) => rule.test(p)));
  if (shapers.length > 0) {
    for (const s of suites) if (READS_REQUESTS.test(s.text)) add(s.name, `it reads requests or the log, and ${shapers.length} files that shape them changed`);
  }

  if (changed.some((p) => /^packages\/extension\/src\//.test(p))) {
    const common = Math.ceil(suites.length * 0.6);
    let matched = false;
    const named = changed.filter((p) => /^packages\/extension\/src\//.test(p)).map((p) => p.replace(/^.*\/|\.[a-z]+$/g, ''));
    for (const token of new Set([...tokensOf(panelDiff), ...named.filter((n) => n.length > 3)])) {
      const users = suites.filter((s) => s.text.includes(token));
      if (users.length === 0 || users.length >= common) continue;
      matched = true;
      for (const s of users) add(s.name, `checks \`${token}\``);
    }
    if (!matched) for (const name of PANEL_SMOKE) add(name, 'panel code changed, and no suite names what it touched');
  }

  return [...reasons].sort(([a], [b]) => a.localeCompare(b)).map(([name, why]) => ({ file: integrationFile(name), reasons: [...why] }));
}

/**
 * The suite files an integration file runs: those it imports from `./suite/`, the ones it names to `setUp` or
 * `buildSuite`, and each of those names' `-fixture`, `-reload`, `-live`, `-ui` and `-attacks` parts.
 */
export function suiteFilesOf(integrationText: string, suiteNames: readonly string[]): string[] {
  const named = new Set<string>();
  for (const m of integrationText.matchAll(/\.\/suite\/([a-z][a-z-]*)\.js/g)) named.add(m[1]!);
  for (const m of integrationText.matchAll(/(?:setUp|buildSuite)\([^'"]*['"]([a-z][a-z-]*)['"]/g)) named.add(m[1]!);
  const files = new Set<string>();
  for (const base of named) for (const s of suiteNames) if (s === base || s.startsWith(`${base}-`)) files.add(s);
  return [...files].sort().map((s) => `packages/extension/test/suite/${s}.ts`);
}

/** Every integration file under `root` as a Suite, with the text of all its parts. */
export function readSuites(root: string): Suite[] {
  const testDir = path.join(root, 'packages/extension/test');
  const suiteNames = readdirSync(path.join(testDir, 'suite')).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3));
  return readdirSync(testDir)
    .filter((f) => f.endsWith('.integration.test.ts'))
    .map((f) => {
      const own = `packages/extension/test/${f}`;
      const files = [own, ...suiteFilesOf(readFileSync(path.join(root, own), 'utf8'), suiteNames)];
      return { name: f.replace('.integration.test.ts', ''), files, text: files.map((p) => readFileSync(path.join(root, p), 'utf8')).join('\n') };
    });
}
