/// <reference lib="dom" />
import { h, icon, type Child } from './dom.js';
import { ACTIONS, type AgentAction, type AgentState, type AgentsFromView, type ExternalAgent, type Outcome } from './agents-model.js';

type Badge = { readonly label: string; readonly tone: 'ok' | 'wait' | 'quiet' | 'busy' | 'failed' };

const BADGES: Readonly<Record<AgentState['kind'], Badge>> = {
  checking: { label: 'Checking…', tone: 'busy' },
  missing: { label: 'Not installed', tone: 'quiet' },
  'signed-out': { label: 'Signed out', tone: 'wait' },
  'signed-in': { label: 'Signed in', tone: 'ok' },
  'signing-in': { label: 'Signing in…', tone: 'busy' },
  'signing-out': { label: 'Signing out…', tone: 'busy' },
  updating: { label: 'Updating…', tone: 'busy' },
  installing: { label: 'Installing…', tone: 'busy' },
  error: { label: 'Error', tone: 'failed' },
};

const BUTTONS: Readonly<Record<AgentAction, { readonly label: string; readonly primary: boolean }>> = {
  login: { label: 'Sign in', primary: true },
  logout: { label: 'Sign out', primary: false },
  update: { label: 'Update', primary: false },
};

const WAITING: Readonly<Partial<Record<AgentState['kind'], string>>> = {
  'signing-in': 'Waiting for the browser…',
  'signing-out': 'Signing out…',
  updating: 'Updating…',
};

const output = (text: string, label: string): Child => text !== '' && h('pre', { class: 'agent-output', 'aria-label': label, tabindex: '0' }, text);

function fact(label: string, value: Child, ...actions: Child[]): HTMLElement {
  return h('div', { class: 'agent-fact' }, h('dt', {}, label), h('dd', {}, value, ...actions));
}

function outcome(last: Outcome | undefined, agent: ExternalAgent): Child {
  if (last === undefined) return undefined;
  return h(
    'div',
    { class: 'agent-last' },
    h('p', { class: 'provider-test', role: 'status', 'data-tone': last.ok ? 'ok' : 'failed' }, icon(last.ok ? 'check' : 'warning'), h('span', {}, last.text)),
    output(last.output, `${agent.label} output`),
  );
}

/** A question the card asks before it acts. */
export type Confirming = 'install' | 'logout';

/** The state a question belongs to; once the agent leaves it, the question is gone. */
export const CONFIRMS_IN: Readonly<Record<Confirming, AgentState['kind']>> = { install: 'missing', logout: 'signed-in' };

function confirmBox(label: string, text: readonly Child[], yes: string, prefix: Confirming, onYes: () => void, onNo: () => void): HTMLElement {
  return h(
    'div',
    { class: 'lane-confirm agent-confirm', 'data-tone': prefix === 'logout' ? 'danger' : 'ask', role: 'group', 'aria-label': label },
    ...text,
    h(
      'div',
      { class: 'lane-actions' },
      h('button', { type: 'button', class: `button small${prefix === 'logout' ? ' danger' : ''}`, 'data-action': `${prefix}-yes`, onclick: onYes }, yes),
      h('button', { type: 'button', class: 'button small secondary', 'data-action': `${prefix}-no`, onclick: onNo }, 'Cancel'),
    ),
  );
}

/**
 * One external agent's card: where its CLI is, its version with Update, and its account with Sign in or Sign out.
 * Installing and signing out ask first, in the card, as discarding a lane does.
 */
