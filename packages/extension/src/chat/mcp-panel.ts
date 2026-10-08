/// <reference lib="dom" />
import type { McpDefinitionView, McpServerView } from '@g-code/core';
import { h, icon, reconcile, type Child } from './dom.js';
import { awaitsApproval, badgeOf, offersSignIn, setServerNames, SOURCE_LABELS, type McpFromView, type McpListing, type McpSignIn } from './mcp-model.js';

/** A labeled line of a definition: what runs, where, with what. */
const field = (label: string, ...values: readonly string[]): HTMLElement =>
  h('div', { class: 'mcp-field' }, h('span', { class: 'mcp-field-label' }, label), ...values.map((value) => h('code', { class: 'mcp-field-value' }, value)));

/** Everything the approval covers, as the engine will run it; a changed definition asks again. */
function definitionFields(definition: McpDefinitionView): Child[] {
  if (definition.kind === 'stdio') {
    return [
      h('pre', { class: 'mcp-trust-command' }, h('code', {}, definition.commandLine)),
      definition.cwd !== undefined && field('In', definition.cwd),
      definition.env.length > 0 && field('With', ...definition.env.map(([key, value]) => `${key}=${value}`)),
    ];
  }
  return [
    h('pre', { class: 'mcp-trust-command mcp-trust-url' }, h('code', {}, definition.url)),
    definition.headers.length > 0 && field('Sends', ...definition.headers.map((name) => `${name}: …`)),
  ];
}

const WHERE: Readonly<Record<McpDefinitionView['kind'], string>> = {
  stdio: 'Geno runs this command outside the sandbox, with network access, whenever a chat in this workspace starts.',
  http: 'Geno connects to this address and gives its tools to the model whenever a chat in this workspace starts.',
  sse: 'Geno connects to this address and gives its tools to the model whenever a chat in this workspace starts.',
};

function trustCard(server: McpServerView, post: (message: McpFromView) => void): HTMLElement {
  return h(
    'section',
    { class: 'permission permission-open mcp-trust', role: 'group', 'aria-label': `Allow ${server.name} to run`, 'data-trust': server.name },
    h('div', { class: 'permission-title' }, icon('shield'), h('span', {}, server.definition.kind === 'stdio' ? 'Allow this server to run?' : 'Allow this server to connect?')),
    ...definitionFields(server.definition),
    h(
      'p',
      { class: 'permission-reason' },
      `${server.source === 'plugin' ? 'A Claude Code plugin you installed defines it, so whoever wrote the plugin chose it.' : `${SOURCE_LABELS[server.source]} in this workspace defines it, so whoever wrote the repository chose it.`} ${WHERE[server.definition.kind]} A changed definition asks again.`,
    ),
    h(
      'div',
      { class: 'permission-actions' },
      h('button', { type: 'button', class: 'button', 'data-focus': `trust:${server.name}`, onclick: () => post({ type: 'mcp-trust', name: server.name, hash: server.hash }) }, 'Allow'),
      h('button', { type: 'button', class: 'button secondary', 'data-focus': `off:${server.name}`, onclick: () => post({ type: 'mcp-enable', name: server.name, enabled: false }) }, 'Turn off'),
    ),
  );
}

const BUILTIN_NOTE = 'Chrome with a fresh profile that is thrown away after each chat, never yours. Pages on this machine open without asking; any other site asks first.';

const shortTool = (server: string, tool: string): string => tool.replace(new RegExp(`^mcp__${server.replace(/[^A-Za-z0-9_]/g, '_')}__`), '');

/**
 * Sign-in for a server that wants it, and sign-out once signed in. The browser does the signing in; the tokens stay
 * in VS Code's secret storage, and the model only learns that the server needs sign-in.
 */
function signInRow(server: McpServerView, signIn: McpSignIn | undefined, post: (message: McpFromView) => void): HTMLElement | undefined {
  if (signIn === 'signing-in') return h('p', { class: 'mcp-sign-in tone-busy' }, icon('loading', 'codicon-modifier-spin'), h('span', {}, 'Finish signing in in your browser.'));
  if (offersSignIn(server)) {
    return h(
      'p',
      { class: 'mcp-sign-in tone-wait' },
      h('span', {}, 'It needs you to sign in before Geno can use its tools.'),
      h('button', { type: 'button', class: 'button', 'data-focus': `sign-in:${server.name}`, onclick: () => post({ type: 'mcp-sign-in', name: server.name }) }, 'Sign in'),
    );
  }
  if (signIn === 'signed-in') {
    return h(
      'p',
      { class: 'mcp-sign-in tone-quiet' },
      h('span', {}, 'Signed in.'),
      h('button', { type: 'button', class: 'link-button', 'data-focus': `sign-out:${server.name}`, onclick: () => post({ type: 'mcp-sign-out', name: server.name }) }, 'Sign out'),
    );
  }
  return undefined;
}

