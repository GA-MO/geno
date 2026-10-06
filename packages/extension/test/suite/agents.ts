import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { ENV, FAKE, fakeAgentScript, THEMES } from './agents-fixture.js';
import { check, click, openPanel, panel, panelWidth, press, shown, sleep, textOf, ui, waitFor } from './lanes-ui.js';

const INSTALL = 'curl https://cursor.com/install -fsS | bash';
const card = (inner = '') => `.agent-card[data-agent="cursor"] ${inner}`.trim();
const stateOf = () => panel<string | null>(`doc.querySelector('${card()}')?.dataset.state ?? null`);
const text = async (inner: string) => (await textOf(card(inner)))?.trim() ?? null;
const html = () => panel<string>('doc.documentElement.outerHTML');
const seen = async () => ({ state: await stateOf(), card: await text('') });
const settle = (what: string, state: string) => waitFor(what, async () => (await stateOf()) === state, 30_000, seen);

const scrollToAgents = () => panel(`doc.querySelector('${card()}').scrollIntoView({ block: 'nearest' })`);

async function screenshots(name: string): Promise<void> {
  await ui({ do: 'pointerAway' });
  for (const [slug, theme] of Object.entries(THEMES)) {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
    await sleep(1500);
    await vscode.commands.executeCommand('notifications.clearAll');
    await scrollToAgents();
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

  await openPanel();
  await panelWidth(420);
  await vscode.commands.executeCommand('gcode.chat.settings');
  await waitFor('the settings page', () => shown('.settings'));
  await scrollToAgents();

  await settle('Cursor to read as not installed', 'missing');
  check((await text('.mcp-state')) === 'Not installed', 'the badge says so', await text('.mcp-state'));
  check((await text('[data-action="install"]')) === 'Install Cursor CLI', 'the card offers to install the CLI', await text('[data-action="install"]'));
  check(await shown(card('[data-action="guide"]')), 'and links Cursor’s install guide');
  await screenshots('agents-missing');

  await click(card('[data-action="install"]'));
  await waitFor('the install confirm', () => shown(card('[data-action="install-yes"]')));
  check((await panel<string | null>('doc.activeElement?.dataset.action ?? null')) === 'install-no', 'the confirm takes the focus on its Cancel');
  check((await text('.agent-install')) === INSTALL, 'the confirm names the official install command', await text('.agent-install'));
  check(
    (await text('.agent-confirm'))?.includes('It downloads the CLI from cursor.com and puts it in ~/.local/bin.') === true,
    'and where it downloads from and installs to',
    await text('.agent-confirm'),
  );
  await screenshots('agents-confirm-install');
  await click(card('[data-action="install-yes"]'));
  await settle('the install to run in a terminal', 'installing');
  const terminal = vscode.window.terminals.find((t) => t.name === 'Install Cursor CLI');
  check(terminal !== undefined, 'a terminal of its own runs the installer', vscode.window.terminals.map((t) => t.name));
  // The test's default shell only records what it is sent, so the real installer never runs.
  const typed = () => readFile(path.join(state, 'terminal-input'), 'utf8').catch(() => '');
  await waitFor('the terminal to get the install command', async () => (await typed()).trim() === INSTALL, 30_000, async () => ({ typed: await typed() }));
  await screenshots('agents-installing');
  terminal!.dispose();
  await settle('a check once the terminal closes, which still finds no CLI', 'missing');
  check((await calls()).length === 0, 'nothing ran while there was no CLI');

  await writeFile(fake, fakeAgentScript(state));
  await chmod(fake, 0o755);
  await click(card('[data-action="check"]'));
  await settle('Cursor to read as signed out once its CLI is there', 'signed-out');
  // Every later click runs this CLI, so it must be the fake and never the user's own.
  check((await text('.agent-path')) === fake, 'the card names the CLI it found, the fake one', await text('.agent-path'));
  check((await text('.agent-version')) === FAKE.version, 'and its version from `agent about`', await text('.agent-version'));
  check((await text('.agent-account')) === 'Signed out', 'and the account', await text('.agent-account'));
  check(!(await shown(card('[data-action="logout"]'))) && (await shown(card('[data-action="login"]'))), 'a signed-out card offers Sign in, not Sign out');

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
  const narrow = await panelWidth(300);
  check(Math.abs(narrow - 300) <= 4, 'the panel narrows to about 300px', narrow);
  await sleep(300);
  await scrollToAgents();
  const fits = await panel<{ fits: boolean; outside: string[] }>(
    `(() => { const c = doc.querySelector('${card()}').getBoundingClientRect(); const outside = [...doc.querySelectorAll('${card('*')}')].filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().right > c.right + 0.5).map((e) => e.className || e.tagName); return { fits: outside.length === 0, outside }; })()`,
  );
  check(fits.fits, 'nothing in the card runs past its edge at 300px', fits);
  await screenshots('agents-narrow-300');
  await panelWidth(420);

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
  check((await text('.agent-last .agent-output'))?.includes(`Updated to ${FAKE.updated}`) === true, 'with what the update printed', await text('.agent-last .agent-output'));

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

  const log = await calls();
  const commands = log.map((call) => call.split(' ')[0]);
  check(
    JSON.stringify(commands) === JSON.stringify(['about', 'login', 'about', 'login', 'about', 'update', 'about', 'logout', 'about']),
    'Geno ran only the CLI’s own commands, each sign-in, update and sign-out followed by a status check',
    log,
  );
  check(log.filter((call) => call.startsWith('about')).every((call) => call.endsWith('NO_OPEN_BROWSER=1')), 'a status check never opens a browser', log);
  check(log.filter((call) => call.startsWith('login')).every((call) => call.endsWith('NO_OPEN_BROWSER=')), 'a sign-in lets the CLI open the browser', log);
}
