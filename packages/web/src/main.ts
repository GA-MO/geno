/**
 * `pnpm web`: Geno's chat panel in a browser. The extension's own chat host runs here under Node, with `vscode` the
 * shim, and talks to the engine as the extension does; the panel's page is served on 127.0.0.1 behind a token.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as vscode from 'vscode';
import { registerChat } from '../../extension/src/chat-activation.js';
import { CHAT_VIEW } from '../../extension/src/chat/chat.js';
import { findExecutable } from '../../extension/src/executables.js';
import { gcodeHome } from '../../extension/src/tab/log.js';
import { newToken } from './security.js';
import { WebServer } from './server.js';
import { defaultsOf, SettingsFile } from './settings.js';
import { CancellationTokenSource, configureShim, EventEmitter, settingsChanged, Uri, viewProvider, webviewView } from './vscode-shim.js';

export type WebOptions = { readonly workspace: string; readonly trusted: boolean; readonly port: number | undefined };

const USAGE = 'usage: pnpm web -- [--workspace <dir>] [--trust] [--port <n>]';

/** The command line, with relative paths from where the user ran `pnpm web`. */
export function parseArgs(argv: readonly string[], cwd: string): WebOptions {
  let workspace = cwd;
  let trusted = false;
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') continue;
    if (arg === '--trust') trusted = true;
    else if (arg === '--workspace' && argv[i + 1] !== undefined) workspace = path.resolve(cwd, argv[++i]!);
    else if (arg === '--port' && /^\d+$/.test(argv[i + 1] ?? '')) port = Number(argv[++i]);
    else throw new Error(`${arg}: ${USAGE}`);
  }
  return { workspace, trusted, port };
}

/** SecretStorage for this run only: a key set in the page lasts until the server stops, and keys in the environment need none. */
function memorySecrets(): vscode.SecretStorage {
  const values = new Map<string, string>();
  const changed = new EventEmitter<vscode.SecretStorageChangeEvent>();
  return {
    get: async (key) => values.get(key),
    store: async (key, value) => {
      values.set(key, value);
      changed.fire({ key });
    },
    delete: async (key) => {
      values.delete(key);
      changed.fire({ key });
    },
    onDidChange: changed.event,
  } as vscode.SecretStorage;
}

function memento(): vscode.Memento & { setKeysForSync(keys: readonly string[]): void } {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => (values.has(key) ? (values.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void (value === undefined ? values.delete(key) : values.set(key, value)),
    setKeysForSync: () => {},
  } as vscode.Memento & { setKeysForSync(keys: readonly string[]): void };
}

/**
 * The extension context VS Code would hand the extension, laid out under GCODE_HOME/web as VS Code lays out its own
 * user data, so the web host never shares the last session or seen marks with the user's VS Code window.
 */
function extensionContext(extension: string, workspace: string, home: string): vscode.ExtensionContext {
  const web = path.join(home, 'web');
  const folder = createHash('sha256').update(workspace).digest('hex').slice(0, 16);
  return {
    subscriptions: [],
    extensionPath: extension,
    extensionUri: Uri.file(extension),
    storageUri: Uri.file(path.join(web, 'workspaceStorage', folder)),
    globalStorageUri: Uri.file(path.join(web, 'User', 'globalStorage', 'g-code')),
    logUri: Uri.file(path.join(web, 'logs')),
    globalState: memento(),
    workspaceState: memento(),
    secrets: memorySecrets(),
    asAbsolutePath: (relative: string) => path.join(extension, relative),
  } as unknown as vscode.ExtensionContext;
}

export type WebHost = { readonly url: string; readonly port: number; readonly token: string; close(): Promise<void> };

/** Starts the chat host and its server; `extension` is the extension package, whose dist holds the panel and the engine. */
export async function startWeb(options: WebOptions, extension: string, client: string): Promise<WebHost> {
  for (const file of ['dist/webview.js', 'dist/engine/cli.js']) {
    if (!existsSync(path.join(extension, file))) throw new Error(`${path.join(extension, file)} is missing; run pnpm --filter ./packages/extension build`);
  }
  if (!existsSync(options.workspace)) throw new Error(`${options.workspace} does not exist`);
  const token = newToken();
  const server = new WebServer(token, client, 'dark');
  const port = await server.listen(options.port);
  const home = gcodeHome(process.env);
  const manifest = JSON.parse(readFileSync(path.join(extension, 'package.json'), 'utf8')) as Parameters<typeof defaultsOf>[0];
  const settings = await SettingsFile.open(path.join(home, 'web-settings.json'), defaultsOf(manifest), settingsChanged);
  const rg = process.env['GCODE_RG'] ?? (await findExecutable('rg', process.env));
  configureShim({ workspace: options.workspace, trusted: options.trusted, settings, page: server, rg });
  const context = extensionContext(extension, options.workspace, home);
  registerChat(context, () => undefined);
  const provider = viewProvider(CHAT_VIEW);
  if (provider === undefined) throw new Error('the chat registered no view');
  await provider.resolveWebviewView(webviewView('chat') as unknown as vscode.WebviewView, { state: undefined }, new CancellationTokenSource().token);
  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    close: async () => {
      for (const subscription of context.subscriptions) subscription.dispose();
      await server.close();
    },
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    const options = parseArgs(process.argv.slice(2), process.env['INIT_CWD'] ?? process.cwd());
    const web = await startWeb(options, path.resolve(here, '../../extension'), path.join(here, 'client.js'));
    process.stdout.write(`Geno web: ${web.url}\n`);
    process.stderr.write(`workspace ${options.workspace}${options.trusted ? ', trusted' : ', not trusted (pass --trust to run its hooks)'}\n`);
    const stop = () => void web.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
