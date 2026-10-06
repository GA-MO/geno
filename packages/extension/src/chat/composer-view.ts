/// <reference lib="dom" />
import type { ComposerView, ModelMenu } from './composer-model.js';
import { h, icon } from './dom.js';
import type { FromView } from './messages.js';

const SVG = 'http://www.w3.org/2000/svg';
/** The ring's radius in its 16px box; the stroke's dash runs the circumference. */
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The context ring: a track and an arc filled to the share of the window in use. Data, not an icon, so it is drawn. */
function contextRing() {
  const circle = (cls: string) => {
    const c = document.createElementNS(SVG, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '8');
    c.setAttribute('cy', '8');
    c.setAttribute('r', String(RADIUS));
    return c;
  };
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const arc = circle('ring-fill');
  arc.setAttribute('stroke-dasharray', String(CIRCUMFERENCE));
  svg.append(circle('ring-track'), arc);
  const element = h('span', { class: 'context-ring', role: 'img', tabindex: '0' });
  element.append(svg);
  return {
    element,
    show({ fraction, high, title }: ComposerView['ring']): void {
      element.title = title;
      element.setAttribute('aria-label', title);
      element.dataset['level'] = fraction === undefined ? 'unknown' : high ? 'high' : 'ok';
      arc.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE * (1 - (fraction ?? 0))));
    },
  };
}

/**
 * The menu the model button opens: the models the user can switch to, the Models and Keys page, then the efforts the
 * engine offers, with a muted note on what an effort change costs. It keeps the keys of the mode menu.
 */
