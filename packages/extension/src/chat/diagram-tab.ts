import * as vscode from 'vscode';
import { diagramTitle } from './diagram.js';
import { pageHtml } from './page.js';

export const DIAGRAM_VIEW = 'gcode.diagram';

/** What the diagram tab tells its webview, and what the webview asks of the extension. */
export type ToDiagramTab = { readonly type: 'show'; readonly source: string };
export type FromDiagramTab = { readonly type: 'ready' } | { readonly type: 'copy'; readonly text: string };

const open = new Map<string, vscode.WebviewPanel>();

/**
 * Shows a diagram full size in an editor tab: a read-only webview drawing it the same way the chat panel does,
 * which a markdown preview cannot without a mermaid extension. Opening the same diagram again shows its tab.
 */
export function openDiagram(extensionUri: vscode.Uri, source: string): void {
  const existing = open.get(source);
  if (existing !== undefined) {
    existing.reveal();
    return;
  }
  const dist = vscode.Uri.joinPath(extensionUri, 'dist');
  const panel = vscode.window.createWebviewPanel(DIAGRAM_VIEW, diagramTitle(source), vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [dist],
  });
  open.set(source, panel);
  panel.onDidDispose(() => open.delete(source));
  const handlers: { readonly [K in FromDiagramTab['type']]: (message: Extract<FromDiagramTab, { type: K }>) => void } = {
    ready: () => void panel.webview.postMessage({ type: 'show', source } satisfies ToDiagramTab),
    copy: ({ text }) => void vscode.env.clipboard.writeText(text),
  };
  panel.webview.onDidReceiveMessage((message: FromDiagramTab) => (handlers[message.type] as (m: FromDiagramTab) => void)(message));
  panel.webview.html = pageHtml(panel.webview, dist, 'diagram-tab.js');
}
