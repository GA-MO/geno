import * as vscode from 'vscode';
import type { CompletionId } from '@g-code/core/tab';
import { openTabLog, tabEventsFile } from './tab/log.js';
import { readSettings, TabProvider } from './tab/provider.js';
import { ACCEPT_COMMAND, OutcomeTracker } from './tab/tracker.js';
import { TAB_DOCUMENTS } from './tab/documents.js';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('g-code');
  const log = openTabLog(tabEventsFile(process.env), (error) => output.appendLine(`tab log: ${String(error)}`));
  const tracker = new OutcomeTracker(log);
  context.subscriptions.push(
    output,
    tracker,
    vscode.commands.registerCommand('gcode.hello', () => {
      void vscode.window.showInformationMessage('Hello from g-code');
    }),
    vscode.commands.registerCommand(ACCEPT_COMMAND, (uri: vscode.Uri, id: CompletionId, text: string) =>
      tracker.accepted(uri, id, text),
    ),
    vscode.languages.registerInlineCompletionItemProvider(TAB_DOCUMENTS, new TabProvider(readSettings, log, tracker)),
  );
}

export function deactivate(): void {}
