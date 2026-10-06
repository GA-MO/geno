import path from 'node:path';
import * as vscode from 'vscode';
import { CHECKPOINT_TEXT_METHOD, type CheckpointRef, type CheckpointTextRequest, type CheckpointTextResponse, type DiffBase } from '@g-code/core';
import { realOrSelf } from '../chat/bridge.js';
import type { SessionLink } from '../chat/chat.js';

export const CHECKPOINT_SCHEME = 'gcode-checkpoint';

/** The read-only document for a file as it was at the session's first checkpoint, at `checkpoint`, or at the checkpoint `sha`. */
export const checkpointUri = (file: vscode.Uri, checkpoint?: CheckpointRef | { readonly sha: string }): vscode.Uri =>
  file.with({ scheme: CHECKPOINT_SCHEME, query: checkpoint === undefined ? '' : new URLSearchParams(checkpoint).toString() });

/** Serves `gcode-checkpoint:` documents from the engine's checkpoint; a file that did not exist then is empty. */
export class CheckpointDocuments implements vscode.TextDocumentContentProvider {
  constructor(private readonly link: () => Promise<SessionLink>) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { connection, sessionId } = await this.link();
    const file = await realOrSelf(uri.with({ scheme: 'file', query: '' }).fsPath);
    const query = new URLSearchParams(uri.query);
    const before = query.get('before') ?? undefined;
    const sha = query.get('sha') ?? undefined;
    const { text } = await connection.agent.request<CheckpointTextResponse, CheckpointTextRequest>(CHECKPOINT_TEXT_METHOD, {
      sessionId,
      path: file,
      ...(before === undefined ? {} : { before }),
      ...(sha === undefined ? {} : { sha }),
    });
    return text ?? '';
  }
}

export const openDiff = (file: vscode.Uri, checkpoint?: CheckpointRef): Thenable<unknown> =>
  vscode.commands.executeCommand('vscode.diff', checkpointUri(file, checkpoint), file, `${path.basename(file.fsPath)} (${checkpoint === undefined ? 'checkpoint' : 'before the turn'} ↔ now)`);

const SINCE: Readonly<Record<DiffBase['since'], string>> = { turn: 'before the turn', session: 'session start' };

/** A show_diff's diff: the file at the checkpoint the engine chose, and the file now. */
export const openCheckpointDiff = (file: vscode.Uri, base: DiffBase): Thenable<unknown> =>
  vscode.commands.executeCommand('vscode.diff', checkpointUri(file, { sha: base.sha }), file, `${path.basename(file.fsPath)} (${SINCE[base.since]} ↔ now)`);
