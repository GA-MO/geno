import * as vscode from 'vscode';
import { registerChat } from './chat-activation.js';
import { editorReview } from './review/commands.js';
import type { CompletionId } from '@g-code/core/tab';
import { EditHistoryTracker } from './tab/history.js';
import { openTabLog, tabEventsFile } from './tab/log.js';
import { inlineEditsAvailable, NextEditProvider, TabRouter } from './tab/next-edit.js';
import { readSettings, TabProvider } from './tab/provider.js';
import { registerTabServer } from './tab/status.js';
import { TAB_DOCUMENTS } from './tab/documents.js';
import { ACCEPT_COMMAND, OutcomeTracker } from './tab/tracker.js';

export function activate(context: vscode.ExtensionContext): void {
  registerChat(context, editorReview(context));
  const output = vscode.window.createOutputChannel('Geno');
  const log = openTabLog(tabEventsFile(process.env), (error) => output.appendLine(`tab log: ${String(error)}`));
  const tracker = new OutcomeTracker(log);
  const fim = new TabProvider(readSettings, log, tracker);
  registerTabServer(context, readSettings, output);
  context.subscriptions.push(
    output,
    tracker,
    vscode.commands.registerCommand('gcode.hello', () => {
      void vscode.window.showInformationMessage('Hello from Geno');
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