function modelMenu(post: (message: FromView) => void, button: HTMLButtonElement) {
  const menu = h('ul', { class: 'model-menu', id: 'model-menu', role: 'menu', 'aria-label': 'Model and effort', hidden: true });
  let shown: ModelMenu = { models: [], efforts: [], note: undefined };

  const items = () => [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  const option = (attrs: Record<string, string>, label: string, checked: boolean | undefined, run: () => void, detail?: string) =>
    h(
      'li',
      { class: 'model-option', tabindex: '-1', ...attrs, ...(checked === undefined ? {} : { 'aria-checked': String(checked) }), onclick: () => (close(), run()) },
      h('span', { class: 'model-option-text' }, h('span', { class: 'model-option-name' }, label), detail !== undefined && h('span', { class: 'model-option-detail' }, detail)),
      checked === true && icon('check', 'model-check'),
    );
  const heading = (text: string) => h('li', { class: 'menu-heading', role: 'presentation' }, text);

  function open(): void {
    // A chat with no session yet learns its effort from the session's response; asking opens one.
    if (shown.efforts.length === 0) post({ type: 'want-commands' });
    draw();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    (items().find((item) => item.getAttribute('aria-checked') === 'true') ?? items()[0])?.focus();
  }

  function draw(): void {
    const { models, efforts, note } = shown;
    menu.replaceChildren(
      heading('Model'),
      ...models.map((m) =>
        option({ role: 'menuitemradio', 'data-model': m.model, 'data-provider': m.provider }, m.model, m.current, () => {
          if (!m.current) post({ type: 'set-model', provider: m.provider, model: m.model });
        }, m.providerLabel),
      ),
      option({ role: 'menuitem', 'data-action': 'models' }, 'Models and Keys…', undefined, () => post({ type: 'choose-model' })),
      ...(efforts.length === 0
        ? []
        : [
            h('li', { class: 'menu-separator', role: 'separator' }),
            heading('Effort'),
            ...efforts.map((e) =>
              option({ role: 'menuitemradio', 'data-effort': e.value }, e.name, e.current, () => {
                if (!e.current) post({ type: 'set-effort', value: e.value });
              }),
            ),
          ]),
      ...(note === undefined ? [] : [h('li', { class: 'menu-note', role: 'presentation', title: note }, note)]),
    );
  }

  function close(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.focus();
  }

  menu.addEventListener('keydown', (event) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const moves: Readonly<Record<string, () => void>> = {
      ArrowDown: () => all[(at + 1) % all.length]?.focus(),
      ArrowUp: () => all[(at - 1 + all.length) % all.length]?.focus(),
      Enter: () => all[at]?.click(),
      ' ': () => all[at]?.click(),
      Escape: close,
      Tab: close,
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    move();
  });
  document.addEventListener('mousedown', (event) => {
    if (!menu.hidden && !menu.contains(event.target as Node) && !button.contains(event.target as Node)) close();
  });

  return {
    menu,
    toggle: () => (menu.hidden ? open() : close()),
    show(next: ModelMenu): void {
      const changed = JSON.stringify(next) !== JSON.stringify(shown);
      shown = next;
      if (!changed || menu.hidden) return;
      const focused = (document.activeElement as HTMLElement | null)?.dataset;
      const key = focused?.['effort'] ?? focused?.['model'];
      draw();
      (items().find((item) => item.dataset['effort'] === key || item.dataset['model'] === key) ?? items().find((item) => item.getAttribute('aria-checked') === 'true'))?.focus();
    },
  };
}

export type ComposerControls = ReturnType<typeof composerControls>;

/**
 * The composer's own controls around the text field: the tray's browser and queued chips, and the bottom row's
 * `+`, `/`, the running time and cost, the context ring and the model button. `show` draws a ComposerView.
 */
export function composerControls(post: (message: FromView) => void, hooks: { readonly addContext: () => void; readonly openCommands: () => void; readonly unqueue: () => void }) {
  const browserLabel = h('span', { class: 'tray-label' });
  const browser = h(
    'div',
    { class: 'tray-chip browser-chip', role: 'listitem', hidden: true },
    icon('globe', 'browser-globe'),
    browserLabel,
    h('button', { type: 'button', class: 'chip-remove', 'aria-label': 'Turn the browser off', title: 'Turn the browser off', onclick: () => post({ type: 'mcp-enable', name: 'browser', enabled: false }) }, icon('close')),
  );
  const queuedLabel = h('span', { class: 'tray-label' });
  const queued = h(
    'div',
    { class: 'tray-chip queued-chip', role: 'listitem', hidden: true, title: 'Sends when the turn finishes' },
    icon('clock'),
    queuedLabel,
    h('button', { type: 'button', class: 'chip-remove', 'aria-label': 'Drop the queued follow-up', title: 'Drop it', onclick: hooks.unqueue }, icon('close')),
  );

  const add = h('button', { type: 'button', class: 'composer-icon context-add', title: 'Add context or attach files (@)', 'aria-label': 'Add context', onclick: hooks.addContext }, icon('add'));
  const commands = h('button', { type: 'button', class: 'composer-icon slash-button', title: 'Commands (/)', 'aria-label': 'Commands', onclick: hooks.openCommands }, h('span', { 'aria-hidden': 'true' }, '/'));

  const elapsed = h('span', { class: 'run-elapsed' });
  const cost = h('span', { class: 'run-cost' });
  const status = h('span', { class: 'run-status', hidden: true, role: 'status' }, h('span', { class: 'run-time', title: 'Time this turn has run' }, icon('clock'), elapsed), cost);

  const ring = contextRing();
  const modelName = h('span', { class: 'model-name' });
  const effort = h('span', { class: 'model-effort' });
  const modelButton = h(
    'button',
    { type: 'button', class: 'composer-model', title: 'Choose the model and effort', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'model-menu' },
    modelName,
    effort,
    icon('chevron-down', 'model-chevron'),
  );
  const menu = modelMenu(post, modelButton);
  modelButton.addEventListener('click', menu.toggle);

  return {
    tray: [browser, queued] as const,
    left: [add, commands] as const,
    right: [status, ring.element, modelButton] as const,
    menu: menu.menu,
    show(view: ComposerView): void {
      browser.hidden = view.browser === undefined;
      browserLabel.textContent = view.browser?.label ?? '';
      browser.title = view.browser?.title ?? '';
      queued.hidden = view.queued === undefined;
      queuedLabel.textContent = view.queued ?? '';
      ring.show(view.ring);
      modelName.textContent = view.model.name;
      effort.textContent = view.model.effort ?? '';
      effort.hidden = view.model.effort === undefined;
      menu.show(view.menu);
      status.hidden = view.running === undefined;
      if (view.running !== undefined) {
        elapsed.textContent = view.running.elapsed;
        cost.hidden = view.running.cost === undefined;
        cost.textContent = view.running.cost?.text ?? '';
        cost.title = view.running.cost?.title ?? '';
      }
    },
  };
}
