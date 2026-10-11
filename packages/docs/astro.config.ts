import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unified } from '@astrojs/markdown-remark';
import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import type { AstroIntegration } from 'astro';
import { defineConfig } from 'astro/config';
import rehypeMermaid from 'rehype-mermaid';
import { parse } from 'yaml';
import type { CatalogIn } from './src/scenario/schema';
import { loadSite, siteOptions } from './src/scenario/site';

const root = path.dirname(fileURLToPath(import.meta.url));
// Bundled pages lose their own path, so site.ts finds the package through this.
process.env['GDOCS_ROOT'] = root;

const catalog = parse(readFileSync(path.join(root, 'src/data/catalog.yaml'), 'utf8')) as CatalogIn;
const pagesIn = (dir: string): boolean => existsSync(dir) && readdirSync(dir).some((name) => /\.mdx?$/.test(name));

/** One sidebar group per catalog chapter; a chapter with no pages yet links to its rows in the index. */
const chapters = catalog.chapters.map((chapter) => {
  const label = `${chapter.number}. ${chapter.thai}`;
  const directory = `scenarios/${chapter.prefix}`;
  return pagesIn(path.join(root, 'src/content/docs', directory))
    ? { label, items: [{ autogenerate: { directory } }] }
    : { label, collapsed: true, items: [{ label: 'ยังไม่มีหน้า ดูในดัชนี', link: `/scenarios/#ch-${chapter.number}` }] };
});

/** The build fails on the same problems `pnpm docs:check` reports. */
const scenarioGate = (): AstroIntegration => ({
  name: 'scenario-gate',
  hooks: {
    'astro:build:start': ({ logger }) => {
      const problems = loadSite(siteOptions(root)).problems;
      const errors = problems.filter((problem) => problem.level === 'error');
      for (const problem of errors) logger.error(`${problem.file}  ${problem.path}  ${problem.message}`);
      if (errors.length > 0) throw new Error(`${errors.length} scenario problem(s); run pnpm docs:check`);
      logger.info(`scenarios checked; ${problems.length} warning(s), see pnpm docs:check`);
    },
  },
});

export default defineConfig({
  markdown: {
    // Mermaid fences skip Expressive Code and become inline SVG at build, so they read with JS off and in print.
    syntaxHighlight: { type: 'shiki', excludeLangs: ['mermaid'] },
    processor: unified({ rehypePlugins: [[rehypeMermaid, { strategy: 'inline-svg', mermaidConfig: { fontFamily: '"Noto Sans Thai", sans-serif', theme: 'neutral' } }]] }),
  },
  integrations: [
    starlight({
      title: 'Geno ทำงานอย่างไร',
      description: 'ทัวร์ทีละขั้นผ่าน harness ของ Geno: AI ทำอะไร harness ทำอะไร จนจบ turn',
      defaultLocale: 'root',
      locales: { root: { label: 'ไทย', lang: 'th' } },
      customCss: ['@fontsource/noto-sans-thai/400.css', '@fontsource/noto-sans-thai/600.css', './src/styles/docs.css'],
      components: { MarkdownContent: './src/overrides/MarkdownContent.astro' },
      sidebar: [
        { label: 'เริ่มต้น', items: [{ label: 'หน้าแรก', link: '/' }, 'start/how-to-read'] },
        { label: 'แผนที่ระบบ', link: '/map/' },
        { label: 'แนวคิดหลัก', items: [{ autogenerate: { directory: 'concepts' } }] },
        { label: 'สถานการณ์', items: [{ label: 'ดัชนีสถานการณ์', link: '/scenarios/' }, ...chapters] },
      ],
    }),
    react(),
    scenarioGate(),
  ],
});
