import {
  PERMISSION_ADD_METHOD,
  PERMISSION_REMOVE_METHOD,
  PERMISSIONS_METHOD,
  patternText,
  type PermissionAddRequest,
  type PermissionRemoveRequest,
  type PermissionsRequest,
  type PermissionsResponse,
} from '@g-code/core';
import type { Connection } from './engine.js';
import type { PermissionsFromView, PermissionsListing, PermissionsToView } from './permissions-model.js';

type Link = { readonly connection: Connection; readonly sessionId: string };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const listingOf = ({ workspace, rules }: PermissionsResponse, refused?: string): PermissionsListing => ({
  kind: 'loaded',
  workspace,
  rules: rules.map(({ id, effect, pattern }) => ({ id, effect, text: patternText(pattern) })),
  ...(refused === undefined ? {} : { refused }),
});

/** Settings' Permissions section in the extension: the rules of the shown session's workspace, kept by the engine. */
export class PermissionsHost {
  constructor(
    private readonly link: () => Promise<Link>,
    private readonly post: (message: PermissionsToView) => void,
  ) {}

  private async show(request: (link: Link) => Promise<PermissionsResponse>): Promise<void> {
    let listing: PermissionsListing;
    try {
      listing = listingOf(await request(await this.link()));
    } catch (error) {
      listing = { kind: 'failed', message: messageOf(error) };
    }
    this.post({ type: 'permissions', listing });
  }

  private list = (link: Link) => link.connection.agent.request<PermissionsResponse, PermissionsRequest>(PERMISSIONS_METHOD, { sessionId: link.sessionId });

  /** A rule the engine refuses leaves the list as it was and says why under the form. */
  private async add(effect: PermissionAddRequest['effect'], text: string): Promise<void> {
    let listing: PermissionsListing;
    try {
      const link = await this.link();
      try {
        listing = listingOf(await link.connection.agent.request<PermissionsResponse, PermissionAddRequest>(PERMISSION_ADD_METHOD, { sessionId: link.sessionId, effect, text }));
      } catch (error) {
        listing = listingOf(await this.list(link), messageOf(error));
      }
    } catch (error) {
      listing = { kind: 'failed', message: messageOf(error) };
    }
    this.post({ type: 'permissions', listing });
  }

  readonly handlers: { readonly [K in PermissionsFromView['type']]: (message: Extract<PermissionsFromView, { type: K }>) => void } = {
    'permissions-list': () => void this.show(this.list),
    'permissions-add': ({ effect, text }) => void this.add(effect, text),
    'permissions-remove': ({ id }) =>
      void this.show((link) => link.connection.agent.request<PermissionsResponse, PermissionRemoveRequest>(PERMISSION_REMOVE_METHOD, { sessionId: link.sessionId, id })),
  };
}
