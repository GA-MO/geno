import { compactFoldId, compactLook } from './compact-model.js';
import { h, icon } from './dom.js';
import type { CompactBlock } from './messages.js';
import { textBlock, type Ui } from './render.js';

const fileList = (label: string, files: readonly string[]): HTMLElement | false =>
  files.length > 0 &&
  h(
    'div',
    { class: 'compact-files' },
    h('span', { class: 'compact-files-label' }, label),
    h('ul', {}, ...files.map((file) => h('li', { title: file }, h('code', {}, file)))),
  );

/**
 * The divider where the context was compacted: a line with the counts that opens to the summary and the files. It opens
 * and folds in place, so the button keeps the keyboard's focus; the summary renders the first time it opens.
 */
export function compactStep(block: CompactBlock, ui: Ui): HTMLElement {
  const id = compactFoldId(block);
  const look = compactLook(block.mark);
  const bodyId = `compact-body-${block.mark.seq}`;
  const { read, changed } = block.mark.files;
  const chevron = h('span', { class: 'chevron-slot' });
  const summary = h('div', { class: 'compact-summary' });
  const body = h(
    'div',
    { class: 'compact-body', id: bodyId },
    look.reason !== undefined && h('p', { class: 'compact-reason' }, look.reason),
    look.focus !== undefined && h('p', { class: 'compact-focus' }, h('span', { class: 'compact-files-label' }, 'Focus'), look.focus),
    summary,
    fileList('Read', read),
    fileList('Changed', changed),
  );
  const head = h(
    'button',
    { type: 'button', class: 'compact-head', 'aria-controls': bodyId, 'data-focus': id, onclick: () => (ui.toggle(id), show(ui.isOpen(id))) },
    h('span', { class: 'compact-title' }, look.title),
    h('span', { class: 'compact-numbers' }, look.numbers),
    chevron,
  );
  const section = h('section', { class: 'compact', 'data-trigger': block.mark.trigger, 'aria-label': `${look.title}, ${look.numbers}` }, head, body);
  const show = (open: boolean): void => {
    section.dataset['open'] = String(open);
    head.setAttribute('aria-expanded', String(open));
    head.title = open ? 'Hide the summary' : 'Show the summary';
    chevron.replaceChildren(icon(open ? 'chevron-down' : 'chevron-right', 'chevron'));
    body.hidden = !open;
    if (open && summary.childElementCount === 0) summary.append(textBlock(block.mark.summary, false, ui));
  };
  show(ui.isOpen(id));
  return section;
}
