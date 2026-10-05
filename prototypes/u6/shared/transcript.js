/*
 * The fixed transcript every U6 direction renders, so the screenshots differ only in design.
 * window.PROTO_STATE picks the moment: 'full' (a finished turn), 'permission' (a run waiting on a command),
 * 'streaming' (an answer mid-stream) or 'empty' (no conversation yet).
 */
(() => {
  const code = [
    '<span class="tk-k">export function</span> <span class="tk-f">add</span>(a: <span class="tk-t">number</span>, b: <span class="tk-t">number</span>): <span class="tk-t">number</span> {',
    '  <span class="tk-k">return</span> b + a;',
    '}',
  ].join('\n');

  const diagram = `<svg class="dg" viewBox="0 0 424 160" role="img" aria-label="Composer to engine to model; the model calls tools; tool results return to the engine; edits land in Changes">
  <defs><marker id="dg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="dg-arrow" d="M0 0 L8 4 L0 8 z"/></marker></defs>
  <g class="dg-edge"><path d="M108 32 H156" marker-end="url(#dg-arrow)"/><path d="M264 32 H312" marker-end="url(#dg-arrow)"/>
  <path d="M368 52 V108" marker-end="url(#dg-arrow)"/><path d="M314 116 L252 56" marker-end="url(#dg-arrow)"/><path d="M312 132 H266" marker-end="url(#dg-arrow)"/></g>
  <g class="dg-label"><text x="374" y="84">tool calls</text><text x="250" y="96" text-anchor="end">results</text><text x="289" y="148" text-anchor="middle">edits</text></g>
  <g class="dg-node"><rect x="4" y="12" width="104" height="40"/><text x="56" y="37">Composer</text></g>
  <g class="dg-node dg-hot"><rect x="158" y="12" width="104" height="40"/><text x="210" y="37">Engine</text></g>
  <g class="dg-node"><rect x="314" y="12" width="104" height="40"/><text x="366" y="37">Model</text></g>
  <g class="dg-node"><rect x="314" y="112" width="104" height="40"/><text x="366" y="137">Tools</text></g>
  <g class="dg-node"><rect x="158" y="112" width="104" height="40"/><text x="210" y="137">Changes</text></g>
</svg>`;

  const answer = {
    intro: '<p>Swapped the operands in <code>add</code>, shortened the greeting and made <code>double</code> multiply. The new <code>add</code> reads:</p>',
    code: { lang: 'ts', file: 'src/a.ts', html: code },
    lead: '<p>A chat turn loops between the model and the tools until the model stops asking for them:</p>',
    diagram,
    list: '<ul><li><strong>a.ts</strong> returns <code>b + a</code> instead of <code>a + b</code></li><li><strong>b.ts</strong> greets with <code>\'hi\'</code></li><li><strong>c.ts</strong> <code>double</code> returns <code>n * 2</code></li></ul>',
  };

  const finished = {
    prompt: 'Swap the operands in <code>add</code>, make <code>double</code> multiply, shorten the greeting, and sketch how a chat turn flows.',
    thought: { seconds: 3, text: 'Three one-line edits in a.ts, b.ts and c.ts. Read each file before editing, then draw the turn loop.' },
    steps: [
      { kind: 'search', icon: 'search', verb: 'Searched', target: 'greeting|double', detail: '3 matches in 2 files', ms: 14 },
      { kind: 'read', icon: 'file', verb: 'Read', target: 'src/a.ts', detail: '4 lines', ms: 2 },
      { kind: 'read', icon: 'file', verb: 'Read', target: 'src/b.ts', detail: '1 line', ms: 1 },
      { kind: 'read', icon: 'file', verb: 'Read', target: 'src/c.ts', detail: '3 lines', ms: 1 },
      { kind: 'edit', icon: 'edit', verb: 'Edited', target: 'src/a.ts', add: 1, del: 1, ms: 6 },
      { kind: 'edit', icon: 'edit', verb: 'Edited', target: 'src/b.ts', add: 1, del: 1, ms: 4 },
      { kind: 'edit', icon: 'edit', verb: 'Edited', target: 'src/c.ts', add: 1, del: 1, ms: 5 },
    ],
    answer,
    diff: [
      { file: 'src/a.ts', add: 1, del: 1, lines: [[' ', 1, 'export function add(a: number, b: number): number {'], ['-', 2, '  return a + b;'], ['+', 2, '  return b + a;'], [' ', 3, '}']] },
      { file: 'src/b.ts', add: 1, del: 1, lines: [['-', 1, "export const greeting = 'hello there';"], ['+', 1, "export const greeting = 'hi';"]] },
      { file: 'src/c.ts', add: 1, del: 1, lines: [['-', 2, '  return n + n;'], ['+', 2, '  return n * 2;']] },
    ],
    usage: { model: 'qwen3.8-flash', seconds: 8.4, input: '3.1k', output: '412', cost: '$0.0007' },
  };

  const waiting = {
    prompt: 'Delete the build folder and run the tests again.',
    text: 'Removing the build output first, then the tests.',
    steps: [{ kind: 'bash', icon: 'terminal', verb: 'Run', target: 'rm -rf build', status: 'waiting' }],
    permission: { command: 'rm -rf build', reason: 'g-code asks because rm -rf deletes a folder inside the workspace.' },
  };

  const state = window.PROTO_STATE ?? 'full';
  window.T = {
    state,
    model: 'qwen3.8-flash',
    context: ['a.ts', 'AGENTS.md'],
    turns: state === 'empty' ? [] : state === 'streaming' ? [{ ...finished, streaming: true, diff: [], usage: undefined }] : [finished, ...(state === 'permission' ? [waiting] : [])],
    suggestions: ['Explain what this file does', 'Find where tool calls are rendered', 'Write a test for the diff card'],
    live: state === 'permission' || state === 'streaming',
  };

  window.icon = (name, cls = '') => `<i class="codicon codicon-${name} ${cls}"></i>`;
  window.dino = (name) => window.DINOS[name];
  /** Scrolls `el` to its end once layout settles, for the states that show a live tail. */
  window.settle = (el) => {
    if (state === 'permission' || state === 'streaming') requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
  };
})();
