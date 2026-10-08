import * as vscode from 'vscode';
import { ANSWERS, PROMPTS, THEMES, THREE, TWO } from './question-fixture.js';
import { SHOOTING } from './shooting.js';

const model = () => process.env['GCODE_FAKE_MODEL']!;

function check(ok: boolean, what: string, actual?: unknown): void {
  if (!ok) throw new Error(`${what}${actual === undefined ? '' : `; got ${JSON.stringify(actual)}`}`);
}

async function waitFor(what: string, probe: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      if (await probe()) return;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last === undefined ? '' : `: ${String(last)}`}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function ui<T = unknown>(action: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${model()}/ui`, { method: 'POST', body: JSON.stringify(action) });
  const text = await response.text();
  check(response.ok, `ui ${JSON.stringify(action)}`, text);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

const panel = <T>(expression: string): Promise<T> => ui<T>({ do: 'eval', expression });
const click = (selector: string, text?: string) => ui({ do: 'click', selector, ...(text === undefined ? {} : { text }) });
const press = (key: string, modifiers: readonly string[] = []) => ui({ do: 'press', key, modifiers });
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const textsOf = (selector: string) => panel<string[]>(`[...doc.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent)`);
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CARD = '.permission-open.permission-ask-question';

/** Where the keyboard is: the focused row's question tab and row, or the focused control's class. */
type Focus = { readonly tab: string | null; readonly row: string | null; readonly what: string };
const focus = () =>
  panel<Focus>(`(() => {
    const a = doc.activeElement;
    const card = a?.closest('.question-card');
    return {
      tab: card?.querySelector('.question-tab-on')?.textContent ?? null,
      row: a?.closest('.question-row')?.dataset.row ?? null,
      what: a ? a.tagName.toLowerCase() + '.' + [...a.classList].join('.') : 'none',
    };
  })()`);

async function expectFocus(what: string, tab: string | null, row: string): Promise<void> {
  await waitFor(`${what}: the keyboard on ${tab ?? 'the card'}, row ${row}`, async () => {
    const at = await focus();
    return at.tab === tab && at.row === row;
  }, 5_000).catch(async (error) => {
    throw new Error(`${String(error)}; at ${JSON.stringify(await focus())}`);
  });
}

async function send(prompt: string): Promise<void> {
  await click('textarea[data-focus="composer"]');
  await ui({ do: 'type', text: prompt });
  await press('Enter');
}

async function screenshots(name: string): Promise<void> {
  if (!SHOOTING) return;
  for (const [slug, theme] of Object.entries(THEMES)) {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
    await sleep(1500);
    await vscode.commands.executeCommand('notifications.clearAll');
    await sleep(300);
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
  }
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', THEMES.dark, vscode.ConfigurationTarget.Global);
  await sleep(800);
}

const finished = (n: number) => waitFor(`turn ${n} to finish`, async () => (await count('.turn-footer')) === n);

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  // Wide enough that a preview sits beside the options, as it does in a roomy panel.
  for (let i = 0; i < 10; i++) await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');

  // The keyboard: a three-question card opens with the keyboard on its first option and that option's preview.
  await send(PROMPTS.keyboard);
  await waitFor('the question card', async () => (await count(CARD)) === 1);
  const tabs = await textsOf(`${CARD} .question-tab`);
  check(JSON.stringify(tabs) === JSON.stringify(THREE.questions.map((q) => q.header)), 'a tab per question, labelled by its header', tabs);
  await expectFocus('the card opens', 'Button', '0');
  check((await textOf(`${CARD} .question-text`)) === THREE.questions[0].question, 'the first question shows', await textOf(`${CARD} .question-text`));
  check(JSON.stringify(await textsOf(`${CARD} .question-option`)) === '["Solid","Ghost"]', 'its options, Other not among them', await textsOf(`${CARD} .question-option`));
  check((await count(`${CARD} .question-other .question-input`)) === 1, 'Other is a row of its own with a text field');
  check((await textsOf(`${CARD} .question-tag`)).join() === 'Recommended', 'the recommended option is tagged', await textsOf(`${CARD} .question-tag`));
  check((await textOf(`${CARD} .question-preview`))?.includes('background: #171717') === true, 'the focused option shows its preview', await textOf(`${CARD} .question-preview`));
  check((await count(`${CARD} .question-preview script, ${CARD} .question-preview iframe`)) === 0, 'the preview is rendered markdown, never markup');
  check(await panel<boolean>(`doc.querySelector('${CARD} .question-submit').disabled`), 'Submit answers waits for every answer');
  await panel(`doc.querySelector('${CARD}').scrollIntoView({ block: 'start' })`);
  await screenshots('card');
  await panel(`doc.querySelector('${CARD} [data-keyboard]').focus()`);

  await press('ArrowRight');
  await expectFocus('right goes to the next question', 'Targets', '0');
  await press('ArrowLeft');
  await expectFocus('left comes back', 'Button', '0');
  await press('ArrowDown');
  await expectFocus('down moves to the next option', 'Button', '1');
  check((await textOf(`${CARD} .question-preview`))?.includes('background: transparent') === true, 'the preview follows the focus', await textOf(`${CARD} .question-preview`));
  await press('Enter');
  await expectFocus('Enter picks Ghost and moves on', 'Targets', '0');
  check((await count(`${CARD} .question-tab .question-dot`)) === 1, 'the answered tab has a dot');
  await press('Space');
  await press('ArrowDown');
  await press('ArrowDown');
  await press('Space');
  check(JSON.stringify(await textsOf(`${CARD} .question-row-on .question-option`)) === '["Web","Mobile"]', 'Space toggles in a multi-select', await textsOf(`${CARD} .question-row-on .question-option`));
  await press('4');
  await waitFor('4 to open Other', async () => (await focus()).what.startsWith('textarea.question-input'));
  await ui({ do: 'type', text: 'a CLI' });
  await press('Tab');
  await expectFocus('Tab goes to the last question', 'Layout', '0');
  check(await panel<boolean>(`doc.querySelector('${CARD} .question-submit').disabled`), 'still one question to answer');
  await press('ArrowDown');
  await press('Enter');
  await finished(1);
  check((await textOf('.permission-ask-question .permission-outcome')) === 'Answered 3 questions: Button, Targets, Layout', 'the answered card folds into one line', await textOf('.permission-ask-question .permission-outcome'));
  check((await count('.permission-ask-question.permission-folded')) === 1, 'folded while the turn is');
  await screenshots('folded');
  await click('.turn-fold');
  await waitFor('the opened turn to list the answers', async () => (await count('.question-answers dd')) === 3);
  const answers = await textsOf('.question-answers dd');
  check(JSON.stringify(answers) === JSON.stringify(['Ghost', 'Web, Mobile, a CLI', 'Side']), 'the opened turn shows each answer', answers);
  await panel(`doc.querySelector('.question-answers').closest('.turn').scrollIntoView({ block: 'start' })`);
  await screenshots('answered');
  check((await textOf('[data-turn] .markdown')) !== null && (await textsOf('.markdown')).some((t) => t.includes(ANSWERS.keyboard)), 'the turn answered');

  // Clicks: a tab, an option, the Other field, then Submit answers.
  await send(PROMPTS.clicks);
  await waitFor('the second card', async () => (await count(CARD)) === 1);
  await click(`${CARD} .question-option`, 'Medium');
  check((await count(CARD)) === 1, 'a click picks without sending when there are several questions');
  check(await panel<boolean>(`doc.querySelector('${CARD} .question-submit').disabled`), 'the second question is still open');
  await click(`${CARD} .question-tab`, TWO.questions[1].header);
  await waitFor('the Extras tab', async () => (await textOf(`${CARD} .question-text`)) === TWO.questions[1].question);
  await click(`${CARD} .question-other`);
  await waitFor('the Other field to take the keyboard', async () => (await focus()).what.startsWith('textarea.question-input'));
  await ui({ do: 'type', text: 'Dark mode' });
  await waitFor('Submit answers to wake once both questions have an answer', async () => !(await panel<boolean>(`doc.querySelector('${CARD} .question-submit').disabled`)), 5_000).catch(async (error) => {
    throw new Error(`${String(error)}; card ${await panel<string>(`doc.querySelector('${CARD}').outerHTML.slice(0, 3000)`)}`);
  });
  await click(`${CARD} .question-submit`);
  await finished(2);
  check((await textsOf('.permission-ask-question .permission-outcome')).at(-1) === 'Answered 2 questions: Size, Extras', 'the second card answered', await textsOf('.permission-ask-question .permission-outcome'));

  // Esc declines the card, and the turn goes on without the answer.
  await send(PROMPTS.cancel);
  await waitFor('the third card', async () => (await count(CARD)) === 1);
  await expectFocus('a one-question card', null, '0');
  await press('Escape');
  await finished(3);
  check((await textsOf('.permission-outcome')).at(-1) === 'Skipped', 'Esc skips the question', await textsOf('.permission-outcome'));
  check((await textsOf('.markdown')).some((t) => t.includes(ANSWERS.cancel)), 'the turn went on to its answer');
}
