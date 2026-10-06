/// <reference lib="dom" />
import { h, icon, reconcile } from './dom.js';
import type { PermissionRuleView, PermissionsFromView, PermissionsListing, RuleEffectView } from './permissions-model.js';

const EFFECT_LABELS: Readonly<Record<RuleEffectView, { readonly label: string; readonly tone: string }>> = {
  allow: { label: 'Allow', tone: 'tone-ok' },
  deny: { label: 'Deny', tone: 'tone-failed' },
};

function ruleRow(rule: PermissionRuleView, post: (message: PermissionsFromView) => void): HTMLElement {
  const { label, tone } = EFFECT_LABELS[rule.effect];
  return h(
    'li',
    { class: 'rule-row', 'data-rule': rule.id, 'data-effect': rule.effect },
    h('span', { class: `rule-effect mcp-state ${tone}` }, label),
    h('code', { class: 'rule-pattern' }, rule.text),
    h(
      'button',
      { type: 'button', class: 'link-button rule-remove', 'aria-label': `Remove the rule ${label.toLowerCase()} ${rule.text}`, onclick: () => post({ type: 'permissions-remove', id: rule.id }) },
      'Remove',
    ),
  );
}

/**
 * Settings' Permissions section: the workspace's allow and deny rules, each removable, and a form to add one. The
 * engine keeps them; the page only shows the last listing it heard.
 */
export function permissionsSection(post: (message: PermissionsFromView) => void) {
  const list = h('ul', { class: 'rules-list', 'aria-label': 'Permission rules' });
  const note = h('p', { class: 'provider-note rules-note' }, 'Loading…');
  const refused = h('p', { class: 'provider-test rules-refused', 'data-tone': 'failed', role: 'alert', hidden: true });
  const effect = h('select', { class: 'role-provider rules-effect', 'aria-label': 'Rule effect' }, h('option', { value: 'allow' }, 'Allow'), h('option', { value: 'deny' }, 'Deny'));
  const text = h('input', { class: 'provider-input rules-text', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'pnpm test', 'aria-label': 'Command' });
  const form = h(
    'form',
    {
      class: 'rules-add',
      onsubmit: (event: Event) => {
        event.preventDefault();
        if (text.value.trim() === '') return;
        post({ type: 'permissions-add', effect: effect.value === 'deny' ? 'deny' : 'allow', text: text.value });
      },
    },
    effect,
    text,
    h('button', { type: 'submit', class: 'button secondary small' }, 'Add'),
  );
  const element = h(
    'div',
    { class: 'rules-section' },
    h('h3', { class: 'settings-heading' }, 'Permissions'),
    h(
      'p',
      { class: 'settings-intro' },
      'Commands Geno runs in this workspace without asking, and commands it never runs there. A command matches when it starts with the rule’s words, and a deny wins. Geno keeps the rules in its own folder, never in the repository, and still asks before a forced push, deleting outside the workspace, or touching credentials.',
    ),
    note,
    list,
    form,
    refused,
  );
  return {
    element,
    refresh: () => post({ type: 'permissions-list' }),
    listed(listing: PermissionsListing): void {
      if (listing.kind !== 'loaded') {
        note.hidden = false;
        note.textContent = listing.kind === 'loading' ? 'Loading…' : listing.message;
        reconcile(list, []);
        return;
      }
      note.hidden = listing.rules.length > 0;
      note.textContent = 'No rules yet. Choose Always allow in this workspace on a command’s card, or add one here.';
      reconcile(list, listing.rules.map((rule) => ({ key: rule.id, deps: [rule.effect, rule.text], build: () => ruleRow(rule, post) })));
      refused.hidden = listing.refused === undefined;
      refused.replaceChildren(...(listing.refused === undefined ? [] : [icon('error'), h('span', {}, listing.refused)]));
      // A rule the engine saved leaves the field; one it refused stays, to be fixed.
      if (listing.refused === undefined && listing.rules.some((rule) => rule.text === text.value.trim().replace(/\s+/g, ' '))) text.value = '';
    },
  };
}
