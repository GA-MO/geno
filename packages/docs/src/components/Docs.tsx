import type { Root } from 'fumadocs-core/page-tree';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsPage, type DocsPageProps } from 'fumadocs-ui/layouts/docs/page';
import { RootProvider } from 'fumadocs-ui/provider/astro';
import type { ReactNode } from 'react';
import SearchDialog from './SearchDialog';

interface Props {
  readonly tree: Root;
  readonly pathname: string;
  readonly page: Pick<DocsPageProps, 'toc' | 'full'>;
  readonly children: ReactNode;
}

// The whole frame is one React island; the page body arrives as server-rendered children, and the tours inside it
// hydrate as their own islands.
export function Docs({ tree, pathname, page, children }: Props) {
  return (
    <RootProvider pathname={pathname} theme={{ attribute: ['class', 'data-theme'], defaultTheme: 'light', enableSystem: false }} search={{ SearchDialog }}>
      <DocsLayout tree={tree} nav={{ title: 'Geno ทำงานอย่างไร' }}>
        <DocsPage {...page} tableOfContent={{ enabled: page.toc !== undefined && page.toc.length > 0 }}>
          {children}
        </DocsPage>
      </DocsLayout>
    </RootProvider>
  );
}
