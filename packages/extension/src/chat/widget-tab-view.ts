/// <reference lib="dom" />
import type { FromWidgetTab, ToWidgetTab } from './messages.js';
import { h } from './dom.js';
import { askAbout, widgetFrame } from './widget-view.js';

/** The widget tab's page: one widget across the tab, in the theme the chat had when it was opened. */

declare function acquireVsCodeApi(): { postMessage(message: FromWidgetTab): void };

const host = acquireVsCodeApi();
const stage = h('main', { class: 'widget-stage', 'aria-label': 'Widget' });
const top = h('div', { class: 'widget-tab-top' });
document.body.classList.add('widget-tab');
document.body.append(top, stage);

window.addEventListener('message', (event: MessageEvent<ToWidgetTab>) => {
  // The extension's messages arrive through VS Code's page; anything from the widget's own frame is not one of them.
  if (event.data?.type !== 'show' || [...document.querySelectorAll('iframe')].some((frame) => frame.contentWindow === event.source)) return;
  const { html, theme } = event.data;
  stage.replaceChildren(widgetFrame(html, document.title, 'widget-tab', (href) => askAbout(top, href, () => host.postMessage({ type: 'widget-link', href })), theme));
});

host.postMessage({ type: 'ready' });
