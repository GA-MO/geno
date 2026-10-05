import path from 'node:path';
import * as vscode from 'vscode';
import { CHECKPOINT_TEXT_METHOD, type CheckpointTextRequest, type CheckpointTextResponse } from '@g-code/core';
import { realOrSelf } from '../chat/bridge.js';
import type { SessionLink } from '../chat/chat.js';

export const CHECKPOINT_SCHEME = 'gcode-checkpoint';

/** The read-only document for a file as it was at the session's first checkpoint. */
export const checkpointUri = (file: vscode.Uri): vscode.Uri => file.with({ scheme: CHECKPOINT_SCHEME });

/** Serves `gcode-checkpoint:` documents from the engine's checkpoint; a file that did not exist then is empty. */
export class CheckpointDocuments implements vscode.TextDocumentContentProvider {
  constructor(private readonly link: () => Promise<SessionLink>) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { connection, sessionId } = await this.link();
    const file = await realOrSelf(uri.with({ scheme: 'file' }).fsPath);
    const { text } = await connection.agent.request<CheckpointTextResponse, CheckpointTextRequest>(CHECKPOINT_TEXT_METHOD, { sessionId, path: file });
    return text ?? '';
  }
}

export const openDiff = (file: vscode.Uri): Thenable<unknown> =>
  vscode.commands.executeCommand('vscode.diff', checkpointUri(file), file, `${path.basename(file.fsPath)} (checkpoint ↔ now)`);
