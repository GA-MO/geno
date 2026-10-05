import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { asSha256, ATTACHMENT_META, attachmentFileName, formatBytes, isImageMediaType } from '@g-code/core/attachments';
import { gcodeHome } from '../tab/log.js';
import { viewOf, type AttachmentView, type OpenTarget, type OutgoingAttachment, type PickedFile, type Refused } from './attachment-model.js';
import type { ToolImage, WebviewRoot } from './messages.js';

const MAX_READ_BYTES = 64 * 1024 * 1024;

const fileUri = (file: string): string => vscode.Uri.file(file).toString();

/** The session/prompt blocks for a message's attachments: `image` blocks and embedded text resources. */
export function promptBlocks(attachments: readonly OutgoingAttachment[]): acp.ContentBlock[] {
  return attachments.map((a): acp.ContentBlock => {
    const _meta = { [ATTACHMENT_META]: { name: a.name } };
    if (a.kind === 'image') return { type: 'image', data: a.data, mimeType: a.mediaType, ...(a.path === undefined ? {} : { uri: fileUri(a.path) }), _meta };
    return { type: 'resource', resource: { uri: a.path === undefined ? `untitled:${a.name}` : fileUri(a.path), text: a.text, mimeType: a.mediaType }, _meta };
  });
}

function storedName(attachment: OutgoingAttachment): string {
  const bytes = attachment.kind === 'image' ? Buffer.from(attachment.data, 'base64') : Buffer.from(attachment.text);
  const sha256 = asSha256(createHash('sha256').update(bytes).digest('hex'));
  return attachment.kind === 'image'
    ? attachmentFileName({ kind: 'image', sha256, mediaType: attachment.mediaType, name: attachment.name, bytes: bytes.length, width: attachment.width, height: attachment.height })
    : attachmentFileName({ kind: 'file', sha256, mediaType: attachment.mediaType, name: attachment.name, bytes: bytes.length });
}

/** The sent message's chips: each opens the file it came from, or its stored copy when it was pasted. */
export const viewsOf = (attachments: readonly OutgoingAttachment[]): AttachmentView[] =>
  attachments.map((a) => viewOf(a, a.path === undefined ? { kind: 'stored', file: storedName(a) } : { kind: 'path', path: a.path }));

/** Reads files for the composer; folders and very large files are refused by name. */
export async function readForComposer(uris: readonly vscode.Uri[]): Promise<{ readonly files: PickedFile[]; readonly refused: Refused[] }> {
  const files: PickedFile[] = [];
  const refused: Refused[] = [];
  for (const uri of uris) {
    const name = path.basename(uri.path);
    const stat = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(() => undefined);
    if (stat === undefined) refused.push({ name, reason: `${name} could not be read.` });
    else if ((stat.type & vscode.FileType.Directory) !== 0) refused.push({ name, reason: `${name} is a folder; attach files one by one.` });
    else if (stat.size > MAX_READ_BYTES) refused.push({ name, reason: `${name} is ${formatBytes(stat.size)}, too large to attach.` });
    else files.push({ name, path: uri.fsPath, data: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('base64') });
  }
  return { files, refused };
}

export async function pickFiles(): Promise<vscode.Uri[]> {
  return (await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, openLabel: 'Attach' })) ?? [];
}

/** `file:` URIs from a drop; anything else, such as a web address, is ignored. */
export const droppedUris = (raw: readonly string[]): vscode.Uri[] =>
  raw.flatMap((line) => {
    try {
      const uri = vscode.Uri.parse(line.trim(), true);
      return uri.scheme === 'file' ? [uri] : [];
    } catch {
      return [];
    }
  });

/**
 * Each workspace folder's path, and its real path when a symlink leads to it, as on macOS, where /var is
 * /private/var: the engine names files by their real paths.
 */
function folderPaths(): { readonly folder: vscode.Uri; readonly paths: readonly string[] }[] {
  return (vscode.workspace.workspaceFolders ?? []).map(({ uri }) => {
    let real = uri.fsPath;
    try {
      real = realpathSync(uri.fsPath);
    } catch {
    }
    return { folder: uri, paths: real === uri.fsPath ? [uri.fsPath] : [uri.fsPath, real] };
  });
}

const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const STORED = /^[0-9a-f]{64}\.(png|jpg|gif|webp|txt)$/;

/**
 * Opens what the transcript shows in an editor tab. Only a file inside a workspace folder, the file an attachment
 * came from, or a stored attachment of this session opens; the webview's word is not enough for anything else.
 */
export async function openTarget(target: OpenTarget, sessionId: string | undefined, sent: ReadonlySet<string>): Promise<void> {
  let file: string | undefined;
  if (target.kind === 'stored') {
    if (sessionId !== undefined && STORED.test(target.file)) file = path.join(gcodeHome(process.env), 'sessions', sessionId, 'attachments', target.file);
  } else {
    const folders = folderPaths().flatMap((f) => f.paths);
    if (folders.some((root) => inside(root, target.path)) || sent.has(target.path)) file = target.path;
  }
  if (file !== undefined) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
}

/** The workspace folders as the webview reaches them, for read thumbnails and markdown images. */
export const webviewRoots = (webview: vscode.Webview): WebviewRoot[] =>
  folderPaths().flatMap(({ folder, paths }) => paths.map((root) => ({ path: root, uri: webview.asWebviewUri(folder).toString() })));

/** The image files a tool call's content links to, as the engine sends a read of an image. */
export function imagesOf(content: readonly acp.ToolCallContent[] | null | undefined): ToolImage[] {
  return (content ?? []).flatMap((c) =>
    c.type === 'content' && c.content.type === 'resource_link' && c.content.uri.startsWith('file:') && isImageMediaType(c.content.mimeType ?? '')
      ? [{ path: vscode.Uri.parse(c.content.uri).fsPath, name: c.content.name }]
      : [],
  );
}
