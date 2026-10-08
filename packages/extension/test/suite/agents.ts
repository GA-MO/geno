import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { CLAUDE, claudeStatus, ENV, FAKE, fakeAdapterScript, fakeAgentScript, fakeClaudeScript, THEMES } from './agents-fixture.js';
import { check, click, openPanel, panel, panelWidth, press, shown, sleep, textOf, ui, waitFor } from './lanes-ui.js';
import { SHOOTING } from './shooting.js';

const INSTALL = 'curl https://cursor.com/install -fsS | bash';
const card = (inner = '') => `.agent-card[data-agent="cursor"] ${inner}`.trim();
const stateOf = () => panel<string | null>(`doc.querySelector('${card()}')?.dataset.state ?? null`);
const text = async (inner: string) => (await textOf(card(inner)))?.trim() ?? null;
const html = () => panel<string>('doc.documentElement.outerHTML');
const seen = async () => ({ state: await stateOf(), card: await text('') });
const settle = (what: string, state: string) => waitFor(what, async () => (await stateOf()) === state, 30_000, seen);

const scrollToAgents = (selector = card()) => panel(`doc.querySelector('${selector}').scrollIntoView({ block: 'nearest' })`);

/** Whether anything in the card runs past its right edge, as at 300px a long command or path could. */
const fitsIn = (selector: string) =>
  panel<{ fits: boolean; outside: string[] }>(
    `(() => { const c = doc.querySelector('${selector}').getBoundingClientRect(); const outside = [...doc.querySelectorAll('${selector} *')].filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().right > c.right + 0.5).map((e) => e.className || e.tagName); return { fits: outside.length === 0, outside }; })()`,
  );

async function screenshots(name: string, selector = card()): Promise<void> {
  if (!SHOOTING) return;
  await ui({ do: 'pointerAway' });
  for (const [slug, theme] of Object.entries(THEMES)) {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
    await sleep(1500);
    await vscode.commands.executeCommand('notifications.clearAll');
    await scrollToAgents(selector);
    await sleep(200);
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
  }
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', THEMES.dark, vscode.ConfigurationTarget.Global);
  await sleep(500);
}

