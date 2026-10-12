/**
 * Reads every payload card a running docs server renders (dev or preview) and fails on any card that shows part of a
 * block, or whose label disagrees with its JSON. It reads the HTML a reader gets, so it covers beat cards (through the
 * static story list), `<Payload>` cards and every tab of a tabbed card.
 *
 *   pnpm --filter @g-code/docs cards [http://localhost:4321]
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = path.join(DOCS, 'src/content/docs');
const base = (process.argv[2] ?? process.env['DOCS_URL'] ?? 'http://localhost:4321').replace(/\/$/, '');

interface Card {
  readonly page: string;
  readonly unit: string;
  readonly label: string;
  /** The tab or bar text the reader sees for this card. */
  readonly title: string;
  readonly chips: number;
  readonly note: boolean;
  readonly answers: string;
  readonly json: string;
}

const pageUrls = (): string[] =>
  readdirSync(PAGES, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.mdx?$/.test(entry.name) && /kind: payload|^payloads:/m.test(readFileSync(path.join(entry.parentPath, entry.name), 'utf8')))
    .map((entry) => `/${path.relative(PAGES, path.join(entry.parentPath, entry.name)).replace(/\.mdx?$/, '').replace(/(^|\/)index$/, '')}/`.replace(/\/+/g, '/'))
    .sort();

const decode = (text: string): string =>
  text.replace(/&(#x?[0-9a-f]+|quot|amp|lt|gt|#39|nbsp);/gi, (_, code: string) =>
    code[0] === '#' ? String.fromCodePoint(code[1] === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : ({ quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ' } as Record<string, string>)[code]!,
  );
const attr = (tag: string, name: string): string | undefined => {
  const found = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  return found === undefined ? undefined : decode(found);
};
const VOID = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'source', 'wbr']);

/** A card while its HTML is read. */
type Panel = { -readonly [K in Exclude<keyof Card, 'page' | 'title'>]: Card[K] } & { depth: number };
type Inner = 'title' | 'answers' | 'json' | 'cut' | 'fold';

/** The cards of one page's HTML: each panel of each `.mk-payload` figure, titled by its tab, or by the bar of a lone card. */
function cardsOf(page: string, html: string): Card[] {
  const cards: Card[] = [];
  let depth = 0;
  let figure: { depth: number; titles: string[]; panels: Panel[] } | undefined;
  let panel: Panel | undefined;
  const open: { depth: number; what: Inner }[] = [];
  const inside = (what: Inner): boolean => open.some((entry) => entry.what === what);
  const markup = html.replace(/<(script|style)\b[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi, '');
  for (const [, close, name, rest, raw] of markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g)) {
    if (raw !== undefined) {
      const text = decode(raw);
      if (figure !== undefined && inside('title')) figure.titles[figure.titles.length - 1] += text;
      if (panel === undefined || inside('cut') || inside('fold')) continue;
      if (inside('answers')) panel.answers += text;
      else if (inside('json')) panel.json += text;
      continue;
    }
    const tag = rest ?? '';
    if (close === '/') {
      while (open.at(-1)?.depth === depth) open.pop();
      if (panel?.depth === depth) {
        figure?.panels.push(panel);
        panel = undefined;
      }
      if (figure?.depth === depth) {
        const titles = figure.titles.map((title) => title.trim());
        figure.panels.forEach(({ depth: _, ...card }, i) => cards.push({ page, ...card, title: titles.length === 1 ? titles[0]! : (titles[i] ?? '') }));
        figure = undefined;
      }
      depth--;
      continue;
    }
    if (VOID.has(name!.toLowerCase()) || tag.endsWith('/')) continue;
    depth++;
    const classes = (attr(tag, 'class') ?? '').split(/\s+/);
    const enter = (what: Inner) => open.push({ depth, what });
    if (classes.includes('mk-payload')) figure = { depth, titles: [], panels: [] };
    if (figure !== undefined && panel === undefined && (classes.includes('mk-payload-label') || attr(tag, 'role') === 'tab')) {
      figure.titles.push('');
      enter('title');
    }
    if (classes.includes('mk-panel')) panel = { depth, unit: attr(tag, 'data-unit') ?? '', label: attr(tag, 'data-label') ?? '', chips: 0, note: false, answers: '', json: '' };
    if (panel === undefined) continue;
    if (classes.includes('mk-chip')) panel.chips++;
    if (classes.includes('mk-note')) panel.note = true;
    if (classes.includes('mk-answers')) enter('answers');
    if (classes.includes('mk-json')) enter('json');
    if (classes.includes('js-cut')) enter('cut');
    if (classes.includes('js-fold')) {
      panel.json += 'null';
      enter('fold');
    }
  }
  return cards;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const objects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.flatMap(objects) : isObject(value) ? [value, ...Object.values(value).flatMap(objects)] : [];
/** The blocks a card shows: an array of them, one block, or the content of a message. */
const blocksOf = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isObject) : !isObject(value) ? [] : typeof value['type'] === 'string' ? [value] : Array.isArray(value['content']) ? value['content'].filter(isObject) : [];

/** What the root of a card's JSON must look like for its unit. */
const SHAPES: Readonly<Record<string, (root: unknown) => boolean>> = {
  request: (root) => isObject(root) && 'model' in root && 'messages' in root,
  response: (root) => isObject(root) && root['type'] === 'message',
  stream: (root) => Array.isArray(root) && root.every((item) => item === null || (isObject(item) && 'event' in item)),
  'stream-event': (root) => isObject(root) && 'event' in root && 'data' in root,
  messages: (root) => Array.isArray(root) && root.every((item) => item === null || (isObject(item) && 'role' in item)),
  message: (root) => isObject(root) && 'role' in root && 'content' in root,
  'tool-result': (root) => blocksOf(root).length > 0 && blocksOf(root).every((block) => block['type'] === 'tool_result'),
  'model-output': (root) => blocksOf(root).length > 0 && blocksOf(root).every((block) => typeof block['type'] === 'string'),
  'request-content': (root) => blocksOf(root).length > 0 && blocksOf(root).every((block) => typeof block['type'] === 'string'),
  tools: (root) => Array.isArray(root) && root.every((item) => item === null || (isObject(item) && 'name' in item)),
  tool: (root) => isObject(root) && typeof root['name'] === 'string' && ('input_schema' in root || 'description' in root),
  system: (root) => typeof root === 'string' || blocksOf(root).every((block) => block['type'] === 'text'),
  'log-event': (root) => isObject(root) && typeof root['kind'] === 'string' && 'seq' in root,
};
const LOG_LABEL = 'บันทึกใน session log';

/** Why a card misleads a reader, or nothing. */
function faults(card: Card): string[] {
  const out: string[] = [];
  let root: unknown;
  try {
    root = JSON.parse(card.json.replace(/,(\s*[\]}])/g, '$1').replace(/,\s*$/, '')) as unknown;
  } catch (error) {
    return [`its JSON does not read back: ${(error as Error).message}`];
  }
  const shape = SHAPES[card.unit];
  if (shape === undefined) return [`unit "${card.unit}" is not one the cards know`];
  if (!shape(root)) out.push(`its JSON is not a whole ${card.unit}`);
  if (card.title !== card.label) out.push(`its title "${card.title}" is not its label "${card.label}"`);
  for (const block of objects(root)) {
    if (block['type'] === 'tool_use' && !['id', 'name', 'input'].every((key) => key in block)) out.push('a tool_use block without its id, name or input');
    if (block['type'] === 'tool_result' && !['tool_use_id', 'content'].every((key) => key in block)) out.push('a tool_result block without its tool_use_id or content');
  }
  if (card.unit === 'tool-result' && card.chips === 0) out.push('a tool result with no chip row');
  if (card.unit === 'tool-result' && !card.answers.includes('tool_use')) out.push('a tool result that does not name the call it answers');
  if (card.unit === 'log-event' && (card.label !== LOG_LABEL || !card.note)) out.push('a log event not labelled as one, or with no line on what it records');
  if (card.unit !== 'log-event' && isObject(root) && typeof root['kind'] === 'string' && 'seq' in root) out.push('a session log event labelled as something else');
  return out;
}

