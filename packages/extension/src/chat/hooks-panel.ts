/// <reference lib="dom" />
import type { HookProblem, HookRow } from '@g-code/core';
import { h, icon, reconcile } from './dom.js';
import { HOOK_STATUS_LABELS, type HooksFromView, type HooksListing } from './hooks-model.js';

const sourceOf = (hook: HookRow): string => (hook.plugin === undefined ? hook.file : `the ${hook.plugin} plugin`);

function hookRow(hook: HookRow): HTMLElement {
  const { label, tone } = HOOK_STATUS_LABELS[hook.status];
  return h(
    'li',
    { class: 'perm-row hook-row', 'data-event': hook.event, 'data-status': hook.status },
    h(
      'div',
      { class: 'hook-text' },
      h('span', { class: 'hook-event' }, hook.matcher === undefined || hook.matcher === '' ? hook.event : `${hook.event} (${hook.matcher})`),
      h('code', { class: 'perm-pattern' }, hook.command),
      h('span', { class: 'hook-source' }, `From ${sourceOf(hook)}`),
      ...(hook.why === undefined ? [] : [h('span', { class: 'hook-why' }, hook.why)]),
    ),
    h('span', { class: `hook-status mcp-state tone-${tone}` }, label),
  );
}

const problemRow = (problem: HookProblem): HTMLElement =>
  h('li', { class: 'hook-problem', 'data-severity': problem.severity }, icon(problem.severity === 'warning' ? 'warning' : 'info'), h('span', {}, problem.text));

/**
 * Settings' Hooks section: every hook Geno found for this folder, from Claude Code's settings files, Geno's own and
 * installed plugins, with whether it runs, and a warning for each mistake in the files, such as a misspelled event.
 */
export function hooksSection(post: (message: HooksFromView) => void) {
  const problems = h('ul', { class: 'hook-problems', 'aria-label': 'Hook problems' });
  const list = h('ul', { class: 'perm-list', 'aria-label': 'Hooks' });
  const note = h('p', { class: 'provider-note perm-note' }, 'Loading…');
  const element = h(
    'div',
    { class: 'perm-section hooks-section' },
    h('h3', { class: 'settings-heading' }, 'Hooks'),
    h(
      'p',
      { class: 'settings-intro' },
      'Commands that run at session events, in Claude Code’s format: from ~/.claude/settings.json, the workspace’s .claude/settings.json and .claude/settings.local.json, Geno’s ~/.g-code/settings.json and .gcode.json, and installed plugins. Geno runs SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, PostToolBatch, Stop, SubagentStart, SubagentStop, and its own LaneCreated; each other event says why Geno never fires it. A workspace’s own hooks run only when VS Code trusts the workspace, inside the sandbox.',
    ),
    problems,
    note,
    list,
  );
  return {
    element,
    refresh: () => post({ type: 'hooks-list' }),
    listed(listing: HooksListing): void {
      if (listing.kind !== 'loaded') {
        note.hidden = false;
        note.textContent = listing.kind === 'loading' ? 'Loading…' : listing.message;
        reconcile(list, []);
        reconcile(problems, []);
        return;
      }
      note.hidden = listing.hooks.length > 0;
      note.textContent = 'No hooks. Add one under "hooks" in ~/.claude/settings.json.';
      reconcile(problems, listing.problems.map((problem, i) => ({ key: `${i}`, deps: [problem.severity, problem.text], build: () => problemRow(problem) })));
      reconcile(list, listing.hooks.map((hook, i) => ({ key: `${i}`, deps: [JSON.stringify(hook)], build: () => hookRow(hook) })));
    },
  };
}