export async function run(): Promise<void> {
  const bin = process.env[ENV.bin]!;
  const state = process.env[ENV.state]!;
  const fake = path.join(bin, 'agent');
  const calls = async () => (await readFile(path.join(state, 'calls.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  const keyed = async () => (await readFile(path.join(state, 'keyed.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  const terminals = vscode.window.terminals.length;

  await openPanel();
  await panelWidth(420);
  await vscode.commands.executeCommand('gcode.chat.settings');
  await waitFor('the settings page', () => shown('.settings'));
  await scrollToAgents();

  await settle('Cursor to read as not installed', 'missing');
  check((await text('.mcp-state')) === 'Not installed', 'the badge says so', await text('.mcp-state'));
  check((await text('.agent-text'))?.startsWith('Geno needs Cursor’s CLI') === true, 'the card says Geno needs the CLI', await text('.agent-text'));
  check((await text('.agent-install')) === INSTALL, 'and shows the official install command', await text('.agent-install'));
  check(!(await shown(card('[data-action="install"]'))), 'with no button that installs it');
  check((await text('[data-action="guide"]')) === 'Open the install page', 'it links Cursor’s install page', await text('[data-action="guide"]'));
  await vscode.env.clipboard.writeText('');
  await click(card('[data-action="copy-install"]'));
  await waitFor('the command on the clipboard', async () => (await vscode.env.clipboard.readText()) === INSTALL, 10_000, async () => vscode.env.clipboard.readText());
  check((await text('[data-action="copy-install"]')) === 'Copied', 'the Copy button says it copied', await text('[data-action="copy-install"]'));
  await screenshots('agents-missing');
  const narrow = await panelWidth(300);
  check(Math.abs(narrow - 300) <= 4, 'the panel narrows to about 300px', narrow);
  await sleep(300);
  await scrollToAgents();
  const fits = await panel<{ fits: boolean; outside: string[] }>(
    `(() => { const c = doc.querySelector('${card()}').getBoundingClientRect(); const outside = [...doc.querySelectorAll('${card('*')}')].filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().right > c.right + 0.5).map((e) => e.className || e.tagName); return { fits: outside.length === 0, outside }; })()`,
  );
  check(fits.fits, 'nothing in the missing card runs past its edge at 300px', fits);
  await screenshots('agents-missing-narrow-300');
  await panelWidth(420);
  check(vscode.window.terminals.length === terminals, 'no terminal opened', vscode.window.terminals.map((t) => t.name));
  check((await calls()).length === 0, 'nothing ran while there was no CLI');

  await writeFile(fake, fakeAgentScript(state));
  await chmod(fake, 0o755);
  // Another window takes the OS focus and gives it back, as switching to a terminal to install the CLI does.
  // A window that has sat behind another app has no focus to give away, so it takes the focus first.
  await vscode.commands.executeCommand('workbench.action.focusWindow');
  await waitFor('this window to have the focus', async () => vscode.window.state.focused, 10_000);
  const changes: boolean[] = [];
  const watch = vscode.window.onDidChangeWindowState((w) => changes.push(w.focused));
  await vscode.commands.executeCommand('workbench.action.newWindow');
  await waitFor('another window to take the focus', async () => changes.includes(false) || !vscode.window.state.focused, 30_000, async () => changes);
  const closed = await ui({ do: 'closeOtherWindows' });
  await waitFor('the focus to come back', async () => changes.at(-1) === true, 30_000, async () => ({ changes, closed }));
  watch.dispose();
  await settle('the window regaining the focus to find the CLI the user installed', 'signed-out');
  check((await text('.agent-path')) === fake, 'the card names the CLI it found, the fake one', await text('.agent-path'));
  check((await text('.agent-version')) === FAKE.version, 'and its version from `agent about`', await text('.agent-version'));
  check((await text('.agent-account')) === 'Signed out', 'and the account', await text('.agent-account'));
  check(!(await shown(card('[data-action="logout"]'))) && (await shown(card('[data-action="login"]'))), 'a signed-out card offers Sign in, not Sign out');
  check((await text('.agent-billing')) === 'May bill by usage instead of your plan', 'the key field says how a key may bill', await text('.agent-billing'));
  await panelWidth(300);
  await sleep(300);
  await scrollToAgents();
  const fitsSignedOut = await panel<{ fits: boolean; outside: string[] }>(
    `(() => { const c = doc.querySelector('${card()}').getBoundingClientRect(); const outside = [...doc.querySelectorAll('${card('*')}')].filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().right > c.right + 0.5).map((e) => e.className || e.tagName); return { fits: outside.length === 0, outside }; })()`,
  );
  check(fitsSignedOut.fits, 'nothing in the signed-out card, key field and all, runs past its edge at 300px', fitsSignedOut);
  await screenshots('agents-narrow-300');
  await panelWidth(420);

  await click(card('[data-action="login"]'));
  await settle('the sign-in to start', 'signing-in');
  await waitFor('the sign-in link', () => shown(card('[data-action="open-sign-in"]')), 30_000, seen);
  check((await text('.agent-wait')) === 'Waiting for the browser…', 'the card waits for the browser', await text('.agent-wait'));
  check((await text('[data-action="open-sign-in"]')) === `open the sign-in page on ${FAKE.host}`, 'the link names the sign-in host', await text('[data-action="open-sign-in"]'));
  await waitFor('the streamed output', async () => (await text('.agent-output'))?.includes('token: [redacted]') === true, 30_000, seen);
  check((await text('.agent-output'))?.includes(`https://${FAKE.host}/loginDeepControl?…`) === true, 'the output shows the address without its query', await text('.agent-output'));
  const page = await html();
  check(!page.includes(FAKE.challenge) && !page.includes(FAKE.token), 'neither the login challenge nor the token is anywhere in the page');
  await screenshots('agents-signing-in');

  await click(card('[data-action="cancel"]'));
  await settle('the cancelled sign-in to settle signed out', 'signed-out');
  check((await text('.agent-last .provider-test')) === 'Sign-in cancelled.', 'the card says the sign-in was cancelled', await text('.agent-last .provider-test'));

  await click(card('[data-action="login"]'));
  await waitFor('the sign-in link again', () => shown(card('[data-action="open-sign-in"]')), 30_000, seen);
  await writeFile(path.join(state, 'go'), '');
  await settle('Cursor to read as signed in', 'signed-in');
  check((await text('.agent-account')) === FAKE.account, 'the card names the account `agent about` printed', await text('.agent-account'));
  check((await text('.agent-last .provider-test')) === 'Sign-in finished.', 'and that the sign-in finished', await text('.agent-last .provider-test'));
  check(!(await html()).includes(FAKE.token), 'the token never reached the page');
  await scrollToAgents();
  await screenshots('agents-signed-in');

  await click(card('[data-action="update"]'));
  await settle('the update to run', 'updating');
  await settle('the update to finish', 'signed-in');
  check((await text('.agent-version')) === FAKE.updated, 'the card shows the new version', await text('.agent-version'));
  check((await text('.agent-last .provider-test')) === 'Update finished.', 'and that the update finished', await text('.agent-last .provider-test'));

  await click(card('[data-action="logout"]'));
  await waitFor('the sign-out confirm', () => shown(card('[data-action="logout-yes"]')));
  check((await panel<string | null>('doc.activeElement?.dataset.action ?? null')) === 'logout-no', 'the confirm takes the focus on its Cancel');
  await scrollToAgents();
  await screenshots('agents-confirm-sign-out');
  await press('Enter');
  await waitFor('the confirm to close', async () => !(await shown(card('[data-action="logout-yes"]'))));
  check((await stateOf()) === 'signed-in' && !(await calls()).some((call) => call.startsWith('logout')), 'Cancel signs nothing out');
  await click(card('[data-action="logout"]'));
  await waitFor('the sign-out confirm again', () => shown(card('[data-action="logout-yes"]')));
  await click(card('[data-action="logout-yes"]'));
  await settle('Cursor to read as signed out again', 'signed-out');
  check(!existsSync(path.join(state, 'email')), 'the fake CLI signed itself out');
  check((await keyed()).length === 0, 'no command had a key before one was stored', await keyed());

  await panel(`(() => { const w = doc.defaultView; w.__agentMessages = []; w.addEventListener('message', (e) => w.__agentMessages.push(JSON.stringify(e.data))); })()`);
  await click(card('.agent-key input'));
  await ui({ do: 'type', text: FAKE.key });
  await press('Enter');
  await settle('Cursor to read as signed in by key', 'signed-in');
  check((await text('.agent-account')) === 'API key', 'the account reads as an API key', await text('.agent-account'));
  check((await shown(card('[data-action="remove-key"]'))) && !(await shown(card('[data-action="logout"]'))), 'with Remove key in place of Sign out');
  const messages = await panel<string[]>('doc.defaultView.__agentMessages');
  check(messages.some((m) => m.includes('"api-key"')), 'the page heard the new state', messages.length);
  check(!messages.some((m) => m.includes(FAKE.key)), 'no message to the page carried the key');
  check(!(await html()).includes(FAKE.key), 'the key is nowhere in the page');
  check(JSON.stringify(await keyed()) === JSON.stringify(['about']), 'the status check had exactly the stored key in its env', await keyed());
  await scrollToAgents();
  await screenshots('agents-signed-in-key');

  await click(card('[data-action="update"]'));
  await settle('the update with the key to finish', 'signed-in');
  check(JSON.stringify(await keyed()) === JSON.stringify(['about', 'update', 'about']), 'Update ran with the key in its env too', await keyed());

  await click(card('[data-action="remove-key"]'));
  await settle('Remove key to sign out', 'signed-out');
  check((await calls()).at(-1)?.endsWith('key=') === true, 'the next check ran without a key', await calls());

  const log = await calls();
  check(!log.some((call) => call.includes(FAKE.key)), 'the key never appeared in any argv', log);
  const commands = log.map((call) => call.split(' ')[0]);
  check(
    JSON.stringify(commands) === JSON.stringify(['about', 'login', 'about', 'login', 'about', 'update', 'about', 'logout', 'about', 'about', 'update', 'about', 'about']),
    'Geno ran only the CLI’s own commands, each one followed by a status check',
    log,
  );
  check(log.filter((call) => call.startsWith('about')).every((call) => call.includes('NO_OPEN_BROWSER=1 ')), 'a status check never opens a browser', log);
  check(log.filter((call) => call.startsWith('login')).every((call) => call.includes('NO_OPEN_BROWSER= ')), 'a sign-in lets the CLI open the browser', log);

  await claudeCode(bin, state);
}

const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';
const ADAPTER_INSTALL = 'npm install -g @agentclientprotocol/claude-agent-acp';
const claudeCard = (inner = '') => `.agent-card[data-agent="claude-code"] ${inner}`.trim();
const claudeText = async (inner: string) => (await textOf(claudeCard(inner)))?.trim() ?? null;
const claudeSeen = async () => ({ state: await panel<string | null>(`doc.querySelector('${claudeCard()}')?.dataset.state ?? null`), card: await claudeText('') });
const claudeSettle = (what: string, state: string) => waitFor(what, async () => (await claudeSeen()).state === state, 30_000, claudeSeen);

/** Copies through the card's button and waits for exactly `command` on the clipboard. */
async function copies(selector: string, command: string, what: string): Promise<void> {
  await vscode.env.clipboard.writeText('');
  await click(selector);
  await waitFor(what, async () => (await vscode.env.clipboard.readText()) === command, 10_000, async () => vscode.env.clipboard.readText());
  check((await textOf(selector))?.trim() === 'Copied', `${what}: the button says it copied`, await textOf(selector));
}

/**
 * Claude Code: the official installer to copy, then a fake CLI found signed out with its sign-in to copy, signed in
 * with its sign-out to copy, Update run, the adapter missing and then found in npm's global bin, and a key that goes
 * only into the env of the CLI's processes. Geno never runs `claude auth login`, `claude auth logout` or the adapter.
 */
async function claudeCode(bin: string, state: string): Promise<void> {
  const fake = path.join(bin, 'claude');
  const adapter = path.join(process.env['NPM_CONFIG_PREFIX']!, 'bin', 'claude-agent-acp');
  const calls = async () => (await readFile(path.join(state, 'claude-calls.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  const keyed = async () => (await readFile(path.join(state, 'claude-keyed.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  const status = (signedIn: boolean) => writeFile(path.join(state, 'claude-status.json'), claudeStatus(signedIn));
  const checkAgain = () => click(claudeCard('[data-action="check"]'));

  await scrollToAgents(claudeCard());
  await claudeSettle('Claude Code to read as not installed', 'missing');
  check((await claudeText('.mcp-state')) === 'Not installed', 'the Claude Code badge says not installed', await claudeText('.mcp-state'));
  check((await claudeText('.agent-text'))?.startsWith('Geno needs Claude Code’s CLI') === true, 'the card says Geno needs the CLI', await claudeText('.agent-text'));
  check((await claudeText('.agent-install')) === CLAUDE_INSTALL, 'and shows the official install command', await claudeText('.agent-install'));
  check((await claudeText('[data-action="guide"]')) === 'Open the install page', 'it links the setup page', await claudeText('[data-action="guide"]'));
  await copies(claudeCard('[data-action="copy-install"]'), CLAUDE_INSTALL, 'the Claude Code install command on the clipboard');
  check((await calls()).length === 0, 'nothing ran while there was no claude');
  await screenshots('agents-claude-missing', claudeCard());

  await writeFile(path.join(state, 'claude-version'), CLAUDE.version);
  await status(false);
  await writeFile(fake, fakeClaudeScript(state));
  await chmod(fake, 0o755);
  await checkAgain();
  await claudeSettle('Check again to find the fake claude, signed out', 'signed-out');
  check((await claudeText('.agent-path')) === fake, 'the card names the CLI it found, the fake one', await claudeText('.agent-path'));
  check((await claudeText('.agent-version')) === CLAUDE.version, 'and its version from `claude --version`', await claudeText('.agent-version'));
  check((await claudeText('.agent-account')) === 'Signed out', 'and the account from `claude auth status --json`', await claudeText('.agent-account'));
  check(!(await shown(claudeCard('[data-action="login"]'))) && !(await shown(claudeCard('[data-action="logout"]'))), 'no Sign in or Sign out button: Geno does not run them');
  check((await claudeText('[data-command="login"] code')) === 'claude auth login', 'the card shows the sign-in command to copy', await claudeText('[data-command="login"] code'));
  await copies(claudeCard('[data-action="copy-login"]'), 'claude auth login', 'the sign-in command on the clipboard');
  check((await claudeText('.agent-adapter')) === 'Not installed', 'the adapter reads as not installed', await claudeText('.agent-adapter'));
  check(
    (await claudeText('.agent-adapter-note'))?.startsWith('Geno runs Claude Code through its ACP adapter, claude-agent-acp. Geno does not install it') === true,
    'the card names the adapter and says Geno does not install it',
    await claudeText('.agent-adapter-note'),
  );
  check((await claudeText('[data-command="adapter"] code')) === ADAPTER_INSTALL, 'and shows the npm command to install it', await claudeText('[data-command="adapter"] code'));
  await copies(claudeCard('[data-action="copy-adapter"]'), ADAPTER_INSTALL, 'the adapter command on the clipboard');
  check((await claudeText('.agent-billing')) === 'Bills by API usage instead of your Claude plan', 'the key field says how a key bills', await claudeText('.agent-billing'));
  await screenshots('agents-claude-signed-out', claudeCard());
  await panelWidth(300);
  await sleep(300);
  await scrollToAgents(claudeCard());
  const fits = await fitsIn(claudeCard());
  check(fits.fits, 'nothing in the signed-out Claude Code card runs past its edge at 300px', fits);
  await screenshots('agents-claude-narrow-300', claudeCard());
  await panelWidth(420);

  await status(true);
  await checkAgain();
  await claudeSettle('Check again to read Claude Code as signed in', 'signed-in');
  check((await claudeText('.agent-account')) === CLAUDE.account, 'the card names the account', await claudeText('.agent-account'));
  check((await claudeText('.agent-plan')) === 'Max plan', 'and its plan', await claudeText('.agent-plan'));
  check(!(await shown(claudeCard('[data-action="logout"]'))), 'with no Sign out button');
  check((await claudeText('[data-command="logout"] code')) === 'claude auth logout', 'but the sign-out command to copy', await claudeText('[data-command="logout"] code'));
  await copies(claudeCard('[data-action="copy-logout"]'), 'claude auth logout', 'the sign-out command on the clipboard');

  await writeFile(adapter, fakeAdapterScript(state));
  await chmod(adapter, 0o755);
  await checkAgain();
  await waitFor('the adapter to be found in npm’s global bin', async () => (await claudeText('.agent-adapter')) === adapter, 30_000, claudeSeen);
  check((await claudeText('.agent-adapter-note')) === 'Geno runs Claude Code through its ACP adapter, claude-agent-acp.', 'the card says Geno runs Claude Code through it', await claudeText('.agent-adapter-note'));
  check(!(await shown(claudeCard('[data-action="copy-adapter"]'))), 'and no longer offers its install command');
  await scrollToAgents(claudeCard());
  await screenshots('agents-claude-signed-in', claudeCard());

  await click(claudeCard('[data-action="update"]'));
  await claudeSettle('Claude Code’s update to run', 'updating');
  await claudeSettle('Claude Code’s update to finish', 'signed-in');
  check((await claudeText('.agent-version')) === CLAUDE.updated, 'the card shows the new version', await claudeText('.agent-version'));
  check((await claudeText('.agent-last .provider-test')) === 'Update finished.', 'and that the update finished', await claudeText('.agent-last .provider-test'));
  check((await keyed()).length === 0, 'no claude call had a key before one was stored', await keyed());

  await status(false);
  await checkAgain();
  await claudeSettle('Claude Code to read as signed out before the key', 'signed-out');
  const before = (await calls()).length;
  await panel(`(() => { const w = doc.defaultView; w.__agentMessages = []; w.addEventListener('message', (e) => w.__agentMessages.push(JSON.stringify(e.data))); })()`);
  await click(claudeCard('.agent-key input'));
  await ui({ do: 'type', text: CLAUDE.key });
  await press('Enter');
  await waitFor('Claude Code to read as signed in by key', async () => (await claudeText('.agent-account')) === 'API key', 30_000, claudeSeen);
  check(await shown(claudeCard('[data-action="remove-key"]')), 'with Remove key');
  check(JSON.stringify(await keyed()) === JSON.stringify(['--version', 'auth status --json']), 'the status check ran with exactly the stored key in its env', await keyed());
  check((await calls()).slice(before).every((call) => call.endsWith('key=present')), 'every call after the key was stored had it', await calls());
  const messages = await panel<string[]>('doc.defaultView.__agentMessages');
  check(messages.some((m) => m.includes('"api-key"')), 'the page heard the new state', messages.length);
  check(!messages.some((m) => m.includes(CLAUDE.key)), 'no message to the page carried the key');
  check(!(await html()).includes(CLAUDE.key), 'the key is nowhere in the page');
  await scrollToAgents(claudeCard());
  await screenshots('agents-claude-signed-in-key', claudeCard());

  await click(claudeCard('[data-action="remove-key"]'));
  await claudeSettle('Remove key to sign Claude Code out', 'signed-out');
  check((await calls()).at(-1) === 'auth status --json key=', 'the next status check ran without a key', await calls());

  const log = await calls();
  check(!log.some((call) => call.includes(CLAUDE.key)), 'the key never appeared in any argv', log);
  const commands = new Set(log.map((call) => call.replace(/ key=(present)?$/, '')));
  check([...commands].sort().join(',') === ['--version', 'auth status --json', 'update'].sort().join(','), 'Geno ran only --version, auth status --json and update, never auth login or logout', [...commands]);
  check(!existsSync(path.join(state, 'adapter.log')), 'Geno only looked for the adapter and never ran it');
}
