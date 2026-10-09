import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { themeTokensOf, tokenNamesIn } from '../../src/chat/tokens.js';
import { buildPanel, closeBrowser, DEFAULT_LOOK, openPanel, type Panel } from './harness.js';
import { turnStart } from './turns.js';

/** `gcode.appearance.tokens` as a user might write it: a dark theme, a light one, an unknown token and VS Code's own. */
const SETTING = {
  dark: { '--muted': '#ff00aa', '--bubble-fill': 'rgb(0 128 255 / 30%)', '--not-a-token': 'red', '--vscode-foreground': 'red' },
  light: { '--muted': 'rgb(0, 128, 0)' },
  sepia: { '--muted': 'brown' },
};

const known = async () => new Set(tokenNamesIn(await readFile(path.join(await buildPanel(), 'webview.css'), 'utf8')));

/** The muted text of the start page's project line and the user's message bubble, as drawn. */
const drawn = (panel: Panel) =>
  panel.eval<{ muted: string; bubble: string | null; foreground: string }>(`({
    muted: getComputedStyle(doc.querySelector('.start-project') ?? doc.querySelector('.turn-meta') ?? doc.body).color,
    bubble: doc.querySelector('.request-bubble') ? getComputedStyle(doc.querySelector('.request-bubble')).backgroundColor : null,
    foreground: getComputedStyle(doc.documentElement).getPropertyValue('--vscode-foreground').trim(),
  })`);

afterAll(closeBrowser);

describe('gcode.appearance.tokens in the panel', () => {
  it('keeps only Geno tokens with usable values, and says why it left each other one out', async () => {
    const { tokens, problems } = themeTokensOf(
      { ...SETTING, light: { ...SETTING.light, '--accent': 'red; } body { display: none', '--warn': 'url(https://example.com/x.png)', '--ok': 'rgb(1 2 3' } },
      await known(),
    );
    expect(tokens).toEqual({ dark: { '--muted': '#ff00aa', '--bubble-fill': 'rgb(0 128 255 / 30%)' }, light: { '--muted': 'rgb(0, 128, 0)' } });
    expect(problems).toEqual([
      'gcode.appearance.tokens.dark: --not-a-token is not a Geno token, so it is ignored.',
      "gcode.appearance.tokens.dark: --vscode-foreground is VS Code's own variable, which Geno leaves to the color theme.",
      'gcode.appearance.tokens.light: the value of --accent holds one of ; { } < > \\ !, so it is ignored.',
      'gcode.appearance.tokens.light: the value of --warn loads a resource, so it is ignored.',
      'gcode.appearance.tokens.light: the value of --ok leaves a bracket open, so it is ignored.',
      'gcode.appearance.tokens: "sepia" is not a theme kind; use dark, light, highContrast, highContrastLight.',
    ]);
    expect(themeTokensOf(['--muted'], await known()).problems).toEqual(['gcode.appearance.tokens must be an object keyed by theme kind: dark, light, highContrast, highContrastLight.']);
  });

  it('draws the tokens from the first frame, follows a change and a theme switch, and leaves high contrast alone until it is named', async () => {
    const { tokens } = themeTokensOf(SETTING, await known());
    const plain = await openPanel();
    const before = await drawn(plain);
    await plain.close();

    const panel = await openPanel({ look: { ...DEFAULT_LOOK, tokens } });
    const first = await drawn(panel);
    expect(first.muted, 'the dark --muted reaches the start page on the first frame').toBe('rgb(255, 0, 170)');
    expect(first.muted).not.toBe(before.muted);
    expect(first.foreground, "VS Code's own variables stay the theme's").toBe(before.foreground);

    await panel.host.act(turnStart('t0', 'Fix the login form'));
    await panel.frame();
    expect((await drawn(panel)).bubble, 'a token the glass style sets is overridden too').toBe('rgba(0, 128, 255, 0.3)');

    await panel.look({ tokens: { ...tokens, dark: { '--muted': 'rgb(10, 20, 30)' } } });
    expect(await panel.eval(`getComputedStyle(doc.body).getPropertyValue('--muted').trim()`), 'a changed setting applies without a reload').toBe('rgb(10, 20, 30)');
    expect((await drawn(panel)).bubble, 'a token the change drops goes back to the theme').toBe('rgba(255, 255, 255, 0.07)');

    await panel.theme('light');
    expect(await panel.eval(`getComputedStyle(doc.body).getPropertyValue('--muted').trim()`), 'a light theme takes the light tokens').toBe('rgb(0, 128, 0)');

    const contrast = await openPanel({ theme: 'high-contrast' });
    const native = await contrast.eval<string>(`getComputedStyle(doc.body).getPropertyValue('--muted').trim()`);
    await contrast.close();
    await panel.theme('high-contrast');
    expect(await panel.eval(`getComputedStyle(doc.body).getPropertyValue('--muted').trim()`), 'high contrast keeps its own value while the setting names no high contrast kind').toBe(native);
    await panel.look({ tokens: { ...tokens, highContrast: { '--muted': 'rgb(255, 255, 0)' } } });
    expect(await panel.eval(`getComputedStyle(doc.body).getPropertyValue('--muted').trim()`), 'naming highContrast opts it in').toBe('rgb(255, 255, 0)');
    await panel.theme('high-contrast-light');
    expect(await panel.eval(`getComputedStyle(doc.body).getPropertyValue('--muted').trim()`), 'high contrast light is its own kind').not.toBe('rgb(255, 255, 0)');

    expect(panel.consoleErrors, 'the token stylesheet passes the page CSP, first and after each change').toEqual([]);
    await panel.close();
  });
});
