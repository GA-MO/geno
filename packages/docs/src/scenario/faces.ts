/**
 * The faces of the panel's permission card, as packages/extension/src/chat/render.ts (FACES, SUBJECT_FACES) and
 * mcp-panel.ts (trustCard) draw them: the title, and the buttons the engine offers (packages/engine/src/serve.ts) under
 * the panel's labels. A mock quotes them, so they stay in the product's English.
 */
export const PERMISSION_FACES = ['command', 'edit', 'read', 'fetch', 'browse', 'mcp', 'memory', 'workflow', 'server', 'server-connect'] as const;
export type PermissionFace = (typeof PERMISSION_FACES)[number];

/** What a face's title names beyond its kind: the host of a fetch, the server and tool of an MCP call. */
export interface FaceSubject {
  readonly host?: string | undefined;
  readonly server?: string | undefined;
  readonly tool?: string | undefined;
}

interface Face {
  readonly title: (subject: FaceSubject) => string;
  readonly options: readonly string[];
  /** The subject a title needs; the check fails a mock that leaves it out. */
  readonly needs: readonly (keyof FaceSubject)[];
}

const TELL = 'No, and tell the agent…';
const RULE_OPTIONS = ['Allow', 'Deny', 'Always allow in this workspace', TELL];

export const FACES: Readonly<Record<PermissionFace, Face>> = {
  command: { title: () => 'Run this command?', options: RULE_OPTIONS, needs: [] },
  edit: { title: () => 'Change this file?', options: RULE_OPTIONS, needs: [] },
  read: { title: () => 'Read outside the workspace?', options: ['Allow', 'Allow this directory for the session', 'Deny', TELL], needs: [] },
  fetch: { title: ({ host }) => `Fetch from ${host}?`, options: RULE_OPTIONS, needs: ['host'] },
  browse: { title: ({ host }) => `Open a page on ${host}?`, options: ['Allow', 'Deny', TELL], needs: ['host'] },
  mcp: { title: ({ server, tool }) => `Use ${server} tool ${tool}?`, options: ['Allow', 'Allow this tool for the session', 'Deny', 'Always allow in this workspace', TELL], needs: ['server', 'tool'] },
  memory: { title: () => 'Remember this?', options: ['Remember', "Don't remember"], needs: [] },
  workflow: { title: () => 'Run this workflow?', options: ['Run', "Don't run"], needs: [] },
  server: { title: () => 'Allow this server to run?', options: ['Allow', 'Turn off'], needs: [] },
  'server-connect': { title: () => 'Allow this server to connect?', options: ['Allow', 'Turn off'], needs: [] },
};

/** The note a memory card adds under the note, by where the note is kept. */
export const MEMORY_SCOPES = {
  project: 'Geno will follow this note in every later chat in this project. You can change or delete it in /memory.',
  global: 'Geno will follow this note in every later chat, in every project. You can change or delete it in /memory.',
} as const;
