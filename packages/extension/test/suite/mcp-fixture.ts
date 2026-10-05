/** The MCP fixture's names and prompts, shared by the suite inside VS Code and the test that launches it. */

/** Defined in the workspace's .vscode/mcp.json, so it waits for the user's approval. */
export const WORKSPACE_SERVER = 'wsfake';
/** Defined in the user's VS Code mcp.json, which the extension forwards. */
export const USER_SERVER = 'userfake';

export const PROMPTS = { first: 'What can you reach?', second: 'Echo hi with the user server' } as const;

/** Environment the launcher gives the extension host, for the suite to check against. */
export const ENV = {
  /** Written by the workspace server when it runs, which it must not do before Allow. */
  workspaceMarker: 'MCP_TEST_WORKSPACE_MARKER',
  /** The exact command line the trust card must show. */
  workspaceCommand: 'MCP_TEST_WORKSPACE_COMMAND',
} as const;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
