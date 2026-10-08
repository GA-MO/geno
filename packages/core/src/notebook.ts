import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

export const NOTEBOOK_EDIT_TOOL = 'notebook_edit';

export const CELL_TYPES = ['code', 'markdown'] as const;
export type CellType = (typeof CELL_TYPES)[number];

export const CELL_EDIT_MODES = ['replace', 'insert', 'delete'] as const;
export type CellEditMode = (typeof CELL_EDIT_MODES)[number];

/** Claude Code's NotebookEdit, with its field names, so a model trained on it calls this the same way. */
export const NOTEBOOK_EDIT_TOOL_DEFINITION: Tool = {
  name: NOTEBOOK_EDIT_TOOL,
  description: `Replace, insert or delete one cell of a Jupyter notebook (.ipynb). Use it instead of edit on a notebook's JSON, which can break the notebook. Read the notebook first in this session; one that changed since your read is refused until you read it again. cell_id is the id read shows in each cell's heading; a cell with no id in the file shows as cell-0, cell-1 and so on, counted from 0. edit_mode defaults to replace, which sets the cell's source and, with cell_type, its type. insert adds a cell after the cell with cell_id, or at the start when cell_id is left out, and needs cell_type. delete removes the cell and ignores new_source. An edited code cell loses its outputs and execution count. The rest of the file keeps its bytes.`,
  input_schema: {
    type: 'object',
    properties: {
      notebook_path: { type: 'string', description: 'The notebook to edit, relative to the workspace root or absolute.' },
      cell_id: {
        type: 'string',
        description: 'The id of the cell to edit, as read shows it. When inserting, the new cell goes after this cell, or at the start when it is left out.',
      },
      new_source: { type: 'string', description: 'The new source of the cell.' },
      cell_type: {
        type: 'string',
        enum: [...CELL_TYPES],
        description: "The cell's type. Defaults to the cell's current type; required with edit_mode insert.",
      },
      edit_mode: { type: 'string', enum: [...CELL_EDIT_MODES], description: 'replace, insert or delete. Defaults to replace.' },
    },
    required: ['notebook_path', 'new_source'],
    additionalProperties: false,
  },
};
