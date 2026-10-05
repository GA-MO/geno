/**
 * Diagrams in assistant markdown: a ```` ```mermaid ```` fence inside a text block. The transcript keeps the
 * text as the model wrote it; whether a fence has been drawn is the webview's own state, since only the
 * webview can draw.
 */

/** A diagram fence. `closed` is false while its closing fence has not streamed in yet. */
export type Diagram = { readonly source: string; readonly closed: boolean };

/** Where a diagram's drawing stands, for one theme: it is drawn when the fence closes and the library loads. */
export type DiagramState =
  | { readonly status: 'pending' }
  | { readonly status: 'rendered'; readonly svg: string }
  | { readonly status: 'failed'; readonly message: string };

export type SettledState = Exclude<DiagramState, { status: 'pending' }>;

/** What a drawing was made for: the theme, as a key, and the panel width. A change to either draws it again. */
export type Basis = { readonly theme: string; readonly width: number };

const sameBasis = (a: Basis | undefined, b: Basis): boolean => a !== undefined && a.theme === b.theme && a.width === b.width;

const PENDING: DiagramState = { status: 'pending' };

/**
 * Every diagram's drawing by source, so a source shown twice, or rebuilt as text streams around it, is drawn
 * once. A redraw keeps showing the previous drawing until the new one settles, and a drawing that settles after
 * a newer one was asked for is dropped.
 */
export class DiagramStore {
  private readonly settled = new Map<string, { readonly state: DiagramState; readonly basis: Basis }>();
  private readonly drawing = new Map<string, Basis>();

  /** What to show for a diagram; an unclosed fence is pending whatever was drawn before. */
  stateOf(diagram: Diagram): DiagramState {
    return diagram.closed ? (this.settled.get(diagram.source)?.state ?? PENDING) : PENDING;
  }

  /** Whether `source` needs drawing for `basis`, and if so marks it as being drawn. */
  start(source: string, basis: Basis): boolean {
    if (sameBasis(this.settled.get(source)?.basis, basis) || sameBasis(this.drawing.get(source), basis)) return false;
    this.drawing.set(source, basis);
    return true;
  }

  /** Records a finished drawing; false when a newer drawing of the source was started since. */
  settle(source: string, basis: Basis, state: SettledState): boolean {
    if (this.drawing.get(source) !== basis) return false;
    this.drawing.delete(source);
    this.settled.set(source, { state, basis });
    return true;
  }

  /** Whether `source` has a drawing to redraw when the theme or width changes; a failed parse fails in any theme. */
  isRendered(source: string): boolean {
    return this.settled.get(source)?.state.status === 'rendered';
  }
}

const DIAGRAM_LANGS: ReadonlySet<string> = new Set(['mermaid']);

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** A fenced code block's closing line repeats its fence character at least as many times, and nothing else. */
function isClosed(raw: string): boolean {
  const lines = raw.trimEnd().split('\n');
  const open = OPENING_FENCE.exec(lines[0] ?? '')?.[1];
  const last = lines.at(-1)?.trim() ?? '';
  return open !== undefined && lines.length > 1 && last.length >= open.length && [...last].every((c) => c === open[0]);
}

/** The diagram a code token holds, from marked's `lang`, `raw` and `text`; any other code block is undefined. */
export function diagramOf(lang: string | undefined, raw: string, text: string): Diagram | undefined {
  const label = lang?.trim().split(/\s/)[0]?.toLowerCase();
  if (label === undefined || !DIAGRAM_LANGS.has(label)) return undefined;
  return { source: text, closed: isClosed(raw) };
}

/** Mermaid's error messages run to several lines of parser detail; one line is what the panel shows. */
export function errorLine(message: string, max = 160): string {
  const lines = message.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !/^-*\^$/.test(line));
  const first = lines[0] ?? 'Unknown error';
  const expecting = lines.find((line) => line.startsWith('Expecting '));
  const line = expecting === undefined || expecting === first ? first : `${first.replace(/:$/, '')}: ${expecting}`;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const TITLES: Readonly<Record<string, string>> = {
  flowchart: 'Flowchart',
  graph: 'Flowchart',
  sequenceDiagram: 'Sequence Diagram',
  stateDiagram: 'State Diagram',
  'stateDiagram-v2': 'State Diagram',
  classDiagram: 'Class Diagram',
  erDiagram: 'Entity Relationship Diagram',
  gantt: 'Gantt Chart',
  journey: 'User Journey',
  mindmap: 'Mind Map',
  timeline: 'Timeline',
  pie: 'Pie Chart',
  gitGraph: 'Git Graph',
};

/** What a diagram is called in its editor tab and to a screen reader, from the keyword that starts it. */
export function diagramTitle(source: string): string {
  const lines = source.split('\n').map((line) => line.trim());
  // Front matter between --- lines may come first.
  const start = lines[0] === '---' ? lines.indexOf('---', 1) + 1 : 0;
  const keyword = lines
    .slice(start)
    .find((line) => line !== '' && !line.startsWith('%%'))
    ?.split(/\s/)[0];
  return TITLES[keyword ?? ''] ?? 'Diagram';
}

