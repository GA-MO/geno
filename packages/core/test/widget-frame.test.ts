import { describe, expect, it } from 'vitest';
import { WIDGET_PALETTE } from '../src/widget.js';
import { FRAME_HEIGHT, frameCsp, frameDocument, fromWidget, standaloneDocument, themeCss, WIDGET_SANDBOX, type WidgetTheme } from '../src/widget-frame.js';

const THEME: WidgetTheme = {
  scheme: 'dark',
  vars: { '--bg': '#1e1e20', '--fg': '#dcdcdc', '--font': '-apple-system, "Segoe UI", sans-serif', '--chart-1': WIDGET_PALETTE[0] },
};

const NONCE = 'bm9uY2Utb2YtdGhlLXBhbmVs';
const META = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g;

describe('the widget frame', () => {
  it('runs scripts and nothing else: no same origin, no forms, no popups, no top navigation', () => {
    expect(WIDGET_SANDBOX).toBe('allow-scripts');
  });

  it('has a policy with no network at all', () => {
    expect(frameCsp(NONCE)).toBe(
      `default-src 'none'; script-src 'nonce-${NONCE}'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'`,
    );
  });

  it('puts the policy first in the head, before anything the widget wrote', () => {
    const html = '<style>.a{}</style><div class="a">hi</div><script>document.title = 1</script>';
    const doc = frameDocument({ html, nonce: NONCE, theme: THEME });
    expect([...doc.matchAll(META)].map((m) => m[1])).toEqual([frameCsp(NONCE)]);
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<style'));
    expect(doc.startsWith('<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"')).toBe(true);
  });

  it('never lets the widget text reach the parser: it travels as a script string with every < escaped', () => {
    const html = '</script><script>alert(1)</script><!-- --><img src=x onerror=alert(2)> ';
    const doc = frameDocument({ html, nonce: NONCE, theme: THEME });
    const [, boot] = /<script nonce="[^"]+">([\s\S]*)<\/script><\/body>/.exec(doc)!;
    expect(boot).not.toContain('<');
    expect(boot).toContain(JSON.stringify(html).replaceAll('<', '\\u003c'));
    expect(doc.match(/<script/g), 'the one script in the document is the bootstrap').toHaveLength(1);
  });

  it('gives every element it writes the nonce the inherited policy needs', () => {
    const doc = frameDocument({ html: '<p>x</p>', nonce: NONCE, theme: THEME });
    expect(doc.match(/<(script|style)[^>]*>/g)).toEqual([`<style nonce="${NONCE}">`, `<style nonce="${NONCE}" id="geno-theme">`, `<script nonce="${NONCE}">`]);
  });

  it('sets the theme variables and color scheme, dropping values that could break out of the style', () => {
    expect(themeCss({ scheme: 'light', vars: { '--fg': '#1c1c1c', '--bg': 'red}</style><script>', '--font': '"Segoe UI", sans-serif' } })).toBe(
      ':root{color-scheme:light;--fg:#1c1c1c;--font:"Segoe UI", sans-serif}',
    );
  });

  it('rejects a nonce that is not base64', () => {
    expect(() => frameDocument({ html: '', nonce: 'a" onload="x', theme: THEME })).toThrow('not a nonce');
  });
});

describe('messages from a widget', () => {
  it('takes a height, clamped', () => {
    expect(fromWidget({ type: 'gcode-widget', kind: 'height', height: 312.4 })).toEqual({ kind: 'height', height: 313 });
    expect(fromWidget({ type: 'gcode-widget', kind: 'height', height: 1e9 })).toEqual({ kind: 'height', height: FRAME_HEIGHT.max });
    expect(fromWidget({ type: 'gcode-widget', kind: 'height', height: -5 })).toEqual({ kind: 'height', height: FRAME_HEIGHT.min });
  });

  it('takes a web link to ask the user about', () => {
    expect(fromWidget({ type: 'gcode-widget', kind: 'link', href: 'https://payloadcms.com/docs' })).toEqual({ kind: 'link', href: 'https://payloadcms.com/docs' });
  });

  it('ignores anything else', () => {
    for (const data of [
      undefined,
      'height',
      { type: 'gcode-widget', kind: 'height', height: '300' },
      { type: 'gcode-widget', kind: 'height', height: Number.NaN },
      { type: 'gcode-widget', kind: 'height', height: Infinity },
      { type: 'other', kind: 'height', height: 300 },
      { type: 'gcode-widget', kind: 'link', href: 'javascript:alert(1)' },
      { type: 'gcode-widget', kind: 'link', href: 'file:///etc/passwd' },
      { type: 'gcode-widget', kind: 'link', href: 'command:workbench.action.terminal.new' },
      { type: 'gcode-widget', kind: 'link', href: `https://example.com/${'x'.repeat(3000)}` },
      { type: 'gcode-widget', kind: 'eval', code: '1' },
    ]) {
      expect(fromWidget(data), JSON.stringify(data)?.slice(0, 80)).toBeUndefined();
    }
  });
});

describe('the downloaded widget', () => {
  it('is a whole page with the theme inlined and the same no-network policy, scripts allowed inline', () => {
    const doc = standaloneDocument({ title: 'Speed <chart>', html: '<p>x</p><script>1</script>', theme: THEME });
    expect([...doc.matchAll(META)].map((m) => m[1])).toEqual([
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'",
    ]);
    expect(doc).toContain('<title>Speed &lt;chart&gt;</title>');
    expect(doc).toContain(themeCss(THEME));
    expect(doc).toContain('<p>x</p><script>1</script>');
  });
});
