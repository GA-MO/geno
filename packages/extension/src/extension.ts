import path from 'node:path';
import * as vscode from 'vscode';
import { Chat, CHAT_VIEW, SEND_COMMAND, sessionMemory, STOP_COMMAND } from './chat/chat.js';
import type { EngineSettings } from './chat/engine.js';
import { registerReview } from './review/commands.js';
import { ReviewController } from './review/controller.js';
import type { CompletionId } from '@g-code/core/tab';
import { EditHistoryTracker } from './tab/history.js';
import { openTabLog, tabEventsFile } from './tab/log.js';
import { inlineEditsAvailable, NextEditProvider, TabRouter } from './tab/next-edit.js';
import { readSettings, TabProvider } from './tab/provider.js';
import { TAB_DOCUMENTS } from './tab/documents.js';
import { ACCEPT_COMMAND, OutcomeTracker } from './tab/tracker.js';

function engineSettings(extensionPath: string): EngineSettings {
  const configured = vscode.workspace.getConfiguration('gcode.engine').get<string>('path', '');
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) throw new Error('g-code chat needs an open folder');
  return { cliPath: configured || path.join(extensionPath, '..', 'engine', 'dist', 'cli.js'), cwd: folder.uri.fsPath };
}

function registerChat(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('g-code engine');
  const review = new ReviewController(() => chat.link(), output);
  const chat = new Chat(() => engineSettings(context.extensionPath), context.extensionUri, output, sessionMemory(context.storageUri), (document, change) =>
    review.track(document, change),
  );
  registerReview(context, chat, review, output);
  context.subscriptions.push(
    output,
    chat,
    vscode.window.registerWebviewViewProvider(CHAT_VIEW, chat),
    vscode.commands.registerCommand(SEND_COMMAND, async (prompt?: string) => {
      const text = prompt ?? (await vscode.window.showInputBox({ prompt: 'Ask g-code for a change' }));
      return text === undefined || text.trim() === '' ? undefined : chat.send(text.trim());
    }),
    vscode.commands.registerCommand(STOP_COMMAND, () => chat.stop()),
  );
}

export function activate(context: vscode.ExtensionContext): void {
  registerChat(context);
  const output = vscode.window.createOutputChannel('g-code');
  const log = openTabLog(tabEventsFile(process.env), (error) => output.appendLine(`tab log: ${String(error)}`));
  const tracker = new OutcomeTracker(log);
  const fim = new TabProvider(readSettings, log, tracker);
  context.subscriptions.push(
    output,
    tracker,
    vscode.commands.registerCommand('gcode.hello', () => {
      void vscode.window.showInformationMessage('Hello from g-code');
    }),
    vscode.commands.registerCommand(ACCEPT_COMMAND, (uri: vscode.Uri, id: CompletionId, text: string) =>
      tracker.accepted(uri, id, text),
    ),
  );
  // Stable VS Code has no inline edits, so it keeps the FIM provider alone, exactly as before next-edit existed.
  if (!inlineEditsAvailable()) {
    context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider(TAB_DOCUMENTS, fim));
    return;
  }
  const history = new EditHistoryTracker();
  const router = new TabRouter(readSettings, fim, new NextEditProvider(readSettings, log, history));
  context.subscriptions.push(history, vscode.languages.registerInlineCompletionItemProvider(TAB_DOCUMENTS, router));
  output.appendLine('tab: inline edits available; gcode.tab.nextEdit switches Tab to next-edit prediction');
}

export function deactivate(): void {}