/**
 * Mermaid's theme variables, each from the first VS Code color the theme defines. High contrast themes define
 * contrastBorder, so their outlines win there. Variables left out derive from these in mermaid's base theme.
 */
export const THEME_COLORS: Readonly<Record<string, readonly string[]>> = {
  background: ['--vscode-sideBar-background', '--vscode-editor-background'],
  primaryColor: ['--vscode-editorWidget-background', '--vscode-editor-background'],
  primaryBorderColor: ['--vscode-contrastBorder', '--vscode-focusBorder'],
  primaryTextColor: ['--vscode-foreground'],
  secondaryColor: ['--vscode-input-background', '--vscode-editorWidget-background'],
  secondaryBorderColor: ['--vscode-contrastBorder', '--vscode-widget-border', '--vscode-descriptionForeground'],
  secondaryTextColor: ['--vscode-foreground'],
  tertiaryColor: ['--vscode-textCodeBlock-background', '--vscode-editor-background'],
  tertiaryBorderColor: ['--vscode-contrastBorder', '--vscode-widget-border', '--vscode-descriptionForeground'],
  tertiaryTextColor: ['--vscode-foreground'],
  textColor: ['--vscode-foreground'],
  lineColor: ['--vscode-contrastBorder', '--vscode-descriptionForeground'],
  edgeLabelBackground: ['--vscode-sideBar-background', '--vscode-editor-background'],
  clusterBkg: ['--vscode-textCodeBlock-background', '--vscode-editor-background'],
  clusterBorder: ['--vscode-contrastBorder', '--vscode-widget-border', '--vscode-descriptionForeground'],
  noteBkgColor: ['--vscode-editorHoverWidget-background', '--vscode-editorWidget-background'],
  noteBorderColor: ['--vscode-contrastBorder', '--vscode-editorHoverWidget-border', '--vscode-widget-border'],
  noteTextColor: ['--vscode-editorHoverWidget-foreground', '--vscode-foreground'],
  actorBkg: ['--vscode-editorWidget-background', '--vscode-editor-background'],
  actorBorder: ['--vscode-contrastBorder', '--vscode-focusBorder'],
  actorTextColor: ['--vscode-foreground'],
  actorLineColor: ['--vscode-contrastBorder', '--vscode-descriptionForeground'],
  signalColor: ['--vscode-foreground'],
  signalTextColor: ['--vscode-foreground'],
  labelBoxBkgColor: ['--vscode-input-background', '--vscode-editorWidget-background'],
  labelBoxBorderColor: ['--vscode-contrastBorder', '--vscode-widget-border', '--vscode-descriptionForeground'],
  labelTextColor: ['--vscode-foreground'],
  loopTextColor: ['--vscode-foreground'],
  activationBkgColor: ['--vscode-input-background', '--vscode-editorWidget-background'],
  activationBorderColor: ['--vscode-contrastBorder', '--vscode-focusBorder'],
  sequenceNumberColor: ['--vscode-button-foreground'],
  transitionColor: ['--vscode-contrastBorder', '--vscode-descriptionForeground'],
  transitionLabelColor: ['--vscode-foreground'],
  stateLabelColor: ['--vscode-foreground'],
  specialStateColor: ['--vscode-foreground'],
  innerEndBackground: ['--vscode-foreground'],
  compositeBackground: ['--vscode-textCodeBlock-background', '--vscode-editor-background'],
  errorBkgColor: ['--vscode-inputValidation-errorBackground', '--vscode-editorWidget-background'],
  errorTextColor: ['--vscode-errorForeground', '--vscode-foreground'],
};

/** What a render needs to match the panel: mermaid's theme variables, its font, and whether the theme is dark. */
export type DiagramTheme = {
  readonly darkMode: boolean;
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly colors: Readonly<Record<string, string>>;
};

/** The variables a page's own background replaces: a diagram's labels sit on whatever the page is. */
const SURFACES = ['background', 'edgeLabelBackground'] as const;

/**
 * The theme from `resolve`, which gives a VS Code color variable's value or undefined when the theme lacks it.
 * `surface` is the page's background when it paints one; the chat panel's is transparent over the side bar.
 */
export function themeOf(
  resolve: (name: string) => string | undefined,
  font: { readonly family: string; readonly size: string },
  darkMode: boolean,
  surface?: string,
): DiagramTheme {
  const colors: Record<string, string> = {};
  for (const [variable, names] of Object.entries(THEME_COLORS)) {
    const value = names.map(resolve).find((v) => v !== undefined);
    if (value !== undefined) colors[variable] = value;
  }
  if (surface !== undefined) for (const variable of SURFACES) colors[variable] = surface;
  return { darkMode, fontFamily: font.family, fontSize: font.size, colors };
}