const urls = pageUrls();
const seen = new Map<string, Card>();
const bare: string[] = [];
for (const url of urls) {
  const response = await fetch(base + url);
  if (!response.ok) throw new Error(`${base + url} answered ${response.status}`);
  const found = cardsOf(url, await response.text());
  if (found.length === 0) bare.push(url);
  for (const card of found) if (!seen.has(card.unit + card.json)) seen.set(card.unit + card.json, card);
}
const cards = [...seen.values()];
const suspects = cards.flatMap((card) => faults(card).map((fault) => ({ card, fault })));
const byUnit = new Map<string, number>();
for (const card of cards) byUnit.set(card.unit, (byUnit.get(card.unit) ?? 0) + 1);
for (const { card, fault } of suspects) console.log(`suspect  ${card.page}  ${card.unit} "${card.label}"  ${fault}  ${card.json.slice(0, 80).replace(/\s+/g, ' ')}`);
console.log(`cards: ${cards.length} unique card(s) on ${urls.length - bare.length} of ${urls.length} page(s); ${[...byUnit].map(([unit, n]) => `${unit} ${n}`).join(', ')}; ${suspects.length} suspect(s)`);
for (const url of bare) console.log(`no card  ${url}  its source names a payload, but the page shows none`);
process.exitCode = suspects.length === 0 && bare.length === 0 ? 0 : 1;
