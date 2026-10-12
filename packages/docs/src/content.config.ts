import { glob } from 'astro/loaders';
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { pagePayloadsSchema, scenarioSchema } from './scenario/schema';

const base = './src/content/docs';

export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: '**/*.{md,mdx}', base }),
    schema: z.object({
      title: z.string(),
      description: z.string().optional(),
      // Left over from Starlight in the pages: the hero still draws the home page; meta.json replaced `sidebar`.
      template: z.enum(['doc', 'splash']).optional(),
      hero: z.object({ tagline: z.string(), actions: z.array(z.object({ text: z.string(), link: z.string(), variant: z.string().optional(), icon: z.string().optional() })) }).optional(),
      sidebar: z.object({ order: z.number() }).optional(),
      tableOfContents: z.boolean().optional(),
      scenario: scenarioSchema.optional(),
      payloads: pagePayloadsSchema.optional(),
    }),
  }),
  meta: defineCollection({
    loader: glob({ pattern: '**/meta.json', base }),
    schema: z.object({ title: z.string().optional(), pages: z.array(z.string()).optional(), defaultOpen: z.boolean().optional() }),
  }),
};
