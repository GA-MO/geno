import path from 'node:path';
import * as vscode from 'vscode';
import { DEFAULT_TAB_MODEL_FILE, type TabServerState } from '@g-code/core/tab';
import { findExecutable } from '../executables.js';
import { gcodeHome } from './log.js';
import type { TabSettings } from './provider.js';
import { TabServer, type TabServerPlan } from './server.js';

export const TOGGLE_COMMAND = 'gcode.tab.toggle';

type Look = { readonly text: string; readonly tooltip: string; readonly warning?: boolean };

const LOOKS: { readonly [K in TabServerState['kind']]: (state: Extract<TabServerState, { kind: K }>) => Look } = {
  off: () => ({ text: '$(circle-slash) Tab', tooltip: 'Geno Tab is off. Click to turn it on.' }),
  starting: () => ({ text: '$(loading~spin) Tab', tooltip: 'Geno Tab is starting its model server. Click to turn Tab off.' }),
  ready: ({ owned }) => ({
    text: '$(sparkle) Tab',
    tooltip: `Geno Tab is on${owned ? '' : ', using the model server that was already running'}. Click to turn it off.`,
  }),
  failed: ({ reason }) => ({ text: '$(warning) Tab', tooltip: `Geno Tab failed: ${reason}. Click to turn Tab off.`, warning: true }),
};

const lookOf = <K extends TabServerState['kind']>(state: Extract<TabServerState, { kind: K }>): Look =>
  (LOOKS[state.kind] as (s: Extract<TabServerState, { kind: K }>) => Look)(state);

async function planOf(settings: TabSettings, env: NodeJS.ProcessEnv): Promise<TabServerPlan> {
  if (!settings.enabled) return { kind: 'off' };
  return {
    kind: 'on',
    endpoint: settings.endpoint,
    model: settings.modelPath || path.join(gcodeHome(env), 'models', DEFAULT_TAB_MODEL_FILE),
    binary: await findExecutable('llama-server', env),
  };
}

/** Flips gcode.tab.enabled where it is set: in the workspace if it says so there, otherwise for the user. */
async function toggle(): Promise<void> {
  const config = vscode.workspace.getConfiguration('gcode.tab');
  const inWorkspace = config.inspect<boolean>('enabled')?.workspaceValue !== undefined;
  await config.update('enabled', !config.get('enabled', true), inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
}

/** Runs the Tab model server while Tab is on, shows its state in the status bar, and stops it with the extension. */
export function registerTabServer(context: vscode.ExtensionContext, settings: () => TabSettings, output: vscode.OutputChannel): void {
  const item = vscode.window.createStatusBarItem('gcode.tab', vscode.StatusBarAlignment.Right, 100);
  item.name = 'Geno Tab';
  item.command = TOGGLE_COMMAND;
  const show = (state: TabServerState) => {
    const look = lookOf(state);
    item.text = look.text;
    item.tooltip = look.tooltip;
    item.backgroundColor = look.warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  };
  const server = new TabServer(show, (line) => output.appendLine(line));
  show(server.state);
  item.show();
  const report = (error: unknown) => output.appendLine(`tab server: ${String(error)}`);
  // Plans are made one after another so a slow lookup cannot apply an older setting after a newer one. The
  // start itself is not awaited, so turning Tab off does not wait for a start to finish.
  let planned = Promise.resolve();
  const reconcile = () => {
    planned = planned.then(async () => void server.apply(await planOf(settings(), process.env)).catch(report)).catch(report);
  };
  reconcile();
  context.subscriptions.push(
    item,
    server,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('gcode.tab')) reconcile();
    }),
    vscode.commands.registerCommand(TOGGLE_COMMAND, toggle),
  );
}
