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

/** The divider where the context was compacted: a line with the counts that opens to the summary and the files. */
export function compactStep(block: CompactBlock, ui: Ui): HTMLElement {
  const id = compactFoldId(block);
  const open = ui.isOpen(id);
  const look = compactLook(block.mark);
  const body = `compact-body-${block.mark.seq}`;
  const { read, changed } = block.mark.files;
  return h(
    'section',
    { class: 'compact', 'data-open': String(open), 'data-trigger': block.mark.trigger, 'aria-label': `${look.title}, ${look.numbers}` },
    h(
      'button',
      { type: 'button', class: 'compact-head', 'aria-expanded': String(open), 'aria-controls': body, 'data-focus': id, title: open ? 'Hide the summary' : 'Show the summary', onclick: () => ui.toggle(id) },
      h('span', { class: 'compact-rule', 'aria-hidden': 'true' }),
      h(
        'span',
        { class: 'compact-label' },
        icon('fold', 'compact-icon'),
        h('span', { class: 'compact-title' }, look.title),
        h('span', { class: 'compact-numbers' }, look.numbers),
        icon(open ? 'chevron-down' : 'chevron-right', 'chevron'),
      ),
      h('span', { class: 'compact-rule', 'aria-hidden': 'true' }),
    ),
    h(
      'div',
      { class: 'compact-body', id: body, ...(open ? {} : { hidden: true }) },
      look.reason !== undefined && h('p', { class: 'compact-reason' }, look.reason),
      look.focus !== undefined && h('p', { class: 'compact-focus' }, h('span', { class: 'compact-files-label' }, 'Focus'), look.focus),
      open && h('div', { class: 'compact-summary' }, textBlock(block.mark.summary, false, ui)),
      fileList('Read', read),
      fileList('Changed', changed),
    ),
  );
}
