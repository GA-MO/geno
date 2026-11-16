import path from 'node:path';
import { getCollection, type CollectionEntry } from 'astro:content';
import { structure, type StructuredData } from 'fumadocs-core/mdx-plugins';
import { loader, type StaticSource } from 'fumadocs-core/source';
import { withBase } from './base';

const CONTENT = 'src/content/docs';

type Files = StaticSource<{ metaData: CollectionEntry<'meta'>['data']; pageData: CollectionEntry<'docs'>['data'] & { _raw: CollectionEntry<'docs'> } }>;

const files: Files['files'] = [
  ...(await getCollection('docs')).map((page) => ({ type: 'page' as const, path: path.relative(CONTENT, page.filePath!), data: { ...page.data, _raw: page } })),
  ...(await getCollection('meta')).map((meta) => ({ type: 'meta' as const, path: path.relative(CONTENT, meta.filePath!), data: meta.data })),
];

// meta.json's `[name](/path)` links carry no `$ref` and, unlike pages, do not get the base from `baseUrl`.
export const source = loader({
  source: { files },
  baseUrl: withBase('/'),
  pageTree: { transformers: [{ file: (node) => (node.$ref === undefined && node.url.startsWith('/') ? { ...node, url: withBase(node.url) } : node) }] },
});

export function structuredDataOf(entry: CollectionEntry<'docs'>): StructuredData {
  return structure(entry.body ?? '');
}
