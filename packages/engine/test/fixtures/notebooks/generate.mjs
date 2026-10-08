// Writes the notebook fixtures and the files each cell edit must produce, the way nbformat writes a notebook: sorted
// keys, one space of indent, a trailing newline. It edits the parsed notebook and writes it whole, so it shares no code
// with notebook_edit, which rewrites only the edited cell's bytes. Run: node packages/engine/test/fixtures/notebooks/generate.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const NEW_ID = 'a1b2c3d4';

const sorted = (value) =>
  Array.isArray(value) ? value.map(sorted)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]))
  : value;
const nbformatText = (notebook) => `${JSON.stringify(sorted(notebook), null, 1)}\n`;
const lines = (source) => (source === '' ? [] : source.split(/(?<=\n)/));

function notebook(minor) {
  const id = (value) => (minor >= 5 ? { id: value } : {});
  return {
    cells: [
      { cell_type: 'markdown', ...id('intro'), metadata: { tags: ['title'] }, source: lines('# Sales\n\nTotals by région.') },
      {
        cell_type: 'code',
        ...id('load-data'),
        execution_count: 3,
        metadata: { scrolled: true },
        outputs: [
          { name: 'stdout', output_type: 'stream', text: lines('loaded 12 rows\n') },
          { data: { 'text/plain': ['42'] }, execution_count: 3, metadata: {}, output_type: 'execute_result' },
        ],
        source: lines('rows = load()\nprint(f"loaded {len(rows)} rows")\nlen(rows) * 3 + 6'),
      },
      { cell_type: 'code', ...id('plot'), execution_count: null, metadata: {}, outputs: [], source: lines('plot(rows)') },
    ],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { codemirror_mode: { name: 'ipython', version: 3 }, file_extension: '.py', mimetype: 'text/x-python', name: 'python', pygments_lexer: 'ipython3', version: '3.13.1' },
    },
    nbformat: 4,
    nbformat_minor: minor,
  };
}

const idOf = (nb, index) => nb.cells[index].id ?? `cell-${index}`;
const newCell = (nb, cellType, source) => ({
  cell_type: cellType,
  ...(nb.nbformat_minor >= 5 ? { id: NEW_ID } : {}),
  metadata: {},
  source: lines(source),
  ...(cellType === 'code' ? { execution_count: null, outputs: [] } : {}),
});
function retyped(cell, cellType, source) {
  const { outputs, execution_count, ...rest } = cell;
  return cellType === 'code' ? { ...rest, cell_type: cellType, source: lines(source), execution_count: null, outputs: [] } : { ...rest, cell_type: cellType, source: lines(source) };
}

/** Each case: the tool input besides notebook_path, and what it does to the parsed notebook. */
const CASES = {
  'replace-code': {
    input: (nb) => ({ cell_id: idOf(nb, 1), new_source: 'rows = load(limit=5)\nrows' }),
    apply: (nb) => nb.cells.splice(1, 1, retyped(nb.cells[1], 'code', 'rows = load(limit=5)\nrows')),
  },
  'replace-markdown': {
    input: (nb) => ({ cell_id: idOf(nb, 0), new_source: '# Sales by région\n' }),
    apply: (nb) => nb.cells.splice(0, 1, retyped(nb.cells[0], 'markdown', '# Sales by région\n')),
  },
  'insert-start': {
    input: () => ({ edit_mode: 'insert', cell_type: 'markdown', new_source: 'Run the cells in order.' }),
    apply: (nb) => nb.cells.splice(0, 0, newCell(nb, 'markdown', 'Run the cells in order.')),
  },
  'insert-middle': {
    input: (nb) => ({ edit_mode: 'insert', cell_id: idOf(nb, 0), cell_type: 'code', new_source: 'import pandas as pd\n' }),
    apply: (nb) => nb.cells.splice(1, 0, newCell(nb, 'code', 'import pandas as pd\n')),
  },
  'insert-end': {
    input: (nb) => ({ edit_mode: 'insert', cell_id: idOf(nb, 2), cell_type: 'code', new_source: '' }),
    apply: (nb) => nb.cells.splice(3, 0, newCell(nb, 'code', '')),
  },
  'delete-middle': {
    input: (nb) => ({ edit_mode: 'delete', cell_id: idOf(nb, 1), new_source: '' }),
    apply: (nb) => nb.cells.splice(1, 1),
  },
  'delete-last': {
    input: (nb) => ({ edit_mode: 'delete', cell_id: idOf(nb, 2), new_source: '' }),
    apply: (nb) => nb.cells.splice(2, 1),
  },
  'code-to-markdown': {
    input: (nb) => ({ cell_id: idOf(nb, 1), cell_type: 'markdown', new_source: 'Loading is done in `load`.' }),
    apply: (nb) => nb.cells.splice(1, 1, retyped(nb.cells[1], 'markdown', 'Loading is done in `load`.')),
  },
  'markdown-to-code': {
    input: (nb) => ({ cell_id: idOf(nb, 0), cell_type: 'code', new_source: 'TITLE = "Sales"' }),
    apply: (nb) => nb.cells.splice(0, 1, retyped(nb.cells[0], 'code', 'TITLE = "Sales"')),
  },
};

const VERSIONS = { 'v4.4': 4, 'v4.5': 5 };

const inputs = {};
for (const [version, minor] of Object.entries(VERSIONS)) {
  writeFileSync(path.join(here, `${version}.ipynb`), nbformatText(notebook(minor)));
  for (const [name, { input, apply }] of Object.entries(CASES)) {
    const nb = notebook(minor);
    inputs[`${version}.${name}`] = input(nb);
    apply(nb);
    writeFileSync(path.join(here, `${version}.${name}.ipynb`), nbformatText(nb));
  }
}
writeFileSync(path.join(here, 'cases.json'), `${JSON.stringify({ newId: NEW_ID, inputs }, null, 2)}\n`);
