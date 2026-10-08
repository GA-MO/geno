/** The MCP sign-in fixture's names and prompts, shared by the suite inside VS Code and the test that launches it. */

/** Defined in the workspace's .vscode/mcp.json as an HTTP server that wants a bearer token, so it waits for approval first. */
export const SERVER = 'docs';

export const PROMPTS = { unsigned: 'What can you reach?', signedIn: 'Echo hi with docs', expired: 'Echo again with docs', signedOut: 'Can you still reach docs?' } as const;

/** A route on the fake model's server that makes the fake authorization server's access tokens expire. */
export const EXPIRE_ROUTE = '/oauth/expire';
