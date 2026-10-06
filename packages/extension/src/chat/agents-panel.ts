/// <reference lib="dom" />
import { h, icon, type Child } from './dom.js';
import { offeredActions, type AgentAction, type AgentState, type AgentsFromView, type CliFound, type CopyTarget, type ExternalAgent, type Outcome } from './agents-model.js';

type Badge = { readonly label: string; readonly tone: 'ok' | 'wait' | 'quiet' | 'busy' | 'failed' };

const BADGES: Readonly<Record<AgentState['kind'], Badge>> = {
  checking: { label: 'Checking…', tone: 'busy' },
  missing: { label: 'Not installed', tone: 'quiet' },
  'signed-out': { label: 'Signed out', tone: 'wait' },
  'signed-in': { label: 'Signed in', tone: 'ok' },
  'signing-in': { label: 'Signing in…', tone: 'busy' },
  'signing-out': { label: 'Signing out…', tone: 'busy' },
  updating: { label: 'Updating…', tone: 'busy' },
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
export type Confirming = 'logout';

/** The state a question belongs to; once the agent leaves it, the question is gone. */
export const CONFIRMS_IN: Readonly<Record<Confirming, AgentState['kind']>> = { logout: 'signed-in' };

const COPY_TITLES: Readonly<Record<CopyTarget, string>> = {
  install: 'Copy the install command',
  adapter: 'Copy the adapter’s install command',
  login: 'Copy the sign-in command',
  logout: 'Copy the sign-out command',
  update: 'Copy the update command',
};

/** A command for the user to run themselves, with Copy; the host copies it from its own table. */
function commandToCopy(agent: ExternalAgent, what: CopyTarget, command: string, post: (message: AgentsFromView) => void): HTMLElement {
  const copy = h(
    'button',
    {
      type: 'button',
      class: 'button small secondary agent-copy',
      'data-action': `copy-${what}`,
      title: COPY_TITLES[what],
      onclick: () => {
        post({ type: 'agents-copy', id: agent.id, what });
        copy.textContent = 'Copied';
      },
    },
    'Copy',
  );
  return h('div', { class: 'agent-command', 'data-command': what }, h('code', { class: 'agent-install' }, command), copy);
}

const COPY_INTROS: Readonly<Record<AgentAction, string>> = {
  login: 'Sign in from a terminal with this command. Geno looks again when this window gets the focus back.',
  logout: 'To sign out, run this in a terminal:',
  update: 'To update, run this in a terminal:',
};

/** What the user does to install the CLI: Geno shows the official command and its page, and runs nothing. */
function installHelp(agent: ExternalAgent, post: (message: AgentsFromView) => void, check: Child): Child[] {
  return [
    h('p', { class: 'agent-text' }, `Geno needs ${agent.label}’s CLI to sign in to ${agent.label} and use its agent. Install it yourself with ${agent.label}’s official installer:`),
    commandToCopy(agent, 'install', agent.install.command, post),
    h('p', { class: 'agent-text' }, 'Geno looks again when this window gets the focus back.'),
    h(
      'div',
      { class: 'provider-actions' },
      h('button', { type: 'button', class: 'button small', 'data-action': 'guide', onclick: () => post({ type: 'agents-open', id: agent.id, target: 'install' }) }, 'Open the install page'),
      check,
    ),
  ];
}

/** `max` as the card names it: "Max plan". */
const planLabel = (plan: string): string => `${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan`;

function adapterValue(agent: ExternalAgent, cli: CliFound): [Child, ...Child[]] {
  if (agent.adapter.kind === 'built-in') return [h('code', { class: 'agent-path agent-adapter' }, agent.adapter.command), h('span', { class: 'agent-note' }, 'built in')];
  if (cli.adapter.kind === 'found') return [h('code', { class: 'agent-path agent-adapter', title: cli.adapter.path }, cli.adapter.path)];
  return [h('span', { class: 'agent-adapter agent-note' }, 'Not installed')];
}

/** The separate adapter Geno speaks ACP through; when it is missing, how the user installs it, since Geno does not. */
function adapterHelp(agent: ExternalAgent, cli: CliFound, post: (message: AgentsFromView) => void): Child[] {
  if (agent.adapter.kind !== 'separate') return [];
  const name = h('code', { class: 'agent-name' }, agent.adapter.binaries[0] ?? '');
  const runs = `Geno runs ${agent.label} through its ACP adapter, `;
  if (cli.adapter.kind !== 'missing') return [h('p', { class: 'agent-text agent-adapter-note' }, runs, name, '.')];
  return [
    h('p', { class: 'agent-text agent-adapter-note' }, runs, name, '. Geno does not install it; install it yourself:'),
    commandToCopy(agent, 'adapter', agent.adapter.install, post),
  ];
}

/** Where the key goes and what it costs; the page sends it once and keeps no copy. */
function keyForm(agent: ExternalAgent, post: (message: AgentsFromView) => void): HTMLElement {
  const input = h('input', {
    class: 'provider-input',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': `${agent.label} API key`,
    placeholder: `${agent.label} API key`,
  });
  const submit = (event: Event) => {
    event.preventDefault();
    if (input.value.trim() === '') return;
    post({ type: 'agents-key', id: agent.id, key: input.value });
    input.value = '';
  };
  return h(
    'form',
    { class: 'provider-field agent-key', onsubmit: submit },
    h('label', { class: 'provider-field-label' }, 'Use an API key', h('span', { class: 'provider-field-note' }, 'instead of the browser')),
    h('div', { class: 'provider-field-row' }, input, h('button', { type: 'submit', class: 'button secondary small', 'data-action': 'save-key' }, 'Save')),
    h('p', { class: 'agent-text agent-billing' }, icon('info'), h('span', {}, agent.key.billing)),
  );
}

function confirmBox(label: string, text: readonly Child[], yes: string, onYes: () => void, onNo: () => void): HTMLElement {
  return h(
    'div',
    { class: 'lane-confirm agent-confirm', 'data-tone': 'danger', role: 'group', 'aria-label': label },
    ...text,
    h(
      'div',
      { class: 'lane-actions' },
      h('button', { type: 'button', class: 'button small danger', 'data-action': 'logout-yes', onclick: onYes }, yes),
      h('button', { type: 'button', class: 'button small secondary', 'data-action': 'logout-no', onclick: onNo }, 'Cancel'),
    ),
  );
}

/**
 * One external agent's card: where its CLI is, its version with Update, and its account with Sign in, an API key
 * or Sign out. Without a CLI it shows how to install one. Signing out asks first, in the card, as discarding a lane does.
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
  const keyed = state.kind === 'signed-in' && state.auth.kind === 'api-key';
  const offered = offeredActions(agent, state);
  const button = (action: AgentAction): Child =>
    offered.some(([offer, way]) => offer === action && way.kind === 'run') &&
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
    body.push(...installHelp(agent, post, check));
  } else {
    const signedIn = state.kind === 'signed-in';
    const account = signedIn
      ? state.auth.kind === 'api-key'
        ? 'API key'
        : (state.auth.account ?? 'Signed in')
      : state.kind === 'signed-out' || state.kind === 'signing-in'
        ? 'Signed out'
        : state.kind === 'error'
          ? 'Unknown'
          : '…';
    body.push(
      h(
        'dl',
        { class: 'agent-facts' },
        fact('CLI', h('code', { class: 'agent-path', title: state.cli.path }, state.cli.path)),
        fact('Version', h('span', { class: 'agent-version' }, state.cli.version ?? 'unknown'), button('update')),
        fact(
          'Account',
          h('span', { class: 'agent-account' }, account),
          signedIn && state.auth.kind === 'browser' && state.auth.plan !== undefined && h('span', { class: 'agent-plan' }, planLabel(state.auth.plan)),
          confirming === 'logout' ? undefined : button('login'),
          confirming === 'logout' ? undefined : button('logout'),
          keyed && h('button', { type: 'button', class: 'button small secondary', 'data-action': 'remove-key', onclick: () => post({ type: 'agents-remove-key', id: agent.id }) }, 'Remove key'),
        ),
        fact('ACP', ...adapterValue(agent, state.cli)),
      ),
    );
    for (const [action, way] of offered) {
      if (way.kind === 'copy') body.push(h('p', { class: 'agent-text' }, COPY_INTROS[action]), commandToCopy(agent, action, way.command, post));
    }
    body.push(...adapterHelp(agent, state.cli, post));
    if (confirming === 'logout' && signedIn) {
      body.push(
        confirmBox(
          `Sign out of ${agent.label}`,
          [h('p', { class: 'lane-confirm-text' }, `Sign out of ${agent.label}? Its CLI on this computer forgets your login, so ${agent.label} needs Sign in again before Geno can use it.`)],
          'Sign out',
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
    if (state.kind === 'signed-out') body.push(keyForm(agent, post));
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
