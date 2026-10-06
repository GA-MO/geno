/// <reference lib="dom" />
import type { BackendRow, ComposerView, ModelMenu } from './composer-model.js';
import { h, icon } from './dom.js';
import type { FromView } from './messages.js';
import type { PillState } from './steer-model.js';

const SVG = 'http://www.w3.org/2000/svg';
/** The ring's radius in its 16px box; the stroke's dash runs the circumference. */
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The context ring: a track and an arc filled to the share of the window in use. Data, not an icon, so it is drawn.
 * `inside` draws it as the Compact button's picture, which the button names.
 */
function contextRing(inside = false) {
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
  const element = h('span', inside ? { class: 'context-ring', 'aria-hidden': 'true' } : { class: 'context-ring', role: 'img', tabindex: '0' });
  element.append(svg);
  return {
    element,
    show({ fraction, high, title }: ComposerView['ring']): void {
      if (!inside) {
        element.title = title;
        element.setAttribute('aria-label', title);
      }
      element.dataset['level'] = fraction === undefined ? 'unknown' : high ? 'high' : 'ok';
      arc.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE * (1 - (fraction ?? 0))));
    },
  };
}

/**
 * The menu the model button opens: the backends a new chat can run on, the models the user can switch to, the Models
 * and Keys page, then the efforts the engine offers, with a muted note on what an effort change costs. It keeps the
 * keys of the mode menu.
 */