function serverRow(server: McpServerView, signIn: McpSignIn | undefined, post: (message: McpFromView) => void): HTMLElement {
  const badge = badgeOf(server);
  const on = server.state.status !== 'disabled';
  return h(
    'li',
    { class: 'mcp-server', 'data-server': server.name, 'data-status': server.state.status },
    h(
      'div',
      { class: 'mcp-server-head' },
      icon('mcp', 'kind'),
      h('span', { class: 'mcp-name' }, server.name),
      h('span', { class: 'mcp-source' }, SOURCE_LABELS[server.source]),
      h('span', { class: 'spacer' }),
      h('span', { class: `mcp-state tone-${badge.tone}` }, badge.tone === 'busy' ? icon('loading', 'codicon-modifier-spin') : undefined, badge.label),
      h(
        'button',
        {
          type: 'button',
          class: 'mcp-switch',
          role: 'switch',
          'aria-checked': String(on),
          'aria-label': `${server.name} on`,
          title: server.source === 'builtin' ? `Turn the ${server.name} ${on ? 'off' : 'on'} (the gcode.browser.enabled setting)` : on ? `Turn ${server.name} off for this workspace` : `Turn ${server.name} on`,
          'data-focus': `switch:${server.name}`,
          onclick: () => post({ type: 'mcp-enable', name: server.name, enabled: !on }),
        },
        h('span', { class: 'mcp-switch-knob', 'aria-hidden': 'true' }),
      ),
    ),
    badge.detail !== undefined && h('p', { class: `mcp-detail tone-${badge.tone}` }, badge.detail),
    server.source === 'builtin' && h('p', { class: 'mcp-detail tone-quiet' }, BUILTIN_NOTE),
    awaitsApproval(server) && trustCard(server, post),
    signInRow(server, signIn, post),
    server.tools.length > 0 && h('p', { class: 'mcp-tools' }, server.tools.map((tool) => shortTool(server.name, tool)).join(', ')),
  );
}

/**
 * The MCP servers of the open chat, which take the transcript's place while open, and the notice in the chat
 * when a workspace server waits for approval. `onToggle` hears when the panel opens or closes.
 */
export function mcpPanel(post: (message: McpFromView) => void, onToggle: (open: boolean) => void) {
  let open = false;
  let listing: McpListing = { kind: 'loading' };

  const list = h('ul', { class: 'mcp-list', 'aria-label': 'MCP servers' });
  const note = h('p', { class: 'history-note mcp-note', role: 'status' });
  const problems = h('ul', { class: 'mcp-problems', 'aria-label': 'Problems in the MCP files' });
  const element = h(
    'section',
    { class: 'mcp', 'aria-label': 'MCP servers', hidden: true },
    h(
      'div',
      { class: 'history-bar' },
      h('button', { type: 'button', class: 'icon-button history-back', title: 'Back to the chat (Escape)', 'aria-label': 'Back to the chat', onclick: () => close() }, icon('arrow-left')),
      h('h2', { class: 'history-heading' }, 'MCP servers'),
    ),
    note,
    list,
    problems,
  );
  const noticeText = h('span', { class: 'mcp-notice-text' });
  const notice = h(
    'div',
    { class: 'mcp-notice', role: 'status', hidden: true },
    icon('shield'),
    noticeText,
    h('button', { type: 'button', class: 'link-button', 'data-focus': 'mcp-review', onclick: () => show() }, 'Review'),
  );

  function render(): void {
    const servers = listing.kind === 'loaded' ? listing.servers : [];
    const waiting = servers.filter(awaitsApproval).length;
    notice.hidden = waiting === 0 || open;
    noticeText.textContent = waiting === 1 ? '1 MCP server in this workspace waits for your approval.' : `${waiting} MCP servers in this workspace wait for your approval.`;
    if (!open) return;
    note.textContent =
      listing.kind === 'loading'
        ? 'Loading the servers…'
        : listing.kind === 'failed'
          ? `Could not list the servers: ${listing.message}`
          : servers.length === 0
            ? 'No MCP servers. Add them to .mcp.json or .vscode/mcp.json in the workspace, or to your VS Code user mcp.json.'
            : '';
    note.hidden = note.textContent === '';
    const signIns = listing.kind === 'loaded' ? listing.signIns : {};
    reconcile(list, servers.map((server) => ({ key: server.name, deps: [server, signIns[server.name]], build: () => serverRow(server, signIns[server.name], post) })));
    const found = listing.kind === 'loaded' ? listing.problems : [];
    problems.hidden = found.length === 0;
    problems.replaceChildren(...found.map((problem) => h('li', { class: 'mcp-problem' }, icon('warning'), h('span', {}, problem))));
  }

  function show(): void {
    if (open) return;
    open = true;
    element.hidden = false;
    onToggle(true);
    post({ type: 'mcp-list' });
    render();
    requestAnimationFrame(() => element.querySelector<HTMLElement>('.history-back')?.focus());
  }

  function close(): void {
    if (!open) return;
    open = false;
    element.hidden = true;
    onToggle(false);
    render();
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    close();
  });

  return {
    element,
    notice,
    isOpen: () => open,
    open: show,
    close,
    listed(next: McpListing): void {
      listing = next;
      if (next.kind === 'loaded') setServerNames(next.servers.map((server) => server.name));
      render();
    },
  };
}
