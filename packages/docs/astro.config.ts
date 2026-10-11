import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import rehypeMermaid from 'rehype-mermaid';

export default defineConfig({
  markdown: {
    syntaxHighlight: { type: 'shiki', excludeLangs: ['mermaid'] },
    rehypePlugins: [[rehypeMermaid, { strategy: 'inline-svg', mermaidConfig: { fontFamily: 'Noto Sans Thai, sans-serif' } }]],
  },
  integrations: [
    starlight({
      title: 'Geno ทำงานอย่างไร',
      defaultLocale: 'root',
      locales: { root: { label: 'ไทย', lang: 'th' } },
    }),
  ],
});
