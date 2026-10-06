/// <reference lib="dom" />
import type { EditorAction } from '@g-code/core';
import { h, icon } from './dom.js';
import type { ToolBlock } from './messages.js';

/** A call that showed the user something in the editor, which its step can show again. */
export type EditorTool = ToolBlock & { readonly editorAction: EditorAction };

const basename = (file: string): string => file.slice(file.lastIndexOf('/') + 1) || file;

/** What a step says it did, with the target in code type, and what clicking it does again. */
export type EditorStepText = { readonly icon: string; readonly verb: string; readonly target: string; readonly after: string; readonly again: string };

const STEPS: { readonly [K in EditorAction['kind']]: (action: Extract<EditorAction, { kind: K }>) => EditorStepText } = {
  open: ({ path, line, column }) => {
    const target = `${basename(path)}${line === undefined ? '' : `:${line}`}${line === undefined || column === undefined ? '' : `:${column}`}`;
    return { icon: 'go-to-file', verb: 'Opened', target, after: '', again: `Open ${target} again` };
  },
  diff: ({ path, base }) => ({
    icon: 'diff',
    verb: 'Showed the diff of',
    target: basename(path),
    after: base.since === 'turn' ? '' : ' since the session began',
    again: `Show the diff of ${basename(path)} again`,
  }),
  reveal: ({ path }) => ({ icon: 'list-tree', verb: 'Revealed', target: basename(path), after: ' in the Explorer', again: `Reveal ${basename(path)} in the Explorer again` }),
};

export const editorStepText = (action: EditorAction): EditorStepText => (STEPS[action.kind] as (a: EditorAction) => EditorStepText)(action);

export type EditorUi = { readonly post: (message: { readonly type: 'editor-action'; readonly action: EditorAction }) => void };

/** One small row: what the call showed, and a click shows it again. */
export function editorStep(tool: EditorTool, ui: EditorUi): HTMLElement {
  const text = editorStepText(tool.editorAction);
  return h(
    'div',
    { class: 'calls editor-step', 'data-step': tool.name, 'data-tool': tool.id },
    h(
      'button',
      { class: 'step-row', title: `${text.again}\n${tool.editorAction.path}`, 'data-focus': `editor:${tool.id}`, onclick: () => ui.post({ type: 'editor-action', action: tool.editorAction }) },
      icon(text.icon, 'kind'),
      h('span', { class: 'step-verb' }, text.verb),
      h('code', { class: 'step-target' }, text.target),
      text.after !== '' && h('span', { class: 'editor-after' }, text.after.trim()),
    ),
  );
}
