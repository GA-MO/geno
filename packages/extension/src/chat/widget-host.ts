import * as vscode from 'vscode';
import type { FromWidgetTab, ToolWidget, ToWidgetTab, WidgetFromView } from './messages.js';
import { pageHtml } from './page.js';
import { standaloneDocument, webLink, type WidgetTheme } from './widget-frame.js';

export const WIDGET_VIEW = 'gcode.widget';

type Ready = Extract<ToolWidget, { state: 'ready' }>;

const slug = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'widget';

const defaultUri = (name: string): vscode.Uri | undefined => {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder === undefined ? undefined : vscode.Uri.joinPath(folder, name);
};

const warn = (error: unknown) => void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));

/**
 * What the extension does for a widget: opens a link the user approved, opens the widget in an editor tab, and saves
 * it as a page or an image. `find` looks a drawn widget up in the transcript by its tool call.
 */
export function widgetHost(extensionUri: vscode.Uri, find: (toolId: string) => ToolWidget | undefined) {
  /** A link the user approved in the panel or the tab: opened in the browser, if it is a web address at all. */
  async function openLink(raw: string): Promise<void> {
    const href = webLink(raw);
    if (href !== undefined) await vscode.env.openExternal(vscode.Uri.parse(href, true));
  }

  const ready = (toolId: string): Ready | undefined => {
    const widget = find(toolId);
    return widget?.state === 'ready' ? widget : undefined;
  };

  const tabs = new Map<string, vscode.WebviewPanel>();
  function open(widget: Ready, theme: WidgetTheme): void {
    const existing = tabs.get(widget.sha256);
    if (existing !== undefined) return existing.reveal();
    const dist = vscode.Uri.joinPath(extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel(WIDGET_VIEW, widget.title, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [dist] });
    tabs.set(widget.sha256, panel);
    panel.onDidDispose(() => tabs.delete(widget.sha256));
    panel.webview.onDidReceiveMessage((message: FromWidgetTab) => {
      if (message.type === 'ready') void panel.webview.postMessage({ type: 'show', html: widget.html, theme } satisfies ToWidgetTab);
      if (message.type === 'widget-link') void openLink(message.href).catch(warn);
    });
    panel.webview.html = pageHtml(panel.webview, dist, 'widget-tab.js');
  }

  async function save(name: string, filters: Record<string, string[]>, bytes: Uint8Array): Promise<void> {
    const target = await vscode.window.showSaveDialog({ ...(defaultUri(name) === undefined ? {} : { defaultUri: defaultUri(name)! }), filters, saveLabel: 'Save' });
    if (target !== undefined) await vscode.workspace.fs.writeFile(target, bytes);
  }

  const handlers: { readonly [K in WidgetFromView['type']]: (message: Extract<WidgetFromView, { type: K }>) => void } = {
    'widget-link': ({ href }) => void openLink(href).catch(warn),
    'widget-open': ({ toolId, theme }) => {
      const widget = ready(toolId);
      if (widget !== undefined) open(widget, theme);
    },
    'widget-download': ({ toolId, theme }) => {
      const widget = ready(toolId);
      if (widget === undefined) return;
      const page = standaloneDocument({ title: widget.title, html: widget.html, theme });
      void save(`${slug(widget.title)}.html`, { HTML: ['html'] }, new TextEncoder().encode(page)).catch(warn);
    },
    'widget-image': ({ title, png }) => {
      void vscode.window
        .showWarningMessage('Geno could not put the image on the clipboard.', 'Save as PNG…')
        .then((choice) => (choice === undefined ? undefined : save(`${slug(title)}.png`, { PNG: ['png'] }, Buffer.from(png, 'base64'))))
        .then(undefined, warn);
    },
  };
  return { handlers };
}
