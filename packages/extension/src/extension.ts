import path from 'node:path';
import * as vscode from 'vscode';
import { Chat, CHAT_VIEW, SEND_COMMAND, sessionMemory, STOP_COMMAND, STYLE_SETTING, uiStyleOf } from './chat/chat.js';
import type { EngineSettings } from './chat/engine.js';
import { findExecutable } from './executables.js';
import { registerReview } from './review/commands.js';
import { ReviewController } from './review/controller.js';
import type { CompletionId } from '@g-code/core/tab';
import { EditHistoryTracker } from './tab/history.js';
import { openTabLog, tabEventsFile } from './tab/log.js';
import { inlineEditsAvailable, NextEditProvider, TabRouter } from './tab/next-edit.js';
import { readSettings, TabProvider } from './tab/provider.js';
import { registerTabServer } from './tab/status.js';
import { TAB_DOCUMENTS } from './tab/documents.js';
import { ACCEPT_COMMAND, OutcomeTracker } from './tab/tracker.js';
import { describeRuntime, engineEnv, modelLabel, PROVIDER_LABELS, providerOf, readModelRuntime, secretName, SET_KEY_COMMAND, setupProblem } from './runtime.js';

const ENGINE_SETTINGS = ['gcode.provider', 'gcode.baseUrl', 'gcode.model'];

async function engineSettings(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<EngineSettings> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) throw new Error('Geno chat needs an open folder');
  const runtime = await readModelRuntime(vscode.workspace.getConfiguration('gcode'), context.secrets, process.env);
  const problem = setupProblem(runtime);
  if (problem !== undefined) {
    void vscode.window.showWarningMessage(problem.message, problem.fix.label).then((choice) => {
      if (choice !== undefined) void vscode.commands.executeCommand(problem.fix.command, ...problem.fix.args);
    });
    throw new Error(problem.message);
  }
  output.appendLine(`engine: ${describeRuntime(runtime)}`);
  const rg = process.env['GCODE_RG'] ? undefined : await findExecutable('rg', process.env);
  return {
    cliPath: path.join(context.extensionPath, 'dist', 'engine', 'cli.js'),
    cwd: folder.uri.fsPath,
    env: { ...engineEnv(runtime), ...(rg === undefined ? {} : { GCODE_RG: rg }) },
  };
}

/** Stores the key for the configured provider; the argument lets a test set it without the input box. */
async function setApiKey(secrets: vscode.SecretStorage, given?: string): Promise<void> {
  const provider = providerOf(vscode.workspace.getConfiguration('gcode'));
  const prompt = `Your ${PROVIDER_LABELS[provider]} API key`;
  const key = given ?? (await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true }));
  if (key === undefined || key.trim() === '') return;
  await secrets.store(secretName(provider), key.trim());
}

function registerChat(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Geno engine');
  const review = new ReviewController(() => chat.link(), output);
  const chat = new Chat(
    () => engineSettings(context, output),
    context.extensionUri,
    output,
    sessionMemory(context.storageUri),
    (document, change) => review.track(document, change),
    () => modelLabel(vscode.workspace.getConfiguration('gcode'), process.env),
    () => uiStyleOf(vscode.workspace.getConfiguration('gcode')),
  );
  registerReview(context, chat, review, output);
  context.subscriptions.push(
    output,
    chat,
    review.onDidChange(() => chat.reviewed(review.all())),
    vscode.commands.registerCommand(SET_KEY_COMMAND, (key?: string) => setApiKey(context.secrets, key)),
    context.secrets.onDidChange(() => chat.resetEngine()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (ENGINE_SETTINGS.some((section) => event.affectsConfiguration(section))) chat.resetEngine();
      if (event.affectsConfiguration(STYLE_SETTING)) chat.restyle();
    }),
    vscode.window.registerWebviewViewProvider(CHAT_VIEW, chat),
    vscode.commands.registerCommand(SEND_COMMAND, async (prompt?: string) => {
      const text = prompt ?? (await vscode.window.showInputBox({ prompt: 'Ask Geno for a change' }));
      return text === undefined || text.trim() === '' ? undefined : chat.send(text.trim());
    }),
    vscode.commands.registerCommand(STOP_COMMAND, () => chat.stop()),
  );
}

export function activate(context: vscode.ExtensionContext): void {
  registerChat(context);
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