function modelMenu(post: (message: FromView) => void, button: HTMLButtonElement) {
  const menu = h('ul', { class: 'model-menu', id: 'model-menu', role: 'menu', 'aria-label': 'Model and effort', hidden: true });
  let shown: ModelMenu = { backends: [], models: [], efforts: [], note: undefined };

  const items = () => [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  /** An option without `run` is disabled: it keeps its place in the keys' path, and choosing it does nothing. */
  const option = (attrs: Record<string, string>, label: string, checked: boolean | undefined, run: (() => void) | undefined, detail?: string, stacked = false) =>
    h(
      'li',
      {
        class: 'model-option',
        tabindex: '-1',
        ...attrs,
        ...(checked === undefined ? {} : { 'aria-checked': String(checked) }),
        ...(run === undefined ? { 'aria-disabled': 'true' } : { onclick: () => (close(), run()) }),
      },
      h(
        'span',
        { class: stacked ? 'model-option-text stacked' : 'model-option-text' },
        h('span', { class: 'model-option-name', title: label }, label),
        detail !== undefined && h('span', { class: 'model-option-detail', title: detail }, detail),
      ),
      checked === true && icon('check', 'model-check'),
    );
  const backendOption = (b: BackendRow) =>
    option({ role: 'menuitemradio', 'data-backend': b.id }, b.label, b.current, b.disabled ? undefined : () => {
      if (!b.current) post({ type: 'set-backend', backend: b.id });
    }, b.detail, true);
  const heading = (text: string) => h('li', { class: 'menu-heading', role: 'presentation' }, text);

  function open(): void {
    // A chat with no session yet learns its effort from the session's response; asking opens one.
    if (shown.efforts.length === 0) post({ type: 'want-commands' });
    draw();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    // The current model takes the keyboard, over the current backend above it.
    const checked = items().filter((item) => item.getAttribute('aria-checked') === 'true');
    (checked.find((item) => item.dataset['key'] !== undefined) ?? checked[0] ?? items()[0])?.focus();
  }

  function draw(): void {
    const { backends, models, efforts, note } = shown;
    menu.replaceChildren(
      ...(backends.length === 0 ? [] : [heading('Backend'), ...backends.map(backendOption), h('li', { class: 'menu-separator', role: 'separator' })]),
      heading('Model'),
      ...models.map((m) =>
        option({ role: 'menuitemradio', 'data-key': m.key, ...(m.pick.kind === 'geno' ? { 'data-model': m.pick.model, 'data-provider': m.pick.provider } : { 'data-agent-model': m.pick.value }) }, m.label, m.current, () => {
          if (!m.current) post(m.pick.kind === 'geno' ? { type: 'set-model', provider: m.pick.provider, model: m.pick.model } : { type: 'set-agent-model', value: m.pick.value });
        }, m.detail),
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
      const key = focused?.['effort'] ?? focused?.['key'] ?? focused?.['backend'];
      draw();
      (items().find((item) => key !== undefined && (item.dataset['effort'] === key || item.dataset['key'] === key || item.dataset['backend'] === key)) ?? items().find((item) => item.getAttribute('aria-checked') === 'true'))?.focus();
    },
  };
}

/**
 * The row's one pill and its label, as Claude Code's running line has them: "2 running · 1 needs you", then the one
 * thing most worth a look. The pill opens Tasks at Needs you. Both are in the row only while they show, so an idle
 * row with nothing beside it is as U36 left it.
 */
function activityPill(openTasks: () => void) {
  const running = h('span', { class: 'pill-part pill-running' }, h('span', { class: 'pill-count' }), h('span', { class: 'pill-noun' }, ' running'));
  const separator = h('span', { class: 'pill-separator', 'aria-hidden': 'true' }, ' · ');
  const needs = h('span', { class: 'pill-part pill-needs' }, h('span', { class: 'pill-count' }), h('span', { class: 'pill-noun' }));
  const pill = h('button', { type: 'button', class: 'activity-pill', onclick: openTasks }, icon('pulse', 'pill-icon'), running, separator, needs);
  const label = h('span', { class: 'activity-label' });
  const element = h('span', { class: 'run-activity' }, pill, label);
  return {
    element,
    show(activity: ComposerView['activity'], into: HTMLElement, before: Element): void {
      if (activity === undefined) return void element.remove();
      running.hidden = activity.running === 0;
      needs.hidden = activity.needsYou === 0;
      separator.hidden = running.hidden || needs.hidden;
      running.querySelector('.pill-count')!.textContent = String(activity.running);
      needs.querySelector('.pill-count')!.textContent = String(activity.needsYou);
      needs.querySelector('.pill-noun')!.textContent = activity.needsYou === 1 ? ' needs you' : ' need you';
      pill.dataset['needsYou'] = String(activity.needsYou > 0);
      pill.title = `${activity.text}. Open Tasks`;
      pill.setAttribute('aria-label', `${activity.text}. Open Tasks`);
      label.hidden = activity.label === undefined;
      label.textContent = activity.label?.text ?? '';
      label.title = activity.label?.text ?? '';
      label.dataset['tone'] = activity.label?.tone ?? '';
      if (element.parentElement !== into) into.insertBefore(element, before);
    },
  };
}

export type ComposerControls = ReturnType<typeof composerControls>;

/**
 * The composer's own controls around the text field: the tray's browser and queued chips, and the bottom row's
 * `+`, `/`, the running time and cost, the context ring and the model button. `show` draws a ComposerView.
 */
export function composerControls(
  post: (message: FromView) => void,
  hooks: { readonly addContext: () => void; readonly openCommands: () => void; readonly openTasks: () => void; readonly unqueue: () => void; readonly compact: () => void },
) {
  const browserLabel = h('span', { class: 'tray-label' });
  const browser = h(
    'div',
    { class: 'tray-chip browser-chip', role: 'listitem', hidden: true },
    icon('globe', 'browser-globe'),
    browserLabel,
    h('button', { type: 'button', class: 'chip-remove', 'aria-label': 'Turn the browser off', title: 'Turn the browser off', onclick: () => post({ type: 'mcp-enable', name: 'browser', enabled: false }) }, icon('close')),
  );
  const queuedLabel = h('span', { class: 'tray-label' });
  const queuedState = h('span', { class: 'queued-state' });
  const queued = h(
    'div',
    { class: 'tray-chip queued-chip', role: 'listitem', hidden: true, title: 'Sends when the turn finishes' },
    icon('clock'),
    queuedState,
    queuedLabel,
    h('button', { type: 'button', class: 'chip-remove', 'aria-label': 'Drop the queued follow-up', title: 'Drop it', onclick: hooks.unqueue }, icon('close')),
  );

  const add = h('button', { type: 'button', class: 'composer-icon context-add', title: 'Add context or attach files (@)', 'aria-label': 'Add context', onclick: hooks.addContext }, icon('add'));
  const commands = h('button', { type: 'button', class: 'composer-icon slash-button', title: 'Commands (/)', 'aria-label': 'Commands', onclick: hooks.openCommands }, h('span', { 'aria-hidden': 'true' }, '/'));

  const elapsed = h('span', { class: 'run-elapsed' });
  const cost = h('span', { class: 'run-cost' });
  const time = h('span', { class: 'run-time', title: 'Time this turn has worked, its waits left out' }, icon('clock'), elapsed);
  const waitIcons = { offline: icon('debug-disconnect', 'wait-icon'), limited: icon('watch', 'wait-icon') };
  const waitText = h('span', { class: 'wait-text' });
  const retryNow = h(
    'button',
    { type: 'button', class: 'retry-now', title: 'Send the model call again now', 'aria-label': 'Retry now', onclick: () => post({ type: 'retry-now' }) },
    icon('refresh', 'retry-icon'),
    h('span', { class: 'retry-label' }, 'Retry now'),
  );
  const wait = h('span', { class: 'run-wait', hidden: true }, waitIcons.offline, waitIcons.limited, waitText, retryNow);
  const status = h('span', { class: 'run-status', hidden: true, role: 'status' }, wait, time, cost);
  const activity = activityPill(hooks.openTasks);

  const ring = contextRing();
  // From 80% the ring itself becomes the Compact button; the plain ring stays in place, hidden, for what sits beside it.
  const pillRing = contextRing(true);
  const compact = h('button', { type: 'button', class: 'compact-offer', hidden: true, onclick: () => compact.getAttribute('aria-disabled') !== 'true' && hooks.compact() }, pillRing.element, h('span', { class: 'compact-offer-label' }, 'Compact'));
  const modelBackend = h('span', { class: 'model-backend', hidden: true });
  const modelName = h('span', { class: 'model-name' });
  const effort = h('span', { class: 'model-effort' });
  const modelButton = h(
    'button',
    { type: 'button', class: 'composer-model', title: 'Choose the model and effort', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'model-menu' },
    modelBackend,
    modelName,
    effort,
    icon('chevron-down', 'model-chevron'),
  );
  const menu = modelMenu(post, modelButton);
  modelButton.addEventListener('click', menu.toggle);

  return {
    tray: [browser, queued] as const,
    left: [add, commands] as const,
    right: [status, ring.element, compact, modelButton] as const,
    menu: menu.menu,
    /** Whether the follow-up waits for the turn's end or was sent to land at its next tool round (U44). */
    followup(pill: PillState | undefined): void {
      queuedState.textContent = pill?.label ?? '';
      queued.title = pill?.title ?? '';
      queued.dataset['state'] = pill?.state ?? '';
    },
    show(view: ComposerView): void {
      browser.hidden = view.browser === undefined;
      browserLabel.textContent = view.browser?.label ?? '';
      browser.title = view.browser?.title ?? '';
      queued.hidden = view.queued === undefined;
      queuedLabel.textContent = view.queued ?? '';
      ring.show(view.ring);
      pillRing.show(view.ring);
      const offer = view.ring.compact;
      compact.hidden = offer === undefined;
      ring.element.hidden = offer !== undefined;
      compact.title = offer?.title ?? '';
      compact.setAttribute('aria-label', `Compact the context. ${offer?.title ?? ''}`);
      if (offer?.held === undefined) compact.removeAttribute('aria-disabled');
      else compact.setAttribute('aria-disabled', 'true');
      modelName.textContent = view.model.name;
      modelBackend.textContent = view.model.backend ?? '';
      modelBackend.hidden = view.model.backend === undefined;
      modelButton.title = view.model.backend === undefined ? 'Choose the model and effort' : `${view.model.backend} runs this chat. Choose its model, or a backend for a new chat`;
      effort.textContent = view.model.effort ?? '';
      effort.hidden = view.model.effort === undefined;
      // A narrow row hides the name, so the button's name cannot come from its text.
      modelButton.setAttribute('aria-label', [view.model.backend, view.model.name, view.model.effort].filter((part) => part !== undefined).join(' '));
      menu.show(view.menu);
      status.hidden = view.running === undefined;
      activity.show(view.activity, status.parentElement!, ring.element);
      const waiting = view.running?.wait;
      wait.hidden = waiting === undefined;
      time.hidden = waiting !== undefined;
      if (waiting !== undefined) {
        wait.dataset['kind'] = waiting.kind;
        wait.title = waiting.title;
        waitText.textContent = waiting.text;
        waitIcons.offline.hidden = waiting.kind !== 'offline';
        waitIcons.limited.hidden = waiting.kind !== 'limited';
      }
      if (view.running !== undefined) {
        elapsed.textContent = view.running.elapsed;
        cost.hidden = view.running.cost === undefined;
        cost.textContent = view.running.cost?.text ?? '';
        cost.title = view.running.cost?.title ?? '';
      }
    },
  };
}
