/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/** Builds the panel's DOM from data. Text only ever goes in as text nodes, so nothing the model writes becomes markup. */

type Attr = string | number | boolean | undefined;
type Attrs = Readonly<Record<string, Attr | ((event: Event) => void)>>;
export type Child = Node | string | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: readonly Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value === 'function') element.addEventListener(name.slice(2).toLowerCase(), value);
    else if (value === true) element.setAttribute(name, '');
    else if (value !== undefined && value !== false) element.setAttribute(name, String(value));
  }
  append(element, children);
  return element;
}

function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) if (child !== undefined && child !== false) parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
}

/** macOS takes Cmd where other platforms take Ctrl, and names its keys with symbols. */
export const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

export const icon = (name: string, extra = ''): HTMLSpanElement => h('span', { class: `codicon codicon-${name} ${extra}`.trim(), 'aria-hidden': 'true' });

/** One child of a reconciled list: rebuilt only when a dependency changes identity. */
export type Keyed = { readonly key: string; readonly deps: readonly unknown[]; readonly build: () => HTMLElement };

const built = new WeakMap<Element, Map<string, { readonly deps: readonly unknown[]; readonly element: HTMLElement }>>();

const same = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

/**
 * Makes `parent`'s children the items' elements, in order, reusing each element whose dependencies are unchanged
 * and replacing a changed one where it stands. Moving a node blurs whatever inside it has focus, so elements are
 * moved only when the order itself changed.
 */
export function reconcile(parent: HTMLElement, items: readonly Keyed[]): HTMLElement[] {
  const before = built.get(parent) ?? new Map();
  const keys = new Set(items.map((item) => item.key));
  for (const [key, { element }] of before) if (!keys.has(key)) element.remove();
  const after = new Map<string, { readonly deps: readonly unknown[]; readonly element: HTMLElement }>();
  const elements = items.map((item) => {
    const hit = before.get(item.key);
    if (hit !== undefined && same(hit.deps, item.deps)) {
      after.set(item.key, hit);
      return hit.element;
    }
    const element = item.build();
    if (hit?.element.parentNode === parent) hit.element.replaceWith(element);
    after.set(item.key, { deps: item.deps, element });
    return element;
  });
  elements.forEach((element, i) => {
    if (parent.children[i] !== element) parent.insertBefore(element, parent.children[i] ?? null);
  });
  while (parent.children.length > elements.length) parent.lastElementChild!.remove();
  built.set(parent, after);
  return elements;
}
