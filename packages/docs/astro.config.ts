
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unified } from '@astrojs/markdown-remark';
import react from '@astrojs/react';
import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';
import type { AstroIntegration } from 'astro';
import { rehypeCode } from 'fumadocs-core/mdx-plugins';
import { defineConfig } from 'astro/config';
import rehypeMermaid from 'rehype-mermaid';
import { loadSite, siteOptions } from './src/scenario/site';

const root = path.dirname(fileURLToPath(import.meta.url));
// Bundled pages lose their own path, so site.ts finds the package through this.
process.env['GDOCS_ROOT'] = root;

const THAI_FONT = ['400', '600'].map((weight) => pathToFileURL(createRequire(import.meta.url).resolve(`@fontsource/noto-sans-thai/${weight}.css`)));

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
  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: { include: ['@xyflow/react', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'fumadocs-ui/layouts/docs', 'fumadocs-ui/layouts/docs/page', 'fumadocs-ui/provider/astro', 'fumadocs-ui/components/dialog/search', 'fumadocs-core/search/client'] },
  },
  markdown: {
    syntaxHighlight: false,
    // Mermaid fences become inline SVG before Fumadocs' Shiki sees them, so they read with JS off and in print. The
    // renderer loads the page's Thai font too: measured in a fallback font, labels come out clipped.
    processor: unified({
      rehypePlugins: [
        [rehypeMermaid, { strategy: 'inline-svg', css: THAI_FONT, mermaidConfig: { fontFamily: '"Noto Sans Thai", sans-serif', theme: 'neutral', htmlLabels: false, flowchart: { htmlLabels: false } } }],
        rehypeCode,
      ],
    }),
  },
  integrations: [
    react(),
    mdx({ extendMarkdownConfig: true, syntaxHighlight: false }),
    scenarioGate(),
  ],
});
