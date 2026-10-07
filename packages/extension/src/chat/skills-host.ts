import * as vscode from 'vscode';
import {
  CATALOG_INSTALL_METHOD,
  CATALOG_PREVIEW_METHOD,
  CATALOG_SEARCH_METHOD,
  CATALOG_UNINSTALL_METHOD,
  SKILLS_METHOD,
  type CatalogInstallRequest,
  type CatalogInstallResponse,
  type CatalogItemRequest,
  type CatalogPreviewResponse,
  type CatalogSearchRequest,
  type CatalogSearchResponse,
  type CatalogUninstallRequest,
  type CatalogUninstallResponse,
  type SkillsRequest,
  type SkillsResponse,
} from '@g-code/core';
import type { Connection } from './engine.js';
import { entryKey, INSTALLED_KEY, KIND_LABELS, type CatalogResults, type SkillsFromView, type SkillsToView } from './skills-model.js';

type Link = { readonly connection: Connection; readonly cwd: string };

const SETTING = 'skills.catalogs';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Invalid params: /, '');

const catalogs = (): string[] => (vscode.workspace.getConfiguration('gcode').get<unknown[]>(SETTING, []) ?? []).filter((c): c is string => typeof c === 'string' && c.trim() !== '');

const setCatalogs = (next: readonly string[]) => vscode.workspace.getConfiguration('gcode').update(SETTING, next.length === 0 ? undefined : next, vscode.ConfigurationTarget.Global);

/**
 * Settings' Skills section in the extension: what the shown chat's folder loads, and the catalogs the user lists in
 * `gcode.skills.catalogs`, which the engine reads, checks and installs from.
 */
export class SkillsHost implements vscode.Disposable {
  private shown = false;
  private query = '';
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly link: () => Promise<Link>,
    private readonly post: (message: SkillsToView) => void,
  ) {
    this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!this.shown || !event.affectsConfiguration(`gcode.${SETTING}`)) return;
      void this.list();
      void this.search(this.query);
    });
  }

  private request<R, P>(method: string, params: (cwd: string) => P): Promise<R> {
    return this.link().then((link) => link.connection.agent.request<R, P>(method, params(link.cwd)));
  }

  private async list(answer?: SkillsResponse): Promise<void> {
    try {
      const { items, pluginSkills } = answer ?? (await this.request<SkillsResponse, SkillsRequest>(SKILLS_METHOD, (cwd) => ({ cwd })));
      this.post({ type: 'skills', listing: { kind: 'loaded', items, pluginSkills, catalogs: catalogs() } });
    } catch (error) {
      this.post({ type: 'skills', listing: { kind: 'failed', message: messageOf(error) } });
    }
  }

  private async search(query: string): Promise<void> {
    this.query = query;
    const listed = catalogs();
    if (listed.length === 0) return this.post({ type: 'catalog-results', results: { kind: 'idle' } });
    this.post({ type: 'catalog-results', results: { kind: 'searching', query } });
    let results: CatalogResults;
    try {
      const { hits, problems } = await this.request<CatalogSearchResponse, CatalogSearchRequest>(CATALOG_SEARCH_METHOD, (cwd) => ({ cwd, catalogs: listed, query }));
      results = { kind: 'found', query, hits, problems };
    } catch (error) {
      results = { kind: 'failed', query, message: messageOf(error) };
    }
    // A slower answer to an older query must not replace the newer one.
    if (query === this.query) this.post({ type: 'catalog-results', results });
  }

  readonly handlers: { readonly [K in SkillsFromView['type']]: (message: Extract<SkillsFromView, { type: K }>) => void } = {
    'skills-list': () => {
      this.shown = true;
      void this.list();
      void this.search(this.query);
    },
    'catalog-search': ({ query }) => void this.search(query),
    'catalog-open': ({ catalog, kind, name }) => {
      const key = entryKey({ catalog, kind, name });
      this.post({ type: 'catalog-preview', state: { kind: 'loading', key } });
      void this.request<CatalogPreviewResponse, CatalogItemRequest>(CATALOG_PREVIEW_METHOD, (cwd) => ({ cwd, catalog, kind, name })).then(
        (preview) => this.post({ type: 'catalog-preview', state: { kind: 'shown', key, preview } }),
        (error: unknown) => this.post({ type: 'catalog-preview', state: { kind: 'failed', key, message: messageOf(error) } }),
      );
    },
    'catalog-install': ({ catalog, kind, name, scope }) => {
      const key = entryKey({ catalog, kind, name });
      this.post({ type: 'catalog-outcome', outcome: { key, tone: 'busy', text: 'Checking and copying the files…' } });
      void this.request<CatalogInstallResponse, CatalogInstallRequest>(CATALOG_INSTALL_METHOD, (cwd) => ({ cwd, catalog, kind, name, scope })).then(
        async ({ record, already, skills }) => {
          const text = already ? `${KIND_LABELS[kind]} ${name} ${record.version} is already installed at ${record.target}.` : `Installed ${name} ${record.version} at ${record.target}.`;
          this.post({ type: 'catalog-outcome', outcome: { key, tone: 'ok', text } });
          await this.list(skills);
          await this.search(this.query);
        },
        (error: unknown) => this.post({ type: 'catalog-outcome', outcome: { key, tone: 'failed', text: messageOf(error) } }),
      );
    },
    'catalog-uninstall': ({ id, name }) => {
      void this.request<CatalogUninstallResponse, CatalogUninstallRequest>(CATALOG_UNINSTALL_METHOD, (cwd) => ({ cwd, id })).then(
        async ({ kept, skills }) => {
          const text = kept.length === 0 ? `Uninstalled ${name}.` : `Uninstalled ${name}. Kept ${kept.length === 1 ? 'a file' : `${kept.length} files`} you changed: ${kept.join(', ')}.`;
          this.post({ type: 'catalog-outcome', outcome: { key: INSTALLED_KEY, tone: 'ok', text } });
          await this.list(skills);
          await this.search(this.query);
        },
        (error: unknown) => this.post({ type: 'catalog-outcome', outcome: { key: INSTALLED_KEY, tone: 'failed', text: messageOf(error) } }),
      );
    },
    'catalog-add': ({ text }) => {
      const value = text.trim();
      if (value === '' || catalogs().includes(value)) return;
      void setCatalogs([...catalogs(), value]).then(undefined, warn);
    },
    'catalog-remove': ({ text }) => void setCatalogs(catalogs().filter((c) => c !== text)).then(undefined, warn),
  };

  dispose(): void {
    this.subscription.dispose();
  }
}

const warn = (error: unknown) => void vscode.window.showWarningMessage(messageOf(error));
