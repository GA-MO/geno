import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { MCP_SERVER, STEPS } from './real-model-fixture.js';

type Step = (typeof STEPS)[number];
type Event = { kind: string; seq?: number; status?: string; name?: string; content?: { type: string; name?: string; text?: string; input?: unknown }[]; stopReason?: string };

const uiUrl = () => process.env['GCODE_FAKE_MODEL']!;
const workspace = () => vscode.workspace.workspaceFolders![0]!.uri.fsPath;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ui<T = unknown>(action: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${uiUrl()}/ui`, { method: 'POST', body: JSON.stringify(action) });
  const text = await response.text();
  if (!response.ok) throw new Error(`ui ${JSON.stringify(action).slice(0, 120)}: ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

const panel = <T>(expression: string): Promise<T> => ui<T>({ do: 'eval', expression });
const click = (selector: string, text?: string) => ui({ do: 'click', selector, ...(text === undefined ? {} : { text }) });
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const shot = (name: string) => ui({ do: 'screenshot', name });
const report = (step: Step, ok: boolean | null, detail: string, extra: Record<string, unknown> = {}) => ui({ do: 'report', step, ok, detail, ...extra });

async function waitFor(what: string, probe: () => Promise<boolean>, ms = 240_000, tick?: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      if (await probe()) return;
    } catch (error) {
      last = error;
    }
    if (tick !== undefined) await tick();
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last === undefined ? '' : `: ${String(last)}`}`);
    await sleep(250);
  }
}

const thaiShare = (text: string) => {
  const letters = text.match(/\p{L}/gu) ?? [];
  return letters.length === 0 ? 0 : letters.filter((c) => /[฀-๿]/.test(c)).length / letters.length;
};

/** The newest top-level session log in GCODE_HOME. */
async function newestLog(): Promise<Event[]> {
  const dir = path.join(process.env['GCODE_HOME']!, 'sessions');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  const dated = await Promise.all(files.map(async (f) => ({ f, at: (await stat(path.join(dir, f))).mtimeMs })));
  const newest = dated.sort((a, b) => b.at - a.at)[0];
  if (newest === undefined) return [];
  return (await readFile(path.join(dir, newest.f), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Event);
}

const toolNames = (events: Event[]) => events.flatMap((e) => (e.kind === 'assistant' ? (e.content ?? []).filter((b) => b.type === 'tool_use').map((b) => b.name!) : []));
const lastAnswer = () => panel<string>(`[...doc.querySelectorAll('.turn:last-child .markdown')].map((m) => m.textContent).join('\\n')`);

let turnsInChat = 0;
/** Cards the step did not ask about, such as a read-only command in Ask, are allowed and noted. */
let unplanned: string[] = [];

async function allowStrayCards(): Promise<void> {
  if ((await count('.permission-open')) === 0) return;
  unplanned.push((await textOf('.permission-open .permission-command')) ?? (await textOf('.permission-open')) ?? '?');
  await click('.permission-open button', 'Allow');
}

/** Leaves the Lanes pane, which covers the composer once a lane starts. */
async function backToChat(): Promise<void> {
  if ((await panel<boolean>(`[...doc.querySelectorAll('.history-back')].some((b) => b.getClientRects().length > 0)`)) === false) return;
  await panel(`[...doc.querySelectorAll('.history-back')].find((b) => b.getClientRects().length > 0).click()`);
  await waitFor('the composer', async () => (await panel<boolean>(`doc.querySelector('textarea')?.getClientRects().length > 0`)), 10_000);
}

async function newChat(): Promise<void> {
  await backToChat();
  await vscode.commands.executeCommand('gcode.chat.new');
  await waitFor('an empty chat', async () => (await count('.turn')) === 0, 30_000);
  turnsInChat = 0;
  unplanned = [];
}

async function send(prompt: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text: prompt });
  await ui({ do: 'press', key: 'Enter' });
  turnsInChat++;
}

const turnEnded = async () => (await count('.turn-footer')) >= turnsInChat;
const waitTurn = (allowStray = true) => waitFor(`turn ${turnsInChat} to end`, turnEnded, 300_000, allowStray ? allowStrayCards : undefined);

/** GCODE_REAL_STEPS, a comma-separated list, runs only those steps, to retry a few without paying for the rest. */
const chosen = process.env['GCODE_REAL_STEPS']?.split(',').map((s) => s.trim());

async function step(name: Step, run: () => Promise<void>): Promise<void> {
  if (chosen !== undefined && !chosen.includes(name)) return;
  try {
    await run();
  } catch (error) {
    await shot(`${name}-error`).catch(() => undefined);
    await report(name, false, `threw: ${String(error).slice(0, 400)}`);
  }
}

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1, 60_000);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  await step('B10-thai-and-working', async () => {
    await send('อธิบายโปรเจกต์นี้สั้นๆ ว่าทำอะไร ไม่ต้องแก้โค้ด');
    const peeks = new Set<string>();
    const metas = new Set<string>();
    let shotTaken = false;
    await waitFor('the Thai turn to end', turnEnded, 300_000, async () => {
      peeks.add((await panel<string | null>(`doc.querySelector('.peek')?.dataset.state ?? null`)) ?? 'none');
      const meta = await textOf('.turn:last-child .turn-meta');
      if (meta !== null) metas.add(meta.trim().slice(0, 40));
      if (!shotTaken && meta?.includes('working')) {
        shotTaken = true;
        await shot('B10-working-mid-turn');
      }
      await allowStrayCards();
    });
    await shot('B10-thai-answer');
    const answer = await lastAnswer();
    const share = thaiShare(answer);
    await report('B10-thai-and-working', share > 0.3 && [...metas].some((m) => m.includes('working')), `thai share ${share.toFixed(2)}; peek states seen ${[...peeks].join(',')}; turn-meta seen ${[...metas].join(' | ')}; stray cards ${unplanned.join(' | ')}`, { answer: answer.slice(0, 600) });
  });

  await step('B01-ask-allow', async () => {
    await newChat();
    await send('Delete the build folder with rm -rf build, then confirm it is gone.');
    await waitFor('the rm card', async () => (await panel<boolean>(`[...doc.querySelectorAll('.permission-open .permission-command')].some((e) => /rm\\s+-r/.test(e.textContent))`)) || (await turnEnded()), 240_000, allowStrayCards);
    const buttons = await panel<string[]>(`[...doc.querySelectorAll('.permission-open .permission-actions button')].map((b) => b.textContent)`);
    await shot('B01-ask-card');
    if (buttons.length > 0) await click('.permission-open button', 'Allow');
    await waitTurn();
    await shot('B01-after-allow');
    const gone = !existsSync(path.join(workspace(), 'build'));
    await report('B01-ask-allow', buttons.includes('Allow') && gone, `card buttons ${buttons.join(',')}; build removed ${gone}; stray cards ${unplanned.join(' | ')}`, { answer: (await lastAnswer()).slice(0, 400) });
  });

  await step('B02-ask-deny', async () => {
    await newChat();
    // Run 1 sent "Run git clean -fdx to remove everything untracked.", which Ask ran without a card (ISSUES.md).
    await send('Remove src/profile.js with rm -rf src/profile.js.');
    await waitFor('the rm card', async () => (await count('.permission-open')) > 0 || (await turnEnded()), 240_000);
    const command = await textOf('.permission-open .permission-command');
    await shot('B02-card');
    if (command !== null) await click('.permission-open button', 'Deny');
    await waitTurn(false);
    await shot('B02-after-deny');
    const events = await newestLog();
    const rejectedAt = events.findIndex((e) => e.kind === 'tool-result' && e.status === 'rejected');
    const after = rejectedAt < 0 ? [] : events.slice(rejectedAt + 1).filter((e) => e.kind === 'assistant');
    await report('B02-ask-deny', command !== null && rejectedAt >= 0 && after.length === 0, `card for ${command}; rejected result at ${rejectedAt}; model calls after the no ${after.length}; footer ${await textOf('.turn:last-child .turn-footer')}`);
  });

  await step('B03-no-and-tell', async () => {
    await newChat();
    await send('Delete the dist folder with rm -rf dist.');
    await waitFor('the rm dist card', async () => (await count('.permission-open')) > 0 || (await turnEnded()), 240_000);
    const command = await textOf('.permission-open .permission-command');
    if (command !== null) {
      await click('.permission-open button', 'No, and tell the agent…');
      await waitFor('the comment field', async () => (await count('.permission-comment')) === 1, 10_000);
      await click('.permission-comment');
      await ui({ do: 'type', text: "Don't delete it. Rename dist to dist-old with mv instead." });
      await shot('B03-comment');
      await ui({ do: 'press', key: 'Enter' });
    }
    // The comment ends the turn, as a no does; the model reads it on the next turn.
    await waitTurn();
    await shot('B03-after-comment');
    const events = await newestLog();
    const told = JSON.stringify(events).includes('Rename dist to dist-old');
    const ranMv = existsSync(path.join(workspace(), 'dist-old'));
    await report('B03-no-and-tell', command !== null && told, `card for ${command}; comment reached the log ${told}; dist-old exists ${ranMv}; outcome ${await textOf('.permission-outcome')}`, { answer: (await lastAnswer()).slice(0, 400) });
  });

  await step('B04-keep-undo', async () => {
    await newChat();
    await send('Two small edits: in src/money.ts make formatPrice use (cents / 100).toFixed(2), and in src/slug.ts make slugify collapse runs of spaces into one dash. Change nothing else and run no commands.');
    await waitTurn();
    await shot('B04-review');
    const lensIds = async (rel: string) => {
      const found = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', vscode.Uri.file(path.join(workspace(), rel)));
      return [...new Set(found.filter((l) => l.command?.command.startsWith('gcode.review.')).map((l) => l.command!.arguments![0] as string))];
    };
    const hunks = await panel<{ id: string; file: string }[]>(`[...doc.querySelectorAll('[data-hunk]')].map((e) => ({ id: e.dataset.hunk, file: e.textContent.slice(0, 80) }))`);
    const money = (await lensIds('src/money.ts')).map((id) => ({ id, file: 'money' }))[0];
    const slug = (await lensIds('src/slug.ts')).map((id) => ({ id, file: 'slug' }))[0];
    if (money) await click(`[data-hunk="${money.id}"] button`, 'Keep');
    if (slug) await click(`[data-hunk="${slug.id}"] button`, 'Undo');
    await sleep(2000);
    await shot('B04-after-keep-undo');
    const moneyText = await readFile(path.join(workspace(), 'src/money.ts'), 'utf8');
    const slugText = await readFile(path.join(workspace(), 'src/slug.ts'), 'utf8');
    const kept = moneyText.includes('toFixed(2)');
    const undone = slugText.includes(".replace(/ /g, '-')");
    await report('B04-keep-undo', money !== undefined && slug !== undefined && kept && undone, `hunks ${hunks.length} (${hunks.map((h) => h.file.slice(0, 30)).join(' | ')}); money kept ${kept}; slug undone ${undone}; decisions ${await panel<string>(`[...doc.querySelectorAll('[data-hunk] .decision')].map((d) => d.textContent).join(',')`)}`);
  });

  await step('B05-lanes', async () => {
    await newChat();
    await click('textarea');
    await ui({ do: 'type', text: '/lane Add one line at the end of README.md saying the tests use node --test.' });
    await ui({ do: 'press', key: 'Enter' });
    await waitFor('a lane row', async () => (await count('.lane-row')) >= 1, 60_000);
    await shot('B05-lane-from-slash');
    await backToChat();
    await click('textarea');
    await ui({ do: 'type', text: 'Create CONTRIBUTING.md with one sentence asking people to run npm test before a pull request.' });
    await ui({ do: 'press', key: 'Enter', modifiers: ['meta', 'shift'] });
    const second = await waitFor('a second lane row', async () => (await count('.lane-row')) >= 2, 60_000).then(() => true, () => false);    await shot('B05-lane-from-cmd-shift-enter');
    await waitFor('both lanes to finish', async () => (await panel<boolean>(`[...doc.querySelectorAll('.lane-row')].every((r) => !/working|running|starting/i.test(r.textContent))`)), 300_000).catch(() => undefined);
    const rows = await panel<string[]>(`[...doc.querySelectorAll('.lane-row')].map((r) => r.textContent.replace(/\\s+/g, ' ').slice(0, 160))`);
    await shot('B05-lanes-done');
    await report('B05-lanes', rows.length >= 2 && second, `rows: ${rows.join(' || ')}`);
  });

  await step('B07-subagent-row', async () => {
    await newChat();
    await send('Use an explore subagent to find which files call getUser, then list them. Do not change anything.');
    let seen = false;
    await waitFor('the subagent turn to end', turnEnded, 300_000, async () => {
      if (!seen && (await count('.child-view, .child-state, .child-task')) > 0) {
        seen = true;
        await shot('B07-subagent-row');
      }
      await allowStrayCards();
    });
    await shot('B07-after');
    const tools = toolNames(await newestLog());
    await report('B07-subagent-row', seen && tools.includes('agent'), `row seen ${seen}; tools ${tools.join(',')}; stray cards ${unplanned.join(' | ')}`, { answer: (await lastAnswer()).slice(0, 400) });
  });

  await step('B08-mcp-banner', async () => {
    await newChat();
    await vscode.commands.executeCommand('gcode.chat.mcp');
    await waitFor('the trust card', async () => (await count(`.mcp-trust[data-trust="${MCP_SERVER}"]`)) === 1, 60_000);
    await shot('B08-trust-card');
    await ui({ do: 'press', key: 'Escape' });
    const banner = await waitFor('the MCP notice', async () => (await panel<boolean>(`(() => { const n = doc.querySelector('.mcp-notice'); return n !== null && !n.hidden && n.getClientRects().length > 0; })()`)), 20_000).then(() => true, () => false);
    await shot('B08-banner');
    await click('.mcp-notice .link-button', 'Review');
    await click(`.mcp-trust[data-trust="${MCP_SERVER}"] .button`, 'Allow');
    await sleep(3000);
    await ui({ do: 'press', key: 'Escape' });
    await send(`Use the ${MCP_SERVER} MCP server's echo tool to echo the word สวัสดี, and tell me what it returned.`);
    await waitTurn();
    await shot('B08-after-echo');
    const tools = toolNames(await newestLog());
    const echoed = tools.some((t) => t === `mcp__${MCP_SERVER}__echo`);
    const searchedFirst = tools.indexOf('tool_search') >= 0 && tools.indexOf('tool_search') < tools.indexOf(`mcp__${MCP_SERVER}__echo`);
    await report('B08-mcp-banner', banner && echoed && searchedFirst, `banner ${banner}; tools ${tools.join(',')}; stray cards ${unplanned.join(' | ')}`, { answer: (await lastAnswer()).slice(0, 300) });
  });

  await step('B09-stop-and-resume-thai', async () => {
    await newChat();
    await send('Read every file in this repository one at a time and, after each, write a detailed review of at least 300 words before reading the next.');
    await waitFor('the turn to be well under way', async () => (await count('.turn:last-child .calls, .turn:last-child .markdown')) >= 2, 120_000, allowStrayCards);
    await shot('B09-before-stop');
    await click('button.stop');
    await waitFor('Stop to end the turn', async () => (await textOf('.turn:last-child .turn-footer'))?.includes('Stopped') === true, 60_000);
    await shot('B09-stopped');
    await send('ถึงไหนแล้ว');
    // "How far along are you?" asks for a status; a model that resumes the whole task instead is stopped after 3 minutes.
    const answered = await waitFor('the status answer', turnEnded, 180_000, allowStrayCards).then(() => true, () => false);
    await shot('B09-resume-thai');
    if (!answered) {
      await click('button.stop');
      await waitFor('Stop to end the follow-up', async () => (await textOf('.turn:last-child .turn-footer'))?.includes('Stopped') === true, 60_000);
    }
    const events = await newestLog();
    const asked = events.findLastIndex((e) => e.kind === 'user');
    const callsAfter = toolNames(events.slice(asked));
    const answer = await lastAnswer();
    await report('B09-stop-and-resume-thai', answered && thaiShare(answer) > 0.3, `answered within 3 min ${answered}; tool calls after the question ${callsAfter.length} (${callsAfter.slice(0, 12).join(',')}); thai share ${thaiShare(answer).toFixed(2)}`, { answer: answer.slice(0, 500) });
  });
}
