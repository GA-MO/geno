import { lexer, type Tokens } from 'marked';
import { describe, expect, it } from 'vitest';
import { DiagramStore, diagramOf, diagramTitle, errorLine, THEME_COLORS, themeOf, type Diagram } from '../src/chat/diagram.js';

/** The diagrams in markdown as the panel's markdown path finds them: marked's code tokens, through diagramOf. */
const diagramsIn = (markdown: string): (Diagram | undefined)[] =>
  lexer(markdown, { gfm: true })
    .filter((t): t is Tokens.Code => t.type === 'code')
    .map((t) => diagramOf(t.lang, t.raw, t.text));

const FLOW = 'flowchart LR\n  A --> B';

describe('diagram fences', () => {
  it('finds a closed mermaid fence and leaves other code blocks alone', () => {
    expect(diagramsIn(`Here:\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n\n    indented`)).toEqual([
      { source: FLOW, closed: true },
      undefined,
      undefined,
    ]);
  });

  it('is open while the closing fence has not streamed in', () => {
    const streamed = `\`\`\`mermaid\n${FLOW}\n\`\``;
    expect(diagramsIn(streamed)).toEqual([{ source: `${FLOW}\n\`\``, closed: false }]);
    expect(diagramsIn('```mermaid')).toEqual([{ source: '', closed: false }]);
    expect(diagramsIn(`${streamed}\``)).toEqual([{ source: FLOW, closed: true }]);
  });

  it('takes tilde fences, a longer closing fence, any case and an info string after the language', () => {
    expect(diagramsIn(`~~~mermaid\n${FLOW}\n~~~~`)).toEqual([{ source: FLOW, closed: true }]);
    expect(diagramsIn(`\`\`\`Mermaid title="flow"\n${FLOW}\n\`\`\``)).toEqual([{ source: FLOW, closed: true }]);
    expect(diagramsIn(`\`\`\`\`mermaid\n${FLOW}\n\`\`\``)).toEqual([{ source: `${FLOW}\n\`\`\``, closed: false }]);
  });

  it('is not a diagram when mermaid is only part of the language name', () => {
    expect(diagramsIn('```mermaidjs\nA\n```')).toEqual([undefined]);
    expect(diagramsIn('```\nflowchart LR\n```')).toEqual([undefined]);
  });
});

describe('the diagram store', () => {
  const dark = { theme: 'dark', width: 400 };
  const closed: Diagram = { source: FLOW, closed: true };

  it('is pending until a drawing settles, then rendered', () => {
    const store = new DiagramStore();
    expect(store.stateOf(closed)).toEqual({ status: 'pending' });
    expect(store.start(FLOW, dark)).toBe(true);
    expect(store.start(FLOW, { ...dark })).toBe(false);
    expect(store.settle(FLOW, dark, { status: 'rendered', svg: '<svg/>' })).toBe(true);
    expect(store.stateOf(closed)).toEqual({ status: 'rendered', svg: '<svg/>' });
    expect(store.start(FLOW, { ...dark })).toBe(false);
    expect(store.isRendered(FLOW)).toBe(true);
  });

  it('shows an open fence as pending even when the same source was drawn', () => {
    const store = new DiagramStore();
    store.start(FLOW, dark);
    store.settle(FLOW, dark, { status: 'rendered', svg: '<svg/>' });
    expect(store.stateOf({ source: FLOW, closed: false })).toEqual({ status: 'pending' });
  });

  it('keeps the old drawing while a redraw runs, and drops a drawing a newer one replaced', () => {
    const store = new DiagramStore();
    store.start(FLOW, dark);
    store.settle(FLOW, dark, { status: 'rendered', svg: '<svg id="dark"/>' });
    const light = { theme: 'light', width: 400 };
    const wider = { theme: 'light', width: 600 };
    expect(store.start(FLOW, light)).toBe(true);
    expect(store.stateOf(closed)).toEqual({ status: 'rendered', svg: '<svg id="dark"/>' });
    expect(store.start(FLOW, wider)).toBe(true);
    expect(store.settle(FLOW, light, { status: 'rendered', svg: '<svg id="light"/>' })).toBe(false);
    expect(store.stateOf(closed)).toEqual({ status: 'rendered', svg: '<svg id="dark"/>' });
    expect(store.settle(FLOW, wider, { status: 'rendered', svg: '<svg id="wider"/>' })).toBe(true);
    expect(store.stateOf(closed)).toEqual({ status: 'rendered', svg: '<svg id="wider"/>' });
  });

  it('records a failure with its message and does not count it as a drawing to redraw', () => {
    const store = new DiagramStore();
    store.start('flowchart LR\n  A -->', dark);
    store.settle('flowchart LR\n  A -->', dark, { status: 'failed', message: 'Parse error on line 2' });
    expect(store.stateOf({ source: 'flowchart LR\n  A -->', closed: true })).toEqual({ status: 'failed', message: 'Parse error on line 2' });
    expect(store.isRendered('flowchart LR\n  A -->')).toBe(false);
  });
});

