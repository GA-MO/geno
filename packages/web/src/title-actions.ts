/** One action of a view's title bar, as the page's header shows it. */
export type TitleAction = {
  readonly command: string;
  readonly title: string;
  /** The codicon the manifest names as `$(name)`; an action without one shows its title. */
  readonly icon: string | undefined;
  /** In VS Code's `navigation` group, shown as an icon; any other group sits in the `…` menu. */
  readonly inline: boolean;
};

type Manifest = {
  readonly contributes?: {
    readonly commands?: readonly { readonly command: string; readonly title: string; readonly icon?: unknown }[];
    readonly menus?: { readonly 'view/title'?: readonly { readonly command: string; readonly when?: string; readonly group?: string }[] };
  };
};

const orderOf = (group = '') => {
  const [name = '', order] = group.split('@');
  return { name, order: Number(order ?? 0) || 0 };
};

/**
 * The title-bar actions the manifest contributes to `view`, in VS Code's order: the navigation group first, each
 * group by its `@` order. An entry counts when its `when` names the view with `view == <id>`; the web host has no
 * context keys, so its other clauses are not read.
 */
export function titleActions(manifest: Manifest, view: string): TitleAction[] {
  const commands = new Map((manifest.contributes?.commands ?? []).map((command) => [command.command, command]));
  const entries = (manifest.contributes?.menus?.['view/title'] ?? []).filter((entry) => entry.when?.split('&&').some((clause) => clause.trim() === `view == ${view}`));
  return entries
    .map((entry) => ({ entry, group: orderOf(entry.group) }))
    .sort((a, b) => Number(b.group.name === 'navigation') - Number(a.group.name === 'navigation') || a.group.name.localeCompare(b.group.name) || a.group.order - b.group.order)
    .map(({ entry, group }) => {
      const command = commands.get(entry.command);
      const icon = typeof command?.icon === 'string' ? /^\$\(([\w-]+)\)$/.exec(command.icon)?.[1] : undefined;
      return { command: entry.command, title: command?.title ?? entry.command, icon, inline: group.name === 'navigation' };
    });
}
