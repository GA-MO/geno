/// <reference lib="dom" />
/**
 * Runs in the browser before the panel's own script, in place of VS Code's webview preload: `acquireVsCodeApi` posts to
 * the server, the server's events arrive as the window messages a webview gets, and an overlay shows the questions,
 * toasts and links the host's `vscode.window` calls make.
 */
import type { TitleAction } from './title-actions.js';
import type { Note, UiAnswer, UiRequest } from './vscode-shim.js';

type Asked = UiRequest & { readonly id: string };

const script = document.currentScript as HTMLScriptElement;
const view = script.dataset['view'] ?? 'chat';
const nonce = script.nonce ?? '';
const actions = JSON.parse(script.dataset['actions'] ?? '[]') as readonly TitleAction[];
const stateKey = `geno-web-state:${view}`;

let open = false;
const queued: unknown[] = [];

const post = (message: unknown): void => {
  if (!open) return void queued.push(message);
  void fetch(`/message?view=${encodeURIComponent(view)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
};

Object.assign(window, {
  acquireVsCodeApi: () => ({
    postMessage: post,
    getState: (): unknown => {
      const saved = localStorage.getItem(stateKey);
      return saved === null ? undefined : JSON.parse(saved);
    },
    setState: (state: unknown) => localStorage.setItem(stateKey, JSON.stringify(state)),
  }),
});

const events = new EventSource(`/events?view=${encodeURIComponent(view)}`);
events.addEventListener('open', () => {
  // Messages sent while the stream was down are lost, so a page that reconnects starts again from the host's state.
  if (open) return location.reload();
  open = true;
  for (const message of queued.splice(0)) post(message);
});
events.addEventListener('message', (event) => window.dispatchEvent(new MessageEvent('message', { data: JSON.parse((event as MessageEvent<string>).data) })));
events.addEventListener('note', (event) => noted(JSON.parse((event as MessageEvent<string>).data) as Note));
events.addEventListener('ask', (event) => asked(JSON.parse((event as MessageEvent<string>).data) as Asked));
events.addEventListener('answered', (event) => {
  const { id } = JSON.parse((event as MessageEvent<string>).data) as { id: string };
  dialogs.get(id)?.remove();
  dialogs.delete(id);
});

const STYLE = `
.geno-web-toasts { position: fixed; right: 8px; bottom: 8px; display: flex; flex-direction: column; gap: 6px; z-index: 2147483646; max-width: min(360px, calc(100vw - 16px)); }
.geno-web-toast, .geno-web-dialog, .geno-web-menu { font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-notifications-foreground, var(--vscode-foreground));
  background: var(--vscode-notifications-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-notifications-border, var(--vscode-widget-border, transparent));
  box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,.4)); border-radius: 6px; }