describe('diagram errors and titles', () => {
  it('puts a parse error on one line, with what the parser expected', () => {
    const message = "Parse error on line 2:\n...rt LR  A -->\n-------------^\nExpecting 'AMP', 'COLON', 'DOWN', got 'EOF'";
    expect(errorLine(message)).toBe("Parse error on line 2: Expecting 'AMP', 'COLON', 'DOWN', got 'EOF'");
    expect(errorLine('No diagram type detected matching given configuration for text: hello')).toBe(
      'No diagram type detected matching given configuration for text: hello',
    );
    expect(errorLine('x'.repeat(300))).toHaveLength(160);
    expect(errorLine('')).toBe('Unknown error');
  });

  it('names a diagram from its first keyword, past front matter and comments', () => {
    expect(diagramTitle(FLOW)).toBe('Flowchart');
    expect(diagramTitle('%% the request flow\nsequenceDiagram\n  A->>B: hi')).toBe('Sequence Diagram');
    expect(diagramTitle('---\ntitle: States\n---\nstateDiagram-v2\n  [*] --> A')).toBe('State Diagram');
    expect(diagramTitle('zenuml')).toBe('Diagram');
  });
});

describe('the diagram theme', () => {
  const colors: Readonly<Record<string, string>> = {
    '--vscode-foreground': 'rgb(204, 204, 204)',
    '--vscode-editorWidget-background': 'rgb(32, 32, 32)',
    '--vscode-focusBorder': 'rgb(0, 120, 212)',
    '--vscode-descriptionForeground': 'rgb(157, 157, 157)',
  };
  const font = { family: 'system-ui', size: '13px' };

  it('takes each mermaid variable from the first VS Code color the theme defines', () => {
    const theme = themeOf((name) => colors[name], font, true);
    expect(theme.colors['primaryColor']).toBe('rgb(32, 32, 32)');
    expect(theme.colors['primaryBorderColor']).toBe('rgb(0, 120, 212)');
    expect(theme.colors['lineColor']).toBe('rgb(157, 157, 157)');
    expect(theme.colors['primaryTextColor']).toBe('rgb(204, 204, 204)');
    expect(theme).toMatchObject({ darkMode: true, fontFamily: 'system-ui', fontSize: '13px' });
  });

  it("outlines shapes in a panel style's own diagram border before the theme's focus color", () => {
    const theme = themeOf((name) => colors[name], font, true, undefined, 'rgb(140, 140, 140)');
    expect(theme.colors['primaryBorderColor']).toBe('rgb(140, 140, 140)');
    expect(theme.colors['actorBorder']).toBe('rgb(140, 140, 140)');
  });

  it('prefers the contrast border in high contrast themes and leaves out what the theme lacks', () => {
    const theme = themeOf((name) => ({ ...colors, '--vscode-contrastBorder': 'rgb(111, 195, 223)' })[name], font, true);
    expect(theme.colors['primaryBorderColor']).toBe('rgb(111, 195, 223)');
    expect(theme.colors['lineColor']).toBe('rgb(111, 195, 223)');
    expect(themeOf(() => undefined, font, false).colors).toEqual({});
  });

  it('puts labels on the background of a page that paints one', () => {
    const sideBar = (name: string) => ({ ...colors, '--vscode-sideBar-background': 'rgb(24, 24, 24)' })[name];
    expect(themeOf(sideBar, font, true).colors['edgeLabelBackground']).toBe('rgb(24, 24, 24)');
    const tab = themeOf(sideBar, font, true, 'rgb(31, 31, 31)').colors;
    expect([tab['background'], tab['edgeLabelBackground']]).toEqual(['rgb(31, 31, 31)', 'rgb(31, 31, 31)']);
  });

  it('names only VS Code color variables', () => {
    for (const names of Object.values(THEME_COLORS)) for (const name of names) expect(name).toMatch(/^--vscode-[A-Za-z]+(-[A-Za-z]+)?$/);
  });
});
