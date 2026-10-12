import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse, YAMLParseError } from 'yaml';
import type { z } from 'astro/zod';
import { compileScenario } from './compile.js';
import { LOOP_FILE, readEndTables, SERVE_FILE, type EndTables } from './ends.js';
import { partKeyOf, type CodeRef, type Link, type PartKey, type Problem, type Scenario, type StepId } from './model.js';
import { runFiles } from './payload.js';
import { sourceIndex } from './refs.js';
import { catalogSchema, fragmentSchema, isUse, lanesSchema, PRIORITIES, scenarioSchema, type CatalogIn, type LanesIn, type StepIn } from './schema.js';

export interface SiteOptions {
  readonly docsRoot: string;
  readonly repoRoot: string;
}

export interface Visit {
  readonly scenario: string;
  readonly title: string;
  readonly href: string;
  readonly step: StepId;
}

export interface Site {
  readonly lanes: LanesIn;
  readonly catalog: CatalogIn;
  readonly scenarios: Readonly<Record<string, Scenario>>;
  readonly links: Readonly<Record<string, Link>>;
  readonly partRefs: Readonly<Record<PartKey, CodeRef>>;
  readonly visits: Readonly<Record<PartKey, readonly Visit[]>>;
  readonly problems: readonly Problem[];
}

interface Page {
  readonly file: string;
  readonly id: string;
  readonly href: string;
  readonly title: string;
  readonly scenario: unknown;
}

const DATA = 'src/data';
const PAGES = 'src/content/docs';

const relative = (options: SiteOptions, file: string): string => path.relative(options.docsRoot, file).split(path.sep).join('/');

function filesUnder(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function issuesOf(file: string, error: z.ZodError, prefix = ''): Problem[] {
  return error.issues.map((issue) => ({
    level: 'error',
    file,
    path: issue.path.reduce<string>((at, key) => (typeof key === 'number' ? `${at}[${key}]` : at === '' ? String(key) : `${at}.${String(key)}`), prefix) || '(root)',
    message: issue.message,
  }));
}

function yamlOf(file: string, text: string, problems: Problem[], offset = 0): { readonly value: unknown } | undefined {
  try {
    return { value: parse(text) };
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error;
    const line = (error.linePos?.[0].line ?? 1) + offset;
    problems.push({ level: 'error', file, path: `line ${line}`, message: error.message.split(' at line ')[0]! });
    return undefined;
  }
}

function frontmatterOf(file: string, text: string, problems: Problem[]): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return match === null ? {} : ((yamlOf(file, match[1]!, problems, 1)?.value ?? {}) as Record<string, unknown>);
}

function pagesOf(options: SiteOptions, problems: Problem[]): Page[] {
  const root = path.join(options.docsRoot, PAGES);
  return filesUnder(root, /\.mdx?$/).flatMap((file) => {
    const data = frontmatterOf(relative(options, file), readFileSync(file, 'utf8'), problems);
    if (data['scenario'] === undefined) return [];
    const slug = path.relative(root, file).split(path.sep).join('/').replace(/\.mdx?$/, '').replace(/(^|\/)index$/, '');
    return [{ file: relative(options, file), id: path.basename(slug), href: `/${slug}/`, title: String(data['title'] ?? slug), scenario: data['scenario'] }];
  });
}