.geno-web-toast { padding: 8px 10px; display: flex; gap: 8px; align-items: baseline; }
.geno-web-toast a { color: var(--vscode-textLink-foreground); }
.geno-web-backdrop { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; padding: 16px; }
.geno-web-dialog { padding: 12px; width: min(420px, 100%); max-height: 80vh; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
.geno-web-dialog .detail { color: var(--vscode-descriptionForeground); white-space: pre-wrap; }
.geno-web-dialog input { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-focusBorder)); padding: 4px 6px; border-radius: 2px; }
.geno-web-dialog .buttons { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.geno-web-dialog button { font: inherit; padding: 4px 10px; border-radius: 2px; border: 1px solid var(--vscode-button-border, transparent); cursor: pointer;
  color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
.geno-web-dialog button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.geno-web-dialog .pick { display: flex; flex-direction: column; gap: 2px; text-align: left; }
.geno-web-dialog .pick button { text-align: left; background: transparent; color: inherit; }
.geno-web-dialog .pick button:hover, .geno-web-dialog .pick button:focus { background: var(--vscode-list-hoverBackground); }
.geno-web-dialog .pick small { color: var(--vscode-descriptionForeground); margin-left: 6px; }
.geno-web-actions { flex: none; margin-left: auto; display: flex; gap: 2px; align-items: center; }
.geno-web-actions button, .geno-web-menu button { font: inherit; color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: transparent; border: none; cursor: pointer; }
.geno-web-actions button { min-width: 24px; height: 24px; padding: 0; border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; }
.geno-web-actions button.text { padding: 0 6px; }
.geno-web-actions button:hover, .geno-web-actions button[aria-expanded="true"] { background: var(--vscode-toolbar-hoverBackground); }
.geno-web-actions .codicon, .geno-web-menu .codicon { font-size: 16px; }
.geno-web-menu { position: fixed; z-index: 2147483646; min-width: 180px; padding: 4px; display: flex; flex-direction: column; }
.geno-web-menu button { display: flex; gap: 8px; align-items: center; padding: 4px 8px; border-radius: 4px; text-align: left; color: var(--vscode-menu-foreground, inherit); }
.geno-web-menu button:hover, .geno-web-menu button:focus { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, inherit); }
`;

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

let toasts: HTMLElement | undefined;
const dialogs = new Map<string, HTMLElement>();

/** The overlay is added once the body exists, after the panel's own script has started. */
const ready = (): Promise<void> =>
  document.body !== null ? Promise.resolve() : new Promise((resolve) => document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));

async function overlay(): Promise<HTMLElement> {
  await ready();
  if (toasts === undefined) {
    document.head.append(element('style', { nonce, textContent: STYLE }));
    toasts = element('div', { className: 'geno-web-toasts' });
    toasts.setAttribute('role', 'status');
    document.body.append(toasts);
  }
  return toasts;
}

async function toast(text: string, link?: { readonly label: string; readonly url: string }): Promise<void> {
  const shown = element('div', { className: 'geno-web-toast' }, element('span', { textContent: text }));
  if (link !== undefined) shown.append(element('a', { href: link.url, target: '_blank', rel: 'noopener', textContent: link.label }));
  (await overlay()).append(shown);
  setTimeout(() => shown.remove(), link === undefined ? 6000 : 15_000);
}

function noted(note: Note): void {
  if (note.kind === 'toast') return void toast(note.text, note.link);
  if (note.kind === 'clipboard') return void navigator.clipboard.writeText(note.text).catch(() => toast('Could not copy: the page needs focus.'));
  // A browser blocks a window it did not see the user ask for; the link stays in a toast for that case.
  const opened = window.open(note.url, '_blank');
  if (opened === null) void toast(`Open ${note.url}`, { label: 'Open', url: note.url });
  else opened.opener = null;
}

const answer = (id: string, reply: UiAnswer): void => {
  dialogs.get(id)?.remove();
  dialogs.delete(id);
  void fetch('/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, answer: reply }) });
};

const button = (label: string, onclick: () => void, primary = false) => element('button', { type: 'button', textContent: label, className: primary ? 'primary' : '', onclick });

function body(request: Asked, done: (reply: UiAnswer) => void): (Node | string)[] {
  const cancel = () => done({ kind: 'cancel' });
  switch (request.kind) {
    case 'message': {
      const label = { info: 'Geno', warning: 'Warning', error: 'Error' }[request.severity];
      return [
        element('strong', { textContent: `${label}: ${request.text}` }),
        ...(request.detail === undefined ? [] : [element('div', { className: 'detail', textContent: request.detail })]),
        element('div', { className: 'buttons' }, ...request.items.map((item, index) => button(item, () => done({ kind: 'item', index }), index === 0)), button(request.items.length === 0 ? 'OK' : 'Close', cancel)),
      ];
    }
    case 'input':
    case 'path': {
      const input = element('input', { type: request.kind === 'input' && request.password ? 'password' : 'text', value: request.value ?? '', placeholder: request.kind === 'input' ? (request.placeholder ?? '') : 'A path in the workspace, or an absolute one' });
      const submit = () => done({ kind: 'text', value: input.value });
      input.addEventListener('keydown', (event) => event.key === 'Enter' && submit());
      queueMicrotask(() => input.focus());
      const title = request.kind === 'input' ? (request.title ?? request.prompt ?? 'Geno') : request.title;
      return [
        element('strong', { textContent: title }),
        ...(request.kind === 'input' && request.title !== undefined && request.prompt !== undefined ? [element('div', { className: 'detail', textContent: request.prompt })] : []),
        input,
        element('div', { className: 'buttons' }, button(request.kind === 'path' ? request.action : 'OK', submit, true), button('Cancel', cancel)),
      ];
    }
    case 'pick': {
      const chosen = new Set<number>();
      const items = request.items.map((item, index) => {
        const row = button(item.label, () => {
          if (!request.many) return done({ kind: 'item', index });
          if (chosen.has(index)) chosen.delete(index);
          else chosen.add(index);
          row.setAttribute('aria-pressed', String(chosen.has(index)));
        });
        if (item.description !== undefined) row.append(element('small', { textContent: item.description }));
        return row;
      });
      return [
        element('strong', { textContent: request.title ?? request.placeholder ?? 'Choose' }),
        element('div', { className: 'pick' }, ...items),
        element('div', { className: 'buttons' }, ...(request.many ? [button('OK', () => done({ kind: 'items', indexes: [...chosen] }), true)] : []), button('Cancel', cancel)),
      ];
    }
  }
}

// Escape closes the newest dialog wherever focus is, since the panel may have taken it.
document.addEventListener(
  'keydown',
  (event) => {
    const newest = [...dialogs].reverse().find(([, shown]) => shown.classList.contains('geno-web-backdrop'));
    if (event.key !== 'Escape' || newest === undefined) return;
    event.stopPropagation();
    answer(newest[0], { kind: 'cancel' });
  },
  true,
);

/** A message that is not modal shows as a toast, as VS Code shows it: one with choices stays until the user picks or closes it. */
async function notice(request: Extract<Asked, { kind: 'message' }>): Promise<void> {
  if (request.items.length === 0) {
    answer(request.id, { kind: 'cancel' });
    return toast(request.text);
  }
  const done = (reply: UiAnswer) => answer(request.id, reply);
  const shown = element(
    'div',
    { className: 'geno-web-toast' },
    element('span', { textContent: request.text }),
    ...request.items.map((item, index) => element('a', { href: '#', textContent: item, onclick: (event: MouseEvent) => (event.preventDefault(), done({ kind: 'item', index })) })),
    element('a', { href: '#', textContent: 'Close', onclick: (event: MouseEvent) => (event.preventDefault(), done({ kind: 'cancel' })) }),
  );
  dialogs.set(request.id, shown);
  (await overlay()).append(shown);
}

async function asked(request: Asked): Promise<void> {
  if (dialogs.has(request.id)) return;
  if (request.kind === 'message' && !request.modal) return notice(request);
  await overlay();
  const done = (reply: UiAnswer) => answer(request.id, reply);
  const dialog = element('div', { className: 'geno-web-dialog' }, ...body(request, done));
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const backdrop = element('div', { className: 'geno-web-backdrop' }, dialog);
  backdrop.addEventListener('click', (event) => event.target === backdrop && done({ kind: 'cancel' }));
  dialogs.set(request.id, backdrop);
  document.body.append(backdrop);
  (dialog.querySelector('input, button') as HTMLElement | null)?.focus();
}

/** What the header keeps for the project and the chat's title before the actions take the rest; each icon takes one slot. */
const TITLE_ROOM = 160;
const SLOT = 26;

const iconOf = (name: string) => element('span', { className: `codicon codicon-${name}` });

const runAction = (action: TitleAction): void =>
  void fetch('/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: action.command }) });

/**
 * The view's title-bar actions, which VS Code draws above the webview, in the panel's own header: the navigation group
 * as icons while they fit, and the rest in a `…` menu, as VS Code does in a narrow side bar.
 */
function titleBar(header: HTMLElement): void {
  const bar = element('div', { className: 'geno-web-actions', role: 'toolbar', ariaLabel: 'Chat actions' });
  const more = element('button', { type: 'button', title: 'More Actions…', ariaLabel: 'More Actions…', ariaHasPopup: 'menu', ariaExpanded: 'false' }, iconOf('ellipsis'));
  let hidden: readonly TitleAction[] = [];
  let menu: HTMLElement | undefined;

  const closeMenu = (refocus = false): void => {
    menu?.remove();
    menu = undefined;
    more.ariaExpanded = 'false';
    if (refocus) more.focus();
  };
  const openMenu = (): void => {
    const box = more.getBoundingClientRect();
    menu = element(
      'div',
      { className: 'geno-web-menu', role: 'menu' },
      ...hidden.map((action) =>
        element('button', { type: 'button', role: 'menuitem', onclick: () => (closeMenu(), runAction(action)) }, ...(action.icon === undefined ? [] : [iconOf(action.icon)]), action.title),
      ),
    );
    menu.style.top = `${box.bottom + 2}px`;
    menu.style.right = `${Math.max(4, innerWidth - box.right)}px`;
    document.body.append(menu);
    more.ariaExpanded = 'true';
    (menu.querySelector('button') as HTMLElement | null)?.focus();
  };
  more.addEventListener('click', () => (menu === undefined ? openMenu() : closeMenu()));
  document.addEventListener('pointerdown', (event) => menu !== undefined && !menu.contains(event.target as Node) && !more.contains(event.target as Node) && closeMenu(), true);
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || menu === undefined) return;
      event.stopPropagation();
      closeMenu(true);
    },
    true,
  );

  const iconButton = (action: TitleAction) => {
    const shown = element('button', { type: 'button', title: action.title, ariaLabel: action.title, className: action.icon === undefined ? 'text' : '', onclick: () => runAction(action) });
    shown.dataset['command'] = action.command;
    shown.append(action.icon === undefined ? action.title : iconOf(action.icon));
    return shown;
  };

  const layout = (): void => {
    const inline = actions.filter((action) => action.inline);
    const rest = actions.filter((action) => !action.inline);
    const slots = Math.max(1, Math.floor((header.clientWidth - TITLE_ROOM) / SLOT));
    const fits = inline.length + (rest.length > 0 ? 1 : 0) <= slots;
    const shown = fits ? inline : inline.slice(0, slots - 1);
    hidden = [...inline.slice(shown.length), ...rest];
    closeMenu();
    bar.replaceChildren(...shown.map(iconButton), ...(hidden.length > 0 ? [more] : []));
  };
  header.append(bar);
  layout();
  new ResizeObserver(layout).observe(header);
}

void ready().then(async () => {
  const header = document.querySelector<HTMLElement>('.chat-header');
  if (header === null || actions.length === 0) return;
  await overlay();
  titleBar(header);
});
