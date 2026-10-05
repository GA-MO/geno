import * as vscode from 'vscode';
import { BROWSER_META, DEFAULT_BROWSER_SETTINGS, type BrowserSettings } from '@g-code/core';

export const BROWSER_ENABLED_SETTING = 'gcode.browser.enabled';
export const BROWSER_HEADLESS_SETTING = 'gcode.browser.headless';

export function browserSettings(): BrowserSettings {
  const config = vscode.workspace.getConfiguration('gcode');
  return {
    enabled: config.get('browser.enabled', DEFAULT_BROWSER_SETTINGS.enabled) === true,
    headless: config.get('browser.headless', DEFAULT_BROWSER_SETTINGS.headless) !== false,
  };
}

/** What every session request carries, so the engine knows whether the session has the browser and how to run it. */
export const browserMeta = (): Record<string, unknown> => ({ [BROWSER_META]: browserSettings() });

/** The MCP panel's switch writes the user setting; the setting's change tells the engine. */
export const setBrowserEnabled = (enabled: boolean): Thenable<void> =>
  vscode.workspace.getConfiguration('gcode').update('browser.enabled', enabled, vscode.ConfigurationTarget.Global);