export function agentCard(
  agent: ExternalAgent,
  state: AgentState,
  confirming: Confirming | undefined,
  post: (message: AgentsFromView) => void,
  confirm: (what: Confirming | undefined) => void,
): HTMLElement {
  const badge = BADGES[state.kind];
  const run = (action: AgentAction) => post({ type: 'agents-run', id: agent.id, action });
  const offered = ACTIONS[state.kind] ?? [];
  const button = (action: AgentAction): Child =>
    offered.includes(action) &&
    h(
      'button',
      {
        type: 'button',
        class: `button small${BUTTONS[action].primary ? '' : ' secondary'}`,
        'data-action': action,
        onclick: () => (action === 'logout' ? confirm('logout') : run(action)),
      },
      BUTTONS[action].label,
    );
  const check = h('button', { type: 'button', class: 'link-button agent-check', 'data-action': 'check', onclick: () => post({ type: 'agents-check' }) }, 'Check again');

  const body: Child[] = [];
  if (state.kind === 'checking') {
    body.push(h('p', { class: 'provider-note' }, icon('loading', 'codicon-modifier-spin'), h('span', {}, 'Looking for the CLI…')), outcome(state.last, agent));
  } else if (state.kind === 'missing') {
    const guide = h('button', { type: 'button', class: 'link-button agent-check', 'data-action': 'guide', onclick: () => post({ type: 'agents-open', id: agent.id, target: 'install' }) }, 'Install guide');
    body.push(h('p', { class: 'agent-text' }, `${agent.label}’s CLI is not installed. Geno needs it to sign in to ${agent.label} and use its agent.`));
    if (confirming === 'install') {
      body.push(
        confirmBox(
          `Install the ${agent.label} CLI`,
          [
            h('p', { class: 'lane-confirm-text' }, `Install the ${agent.label} CLI? Geno opens a terminal and runs ${agent.label}’s official installer there, where you can watch it:`),
            h('code', { class: 'agent-install' }, agent.install.command),
            h('p', { class: 'lane-confirm-text' }, `It downloads the CLI from ${agent.install.source} and puts it in ${agent.install.location}.`),
          ],
          'Install',
          'install',
          () => (confirm(undefined), post({ type: 'agents-install', id: agent.id })),
          () => confirm(undefined),
        ),
      );
    } else {
      body.push(
        h(
          'div',
          { class: 'provider-actions' },
          h('button', { type: 'button', class: 'button small', 'data-action': 'install', onclick: () => confirm('install') }, `Install ${agent.label} CLI`),
          check,
          guide,
        ),
      );
    }
  } else if (state.kind === 'installing') {
    body.push(
      h('p', { class: 'provider-test agent-wait', role: 'status', 'data-tone': 'busy' }, icon('loading', 'codicon-modifier-spin'), h('span', {}, 'Installing in the terminal…')),
      h('p', { class: 'agent-text' }, 'Geno checks again when you close that terminal. If the install already finished, check now.'),
      h('div', { class: 'provider-actions' }, check),
    );
  } else {
    const signedIn = state.kind === 'signed-in';
    const account = signedIn ? (state.account ?? 'Signed in') : state.kind === 'signed-out' || state.kind === 'signing-in' ? 'Signed out' : state.kind === 'error' ? 'Unknown' : '…';
    body.push(
      h(
        'dl',
        { class: 'agent-facts' },
        fact('CLI', h('code', { class: 'agent-path', title: state.cli.path }, state.cli.path)),
        fact('Version', h('span', { class: 'agent-version' }, state.cli.version ?? 'unknown'), button('update')),
        fact('Account', h('span', { class: 'agent-account' }, account), confirming === 'logout' ? undefined : button('login'), confirming === 'logout' ? undefined : button('logout')),
      ),
    );
    if (confirming === 'logout' && signedIn) {
      body.push(
        confirmBox(
          `Sign out of ${agent.label}`,
          [h('p', { class: 'lane-confirm-text' }, `Sign out of ${agent.label}? Its CLI on this computer forgets your login, so ${agent.label} needs Sign in again before Geno can use it.`)],
          'Sign out',
          'logout',
          () => (confirm(undefined), run('logout')),
          () => confirm(undefined),
        ),
      );
    }
    const waiting = WAITING[state.kind];
    if (waiting !== undefined && 'output' in state) {
      body.push(
        h('p', { class: 'provider-test agent-wait', role: 'status', 'data-tone': 'busy' }, icon('loading', 'codicon-modifier-spin'), h('span', {}, waiting)),
        state.kind === 'signing-in' &&
          state.link !== undefined &&
          h(
            'p',
            { class: 'agent-text agent-link' },
            'If no browser opened, ',
            h('button', { type: 'button', class: 'link-button', 'data-action': 'open-sign-in', title: `Open ${state.link} in your browser`, onclick: () => post({ type: 'agents-open', id: agent.id, target: 'sign-in' }) }, `open the sign-in page on ${state.link}`),
            '.',
          ),
        output(state.output, `${agent.label} output`),
        h('div', { class: 'provider-actions' }, h('button', { type: 'button', class: 'button small secondary', 'data-action': 'cancel', onclick: () => post({ type: 'agents-cancel', id: agent.id }) }, 'Cancel')),
      );
    }
    if (state.kind === 'error') body.push(h('p', { class: 'provider-test', 'data-tone': 'failed' }, icon('error'), h('span', {}, state.text)), output(state.output, `${agent.label} output`));
    if (state.kind === 'signed-in' || state.kind === 'signed-out') body.push(outcome(state.last, agent));
    if (state.kind === 'signed-in' || state.kind === 'signed-out' || state.kind === 'error') body.push(h('div', { class: 'provider-actions agent-footer' }, check));
  }

  return h(
    'li',
    { class: 'agent-card', 'data-agent': agent.id, 'data-state': state.kind },
    h(
      'div',
      { class: 'agent-head' },
      h('span', { class: 'provider-name' }, agent.label),
      h('span', { class: 'provider-format' }, 'ACP agent'),
      h('span', { class: 'spacer' }),
      h('span', { class: `provider-state mcp-state tone-${badge.tone}` }, badge.label),
    ),
    h('div', { class: 'agent-body' }, ...body),
  );
}
