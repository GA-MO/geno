import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { describe, expect, it } from 'vitest';
import { baseOf, type BaseRead } from '@g-code/core';
import { DISK_FILES } from '../src/files.js';
import { notebookEditExecutor } from '../src/tools/agent.js';
import { runTool, type ToolContext, type ToolRun } from '../src/tools/index.js';
import { parseNotebook } from '../src/tools/notebook.js';
import { rgCommand } from './helpers.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'notebooks');
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');
const CASES = JSON.parse(fixture('cases.json')) as { readonly newId: string; readonly inputs: Readonly<Record<string, Readonly<Record<string, unknown>>>> };
const VERSIONS = ['v4.4', 'v4.5'] as const;

const validators = new AjvJsonSchemaValidator();
const schemaOf = (version: string) => {
  const { $schema: _draft, ...schema } = JSON.parse(fixture(`nbformat.${version}.schema.json`)) as Record<string, unknown>;
  return validators.getValidator(schema);
};
const SCHEMAS = { 'v4.4': schemaOf('v4.4'), 'v4.5': schemaOf('v4.5') };

/** A workspace holding `notebook` as n.ipynb, and a notebook_edit that has seen it read unless `read` is false. */
async function workspaceWith(notebook: string, read = true) {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-notebook-')));
  const file = path.join(workspace, 'n.ipynb');
  await writeFile(file, notebook);
  const reads = new Map<string, BaseRead>(read ? [[file, baseOf(notebook, null)]] : []);
  const ctx: ToolContext = {
    workspace,
    spillDir: path.join(workspace, '.spill'),
    spillChars: 24_000,
    attachmentsDir: path.join(workspace, '.spill', 'attachments'),
    readRoots: [],
    credentialPlaces: [],
    rg: rgCommand(),
    signal: new AbortController().signal,
    files: DISK_FILES,
    events: () => [],
    earlierCalls: async () => {},
  };
  const executors = { notebook_edit: notebookEditExecutor(reads, () => CASES.newId) };
  let id = 0;
  const edit = (input: Readonly<Record<string, unknown>>): Promise<ToolRun> =>
    runTool({ type: 'tool_use', id: `tu_${id++}`, name: 'notebook_edit', input: { notebook_path: 'n.ipynb', ...input }, caller: { type: 'direct' } } as ToolUseBlock, ctx, executors);
  return { edit, text: () => readFile(file, 'utf8'), file, reads };
}

describe('notebook_edit round trips', () => {
  it('the schemas turn away what nbformat does: a cell id before 4.5, none from 4.5, and outputs on markdown', () => {
    const v44 = JSON.parse(fixture('v4.4.ipynb')) as { cells: Record<string, unknown>[] };
    v44.cells[0]!['id'] = 'intro';
    expect(SCHEMAS['v4.4'](v44).valid).toBe(false);
    const v45 = JSON.parse(fixture('v4.5.ipynb')) as { cells: Record<string, unknown>[] };
    delete v45.cells[2]!['id'];
    expect(SCHEMAS['v4.5'](v45).valid).toBe(false);
    const outputs = JSON.parse(fixture('v4.5.ipynb')) as { cells: Record<string, unknown>[] };
    outputs.cells[0]!['outputs'] = [];
    expect(SCHEMAS['v4.5'](outputs).valid).toBe(false);
  });

  for (const version of VERSIONS) {
    it(`${version}: the fixture is a valid notebook of its version`, () => {
      expect(SCHEMAS[version](JSON.parse(fixture(`${version}.ipynb`)))).toMatchObject({ valid: true });
    });

    for (const [name, input] of Object.entries(CASES.inputs).filter(([key]) => key.startsWith(`${version}.`))) {
      it(`${name}: writes the expected bytes, which nbformat's schema accepts`, async () => {
        const { edit, text } = await workspaceWith(fixture(`${version}.ipynb`));
        const run = await edit(input);
        expect(run.status, run.text).toBe('ok');
        const written = await text();
        expect(written).toBe(fixture(`${name}.ipynb`));
        expect(SCHEMAS[version](JSON.parse(written)), 'valid nbformat').toMatchObject({ valid: true });
      });
    }
  }

  it('keeps every byte outside the edited cell of a notebook nbformat did not write', async () => {
    const before = '{\n  "nbformat": 4,\n  "nbformat_minor": 5,\n  "metadata": {"ratio": 1.0, "name": "caf\\u00e9"},\n  "cells": [\n    {"cell_type": "markdown", "id": "a", "metadata": {}, "source": "# A"},\n    {\n      "cell_type": "code",\n      "id": "b",\n      "source": "old()",\n      "metadata": {"w": 2.50},\n      "outputs": [{"output_type": "stream", "name": "stdout", "text": "x"}],\n      "execution_count": 7\n    }\n  ]\n}';
    const { edit, text } = await workspaceWith(before);
    expect((await edit({ cell_id: 'b', new_source: 'new()\nnew()' })).status).toBe('ok');
    expect(await text()).toBe(
      '{\n  "nbformat": 4,\n  "nbformat_minor": 5,\n  "metadata": {"ratio": 1.0, "name": "caf\\u00e9"},\n  "cells": [\n    {"cell_type": "markdown", "id": "a", "metadata": {}, "source": "# A"},\n    {\n      "cell_type": "code",\n      "id": "b",\n      "source": "new()\\nnew()",\n      "metadata": {\n        "w": 2.5\n      },\n      "outputs": [],\n      "execution_count": null\n    }\n  ]\n}',
    );
  });

  it('deletes the only cell to an empty list, and inserts into an empty list', async () => {
    const one = '{\n "cells": [\n  {\n   "cell_type": "markdown",\n   "metadata": {},\n   "source": []\n  }\n ],\n "metadata": {},\n "nbformat": 4,\n "nbformat_minor": 4\n}\n';
    const { edit, text } = await workspaceWith(one);
    expect((await edit({ edit_mode: 'delete', cell_id: 'cell-0', new_source: '' })).status).toBe('ok');
    expect(await text()).toBe('{\n "cells": [],\n "metadata": {},\n "nbformat": 4,\n "nbformat_minor": 4\n}\n');
    expect((await edit({ edit_mode: 'insert', cell_type: 'markdown', new_source: '' })).status).toBe('ok');
    expect(await text()).toBe(one);
  });
});

