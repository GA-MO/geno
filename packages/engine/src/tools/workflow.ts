import { z } from 'zod';
import { parseWorkflowInput, STOP_AND_WAIT, WORKFLOW_TOOL, type WorkflowPreview } from '@g-code/core';
import { executor, ToolError, ToolRejected, type Executor } from './context.js';

/** The session's workflows, and the user's yes to a run's preview, which no mode or classifier gives. */
export type WorkflowTools = {
  readonly list: () => Promise<string>;
  /** The run the user confirms, read once; throws a ToolError naming why the workflow cannot run here. */
  readonly prepare: (name: string, input: string) => Promise<PreparedWorkflow>;
  readonly approve: (preview: WorkflowPreview, signal: AbortSignal) => Promise<boolean>;
};

/** Exactly what the preview showed, so a file changed while the card waits does not change what runs. */
export type PreparedWorkflow = {
  readonly preview: WorkflowPreview;
  /** Starts the run in the background; its report reaches this session when it ends. */
  readonly start: (toolUseId: string) => Promise<{ readonly sessionId: string }>;
};

const DECLINED = `The user did not run the workflow. Nothing ran. ${STOP_AND_WAIT}`;

export function workflowExecutor(tools: WorkflowTools): Executor {
  const input = z.unknown().transform((raw, ctx) => {
    const parsed = parseWorkflowInput(raw);
    if (parsed.ok) return parsed.value;
    ctx.addIssue({ code: 'custom', message: parsed.problem });
    return z.NEVER;
  });
  return executor({
    input,
    describe: ({ name, input: text }) => (name === undefined ? `${WORKFLOW_TOOL} list` : `${WORKFLOW_TOOL} ${name}${text === '' ? '' : `: ${text.split('\n')[0]}`}`),
    async run({ name, input: text }, ctx) {
      if (name === undefined) return tools.list();
      if (ctx.toolUseId === undefined) throw new ToolError('a workflow starts only inside an agent run');
      const prepared = await tools.prepare(name, text);
      if (!(await tools.approve(prepared.preview, ctx.signal))) throw new ToolRejected(DECLINED);
      const { sessionId } = await prepared.start(ctx.toolUseId);
      return `Started workflow ${name} in the background as session ${sessionId}. The user follows it in Tasks. Its report arrives as a message when it ends; until then, do not start it again or redo its steps.`;
    },
  });
}
