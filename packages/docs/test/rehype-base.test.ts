import { describe, expect, test } from 'vitest';
import rehypeBase from '../src/lib/rehype-base.js';

const link = (href: unknown) => ({ type: 'element', tagName: 'a', properties: { href }, children: [] });
const hrefAfter = (base: string, href: unknown): unknown => {
  const tree = { type: 'root', children: [{ type: 'element', tagName: 'p', properties: {}, children: [link(href)] }] };
  rehypeBase({ base })(tree);
  return tree.children[0]!.children[0]!.properties.href;
};

describe('rehypeBase', () => {
  test('puts the base on a site path, nested anywhere in the tree', () => {
    expect(hrefAfter('/geno', '/start/glossary/')).toBe('/geno/start/glossary/');
    expect(hrefAfter('/geno', '/')).toBe('/geno/');
    expect(hrefAfter('/geno', '/scenarios/#ch-2')).toBe('/geno/scenarios/#ch-2');
  });

  test('takes the base with or without its trailing slash', () => {
    expect(hrefAfter('/geno/', '/map/')).toBe('/geno/map/');
  });

  test('leaves links that are not site paths alone', () => {
    for (const href of ['https://github.com/GA-MO/geno', '//cdn.example.com/x.js', '#step-3', 'glossary/', '../map/', 'vscode://file/a.ts:3', '', undefined, 42])
      expect(hrefAfter('/geno', href)).toBe(href);
  });

  test('changes nothing when the site is served from the root', () => {
    expect(hrefAfter('/', '/start/glossary/')).toBe('/start/glossary/');
  });

  test('puts the base on an image src and not on other attributes', () => {
    const img = { type: 'element', tagName: 'img', properties: { src: '/media/a.png', alt: '/not-a-link' }, children: [] };
    const div = { type: 'element', tagName: 'div', properties: { href: '/x/' }, children: [] };
    rehypeBase({ base: '/geno' })({ type: 'root', children: [img, div] });
    expect(img.properties).toEqual({ src: '/geno/media/a.png', alt: '/not-a-link' });
    expect(div.properties.href).toBe('/x/');
  });
});
