/// <reference lib="dom" />
import type { CatalogHit, InstalledItem, InstallScope } from '@g-code/core';
import { h, icon, reconcile } from './dom.js';
import {
  entryKey,
  INSTALLED_KEY,
  KIND_LABELS,
  SCOPE_LABELS,
  type CatalogResults,
  type Outcome,
  type PreviewState,
  type SkillsFromView,
  type SkillsListing,
} from './skills-model.js';

const SEARCH_DEBOUNCE_MS = 250;
const WHERE_LABELS: Readonly<Record<InstalledItem['where'], string>> = { workspace: 'Workspace', user: 'You' };

const sizeText = (bytes: number | undefined): string =>
  bytes === undefined ? '' : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function outcomeLine(outcome: Outcome | undefined): HTMLElement | undefined {
  if (outcome === undefined) return undefined;
  return h(
    'p',
    { class: 'provider-test skills-outcome', 'data-tone': outcome.tone, role: outcome.tone === 'failed' ? 'alert' : 'status' },
    outcome.tone === 'busy' ? icon('loading', 'codicon-modifier-spin') : icon(outcome.tone === 'ok' ? 'check' : 'error'),
    h('span', {}, outcome.text),
  );
}

function installedRow(item: InstalledItem, post: (message: SkillsFromView) => void): HTMLElement {
  const install = item.install;
  return h(
    'li',
    { class: 'skills-row', 'data-kind': item.kind, 'data-where': item.where, 'data-name': item.name },
    h(
      'div',
      { class: 'skills-row-head' },
      h('span', { class: 'provider-tag skills-kind' }, KIND_LABELS[item.kind]),
      h('span', { class: 'provider-name skills-name' }, item.name),
      h('span', { class: 'provider-format skills-where' }, WHERE_LABELS[item.where]),
      h('span', { class: 'spacer' }),
      install === undefined
        ? undefined
        : h(
            'button',
            { type: 'button', class: 'link-button skills-uninstall', 'aria-label': `Uninstall ${item.name}`, onclick: () => post({ type: 'catalog-uninstall', id: install.id, name: item.name }) },
            'Uninstall',
          ),
    ),
    h('p', { class: 'skills-description' }, item.loads ? item.description : 'Not loading: the files Geno installed here are gone or changed.'),
    h('p', { class: 'skills-path' }, h('code', {}, item.path), install === undefined ? undefined : h('span', {}, ` · ${install.version} from ${install.catalog}`)),
  );
}

type HitState = {
  readonly open: boolean;
  readonly preview: PreviewState | undefined;
  readonly outcome: Outcome | undefined;
  readonly scope: InstallScope;
};

function previewBlock(state: PreviewState | undefined): HTMLElement {
  if (state === undefined || state.kind === 'loading') return h('p', { class: 'provider-note skills-preview-note' }, 'Checking the file against the catalog…');
  if (state.kind === 'failed') return h('p', { class: 'provider-test skills-preview-failed', 'data-tone': 'failed', role: 'alert' }, icon('error'), h('span', {}, state.message));
  const { preview } = state;
  return h(
    'div',
    { class: 'skills-preview', 'aria-label': `${preview.file}, read-only` },
    h('p', { class: 'provider-field-label' }, preview.file, h('span', { class: 'provider-field-note' }, 'read-only, sha256 checked')),
    preview.fields.length === 0
      ? undefined
      : h('dl', { class: 'skills-fields' }, ...preview.fields.flatMap(([key, value]) => [h('dt', {}, key), h('dd', {}, value)])),
    h('pre', { class: 'skills-body', tabindex: '0' }, preview.body.trim() === '' ? '(no body)' : preview.body),
  );
}

