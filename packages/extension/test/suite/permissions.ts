import * as vscode from 'vscode';
import { COMMAND, PROMPTS } from './permissions-fixture.js';
import { check, click, count, openPanel, panel, panelWidth, screenshots, shown, sleep, textOf, ui, waitFor } from './lanes-ui.js';

const CARD = '.permission-open';
const ALWAYS = `${CARD} button[data-focus$=":allow-workspace"]`;
const rows = () => panel<{ effect: string; text: string }[]>(`[...doc.querySelectorAll('.perm-row')].map((r) => ({ effect: r.dataset.effect, text: r.querySelector('.perm-pattern').textContent }))`);

/** Whether anything inside `selector` runs past its right edge. */
const fitsIn = (selector: string) =>
  panel<{ fits: boolean; outside: string[] }>(
    `(() => { const c = doc.querySelector('${selector}').getBoundingClientRect(); const outside = [...doc.querySelectorAll('${selector} *')].filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().right > c.right + 0.5).map((e) => e.className || e.tagName); return { fits: outside.length === 0, outside }; })()`,
  );

async function send(prompt: string): Promise<void> {
  await click('textarea');
  const before = await panel<string>(`doc.querySelector('textarea').value`);
  check(before === '', 'the composer is empty before the suite types', before);
  await ui({ do: 'type', text: prompt });
  await ui({ do: 'press', key: 'Enter' });
}

async function narrow(name: string, selector: string): Promise<void> {
  const width = await panelWidth(300);
  check(Math.abs(width - 300) <= 4, 'the panel narrows to about 300px', width);
  await sleep(300);
  await panel(`doc.querySelector('${selector}').scrollIntoView({ block: 'nearest' })`);
  const fits = await fitsIn(selector);
  check(fits.fits, `nothing in ${selector} runs past its edge at 300px`, fits);
  await screenshots(`${name}-300`);
  await panelWidth(420);
  await sleep(300);
}

async function addRule(effect: 'allow' | 'deny', text: string): Promise<void> {
  await panel(`(() => { const s = doc.querySelector('.perm-choice'); s.value = '${effect}'; const i = doc.querySelector('.perm-text'); i.value = ''; i.focus(); })()`);
  await ui({ do: 'type', text });
  await click('.perm-add button[type="submit"]');
}

export async function run(): Promise<void> {
  await openPanel();
  await panelWidth(420);

  await send(PROMPTS.first);
  await waitFor('Ask to ask about a path outside the workspace', async () => (await count(CARD)) === 1);
  check((await textOf(ALWAYS)) === 'Always allow in this workspace', 'the card offers Always allow in this workspace', await textOf(ALWAYS));
  const buttons = await panel<string[]>(`[...doc.querySelectorAll('${CARD} .permission-actions button')].map((b) => b.textContent)`);
  check(JSON.stringify(buttons) === JSON.stringify(['Allow', 'Deny', 'Always allow in this workspace']), 'Allow and Deny, then Always allow', buttons);
  check((await textOf(`${CARD} .permission-rule code`)) === COMMAND, 'the card names the rule it would save', await textOf(`${CARD} .permission-rule`));
  await screenshots('card');
  await narrow('card', CARD);

  await click(ALWAYS);
  await waitFor('the first turn to finish', async () => (await count('.turn-footer')) === 1);
  const settled = await textOf('.permission-outcome');
  check(settled === 'Allowed, and saved as a rule for this workspace', 'the settled card says the rule is saved', settled);

  await send(PROMPTS.again);
  await waitFor('the second turn to finish', async () => (await count('.turn-footer')) === 2);
  check((await count('.permission')) === 1, 'the same command runs without a second card', await count('.permission'));
  await screenshots('allowed');

  await vscode.commands.executeCommand('gcode.chat.settings');
  await waitFor('the settings page', () => shown('.settings'));
  await waitFor('the saved rule in Settings', async () => (await rows()).length === 1);
  check(JSON.stringify(await rows()) === JSON.stringify([{ effect: 'allow', text: COMMAND }]), 'Settings lists the saved allow rule', await rows());

  await addRule('deny', 'pnpm publish');
  await waitFor('the deny rule', async () => (await rows()).length === 2);
  check((await rows())[1]!.effect === 'deny', 'the new rule denies', await rows());
  check((await panel<string>(`doc.querySelector('.perm-text').value`)) === '', 'a saved rule clears the field');

  await addRule('allow', 'git push --force');
  await waitFor('the refusal', () => shown('.perm-refused'));
  const refusal = await textOf('.perm-refused');
  check(refusal?.startsWith('Geno always asks') === true, 'an allow rule for a hard ask is refused with the reason', refusal);
  check((await rows()).length === 2, 'and nothing is saved', await rows());
  await panel(`doc.querySelector('.perm-section').scrollIntoView({ block: 'end' })`);
  await screenshots('settings');
  await narrow('settings', '.perm-section');

  await click(`.perm-row[data-effect="allow"] .perm-remove`);
  await waitFor('the allow rule to go', async () => (await rows()).length === 1);
  check(JSON.stringify(await rows()) === JSON.stringify([{ effect: 'deny', text: 'pnpm publish' }]), 'only the deny rule is left', await rows());
}
