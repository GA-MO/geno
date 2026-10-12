/**
 * Writes the Fumadocs meta.json files that order the sidebar. A folder keeps the order its meta.json already lists,
 * drops pages that are gone and adds new ones at the end by file name; the scenario chapters follow catalog.yaml.
 * Rerun after adding a page or a chapter, then move the new page where it belongs in its meta.json.
 * Usage: pnpm --filter @g-code/docs meta
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { catalogSchema } from '../src/scenario/schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'src/content/docs');
const catalog = catalogSchema.parse(parse(readFileSync(path.join(root, 'src/data/catalog.yaml'), 'utf8')));

function orderedPages(dir: string): string[] {
  const pages = readdirSync(path.join(docs, dir))
    .filter((name) => /\.mdx?$/.test(name) && name !== 'index.mdx' && name !== 'index.md')
    .map((name) => name.replace(/\.mdx?$/, ''))
    .sort();
  const file = path.join(docs, dir, 'meta.json');
  const listed = existsSync(file) ? ((JSON.parse(readFileSync(file, 'utf8')) as { pages?: string[] }).pages ?? []) : [];
  const kept = listed.filter((name) => pages.includes(name));
  // The rest marker keeps a page added since the last run in the sidebar, at the end.
  return [...kept, ...pages.filter((name) => !kept.includes(name)), '...'];
}

function write(dir: string, meta: object): void {
  writeFileSync(path.join(docs, dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
}

const chapters = catalog.chapters.map((chapter) =>
  existsSync(path.join(docs, 'scenarios', chapter.prefix)) ? chapter.prefix : `[${chapter.thai}](/scenarios#ch-${chapter.number})`,
);

write('.', {
  pages: ['---เริ่มต้น---', '[หน้าแรก](/)', '[วิธีอ่านทัวร์](/start/how-to-read)', 'foundations', 'practice', 'scenarios', '[แผนที่ระบบ](/map)', 'concepts', '---อ้างอิง---', '[ดัชนีสถานการณ์](/scenarios)'],
});
write('foundations', { title: 'พื้นฐาน', defaultOpen: true, pages: orderedPages('foundations') });
write('practice', { title: 'Tool ในการใช้งานจริง', defaultOpen: true, pages: orderedPages('practice') });
write('concepts', { title: 'แนวคิดหลัก', defaultOpen: true, pages: orderedPages('concepts') });
write('scenarios', { title: 'สถานการณ์', defaultOpen: true, pages: chapters });
for (const chapter of catalog.chapters) {
  if (existsSync(path.join(docs, 'scenarios', chapter.prefix))) write(`scenarios/${chapter.prefix}`, { title: chapter.thai, pages: orderedPages(`scenarios/${chapter.prefix}`) });
}
