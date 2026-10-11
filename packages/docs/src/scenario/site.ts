import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse, YAMLParseError } from 'yaml';
import type { z } from 'astro/zod';
import { compileScenario } from './compile.js';
import type { CodeRef, Link, PartKey, Problem, Scenario, StepId } from './model.js';
import { sourceIndex } from './refs.js';
import { catalogSchema, fragmentSchema, isUse, lanesSchema, PRIORITIES, scenarioSchema, type CatalogIn, type LanesIn, type StepIn } from './schema.js';

/**
 * The one loader, Node only. Reads lanes.yaml, catalog.yaml, the fragments and every page with `scenario:`
 * frontmatter, then compiles each scenario against the source tree. The pages, the build gate and
 * `pnpm docs:check` all call it, so the build and the check cannot disagree.
 */

export interface SiteOptions {
  /** packages/docs */
  readonly docsRoot: string;
  /** The monorepo root, where packages/ lives. */
  readonly repoRoot: string;
}

export interface Visit {
  readonly scenario: string;
  readonly title: string;
  readonly href: string;
  /** The first step of the scenario's walks at this part. */
  readonly step: StepId;
}

export interface Site {
  readonly lanes: LanesIn;
  readonly catalog: CatalogIn;
  readonly scenarios: Readonly<Record<string, Scenario>>;
  /** Catalog id -> its title and the page that covers it, if any. */
  readonly links: Readonly<Record<string, Link>>;
  /** `lane.part` -> where the part lives in the code. */
  readonly partRefs: Readonly<Record<string, CodeRef>>;
  /** System-map node -> the scenarios that pass through it. */
  readonly visits: Readonly<Record<string, readonly Visit[]>>;
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

/** zod issues as Problems whose path reads like the YAML: `scenario.steps[3].lane`. */
function issuesOf(file: string, error: z.ZodError, prefix = ''): Problem[] {
  return error.issues.map((issue) => ({
    level: 'error',
    file,
    path: issue.path.reduce<string>((at, key) => (typeof key === 'number' ? `${at}[${key}]` : at === '' ? String(key) : `${at}.${String(key)}`), prefix) || '(root)',
    message: issue.message,
  }));
}

/** Parsed YAML, or a Problem on the file's own line when it does not parse. `offset` counts lines before the YAML. */
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
      return [row.id, page === undefined ? { id: row.id, title: row.thai } : { id: row.id, title: row.thai, href: page.href }];
    }),
  );

  const source = sourceIndex(options.repoRoot);
  const partRefs: Record<string, CodeRef> = {};
  lanes.lanes.forEach((lane, i) =>
    lane.parts.forEach((part, j) => {
      const resolved = source.resolve(part.ref);
      if (typeof resolved === 'string') problems.push({ level: 'error', file: `${DATA}/lanes.yaml`, path: `lanes[${i}].parts[${j}].ref`, message: resolved });
      else partRefs[`${lane.id}.${part.id}`] = resolved;
    }),
  );
  const scenarios: Record<string, Scenario> = {};
  for (const { page, scenario } of authored) {
    const result = compileScenario(scenario, { file: page.file, id: page.id, href: page.href, title: page.title, lanes, fragments, source, catalog: links });
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
  const visits: Record<string, Visit[]> = {};
  for (const scenario of Object.values(scenarios)) {
    const seen = new Set<string>();
    for (const id of Object.keys(scenario.via)) {
      const step = scenario.steps[id]!;
      if (seen.has(step.part)) continue;
      seen.add(step.part);
      (visits[step.part] ??= []).push({ scenario: scenario.id, title: scenario.title, href: scenario.href, step: step.id });
    }
  }
  return visits;
}

/** `lane.part` -> the part's Thai label, for the tour's lane line. */
export function partLabels(lanes: LanesIn): Record<string, string> {
  return Object.fromEntries(lanes.lanes.flatMap((lane) => lane.parts.map((part) => [`${lane.id}.${part.id}`, part.label])));
}

let memo: { readonly key: string; readonly site: Site } | undefined;

/** The options the site runs with: astro.config.ts sets GDOCS_ROOT, because bundled pages lose their own path. */
export function siteOptions(docsRoot = process.env['GDOCS_ROOT'] ?? process.cwd()): SiteOptions {
  return { docsRoot, repoRoot: path.resolve(docsRoot, '../..') };
}

/** loadSite, reused until an input file changes, so every page of one build shares one load. */
export function siteFor(options = siteOptions()): Site {
  const inputs = [...filesUnder(path.join(options.docsRoot, DATA), /\.yaml$/), ...filesUnder(path.join(options.docsRoot, PAGES), /\.mdx?$/)];
  const key = inputs.map((file) => `${file}:${statSync(file).mtimeMs}`).join('|');
  if (memo?.key !== key) memo = { key, site: loadSite(options) };
  return memo.site;
}

/** The compiled scenario behind a page, or an error naming every problem in it. */
export function scenarioFor(file: string): Scenario {
  const site = siteFor();
  const scenario = Object.values(site.scenarios).find((candidate) => candidate.file === file);
  if (scenario !== undefined) return scenario;
  const mine = site.problems.filter((problem) => problem.file === file && problem.level === 'error');
  throw new Error(`${file} has problems:\n${mine.map((problem) => `  ${problem.path}  ${problem.message}`).join('\n')}`);
}
