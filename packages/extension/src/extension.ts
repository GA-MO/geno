import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { z } from 'zod';
import { approvalModeOf, Chat, CHAT_VIEW, HISTORY_COMMAND, LANES_COMMAND, MCP_COMMAND, NEW_CHAT_COMMAND, SEND_COMMAND, sessionMemory, STOP_COMMAND, TASKS_COMMAND, LOOK_SETTINGS, lookOf } from './chat/chat.js';
import { BROWSER_ENABLED_SETTING } from './chat/browser.js';
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
import { describeEngineRuntime, engineEnvOf, modelLabel, providerOf, readEngineRuntime, secretName, SET_KEY_COMMAND, SETTINGS_COMMAND, setupProblem } from './runtime.js';
import { SettingsPage } from './chat/settings-host.js';
import { isProviderName, PROVIDERS, specOf, type FieldId, type ProviderName } from '@g-code/core';

const engineCli = (context: vscode.ExtensionContext): string => path.join(context.extensionPath, 'dist', 'engine', 'cli.js');

const ENGINE_SETTINGS = ['gcode.provider', 'gcode.baseUrl', 'gcode.model', 'gcode.providers', 'gcode.roles'];

async function engineSettings(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<EngineSettings> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) throw new Error('Geno chat needs an open folder');
  const runtime = await readEngineRuntime(vscode.workspace.getConfiguration('gcode'), context.secrets, process.env);
  const problem = setupProblem(runtime.chat, process.env);
  if (problem !== undefined) {
    void vscode.window.showWarningMessage(problem.message, problem.fix.label).then((choice) => {
      if (choice !== undefined) void vscode.commands.executeCommand(problem.fix.command, ...problem.fix.args);
    });
    throw new Error(problem.message);
  }
  output.appendLine(`engine: ${describeEngineRuntime(runtime)}`);
  const rg = process.env['GCODE_RG'] ? undefined : await findExecutable('rg', process.env);
  return {
    cliPath: engineCli(context),
    cwd: folder.uri.fsPath,
    env: { ...engineEnvOf(runtime), ...(rg === undefined ? {} : { GCODE_RG: rg }) },
  };
}

type SecretChoice = { readonly provider: ProviderName; readonly field: FieldId };

/** Every secret any provider takes, the chat provider's key first. */
async function pickSecret(): Promise<SecretChoice | undefined> {
  const chat = providerOf(vscode.workspace.getConfiguration('gcode'));
  const order = [chat, ...PROVIDERS.filter((p) => p !== chat)];
  const items = order.flatMap((provider) =>
    specOf(provider).fields.filter((f) => f.secret).map((f) => ({ label: `${specOf(provider).label}: ${f.label}`, ...(provider === chat ? { description: 'chat' } : {}), choice: { provider, field: f.id } })),
  );
  return (await vscode.window.showQuickPick(items, { title: 'Set a Geno key', placeHolder: 'Which key?' }))?.choice;
}

/**
 * Stores a provider's key in SecretStorage. With no arguments it asks which key, then for the key in a password
 * box; a test passes the key, and the settings page the provider and field.
 */
async function setApiKey(secrets: vscode.SecretStorage, given?: string, provider?: string, field?: FieldId): Promise<void> {
  const choice: SecretChoice | undefined =
    provider !== undefined && isProviderName(provider)
      ? { provider, field: field ?? 'apiKey' }
      : given !== undefined
        ? { provider: providerOf(vscode.workspace.getConfiguration('gcode')), field: 'apiKey' }
        : await pickSecret();
  if (choice === undefined || !specOf(choice.provider).fields.some((f) => f.id === choice.field && f.secret)) return;
  const label = specOf(choice.provider).fields.find((f) => f.id === choice.field)!.label;
  const key = given ?? (await vscode.window.showInputBox({ prompt: `Your ${specOf(choice.provider).label} ${label}`, password: true, ignoreFocusOut: true }));
  if (key === undefined || key.trim() === '') return;
  await secrets.store(secretName(choice.provider, choice.field), key.trim());
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
    (post) => new SettingsPage(context.secrets, engineCli(context), output, post),
  );
  registerReview(context, chat, review);
  context.subscriptions.push(
    output,
    chat,
    review.onDidChange(() => chat.reviewed(review.all())),
    vscode.commands.registerCommand(SET_KEY_COMMAND, (key?: string, provider?: string, field?: FieldId) => setApiKey(context.secrets, key, provider, field)),
    context.secrets.onDidChange(() => chat.resetEngine()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (ENGINE_SETTINGS.some((section) => event.affectsConfiguration(section))) chat.resetEngine();
      if (LOOK_SETTINGS.some((section) => event.affectsConfiguration(section))) chat.restyle();
      if (event.affectsConfiguration(BROWSER_ENABLED_SETTING)) chat.syncBrowser();
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
    vscode.commands.registerCommand(LANES_COMMAND, async () => {
      await vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
      chat.showPane('show-lanes');
    }),
    vscode.commands.registerCommand(TASKS_COMMAND, async () => {
      await vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
      chat.showPane('show-tasks');
    }),
    vscode.commands.registerCommand(SETTINGS_COMMAND, async () => {
      await vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
      chat.showSettings();
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
