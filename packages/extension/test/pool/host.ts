/**
 * The extension that runs suites in a pooled window. It asks the pool what to do, and either runs a suite in this
 * extension host or leaves for the next suite's folder.
 */
import { appendFileSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import * as vscode from 'vscode';
import { post, type Done, type Job, type Order } from './protocol.js';

const GENO = 'g-code.g-code';
const url = process.env['GCODE_POOL_URL'];
const window = Number(process.env['GCODE_POOL_WINDOW']);
const folder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

/** The pooled Geno depends on this extension, so VS Code activates Geno only once this has set the suite's env. */
export async function activate(): Promise<void> {
  if (url === undefined) return;
  const early = vscode.extensions.getExtension(GENO)?.isActive === true;
  const order = await post<Order>(`${url}/host`, { window, folder: folder(), fresh: true });
  if (order.do !== 'run') return follow(order);
  if (early) return void finish({ message: 'Geno activated before the suite set its environment' });
  Object.assign(process.env, order.job.env);
  void runSuite(order.job);
}

/**
 * Runs the suite from a copy inside Geno's folder: VS Code gives a module's `require('vscode')` the API of the
 * extension whose folder holds it, which for a test runner is the extension under test, and outside any extension
 * an API that belongs to none.
 */
async function runSuite(job: Job): Promise<void> {
  const restore = capture(job.log);
  let error: Done['error'];
  try {
    const dir = path.join(vscode.extensions.getExtension(GENO)!.extensionPath, '.pool-suites');
    mkdirSync(dir, { recursive: true });
    const copy = path.join(dir, `${window}-${Date.now()}-${path.basename(job.suite)}`);
    copyFileSync(job.suite, copy);
    await (require(copy) as { run(): Promise<void> }).run();
  } catch (thrown) {
    error = thrown instanceof Error ? { message: thrown.message, ...(thrown.stack === undefined ? {} : { stack: thrown.stack }) } : { message: String(thrown) };
  } finally {
    restore();
  }
  await finish(error);
}

async function finish(error: Done['error']): Promise<void> {
  await post(`${url}/done`, { window, ...(error === undefined ? {} : { error }) });
  await follow(await post<Order>(`${url}/host`, { window, folder: folder(), fresh: false }));
}

/** A suite run again in its own folder gets a plain reload, which keeps its editors, as a user's reload would. */
async function follow(order: Order): Promise<void> {
  if (order.do === 'open') {
    await leave();
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(order.folder), { forceReuseWindow: true });
  } else if (order.do === 'reload') await vscode.commands.executeCommand('workbench.action.reloadWindow');
  else if (order.do === 'quit') await vscode.commands.executeCommand('workbench.action.quit');
  else if (order.do === 'close') await vscode.commands.executeCommand('workbench.action.closeWindow');
}

/** Clears what would make VS Code ask before it changes folder: unsaved editors and terminals. */
async function leave(): Promise<void> {
  for (const terminal of vscode.window.terminals) terminal.dispose();
  for (const document of vscode.workspace.textDocuments.filter((d) => d.isDirty)) {
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/** Copies the suite's console output to `file`, as a test window prints it to the test's output. */
function capture(file: string): () => void {
  const methods = ['log', 'info', 'warn', 'error'] as const;
  const originals = methods.map((m) => console[m]);
  methods.forEach((m, i) => {
    console[m] = (...args: unknown[]) => {
      appendFileSync(file, `${format(...args)}\n`);
      originals[i]!.apply(console, args);
    };
  });
  return () => methods.forEach((m, i) => (console[m] = originals[i]!));
}