export function loadSite(options: SiteOptions): Site {
  const problems: Problem[] = [];
  const read = <T>(file: string, schema: z.ZodType<T>, prefix = ''): T | undefined => {
    const yaml = yamlOf(file, readFileSync(path.join(options.docsRoot, file), 'utf8'), problems);
    if (yaml === undefined) return undefined;
    const parsed = schema.safeParse(yaml.value);
    if (!parsed.success) problems.push(...issuesOf(file, parsed.error, prefix));
    return parsed.success ? parsed.data : undefined;
  };
  const lanes = read(`${DATA}/lanes.yaml`, lanesSchema);
  const catalog = read(`${DATA}/catalog.yaml`, catalogSchema);
  if (lanes === undefined || catalog === undefined) return { lanes: { processes: [], lanes: [] }, catalog: { chapters: [], scenarios: [] }, scenarios: {}, links: {}, partRefs: {}, visits: {}, problems };

  const fragments: Record<string, readonly StepIn[]> = {};
  for (const file of filesUnder(path.join(options.docsRoot, DATA, 'fragments'), /\.yaml$/)) {
    const steps = read(relative(options, file), fragmentSchema);
    if (steps !== undefined) fragments[path.basename(file, '.yaml')] = steps;
  }

  const pages = pagesOf(options, problems);
  const known = new Set(catalog.scenarios.map((row) => row.id));
  const coveredBy = new Map<string, Page>();
  const seenIds = new Map<string, Page>();
  const authored = pages.flatMap((page) => {
    const parsed = scenarioSchema.safeParse(page.scenario);
    if (!parsed.success) {
      problems.push(...issuesOf(page.file, parsed.error, 'scenario'));
      return [];
    }
    const twin = seenIds.get(page.id);
    if (twin !== undefined) problems.push({ level: 'error', file: page.file, path: '(file name)', message: `another scenario page is also named ${page.id}: ${twin.file}` });
    seenIds.set(page.id, page);
    parsed.data.covers.forEach((id, i) => {
      const claimed = coveredBy.get(id);
      if (!known.has(id)) problems.push({ level: 'error', file: page.file, path: `scenario.covers[${i}]`, message: `"${id}" is not in the catalog (src/data/catalog.yaml)` });
      else if (claimed !== undefined) problems.push({ level: 'error', file: page.file, path: `scenario.covers[${i}]`, message: `"${id}" is already covered by ${claimed.file}` });
      else coveredBy.set(id, page);
    });
    return [{ page, scenario: parsed.data }];
  });

  const links: Record<string, Link> = Object.fromEntries(
    catalog.scenarios.map((row) => {
      const page = coveredBy.get(row.id);
      return [row.id, page === undefined ? { id: row.id, title: row.thai } : { id: row.id, title: page.title, href: page.href }];
    }),
  );

  const source = sourceIndex(options.repoRoot);
  const runs = runFiles(options.repoRoot);
  const partRefs: Record<PartKey, CodeRef> = {};
  lanes.lanes.forEach((lane, i) =>
    lane.parts.forEach((part, j) => {
      const resolved = source.resolve(part.ref);
      if (resolved.ok) partRefs[partKeyOf(lane.id, part.id)] = resolved.ref;
      else problems.push({ level: 'error', file: `${DATA}/lanes.yaml`, path: `lanes[${i}].parts[${j}].ref`, message: resolved.reason });
    }),
  );
  const tables = readEndTables(readFileSync(path.join(options.repoRoot, LOOP_FILE), 'utf8'), readFileSync(path.join(options.repoRoot, SERVE_FILE), 'utf8'));
  if (!tables.ok) problems.push({ level: 'error', file: tables.file, path: '-', message: `${tables.reason}; until it reads, no page's end is checked` });
  const ends: EndTables = tables.ok ? tables.tables : { afterStop: new Map(), turnEnds: new Map(), goingOn: new Set() };
  const scenarios: Record<string, Scenario> = {};
  for (const { page, scenario } of authored) {
    const result = compileScenario(scenario, { file: page.file, id: page.id, href: page.href, title: page.title, lanes, fragments, source, runs, ends, catalog: links });
    if (result.ok) scenarios[page.id] = result.value;
    else problems.push(...result.problems.map((problem) => ({ ...problem, path: `scenario.${problem.path}` })));
  }

  const used = new Set(authored.flatMap(({ scenario }) => usesOf(scenario.steps)));
  for (const name of Object.keys(fragments)) if (!used.has(name)) problems.push({ level: 'warning', file: `${DATA}/fragments/${name}.yaml`, path: '-', message: 'no scenario uses this fragment' });
  for (const priority of PRIORITIES) {
    const open = catalog.scenarios.filter((row) => row.priority === priority && !coveredBy.has(row.id));
    if (open.length > 0) problems.push({ level: 'warning', file: 'catalog', path: priority, message: `${open.length} catalog scenario(s) have no page yet: ${open.map((row) => row.id).join(', ')}` });
  }

  return { lanes, catalog, scenarios, links, partRefs, visits: visitsOf(scenarios), problems };
}

function usesOf(steps: readonly StepIn[]): string[] {
  return steps.flatMap((step) => (isUse(step) ? [step.use] : (step.fork?.options ?? []).flatMap((option) => usesOf(option.steps ?? []))));
}

function visitsOf(scenarios: Readonly<Record<string, Scenario>>): Record<PartKey, Visit[]> {
  const visits: Record<PartKey, Visit[]> = {};
  for (const scenario of Object.values(scenarios)) {
    const seen = new Set<PartKey>();
    for (const id of Object.keys(scenario.via) as StepId[]) {
      const step = scenario.steps[id]!;
      if (seen.has(step.part)) continue;
      seen.add(step.part);
      (visits[step.part] ??= []).push({ scenario: scenario.id, title: scenario.title, href: scenario.href, step: step.id });
    }
  }
  return visits;
}

export function partLabels(lanes: LanesIn): Record<PartKey, string> {
  return Object.fromEntries(lanes.lanes.flatMap((lane) => lane.parts.map((part) => [partKeyOf(lane.id, part.id), part.label])));
}

let memo: { readonly key: string; readonly site: Site } | undefined;

export function siteOptions(docsRoot = process.env['GDOCS_ROOT'] ?? process.cwd()): SiteOptions {
  return { docsRoot, repoRoot: path.resolve(docsRoot, '../..') };
}

export function siteFor(options = siteOptions()): Site {
  const inputs = [...filesUnder(path.join(options.docsRoot, DATA), /\.yaml$/), ...filesUnder(path.join(options.docsRoot, PAGES), /\.mdx?$/)];
  const key = inputs.map((file) => `${file}:${statSync(file).mtimeMs}`).join('|');
  if (memo?.key !== key) memo = { key, site: loadSite(options) };
  return memo.site;
}

export function scenarioFor(file: string): Scenario {
  const site = siteFor();
  const scenario = Object.values(site.scenarios).find((candidate) => candidate.file === file);
  if (scenario !== undefined) return scenario;
  const mine = site.problems.filter((problem) => problem.file === file && problem.level === 'error');
  throw new Error(`${file} has problems:\n${mine.map((problem) => `  ${problem.path}  ${problem.message}`).join('\n')}`);
}
