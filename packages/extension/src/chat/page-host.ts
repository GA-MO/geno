import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { dataUri, imageHrefs, PAGE_THEME, pageFileName, renderPage, type DataUri, type PageDiagram } from '@g-code/core/share-page';
import type { Transcript } from './messages.js';
import { chooseName, imageFile, pagesFolderOf } from './page-files.js';
import { pageDraft, type PageFromView, type PageSource } from './page-model.js';

const IMAGE_MAX = 5 * 1024 * 1024;
const IMAGES_MAX = 20 * 1024 * 1024;
const DIAGRAM_MAX = 2 * 1024 * 1024;

const REVEAL: Readonly<Partial<Record<NodeJS.Platform, string>>> = { darwin: 'Reveal in Finder', win32: 'Reveal in File Explorer' };
const OPEN = 'Open in Browser';

const warn = (error: unknown) => void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** The workspace images the page's markdown shows, read as data, as far as the size caps allow. */
async function readImages(texts: readonly string[]): Promise<Map<string, DataUri>> {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  const images = new Map<string, DataUri>();
  let total = 0;
  for (const href of new Set(texts.flatMap(imageHrefs))) {
    const found = imageFile(href, roots);
    if (found === undefined) continue;
    try {
      const uri = vscode.Uri.file(found.file);
      const { size } = await vscode.workspace.fs.stat(uri);
      if (size > IMAGE_MAX || total + size > IMAGES_MAX) continue;
      images.set(href, dataUri(found.type, await vscode.workspace.fs.readFile(uri)));
      total += size;
    } catch {
      continue;
    }
  }
  return images;
}

const diagramsOf = (page: PageSource): Map<string, PageDiagram> =>
  new Map(page.kind === 'answer' ? page.diagrams.filter((d) => d.svg.length <= DIAGRAM_MAX).map((d) => [d.source, { svg: d.svg, scheme: d.scheme }]) : []);

/**
 * Where the page goes: `<folder>/<name>.html` in the first workspace folder, asking before a file of that name is
 * replaced. Without a workspace, the save dialog asks.
 */
async function targetFor(title: string): Promise<vscode.Uri | undefined> {
  const name = pageFileName(title);
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (workspace === undefined) return vscode.window.showSaveDialog({ filters: { HTML: ['html'] }, saveLabel: 'Save Page', title: name });
  const folder = vscode.Uri.joinPath(workspace.uri, ...pagesFolderOf(vscode.workspace.getConfiguration('gcode.pages').get<string>('folder')));
  const shown = (file: string) => vscode.workspace.asRelativePath(vscode.Uri.joinPath(folder, file));
  const chosen = await chooseName(
    name,
    (file) => exists(vscode.Uri.joinPath(folder, file)),
    async (taken, beside) => {
      const choice = await vscode.window.showWarningMessage(`${shown(taken)} already exists. Replace it?`, { modal: true, detail: `Keep Both saves this page as ${shown(beside)}.` }, 'Replace', 'Keep Both');
      return choice === 'Replace' ? 'replace' : choice === 'Keep Both' ? 'keep-both' : undefined;
    },
  );
  return chosen === undefined ? undefined : vscode.Uri.joinPath(folder, chosen);
}

async function offer(target: vscode.Uri): Promise<void> {
  const reveal = REVEAL[process.platform] ?? 'Open Containing Folder';
  const choice = await vscode.window.showInformationMessage(`Saved the page to ${vscode.workspace.asRelativePath(target)}.`, OPEN, reveal);
  if (choice === OPEN) await vscode.env.openExternal(target);
  if (choice === reveal) await vscode.commands.executeCommand('revealFileInOS', target);
}

/** Save as Page: a widget or an answer from the transcript, written as one standalone HTML file in the workspace. */
export function pageHost(transcript: () => Transcript) {
  async function save(page: PageSource): Promise<void> {
    const draft = pageDraft(page, transcript());
    if (draft === undefined) throw new Error('Geno has nothing to save from this answer.');
    const texts = draft.parts.flatMap((part) => (part.kind === 'markdown' ? [part.text] : []));
    const html = renderPage({ ...draft, images: await readImages(texts), diagrams: diagramsOf(page), theme: PAGE_THEME, nonce: randomBytes(16).toString('base64') });
    const target = await targetFor(draft.title);
    if (target === undefined) return;
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(html));
    void offer(target).catch(warn);
  }

  const handlers: { readonly [K in PageFromView['type']]: (message: Extract<PageFromView, { type: K }>) => void } = {
    'save-page': ({ page }) => void save(page).catch(warn),
  };
  return { handlers };
}
