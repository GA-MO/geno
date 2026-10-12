import type { APIRoute } from 'astro';
import { getBreadcrumbItems } from 'fumadocs-core/breadcrumb';
import { createFromSource } from 'fumadocs-core/search/server';
import { source, structuredDataOf } from '../../lib/source';

const tree = source.getPageTree();

// The default trail starts at the tree root ("Docs") and counts the sidebar's separators as parents.
const server = createFromSource(source, {
  buildIndex: (page) => ({
    id: page.url,
    title: page.data.title,
    ...(page.data.description === undefined ? {} : { description: page.data.description }),
    structuredData: structuredDataOf(page.data._raw),
    url: page.url,
    breadcrumbs: getBreadcrumbItems(page.url, tree, { includeRoot: false, includeSeparator: false, includePage: false }).map((item) => String(item.name)),
  }),
});

export const GET: APIRoute = () => server.staticGET();
