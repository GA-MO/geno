/// <reference lib="dom" />
import type { ProviderName } from '@g-code/core';
import { agentCard, CONFIRMS_IN, type Confirming } from './agents-panel.js';
import { EXTERNAL_AGENTS, type AgentId, type AgentState } from './agents-model.js';
import { h, icon, reconcile } from './dom.js';
import {
  providerBadge,
  type FieldView,
  type ModelsState,
  type ProviderView,
  type RoleView,
  type SettingsFromView,
  type SettingsListing,
  type TestState,
} from './settings-model.js';

const ADAPTER_LABELS = { anthropic: 'Anthropic format', openai: 'OpenAI format' } as const;

/** What a key field says in place of its value, which the page never has. */
function keyPlaceholder(field: Extract<FieldView, { secret: true }>): string {
  if (field.set === 'secret-storage') return 'Set';
  if (field.set === 'environment') return 'Set in the environment';
  return field.required ? field.hint : `${field.hint} (optional)`;
}

function fieldRow(provider: ProviderView, field: FieldView, post: (message: SettingsFromView) => void): HTMLElement {
  const input = h('input', {
    class: 'provider-input',
    type: field.secret ? 'password' : 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': `${provider.label} ${field.label}`,
    placeholder: field.secret ? keyPlaceholder(field) : field.fromEnv ? 'Set in the environment' : field.hint,
  });
  if (!field.secret) input.value = field.value;
  const submit = (event: Event) => {
    event.preventDefault();
    if (field.secret) {
      if (input.value.trim() === '') return;
      post({ type: 'settings-secret', provider: provider.id, field: field.id, value: input.value });
      // The key goes to SecretStorage only; the page keeps no copy.
      input.value = '';
      input.placeholder = 'Set';
    } else {
      post({ type: 'settings-value', provider: provider.id, field: field.id, value: input.value });
    }
  };
  return h(
    'form',
    { class: 'provider-field', 'data-field': field.id, onsubmit: submit },
    h('label', { class: 'provider-field-label' }, field.label, field.secret ? h('span', { class: 'provider-field-note' }, 'write-only') : undefined),
    h(
      'div',
      { class: 'provider-field-row' },
      input,
      h('button', { type: 'submit', class: 'button secondary small' }, 'Save'),
      field.secret && field.set === 'secret-storage'
        ? h('button', { type: 'button', class: 'link-button provider-clear', onclick: () => post({ type: 'settings-clear', provider: provider.id, field: field.id }) }, 'Remove')
        : undefined,
    ),
  );
}

type CardState = { readonly expanded: boolean; readonly test: TestState | undefined; readonly models: ModelsState | undefined };

function providerCard(view: ProviderView, chat: ProviderName, state: CardState, post: (message: SettingsFromView) => void, toggle: () => void): HTMLElement {
  const badge = providerBadge(view);
  const models = state.models;
  return h(
    'li',
    { class: 'provider-card', 'data-provider': view.id, 'data-state': badge.state },
    h(
      'button',
      { type: 'button', class: 'provider-head', 'aria-expanded': String(state.expanded), onclick: toggle },
      icon(state.expanded ? 'chevron-down' : 'chevron-right', 'provider-chevron'),
      h('span', { class: 'provider-name' }, view.label),
      view.id === chat ? h('span', { class: 'provider-tag' }, 'chat') : undefined,
      h('span', { class: 'provider-format' }, ADAPTER_LABELS[view.adapter]),
      h('span', { class: 'spacer' }),
      h('span', { class: `provider-state mcp-state tone-${badge.tone}` }, badge.label),
    ),
    state.expanded &&
      h(
        'div',
        { class: 'provider-body' },
        ...view.fields.map((field) => fieldRow(view, field, post)),
        h(
          'div',
          { class: 'provider-actions' },
          h('button', { type: 'button', class: 'button small', disabled: state.test?.kind === 'running', onclick: () => post({ type: 'settings-test', provider: view.id }) }, 'Test connection'),
          view.listsModels
            ? h('button', { type: 'button', class: 'button secondary small', onclick: () => post({ type: 'settings-list-models', provider: view.id }) }, 'List models')
            : undefined,
        ),
        state.test !== undefined &&
          h(
            'p',
            { class: 'provider-test', role: 'status', 'data-tone': state.test.kind === 'running' ? 'busy' : state.test.kind === 'ok' ? 'ok' : 'failed' },
            state.test.kind === 'running' ? icon('loading', 'codicon-modifier-spin') : icon(state.test.kind === 'ok' ? 'check' : 'error'),
            h('span', {}, state.test.kind === 'running' ? 'Testing…' : state.test.text),
          ),
        models?.kind === 'loading' && h('p', { class: 'provider-note' }, 'Listing models…'),
        models?.kind === 'failed' && h('p', { class: 'provider-test', 'data-tone': 'failed' }, icon('error'), h('span', {}, models.text)),
        models?.kind === 'loaded' &&
          h(
            'ul',
            { class: 'provider-models', 'aria-label': `${view.label} models` },
            ...models.models.map((model) =>
              h(
                'li',
                {},
                h(
                  'button',
                  { type: 'button', class: 'provider-model', title: `Use ${model} for chat`, onclick: () => post({ type: 'settings-role', role: 'chat', provider: view.id, model }) },
                  model,
                ),
              ),
            ),
          ),
      ),
  );
}

