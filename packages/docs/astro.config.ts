import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unified } from '@astrojs/markdown-remark';
import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import type { AstroIntegration } from 'astro';
import { defineConfig } from 'astro/config';
import rehypeMermaid from 'rehype-mermaid';
import { parse } from 'yaml';
import { catalogSchema } from './src/scenario/schema';
import { loadSite, siteOptions } from './src/scenario/site';

const root = path.dirname(fileURLToPath(import.meta.url));
// Bundled pages lose their own path, so site.ts finds the package through this.
process.env['GDOCS_ROOT'] = root;

const THAI_FONT = ['400', '600'].map((weight) => pathToFileURL(createRequire(import.meta.url).resolve(`@fontsource/noto-sans-thai/${weight}.css`)));

const catalog = catalogSchema.parse(parse(readFileSync(path.join(root, 'src/data/catalog.yaml'), 'utf8')));
const pagesIn = (dir: string): boolean => existsSync(dir) && readdirSync(dir).some((name) => /\.mdx?$/.test(name));

// Every chapter starts closed; Starlight opens the one that holds the current page.
const chapters = catalog.chapters.map((chapter) => {
  const directory = `scenarios/${chapter.prefix}`;
  const items = pagesIn(path.join(root, 'src/content/docs', directory)) ? [{ autogenerate: { directory } }] : [{ label: 'ยังไม่มีหน้า', link: `/scenarios/#ch-${chapter.number}` }];
  return { label: chapter.thai, collapsed: true, items };
});

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
  // A cold dev server otherwise finds the islands' imports only when a page asks for them, re-optimizes, and the
  // half-loaded page fails to hydrate with "504 Outdated Optimize Dep" until a restart.
  vite: { optimizeDeps: { include: ['@xyflow/react', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'] } },
  markdown: {
    // Mermaid fences skip Expressive Code and become inline SVG at build, so they read with JS off and in print.
    syntaxHighlight: { type: 'shiki', excludeLangs: ['mermaid'] },
    // The renderer loads the page's Thai font too: measured in a fallback font, labels come out clipped.
    processor: unified({
      rehypePlugins: [[rehypeMermaid, { strategy: 'inline-svg', css: THAI_FONT, mermaidConfig: { fontFamily: '"Noto Sans Thai", sans-serif', theme: 'neutral', htmlLabels: false, flowchart: { htmlLabels: false } } }]],
    }),
  },
  integrations: [
    starlight({
      title: 'Geno ทำงานอย่างไร',
      description: 'ทัวร์ทีละขั้นผ่าน harness ของ Geno: AI ทำอะไร harness ทำอะไร จนจบ turn',
      defaultLocale: 'root',
      locales: { root: { label: 'ไทย', lang: 'th' } },
      customCss: ['@fontsource-variable/inter', '@fontsource/noto-sans-thai/400.css', '@fontsource/noto-sans-thai/600.css', './src/styles/docs.css'],
      components: { MarkdownContent: './src/overrides/MarkdownContent.astro', ThemeProvider: './src/overrides/ThemeProvider.astro', ThemeSelect: './src/overrides/ThemeSelect.astro', PageTitle: './src/overrides/PageTitle.astro' },
      sidebar: [
        { label: 'เริ่มต้น', items: [{ label: 'หน้าแรก', link: '/' }, { label: 'วิธีอ่านทัวร์', link: '/start/how-to-read/' }] },
        { label: 'พื้นฐาน', items: [{ autogenerate: { directory: 'foundations' } }] },
        { label: 'Tool ในการใช้งานจริง', items: [] },
        { label: 'สถานการณ์', items: chapters },
        { label: 'แผนที่ระบบ', link: '/map/' },
        { label: 'แนวคิดหลัก', items: [{ autogenerate: { directory: 'concepts' } }] },
        { label: 'อ้างอิง', items: [{ label: 'ดัชนีสถานการณ์', link: '/scenarios/' }] },
      ],
    }),
    react(),
    scenarioGate(),
  ],
});
