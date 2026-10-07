import { HOOKS_METHOD, type HooksRequest, type HooksResponse } from '@g-code/core';
import type { Connection } from './engine.js';
import type { HooksFromView, HooksListing, HooksToView } from './hooks-model.js';

type Link = { readonly connection: Connection; readonly cwd: string };

/** Settings' Hooks section in the extension: the hooks the engine finds for the shown chat's folder. */
export class HooksHost {
  constructor(
    private readonly link: () => Promise<Link>,
    private readonly post: (message: HooksToView) => void,
  ) {}

  private async show(): Promise<void> {
    let listing: HooksListing;
    try {
      const link = await this.link();
      const { trusted, hooks, problems } = await link.connection.agent.request<HooksResponse, HooksRequest>(HOOKS_METHOD, { cwd: link.cwd });
      listing = { kind: 'loaded', trusted, hooks, problems };
    } catch (error) {
      listing = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
    this.post({ type: 'hooks', listing });
  }

  readonly handlers: { readonly [K in HooksFromView['type']]: (message: Extract<HooksFromView, { type: K }>) => void } = {
    'hooks-list': () => void this.show(),
  };
}