function roleRow(role: RoleView, providers: readonly ProviderView[], post: (message: SettingsFromView) => void): HTMLElement {
  if (role.kind === 'fixed') {
    return h('li', { class: 'role-row', 'data-role': role.role }, h('span', { class: 'role-label' }, role.label), h('span', { class: 'role-fixed' }, role.text));
  }
  const select = h(
    'select',
    { class: 'role-provider', 'aria-label': `${role.label} provider` },
    role.role === 'chat' ? undefined : h('option', { value: '' }, 'Geno’s default'),
    ...providers.map((provider) => h('option', { value: provider.id }, provider.label)),
  );
  select.value = role.provider ?? '';
  const model = h('input', {
    class: 'provider-input role-model',
    type: 'text',
    spellcheck: 'false',
    'aria-label': `${role.label} model`,
    placeholder: providers.find((provider) => provider.id === role.provider)?.defaultModel ?? 'model',
  });
  model.value = role.model;
  const save = () => post({ type: 'settings-role', role: role.role, provider: select.value, model: model.value });
  select.addEventListener('change', save);
  return h(
    'li',
    { class: 'role-row', 'data-role': role.role },
    h('span', { class: 'role-label' }, role.label),
    h(
      'form',
      {
        class: 'role-choice',
        onsubmit: (event: Event) => {
          event.preventDefault();
          save();
        },
      },
      select,
      model,
    ),
  );
}

/**
 * Geno's providers, keys and roles, in the transcript's place while open, styled as the MCP panel is. Keys are
 * write-only: a field takes one and empties, and the page only ever hears whether each is set.
 */
export function settingsPanel(post: (message: SettingsFromView) => void, onToggle: (open: boolean) => void) {
  let open = false;
  let listing: SettingsListing | undefined;
  let expanded: Set<ProviderName> | undefined;
  const tests = new Map<ProviderName, TestState>();
  const models = new Map<ProviderName, ModelsState>();
  const agentStates = new Map<AgentId, AgentState>();
  let confirming: { readonly id: AgentId; readonly what: Confirming } | undefined;

  const roles = h('ul', { class: 'settings-roles', 'aria-label': 'Roles' });
  const providers = h('ul', { class: 'provider-list', 'aria-label': 'Providers' });
  const agents = h('ul', { class: 'provider-list agent-list', 'aria-label': 'Agents' });
  const note = h('p', { class: 'history-note' }, 'Loading…');
  const element = h(
    'section',
    { class: 'settings', 'aria-label': 'Models and keys', hidden: true },
    h(
      'div',
      { class: 'history-bar' },
      h('button', { type: 'button', class: 'icon-button history-back', title: 'Back to the chat (Escape)', 'aria-label': 'Back to the chat', onclick: () => close() }, icon('arrow-left')),
      h('h2', { class: 'history-heading' }, 'Models and keys'),
    ),
    note,
    h('h3', { class: 'settings-heading' }, 'Roles'),
    roles,
    h('h3', { class: 'settings-heading' }, 'Agents'),
    h('p', { class: 'settings-intro' }, 'Other coding agents Geno can work with. Geno runs each agent’s own command line to sign in and update, and never reads or keeps its login.'),
    agents,
    h('h3', { class: 'settings-heading' }, 'Providers'),
    h('p', { class: 'settings-intro' }, 'Keys go to VS Code’s secret storage and are never shown again. Base URLs are kept in your user settings, never a workspace’s.'),
    providers,
  );

  function renderAgents(): void {
    if (confirming !== undefined && agentStates.get(confirming.id)?.kind !== CONFIRMS_IN[confirming.what]) confirming = undefined;
    reconcile(
      agents,
      EXTERNAL_AGENTS.map((agent) => {
        const state = agentStates.get(agent.id) ?? { kind: 'checking' };
        const asking = confirming?.id === agent.id ? confirming.what : undefined;
        return {
          key: agent.id,
          deps: [state, asking],
          build: () =>
            agentCard(agent, state, asking, post, (what) => {
              const was = confirming?.what;
              confirming = what === undefined ? undefined : { id: agent.id, what };
              renderAgents();
              const focus = what !== undefined ? `${what}-no` : was;
              if (focus !== undefined) agents.querySelector<HTMLElement>(`[data-agent="${agent.id}"] [data-action="${focus}"]`)?.focus();
            }),
        };
      }),
    );
  }

  function render(): void {
    if (!open) return;
    renderAgents();
    if (listing === undefined) return;
    note.hidden = true;
    expanded ??= new Set([listing.chat]);
    const { chat } = listing;
    reconcile(roles, listing.roles.map((role) => ({ key: role.role, deps: [JSON.stringify(role)], build: () => roleRow(role, listing!.providers, post) })));
    reconcile(
      providers,
      listing.providers.map((view) => {
        const state: CardState = { expanded: expanded!.has(view.id), test: tests.get(view.id), models: models.get(view.id) };
        return {
          key: view.id,
          deps: [JSON.stringify(view), chat, state.expanded, state.test, state.models],
          build: () =>
            providerCard(view, chat, state, post, () => {
              if (!expanded!.delete(view.id)) expanded!.add(view.id);
              render();
            }),
        };
      }),
    );
  }

  function show(): void {
    if (open) return;
    open = true;
    element.hidden = false;
    onToggle(true);
    post({ type: 'settings-list' });
    post({ type: 'agents-check' });
    render();
    requestAnimationFrame(() => element.querySelector<HTMLElement>('.history-back')?.focus());
  }

  function close(): void {
    if (!open) return;
    open = false;
    element.hidden = true;
    onToggle(false);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    close();
  });

  return {
    element,
    isOpen: () => open,
    open: show,
    close,
    listed(next: SettingsListing): void {
      listing = next;
      render();
    },
    tested(provider: ProviderName, state: TestState): void {
      tests.set(provider, state);
      render();
    },
    modelsListed(provider: ProviderName, state: ModelsState): void {
      models.set(provider, state);
      render();
    },
    agentChanged(id: AgentId, state: AgentState): void {
      agentStates.set(id, state);
      render();
    },
  };
}