function hitCard(hit: CatalogHit, state: HitState, post: (message: SkillsFromView) => void, toggle: () => void, choose: (scope: InstallScope) => void): HTMLElement {
  const ref = { catalog: hit.catalog, kind: hit.kind, name: hit.name };
  const bodyId = `skills-hit-${encodeURIComponent(entryKey(ref)).replace(/%/g, '_')}`;
  const scope = h('select', { class: 'role-provider skills-scope', 'aria-label': `Where to install ${hit.name}` }, ...Object.entries(SCOPE_LABELS).map(([value, label]) => h('option', { value }, label)));
  scope.value = state.scope;
  scope.addEventListener('change', () => choose(scope.value === 'project' ? 'project' : 'user'));
  const here = hit.installed.includes(state.scope);
  return h(
    'li',
    { class: 'provider-card skills-hit', 'data-kind': hit.kind, 'data-name': hit.name, 'data-catalog': hit.catalog },
    h(
      'button',
      { type: 'button', class: 'provider-head', 'aria-expanded': String(state.open), 'aria-controls': bodyId, onclick: toggle },
      icon(state.open ? 'chevron-down' : 'chevron-right', 'provider-chevron'),
      h('span', { class: 'provider-name' }, hit.name),
      h('span', { class: 'provider-tag skills-kind' }, KIND_LABELS[hit.kind]),
      h('span', { class: 'provider-format' }, hit.version),
      h('span', { class: 'spacer' }),
      hit.problem !== undefined
        ? h('span', { class: 'provider-state mcp-state tone-failed' }, 'Unusable')
        : hit.installed.length > 0
          ? h('span', { class: 'provider-state mcp-state tone-ok' }, 'Installed')
          : undefined,
    ),
    h('p', { class: 'skills-description skills-hit-description' }, hit.description, h('span', { class: 'skills-source' }, ` · ${hit.catalogName}`)),
    state.open &&
      h(
        'div',
        { class: 'provider-body skills-detail', id: bodyId },
        hit.problem === undefined ? undefined : h('p', { class: 'provider-test', 'data-tone': 'failed' }, icon('error'), h('span', {}, hit.problem)),
        h(
          'ul',
          { class: 'skills-files', 'aria-label': `Files of ${hit.name}` },
          ...hit.files.map((file) => h('li', {}, h('code', {}, file.path), file.size === undefined ? undefined : h('span', { class: 'skills-size' }, sizeText(file.size)))),
        ),
        hit.problem === undefined ? previewBlock(state.preview) : undefined,
        h(
          'div',
          { class: 'provider-actions skills-install' },
          scope,
          h(
            'button',
            {
              type: 'button',
              class: 'button small skills-install-button',
              disabled: hit.problem !== undefined || here || state.outcome?.tone === 'busy' || state.preview?.kind !== 'shown',
              onclick: () => post({ type: 'catalog-install', ...ref, scope: state.scope }),
            },
            here ? 'Installed' : 'Install',
          ),
        ),
        h('p', { class: 'provider-note skills-promise' }, 'Geno copies these files as data and checks each one’s sha256. Nothing in them runs when they install.'),
        outcomeLine(state.outcome),
      ),
  );
}

/**
 * Settings' Skills section: the skills and agent definitions Geno loads, and a search over the catalogs the user
 * lists. An entry opens read-only, with its main file checked against the catalog, before it can be installed.
 */