describe('notebook_edit refusals', () => {
  const notebook = fixture('v4.5.ipynb');

  it('refuses a notebook not read in this session, and changes nothing', async () => {
    const { edit, text } = await workspaceWith(notebook, false);
    expect(await edit({ cell_id: 'plot', new_source: 'x' })).toEqual({ status: 'error', text: 'read n.ipynb before editing it' });
    expect(await text()).toBe(notebook);
  });

  it('refuses a notebook that changed since the read, and edits it after another read', async () => {
    const { edit, text, file, reads } = await workspaceWith(notebook);
    const changed = notebook.replace('plot(rows)', 'plot(rows, kind=\\"bar\\")');
    await writeFile(file, changed);
    expect(await edit({ cell_id: 'plot', new_source: 'x' })).toEqual({ status: 'error', text: 'n.ipynb changed since it was last read; read it again before editing' });
    expect(await text()).toBe(changed);
    reads.set(file, baseOf(changed, null));
    expect((await edit({ cell_id: 'plot', new_source: 'x' })).status).toBe('ok');
  });

  it('a second edit needs no read in between, since the first leaves the file as the model knows it', async () => {
    const { edit } = await workspaceWith(notebook);
    expect((await edit({ cell_id: 'plot', new_source: 'x' })).status).toBe('ok');
    expect((await edit({ cell_id: 'intro', new_source: 'y' })).status).toBe('ok');
  });

  it('names the cell ids when cell_id matches none, and needs cell_type to insert', async () => {
    const { edit, text } = await workspaceWith(notebook);
    expect(await edit({ cell_id: 'nope', new_source: 'x' })).toEqual({ status: 'error', text: 'n.ipynb has no cell with id nope; its cells are intro, load-data, plot' });
    expect(await edit({ edit_mode: 'insert', new_source: 'x' })).toMatchObject({ status: 'error', text: expect.stringMatching(/cell_type is required/) });
    expect(await edit({ new_source: 'x' })).toMatchObject({ status: 'error', text: expect.stringMatching(/cell_id is required/) });
    expect(await text()).toBe(notebook);
  });

  it('turns away a file that is not a notebook of nbformat 4', async () => {
    const old = await workspaceWith('{"nbformat": 3, "nbformat_minor": 0, "cells": [], "metadata": {}}');
    expect(await old.edit({ edit_mode: 'insert', cell_type: 'code', new_source: 'x' })).toMatchObject({ status: 'error', text: expect.stringMatching(/nbformat 3/) });
    const { edit } = await workspaceWith(notebook);
    expect(await edit({ notebook_path: 'a.py', cell_id: 'plot', new_source: 'x' })).toMatchObject({ status: 'error', text: expect.stringMatching(/a\.py is not one, so use edit/) });
  });

  it('says what it did, with the id of a new cell and the shift of ids by place', async () => {
    expect((await (await workspaceWith(notebook)).edit({ edit_mode: 'insert', cell_id: 'intro', cell_type: 'code', new_source: 'x' })).text).toMatch(/^Inserted a code cell with id a1b2c3d4 in n\.ipynb, cell 2 of 4\./);
    const idless = await workspaceWith(fixture('v4.4.ipynb'));
    expect((await idless.edit({ edit_mode: 'delete', cell_id: 'cell-0', new_source: '' })).text).toMatch(/^Deleted cell cell-0 from n\.ipynb, which has 2 cells now\. Its cells have no ids/);
  });
});

describe('read of a notebook', () => {
  it('shows each cell with the id notebook_edit takes: its own, or cell-N by place', () => {
    expect(parseNotebook(fixture('v4.5.ipynb')).cells.map((cell) => cell.heading)).toEqual(['cell 1 of 3, id intro: markdown', 'cell 2 of 3, id load-data: code [3]', 'cell 3 of 3, id plot: code']);
    expect(parseNotebook(fixture('v4.4.ipynb')).cells.map((cell) => cell.heading)).toEqual(['cell 1 of 3, id cell-0: markdown', 'cell 2 of 3, id cell-1: code [3]', 'cell 3 of 3, id cell-2: code']);
  });
});
