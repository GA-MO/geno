import path from 'node:path';
import { PAGE_IMAGE_TYPES, type PageImageType } from '@g-code/core/share-page';

export const PAGES_FOLDER = 'geno-pages';

/** The folder setting as path segments inside the workspace; one that is absolute or climbs out of it is the default. */
export function pagesFolderOf(setting: string | undefined): readonly string[] {
  const parts = (setting ?? '').split(/[/\\]/).filter((part) => part !== '' && part !== '.');
  return parts.length === 0 || parts.includes('..') || path.isAbsolute(setting ?? '') || /^[a-z]:/i.test(setting ?? '') ? [PAGES_FOLDER] : parts;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The file a markdown image names and its type, when the page may inline it: an image file inside one of `roots`, by
 * a path relative to the first root, an absolute path or a `file:` address. A web image or any other file is undefined.
 */
export function imageFile(href: string, roots: readonly string[]): { readonly file: string; readonly type: PageImageType } | undefined {
  let file: string;
  try {
    if (/^file:\/\//i.test(href)) file = decodeURIComponent(new URL(href).pathname);
    else if (SCHEME.test(href) || href.startsWith('//') || roots[0] === undefined) return undefined;
    else file = path.resolve(roots[0], decodeURIComponent(href.split(/[?#]/)[0]!));
  } catch {
    return undefined;
  }
  const type = PAGE_IMAGE_TYPES[path.extname(file).slice(1).toLowerCase() as keyof typeof PAGE_IMAGE_TYPES];
  const inside = roots.some((root) => {
    const relative = path.relative(root, file);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  return type === undefined || !inside ? undefined : { file: path.resolve(file), type };
}

/** What the user said about a name already taken: replace that file, keep both under a new name, or neither. */
export type Overwrite = 'replace' | 'keep-both' | undefined;

/**
 * The file name a page is saved under in its folder: `name` while it is free. A taken name is replaced only when
 * `ask` says so; keep-both picks the first free `<stem>-<n>.html`.
 */
export async function chooseName(name: string, taken: (name: string) => Promise<boolean>, ask: (name: string, beside: string) => Promise<Overwrite>): Promise<string | undefined> {
  if (!(await taken(name))) return name;
  const stem = name.replace(/\.html$/, '');
  let n = 2;
  while (await taken(`${stem}-${n}.html`)) n++;
  const beside = `${stem}-${n}.html`;
  const choice = await ask(name, beside);
  return choice === 'replace' ? name : choice === 'keep-both' ? beside : undefined;
}
