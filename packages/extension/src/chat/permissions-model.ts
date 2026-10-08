export type RuleEffectView = 'allow' | 'ask' | 'deny';

/** A workspace rule as Settings lists it: a command or `Read(path)` and `Edit(path)`, as the user would type it. */
export type PermissionRuleView = { readonly id: string; readonly effect: RuleEffectView; readonly text: string };

/** `refused` is why the engine would not save the last rule the user typed. */
export type PermissionsListing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly workspace: string; readonly rules: readonly PermissionRuleView[]; readonly refused?: string | undefined }
  | { readonly kind: 'failed'; readonly message: string };

export type PermissionsToView = { readonly type: 'permissions'; readonly listing: PermissionsListing };

/** Each is answered with a `permissions` listing. */
export type PermissionsFromView =
  | { readonly type: 'permissions-list' }
  | { readonly type: 'permissions-add'; readonly effect: RuleEffectView; readonly text: string }
  | { readonly type: 'permissions-remove'; readonly id: string };
