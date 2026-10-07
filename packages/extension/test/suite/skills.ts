import * as vscode from 'vscode';
import { PROMPT } from './skills-fixture.js';
import { check, click, count, openPanel, panel, panelWidth, screenshots, shown, textOf, ui, waitFor } from './lanes-ui.js';

const hit = (name: string) => `.skills-hit[data-name="${name}"]`;
const row = (name: string) => `.skills-row[data-name="${name}"]`;
const scrollTo = (selector: string) => panel(`(doc.querySelector('${selector}').scrollIntoView({ block: 'start' }), 1)`);

async function openSettings(): Promise<void> {
  await vscode.commands.executeCommand('gcode.chat.settings');
  await waitFor('the settings page', () => shown('.settings'));
  await waitFor('the catalog entries', async () => (await count('.skills-hit')) === 2, 90_000, () => textOf('.skills-section'));
}

async function install(name: string, scope: 'user' | 'project'): Promise<void> {
  if (!(await shown(`${hit(name)} .skills-body`))) await click(`${hit(name)} .provider-head`);
  await waitFor(`the preview of ${name}`, () => shown(`${hit(name)} .skills-body`));
  await panel(`(() => { const s = doc.querySelector('${hit(name)} .skills-scope'); s.value = '${scope}'; s.dispatchEvent(new Event('change')); return 1; })()`);
  await waitFor('Install to be ready', () => panel<boolean>(`!doc.querySelector('${hit(name)} .skills-install-button').disabled`));
  await click(`${hit(name)} .skills-install-button`);
  await waitFor(`${name} to install`, () => shown(`${hit(name)} .skills-outcome[data-tone="ok"]`), 30_000, () => textOf(`${hit(name)} .skills-outcome`));
}

export async function run(): Promise<void> {
  await openPanel();
  await panelWidth(420);
  await openSettings();
  await scrollTo('.skills-section');
  const empty = await textOf('.skills-note');
  check(empty === 'No skills or agents in this workspace or in ~/.g-code yet.', 'nothing is installed yet', empty);
  await screenshots('settings');

  await click(`${hit('deploy-notes')} .provider-head`);
  await waitFor('the preview', () => shown(`${hit('deploy-notes')} .skills-body`));
  const body = await textOf(`${hit('deploy-notes')} .skills-body`);
  check(body?.includes('Read references/steps.md, then write the notes.') === true, 'the preview shows the SKILL.md body', body);
  const files = await panel<string[]>(`[...doc.querySelectorAll('${hit('deploy-notes')} .skills-files code')].map((c) => c.textContent)`);
  check(JSON.stringify(files) === JSON.stringify(['SKILL.md', 'references/steps.md', 'install.sh']), 'the preview lists every file', files);
  await scrollTo(hit('deploy-notes'));
  await screenshots('preview');

  await install('deploy-notes', 'user');
  await waitFor('the installed skill in the list', async () => (await count(`${row('deploy-notes')} .skills-uninstall`)) === 1);
  await install('reviewer', 'project');
  await waitFor('the installed agent in the list', async () => (await count(`${row('reviewer')}[data-where="workspace"]`)) === 1);
  await scrollTo('.skills-section');
  await screenshots('installed');

  await ui({ do: 'press', key: 'Escape' });
  await waitFor('the chat', async () => !(await shown('.settings')));
  await click('textarea');
  await ui({ do: 'type', text: PROMPT });
  await ui({ do: 'press', key: 'Enter' });
  await waitFor('the turn that loads the skill to finish', async () => (await count('.turn-footer')) === 1);

  await openSettings();
  await click(`${row('deploy-notes')} .skills-uninstall`);
  await waitFor('the skill to go', async () => (await count(row('deploy-notes'))) === 0);
  const said = await textOf('.skills-list-outcome');
  check(said === 'Uninstalled deploy-notes.', 'the section says it uninstalled the skill', said);
  check((await count(row('reviewer'))) === 1, 'the agent stays');
}
