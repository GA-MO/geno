import { describe, expect, it } from 'vitest';
import { checkBoundaries, checkRepo, type Edge } from './boundaries.js';
import { BOUNDARIES } from './boundaries.rules.js';

const value = (from: string, to: string): Edge => ({ from, to, typeOnly: false });
const type = (from: string, to: string): Edge => ({ from, to, typeOnly: true });
const rulesHit = (edges: readonly Edge[]): string[] => checkBoundaries(edges).map((violation) => violation.rule);

describe('boundaries', () => {
  it('finds no crossing in the repo', () => {
    expect(checkRepo().map(({ rule, message }) => `${rule}: ${message}`)).toEqual([]);
  });

  it('reads the webview entries from the extension build', () => {
    expect(BOUNDARIES.bundles[0]?.entries).toEqual([
      'packages/extension/src/chat/webview.ts',
      'packages/extension/src/chat/diagram-tab-view.ts',
      'packages/extension/src/chat/widget-tab-view.ts',
      'packages/extension/src/chat/diagram-render.ts',
    ]);
  });

  it('keeps core off the engine, the extension and Node I/O', () => {
    expect(rulesHit([value('packages/core/src/a.ts', 'packages/engine/src/store.ts')])).toEqual(['core-is-pure']);
    expect(rulesHit([type('packages/core/src/a.ts', 'packages/extension/src/chat/chat.ts')])).toEqual(['core-is-pure']);
    expect(rulesHit([value('packages/core/src/a.ts', 'node:fs')])).toEqual(['core-is-pure']);
    expect(rulesHit([value('packages/core/src/a.ts', 'child_process')])).toEqual(['core-is-pure']);
    expect(rulesHit([value('packages/core/src/a.ts', 'node:path'), value('packages/core/src/a.ts', 'node:crypto')])).toEqual([]);
  });

  it('allows a listed exception and no other import like it', () => {
    expect(rulesHit([value('packages/core/src/browser.ts', 'node:url')])).toEqual([]);
    expect(rulesHit([value('packages/core/src/page.ts', 'node:url')])).toEqual(['core-is-pure']);
  });

  it('keeps the engine off the extension', () => {
    expect(rulesHit([value('packages/engine/src/serve.ts', 'packages/extension/src/runtime.ts')])).toEqual(['engine-without-extension']);
  });

  it('lets MCP reach the engine only through its listed modules', () => {
    expect(rulesHit([value('packages/engine/src/mcp/hub.ts', 'packages/engine/src/serve.ts')])).toEqual(['mcp-gate']);
    expect(rulesHit([type('packages/engine/src/mcp/hub.ts', 'packages/engine/src/tools/bash.ts')])).toEqual(['mcp-gate']);
    expect(
      rulesHit([
        value('packages/engine/src/mcp/hub.ts', 'packages/engine/src/store.ts'),
        value('packages/engine/src/mcp/hub.ts', 'packages/engine/src/mcp/server.ts'),
        value('packages/engine/src/mcp/hub.ts', '@g-code/core'),
      ]),
    ).toEqual([]);
  });

  it('keeps vscode and Node out of every file the webview bundles reach', () => {
    const entry = 'packages/extension/src/chat/webview.ts';
    expect(rulesHit([value(entry, 'vscode')])).toEqual(['webview-in-browser']);
    expect(rulesHit([value(entry, 'packages/extension/src/chat/render.ts'), value('packages/extension/src/chat/render.ts', 'node:path')])).toEqual([
      'webview-in-browser',
    ]);
    expect(rulesHit([type(entry, 'packages/extension/src/chat/page.ts'), value('packages/extension/src/chat/page.ts', 'vscode')])).toEqual([]);
    expect(rulesHit([value('packages/extension/src/chat/chat.ts', 'vscode')])).toEqual([]);
  });

  it('keeps elkjs out of every file the docs islands reach, so it stays in the build', () => {
    const island = 'packages/docs/src/components/SystemMapFlow.tsx';
    expect(BOUNDARIES.bundles[1]?.entries).toContain(island);
    expect(BOUNDARIES.bundles[1]?.entries).toContain('packages/docs/src/components/Story.tsx');
    expect(rulesHit([value(island, 'packages/docs/src/map/map.ts'), value('packages/docs/src/map/map.ts', 'elkjs/lib/elk.bundled.js')])).toEqual(['docs-islands-without-elk']);
    expect(rulesHit([value(island, 'elkjs')])).toEqual(['docs-islands-without-elk']);
    expect(rulesHit([type(island, 'packages/docs/src/map/map.ts'), value('packages/docs/src/map/map.ts', 'elkjs/lib/elk.bundled.js')])).toEqual([]);
    expect(rulesHit([value(island, 'packages/docs/src/map/hop.ts')])).toEqual([]);
  });

  it('keeps the docs off the packages whose sources they read as text', () => {
    expect(rulesHit([value('packages/docs/src/scenario/refs.ts', 'packages/engine/src/serve.ts')])).toEqual(['docs-read-sources-as-text']);
  });

  it('finds value import cycles inside a package, and no type-only ones', () => {
    const a = 'packages/engine/src/a.ts';
    const b = 'packages/engine/src/b.ts';
    expect(rulesHit([value(a, b), value(b, a)])).toEqual(['no-cycles']);
    expect(rulesHit([value(a, a)])).toEqual(['no-cycles']);
    expect(rulesHit([value(a, b), type(b, a)])).toEqual([]);
  });
});