export function skillsSection(post: (message: SkillsFromView) => void) {
  let listing: SkillsListing = { kind: 'loading' };
  let results: CatalogResults = { kind: 'idle' };
  const previews = new Map<string, PreviewState>();
  const outcomes = new Map<string, Outcome>();
  const open = new Set<string>();
  const scopes = new Map<string, InstallScope>();

  const note = h('p', { class: 'provider-note skills-note' }, 'Loading…');
  const installed = h('ul', { class: 'perm-list skills-installed', 'aria-label': 'Installed skills and agents' });
  const plugins = h('p', { class: 'provider-note skills-plugins', hidden: true });
  const listOutcome = h('div', { class: 'skills-list-outcome' });
  const catalogList = h('ul', { class: 'perm-list skills-catalogs', 'aria-label': 'Catalogs' });
  const catalogInput = h('input', { class: 'provider-input skills-catalog-input', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'https://…/catalog.json or ~/catalogs/team', 'aria-label': 'Catalog URL or folder' });
  const catalogForm = h(
    'form',
    {
      class: 'perm-add skills-catalog-add',
      onsubmit: (event: Event) => {
        event.preventDefault();
        if (catalogInput.value.trim() === '') return;
        post({ type: 'catalog-add', text: catalogInput.value });
        catalogInput.value = '';
      },
    },
    catalogInput,
    h('button', { type: 'submit', class: 'button secondary small' }, 'Add'),
  );
  const query = h('input', { class: 'provider-input skills-query', type: 'search', spellcheck: 'false', autocomplete: 'off', placeholder: 'Search the catalogs', 'aria-label': 'Search the catalogs' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  query.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => post({ type: 'catalog-search', query: query.value.trim() }), SEARCH_DEBOUNCE_MS);
  });
  const searchForm = h(
    'form',
    {
      class: 'skills-search',
      role: 'search',
      onsubmit: (event: Event) => {
        event.preventDefault();
        clearTimeout(timer);
        post({ type: 'catalog-search', query: query.value.trim() });
      },
    },
    query,
  );
  const status = h('p', { class: 'provider-note skills-status' });
  const problems = h('ul', { class: 'skills-problems', 'aria-label': 'Catalog problems' });
  const hits = h('ul', { class: 'provider-list skills-hits', 'aria-label': 'Catalog entries' });

  const element = h(
    'div',
    { class: 'skills-section' },
    h('h3', { class: 'settings-heading' }, 'Skills and agents'),
    h(
      'p',
      { class: 'settings-intro' },
      'Skills and agent definitions Geno loads in this workspace and from ~/.g-code. Uninstall removes only what Geno installed, and keeps files you changed.',
    ),
    note,
    installed,
    plugins,
    listOutcome,
    h('h4', { class: 'settings-subheading' }, 'Catalogs'),
    h('p', { class: 'settings-intro' }, 'A catalog is a catalog.json index, at an https URL or in a folder on this Mac. Geno ships with none.'),
    catalogList,
    catalogForm,
    searchForm,
    status,
    problems,
    hits,
  );

  function renderListing(): void {
    if (listing.kind !== 'loaded') {
      note.hidden = false;
      note.textContent = listing.kind === 'loading' ? 'Loading…' : listing.message;
      reconcile(installed, []);
      return;
    }
    const { items, pluginSkills, catalogs } = listing;
    note.hidden = items.length > 0;
    note.textContent = 'No skills or agents in this workspace or in ~/.g-code yet.';
    reconcile(installed, items.map((item) => ({ key: `${item.where}\n${item.kind}\n${item.path}`, deps: [JSON.stringify(item)], build: () => installedRow(item, post) })));
    plugins.hidden = pluginSkills === 0;
    plugins.textContent = `Also ${pluginSkills} ${pluginSkills === 1 ? 'skill' : 'skills'} from Claude Code plugins, which Claude Code installs.`;
    reconcile(
      catalogList,
      catalogs.map((text) => ({
        key: text,
        deps: [],
        build: () =>
          h(
            'li',
            { class: 'perm-row skills-catalog', 'data-catalog': text },
            icon(/^https:/i.test(text) ? 'globe' : 'folder'),
            h('code', { class: 'perm-pattern' }, text),
            h('button', { type: 'button', class: 'link-button perm-remove', 'aria-label': `Remove the catalog ${text}`, onclick: () => post({ type: 'catalog-remove', text }) }, 'Remove'),
          ),
      })),
    );
    searchForm.hidden = catalogs.length === 0;
  }

  function renderHits(): void {
    const outcome = outcomes.get(INSTALLED_KEY);
    listOutcome.replaceChildren(...(outcome === undefined ? [] : [outcomeLine(outcome)!]));
    const none = listing.kind === 'loaded' && listing.catalogs.length === 0;
    status.hidden = false;
    if (none) status.textContent = 'Add a catalog to search it.';
    else if (results.kind === 'idle') status.textContent = '';
    else if (results.kind === 'searching') status.textContent = 'Searching…';
    else if (results.kind === 'failed') status.textContent = results.message;
    else status.textContent = results.hits.length === 0 ? (results.query === '' ? 'The catalogs list nothing.' : `Nothing matches “${results.query}”.`) : `${results.hits.length} ${results.hits.length === 1 ? 'entry' : 'entries'}`;
    status.hidden = status.textContent === '';
    const found = results.kind === 'found' && !none ? results : undefined;
    reconcile(
      problems,
      (found?.problems ?? []).map((problem) => ({ key: problem, deps: [], build: () => h('li', { class: 'provider-test', 'data-tone': 'failed' }, icon('warning'), h('span', {}, problem)) })),
    );
    reconcile(
      hits,
      (found?.hits ?? []).map((hit) => {
        const key = entryKey(hit);
        const state: HitState = { open: open.has(key), preview: previews.get(key), outcome: outcomes.get(key), scope: scopes.get(key) ?? 'user' };
        return {
          key,
          deps: [JSON.stringify(hit), state.open, state.preview, state.outcome, state.scope],
          build: () =>
            hitCard(
              hit,
              state,
              post,
              () => {
                if (open.delete(key)) return renderHits();
                open.add(key);
                if (hit.problem === undefined && previews.get(key)?.kind !== 'shown') post({ type: 'catalog-open', catalog: hit.catalog, kind: hit.kind, name: hit.name });
                renderHits();
              },
              (scope) => {
                scopes.set(key, scope);
                renderHits();
              },
            ),
        };
      }),
    );
  }

  return {
    element,
    refresh: () => post({ type: 'skills-list' }),
    listed(next: SkillsListing): void {
      listing = next;
      renderListing();
      renderHits();
    },
    found(next: CatalogResults): void {
      results = next;
      renderHits();
    },
    previewed(state: PreviewState): void {
      previews.set(state.key, state);
      renderHits();
    },
    finished(outcome: Outcome): void {
      outcomes.set(outcome.key, outcome);
      renderHits();
    },
  };
}
