import { glob } from 'astro/loaders';
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { pageSchema } from './scenario/schema';

const base = './src/content/docs';

export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: '**/*.{md,mdx}', base }),
    schema: pageSchema,
  }),
  meta: defineCollection({
    loader: glob({ pattern: '**/meta.json', base }),
    schema: z.object({ title: z.string().optional(), pages: z.array(z.string()).optional(), defaultOpen: z.boolean().optional() }),
  }),
};
