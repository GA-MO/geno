import { describe, expect, it } from 'vitest';
import manifest from '../../extension/package.json' with { type: 'json' };
import { titleActions } from '../src/title-actions.js';

/** The chat is the extension's one webview view. */
const CHAT_VIEW = manifest.contributes.views.gcode.find((view) => view.type === 'webview')!.id;

describe('the chat view’s title actions on the web', () => {
  it('has a web entry, with its icon, for every view/title command the manifest gives the chat view', () => {
    const contributed = manifest.contributes.menus['view/title'].filter((entry) => entry.when.includes(`view == ${CHAT_VIEW}`)).map((entry) => entry.command);
    expect(contributed.length).toBeGreaterThan(0);
    const web = titleActions(manifest, CHAT_VIEW);
    expect(web.map((action) => action.command).sort()).toEqual([...contributed].sort());
    for (const action of web) {
      const command = manifest.contributes.commands.find((c) => c.command === action.command)!;
      expect({ title: action.title, icon: `$(${action.icon})` }, action.command).toEqual({ title: command.title, icon: command.icon });
    }
    expect(web.find((action) => action.command === 'gcode.chat.lanes')).toMatchObject({ title: 'Lanes', icon: 'repo-forked', inline: true });
  });

  it('orders the navigation group first by its @ order, puts other groups in the menu, and leaves out other views', () => {
    const actions = titleActions(
      {
        contributes: {
          commands: [
            { command: 'a', title: 'A', icon: '$(add)' },
            { command: 'b', title: 'B', icon: { light: 'b.svg', dark: 'b.svg' } },
            { command: 'c', title: 'C' },
            { command: 'd', title: 'D' },
          ],
          menus: {
            'view/title': [
              { command: 'c', when: 'view == chat', group: '1_more@1' },
              { command: 'b', when: 'view == chat && config.x', group: 'navigation@2' },
              { command: 'a', when: 'view == chat', group: 'navigation@1' },
              { command: 'd', when: 'view == other', group: 'navigation@0' },
            ],
          },
        },
      },
      'chat',
    );
    expect(actions).toEqual([
      { command: 'a', title: 'A', icon: 'add', inline: true },
      { command: 'b', title: 'B', icon: undefined, inline: true },
      { command: 'c', title: 'C', icon: undefined, inline: false },
    ]);
  });
});
