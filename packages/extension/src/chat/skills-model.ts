import type { CatalogHit, CatalogKind, CatalogPreviewResponse, InstalledItem, InstallScope } from '@g-code/core';

/** What Geno loads now, and the catalogs `gcode.skills.catalogs` lists. */
export type SkillsListing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly items: readonly InstalledItem[]; readonly pluginSkills: number; readonly catalogs: readonly string[] }
  | { readonly kind: 'failed'; readonly message: string };

export type CatalogResults =
  | { readonly kind: 'idle' }
  | { readonly kind: 'searching'; readonly query: string }
  | { readonly kind: 'found'; readonly query: string; readonly hits: readonly CatalogHit[]; readonly problems: readonly string[] }
  | { readonly kind: 'failed'; readonly query: string; readonly message: string };

/** One catalog entry, as the page keys it: a name is unique per catalog and kind. */
export type EntryRef = { readonly catalog: string; readonly kind: CatalogKind; readonly name: string };

export const entryKey = (ref: EntryRef): string => `${ref.catalog}\n${ref.kind}\n${ref.name}`;

export type PreviewState =
  | { readonly kind: 'loading'; readonly key: string }
  | { readonly kind: 'shown'; readonly key: string; readonly preview: CatalogPreviewResponse }
  | { readonly kind: 'failed'; readonly key: string; readonly message: string };

/** How the last install or uninstall of an entry or item went, said under it. */
export type Outcome = { readonly key: string; readonly tone: 'busy' | 'ok' | 'failed'; readonly text: string };

export type SkillsToView =
  | { readonly type: 'skills'; readonly listing: SkillsListing }
  | { readonly type: 'catalog-results'; readonly results: CatalogResults }
  | { readonly type: 'catalog-preview'; readonly state: PreviewState }
  | { readonly type: 'catalog-outcome'; readonly outcome: Outcome };

export type SkillsFromView =
  | { readonly type: 'skills-list' }
  | { readonly type: 'catalog-search'; readonly query: string }
  | ({ readonly type: 'catalog-open' } & EntryRef)
  | ({ readonly type: 'catalog-install'; readonly scope: InstallScope } & EntryRef)
  | { readonly type: 'catalog-uninstall'; readonly id: string; readonly name: string }
  | { readonly type: 'catalog-add'; readonly text: string }
  | { readonly type: 'catalog-remove'; readonly text: string };

export const SCOPE_LABELS: Readonly<Record<InstallScope, string>> = { user: 'For you, in ~/.g-code', project: 'This workspace, in .claude' };
export const KIND_LABELS: Readonly<Record<CatalogKind, string>> = { skill: 'Skill', agent: 'Agent' };

/** The key of an outcome about the installed list, such as an uninstall, whose row is gone once it worked. */
export const INSTALLED_KEY = 'installed';
