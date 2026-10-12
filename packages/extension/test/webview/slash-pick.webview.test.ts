import { afterAll, describe, expect, it } from 'vitest';
import { BUILTIN_OPTIONS } from '../../src/chat/slash-route.js';
import type { CommandOption } from '../../src/chat/slash.js';
import { closeBrowser, openPanel, type Panel } from './harness.js';

afterAll(closeBrowser);

/** A project skill as the engine lists one whose SKILL.md declares no argument hint. */
const SKILL: CommandOption = { name: 'add-category', description: 'Add a category to the shop', hint: undefined, route: 'skill' };

const sent = (panel: Panel) => panel.host.received.flatMap((m) => (m.type === 'send' ? [m.text] : []));
const draftOf = (panel: Panel) => panel.eval<string>('doc.querySelector("textarea").value');
const menuOpen = async (panel: Panel) => (await panel.count('#commands:not([hidden])')) > 0;

async function pick(panel: Panel, typed: string, name: string): Promise<void> {
  await panel.click('textarea');
  await panel.type(typed);
  await panel.waitFor(`/${name} in the menu`, async () => (await panel.eval<string | null>(`doc.querySelector('#commands .active')?.dataset.command ?? null`)) === name);
  await panel.press('Enter');
}

describe('picking from the / menu with Enter', () => {
  it('puts a skill in the draft to finish, and the next Enter sends it with what the user typed', async () => {
    const panel = await openPanel({ width: 360 });
    await panel.host.post({ type: 'commands', commands: [...BUILTIN_OPTIONS, SKILL] });
    await pick(panel, '/add-c', 'add-category');
    await panel.host.settled();
    expect(await draftOf(panel), 'the skill goes in the draft with a space after it').toBe('/add-category ');
    expect(await menuOpen(panel), 'the menu closes').toBe(false);
    expect(sent(panel), 'nothing is sent yet').toEqual([]);
    await panel.type('เพิ่มหมวดสัตว์เลี้ยง');
    await panel.press('Enter');
    await panel.waitFor('the send', async () => sent(panel).length > 0);
    expect(sent(panel), 'the skill goes with its arguments').toEqual(['/add-category เพิ่มหมวดสัตว์เลี้ยง']);
    await panel.close();
  });

  it('fills in a built-in with a hint as it does a skill, and sends one without arguments at once', async () => {
    const panel = await openPanel({ width: 360 });
    await panel.host.post({ type: 'commands', commands: [...BUILTIN_OPTIONS, SKILL] });
    await pick(panel, '/compa', 'compact');
    await panel.host.settled();
    expect(await draftOf(panel)).toBe('/compact ');
    expect(sent(panel)).toEqual([]);
    await panel.eval('(doc.querySelector("textarea").value = "", doc.querySelector("textarea").dispatchEvent(new Event("input")), 1)');
    await pick(panel, '/ini', 'init');
    await panel.waitFor('/init to send', async () => sent(panel).length > 0);
    expect(sent(panel), 'a built-in that takes nothing sends on the first Enter').toEqual(['/init']);
    await panel.close();
  });
});
