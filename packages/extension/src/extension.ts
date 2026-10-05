import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { z } from 'zod';
import { approvalModeOf, Chat, CHAT_VIEW, HISTORY_COMMAND, MCP_COMMAND, NEW_CHAT_COMMAND, SEND_COMMAND, sessionMemory, STOP_COMMAND, LOOK_SETTINGS, lookOf } from './chat/chat.js';
import { readForwarded, userMcpFile } from './chat/mcp-forward.js';
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

/**
 * A session chosen from another project's history opens in that project's window: this window leaves it here,
 * keyed by the folder, and the window that opens the folder picks it up.
 */
const HANDOFF_KEY = 'gcode.chat.handoff';
const handoff = z.object({ workspace: z.string(), sessionId: z.string() });

async function openElsewhere(context: vscode.ExtensionContext, workspace: string, sessionId: string): Promise<void> {
  const folder = vscode.Uri.file(workspace);
  const exists = await vscode.workspace.fs.stat(folder).then(() => true, () => false);
  if (!exists) throw new Error(`The project folder ${workspace} no longer exists.`);
  await context.globalState.update(HANDOFF_KEY, { workspace, sessionId });
  await vscode.commands.executeCommand('vscode.openFolder', folder, { forceNewWindow: true });
}

/** The session another window handed to this folder, taken once. */
async function takeHandoff(context: vscode.ExtensionContext): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const parsed = handoff.safeParse(context.globalState.get(HANDOFF_KEY));
  if (folder === undefined || !parsed.success) return undefined;
  if (parsed.data.workspace !== (await realpath(folder.uri.fsPath).catch(() => folder.uri.fsPath))) return undefined;
  await context.globalState.update(HANDOFF_KEY, undefined);
  return parsed.data.sessionId;
}

function registerChat(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Geno engine');
  const review = new ReviewController(() => chat.link(), output);
  const memory = sessionMemory(context.storageUri);
  const chat = new Chat(
    () => engineSettings(context, output),
    context.extensionUri,
    output,
    memory,
    (document, change) => review.track(document, change),
    () => modelLabel(vscode.workspace.getConfiguration('gcode'), process.env),
    () => lookOf(vscode.workspace.getConfiguration('gcode')),
    (workspace, sessionId) => openElsewhere(context, workspace, sessionId),
    () => approvalModeOf(vscode.workspace.getConfiguration('gcode')),
    async () => {
      const file = userMcpFile(context.globalStorageUri.fsPath);
      const { servers, problems } = await readForwarded(file, {
        env: process.env,
        userHome: os.homedir(),
        workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      }).catch((error: unknown) => ({ servers: [], problems: [String(error)] }));
      for (const problem of problems) output.appendLine(`mcp: ${file}: ${problem}`);
      return [...servers];
    },
  );
  registerReview(context, chat, review);
  context.subscriptions.push(
    output,
    chat,
    review.onDidChange(() => chat.reviewed(review.all())),
    vscode.commands.registerCommand(SET_KEY_COMMAND, (key?: string) => setApiKey(context.secrets, key)),
    context.secrets.onDidChange(() => chat.resetEngine()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (ENGINE_SETTINGS.some((section) => event.affectsConfiguration(section))) chat.resetEngine();
      if (LOOK_SETTINGS.some((section) => event.affectsConfiguration(section))) chat.restyle();
    }),
    vscode.window.registerWebviewViewProvider(CHAT_VIEW, chat),
    vscode.commands.registerCommand(SEND_COMMAND, async (prompt?: string) => {
      const text = prompt ?? (await vscode.window.showInputBox({ prompt: 'Ask Geno for a change' }));
      return text === undefined || text.trim() === '' ? undefined : chat.send(text.trim());
    }),
    vscode.commands.registerCommand(STOP_COMMAND, () => chat.stop()),
    vscode.commands.registerCommand(NEW_CHAT_COMMAND, () => chat.newChat()),
    vscode.commands.registerCommand(MCP_COMMAND, async () => {
      await vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
      chat.showMcp();
    }),
    vscode.commands.registerCommand(HISTORY_COMMAND, async () => {
      await vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
      chat.showHistory();
    }),
    chat.onDidSwitch(() => void review.reset().catch((error: unknown) => output.appendLine(`review: could not restore the session: ${String(error)}`))),
  );
  // A window that had a session, or was handed one, loads it at once, so its transcript and review come back.
  void (async () => {
    const handed = await takeHandoff(context);
    if (handed !== undefined) await memory.save(handed);
    if ((await chat.storedSession()) === undefined) return;
    await chat.link();
    if (handed !== undefined) await vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
  })().catch((error: unknown) => output.appendLine(`chat: could not load the last session: ${String(error)}`));
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
