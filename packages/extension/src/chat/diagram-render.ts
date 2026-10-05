/// <reference lib="dom" />
import mermaid from 'mermaid';
import type { DiagramTheme } from './diagram.js';

/**
 * The diagram library, built as its own chunk that the panel imports the first time a transcript holds a
 * diagram. Mermaid's configuration is global, so renders run one at a time.
 */

let queue: Promise<unknown> = Promise.resolve();
let next = 0;

/**
 * Mermaid measures labels with its theme stylesheet in the page, and the panel's CSP admits a style element only
 * with the page's nonce, so style elements made during a render carry it. Without it labels are measured in
 * the wrong font and overflow their boxes.
 */
async function withStyleNonce<T>(nonce: string, run: () => Promise<T>): Promise<T> {
  const create = document.createElement;
  document.createElement = function (this: Document, tag: string, options?: ElementCreationOptions) {
    const element = create.call(this, tag, options);
    if (tag.toLowerCase() === 'style') element.nonce = nonce;
    return element;
  } as typeof document.createElement;
  try {
    return await run();
  } finally {
    document.createElement = create;
  }
}

/** Draws `source` as sanitized SVG markup, or rejects with mermaid's parse or render error. */
export function renderDiagram(source: string, theme: DiagramTheme, nonce: string): Promise<string> {
  const run = async () => {
    mermaid.initialize({
      startOnLoad: false,
      // strict sanitizes the SVG with DOMPurify and turns off click handlers and links that run script.
      securityLevel: 'strict',
      // Labels as SVG text rather than HTML in foreignObject, which an editor tab or a copy shows the same way.
      htmlLabels: false,
      suppressErrorRendering: true,
      // A diagram's own %%{init}%% directive may not change these.
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels'],
      theme: 'base',
      darkMode: theme.darkMode,
      fontFamily: theme.fontFamily,
      themeVariables: { ...theme.colors, darkMode: theme.darkMode, fontFamily: theme.fontFamily, fontSize: theme.fontSize },
      // With SVG labels mermaid paints a participant's name in its box's fill and border, and lets edges show
      // through half-opaque label backgrounds; both are unreadable on a dark theme.
      themeCSS: `text.actor { fill: ${theme.colors['actorTextColor'] ?? 'currentColor'}; stroke: none; } .edgeLabel rect { opacity: 1; }`,
    });
    const { svg } = await withStyleNonce(nonce, () => mermaid.render(`gcode-diagram-${next++}`, source));
    return svg;
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}
