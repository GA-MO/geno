import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { asSessionId, ruleAttachment, type LoadedContext, type TurnEvent } from '@g-code/core';
import { DISK_FILES } from '../src/files.js';
import type { ToolContext } from '../src/tools/context.js';
import { EXECUTORS } from '../src/tools/index.js';
import { ruleAttacher, withRuleAttachments } from '../src/tools/rules.js';
import { settle } from '../src/tools/spill.js';
import { rgCommand } from './helpers.js';

let ctx: ToolContext;

const context: LoadedContext = {
  instructions: [],
  rules: [
    { path: '.cursor/rules/react.mdc', trigger: { kind: 'globs', globs: ['*.tsx'] }, text: 'Function components only.' },
    { path: '.cursor/rules/big.mdc', trigger: { kind: 'globs', globs: ['big/**'] }, text: 'r'.repeat(10_000) },
  ],
  skills: [],
};
const start: TurnEvent = {
  kind: 'session-start',
  session: { id: asSessionId('s'), createdAt: '2026-10-05T00:00:00.000Z', workspace: '/ws', provider: 'modelstudio', model: 'm', effort: 'medium' },
  context,
};
const at = '2026-10-05T00:00:01.000Z';

beforeAll(async () => {
  const ws = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-rules-')));
  await mkdir(path.join(ws, 'src'));
  await mkdir(path.join(ws, 'big'));
  await writeFile(path.join(ws, 'src', 'App.tsx'), 'export const App = () => null;\n');
  await writeFile(path.join(ws, 'src', 'b.tsx'), 'export const B = 1;\n');
  await writeFile(path.join(ws, 'src', 'plain.ts'), 'export const plain = 1;\n');
  await mkdir(path.join(ws, 'src', 'ui'));
  await writeFile(path.join(ws, 'src', 'ui', 'Button.tsx'), 'export const Button = 1;\n');
  await writeFile(path.join(ws, 'big', 'long.txt'), `${'x'.repeat(100)}\n`.repeat(3000));
  ctx = { workspace: ws, spillDir: path.join(ws, '..', 'spill'), readRoots: [], credentialPlaces: [], attachmentsDir: path.join(ws, '..', 'spill', 'attachments'), rg: rgCommand(), signal: new AbortController().signal, files: DISK_FILES, events: () => [], earlierCalls: async () => {}, spillChars: 24_000 };
});

describe('glob rules on read', () => {
  it('attaches a matching rule to the first read of a matching file only', async () => {
    const read = withRuleAttachments(EXECUTORS.read, ruleAttacher([start]));
    const first = await read.run({ path: 'src/App.tsx' }, ctx);
    expect(first).toBe(`1\texport const App = () => null;\n\n${ruleAttachment(context.rules[0]!, 'src/App.tsx')}`);
    expect(await read.run({ path: 'src/b.tsx' }, ctx)).toBe('1\texport const B = 1;');
    expect(await read.run({ path: 'src/plain.ts' }, ctx)).toBe('1\texport const plain = 1;');
  });

  it('attaches the nested files of every directory above the file, outer first and before the glob rules, a file two of them import once', async () => {
    const nested: LoadedContext = {
      ...context,
      nested: [
        { path: 'src/AGENTS.md', text: 'Source.', dir: 'src' },
        { path: 'docs/style.md', text: 'Style.', importedFrom: 'src/AGENTS.md', dir: 'src' },
        { path: 'src/ui/AGENTS.md', text: 'UI.', dir: 'src/ui' },
        { path: 'docs/style.md', text: 'Style.', importedFrom: 'src/ui/AGENTS.md', dir: 'src/ui' },
      ],
    };
    const read = withRuleAttachments(EXECUTORS.read, ruleAttacher([{ ...start, context: nested } as TurnEvent]));
    const attached = [nested.nested![0]!, nested.nested![1]!, nested.nested![2]!, context.rules[0]!].map((rule) => ruleAttachment(rule, 'src/ui/Button.tsx'));
    expect(await read.run({ path: 'src/ui/Button.tsx' }, ctx)).toBe(['1\texport const Button = 1;', ...attached].join('\n\n'));
    expect(await read.run({ path: 'src/App.tsx' }, ctx)).toBe('1\texport const App = () => null;');
  });

  it('does not attach again in a resumed session that already attached it', async () => {
    const earlier: TurnEvent = {
      kind: 'tool-result',
      seq: 3,
      at,
      toolUseId: 'tu_1',
      name: 'read',
      status: 'ok',
      output: `1\tx\n\n${ruleAttachment(context.rules[0]!, 'src/App.tsx')}`,
    };
    const read = withRuleAttachments(EXECUTORS.read, ruleAttacher([start, earlier]));
    expect(await read.run({ path: 'src/b.tsx' }, ctx)).toBe('1\texport const B = 1;');
  });

  it('pages a long file, and names a rule too long to ride along instead of spilling the page', async () => {
    const read = withRuleAttachments(EXECUTORS.read, ruleAttacher([start]));
    const page = (await read.run({ path: 'big/long.txt' }, ctx)) as string;
    expect(page).toContain('read again with start_line=');
    expect(page.endsWith('<project_rule path=".cursor/rules/big.mdc" matched="big/long.txt">\nThis rule applies to big/long.txt. Read .cursor/rules/big.mdc for it.\n</project_rule>')).toBe(true);
    expect(await settle(page, path.join(ctx.spillDir, 'never.txt'), ctx.spillChars)).toEqual({ output: page });
  });
});
