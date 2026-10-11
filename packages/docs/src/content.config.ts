import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { scenarioSchema } from './scenario/schema';

// Starlight checks `scenario:` with the schema site.ts uses, so `astro dev` flags a typo in the page as you type;
// the cross-file checks (lanes, refs, covers) run in site.ts.
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema({ extend: z.object({ scenario: scenarioSchema.optional() }) }) }),
};
