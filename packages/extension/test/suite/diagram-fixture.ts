/** The diagram fixture's prompts and the fake model's answers, shared by the suite inside VS Code and the test that launches it. */
export const FILES = { 'README.md': '# fixture\n' } as const;

export const FLOWCHART = [
  'flowchart TD',
  '  A[Chat panel webview] -->|send| B[Extension host]',
  '  B -->|session/prompt over ACP| C[Engine]',
  '  C --> D{Tool call?}',
  '  D -->|yes| E[Run the tool in the sandbox]',
  '  E --> C',
  '  D -->|no| F[Stream the answer]',
  '  F -->|session/update| B',
  '  B -->|transcript actions| A',
].join('\n');

export const SEQUENCE = [
  'sequenceDiagram',
  '  participant W as Webview',
  '  participant X as Extension',
  '  participant E as Engine',
  '  participant M as Model',
  '  W->>X: send(text)',
  '  X->>E: session/prompt',
  '  E->>M: Messages request',
  '  M-->>E: streamed text',
  '  E-->>X: agent_message_chunk',
  '  X-->>W: text action',
  '  E-->>X: end_turn with usage',
].join('\n');

/** The decision node never closes its brace, so mermaid cannot parse it. */
export const BROKEN = ['flowchart LR', '  A[Start] --> B{Valid?', '  B -->|yes| C'].join('\n');

const fenced = (before: string, source: string, after: string) => [before, '', '```mermaid', source, '```', '', after].join('\n');

export const ANSWERS = {
  flowchart: fenced('A request goes from the panel to the engine and streams back:', FLOWCHART, 'Every step comes back to the panel as a transcript action.'),
  sequence: fenced('The same turn in time order:', SEQUENCE, 'Usage arrives with the end of the turn.'),
  broken: fenced('A diagram with a mistake in it:', BROKEN, 'The brace after `Valid?` is never closed.'),
} as const;

export const PROMPTS = {
  flowchart: 'Draw the request flow',
  sequence: 'Show it as a sequence',
  broken: 'Draw a broken diagram',
} as const;

/** Labels the flowchart must show, each inside its node's box. */
export const FLOW_LABELS = ['Chat panel webview', 'Extension host', 'Engine', 'Tool call?', 'Run the tool in the sandbox', 'Stream the answer'] as const;
