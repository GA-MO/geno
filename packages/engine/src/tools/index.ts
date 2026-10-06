import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ApprovalRecord, EditorAction, FileChange, ImageAttachment, TodoList, ToolName, ToolStatus, WidgetRef } from '@g-code/core';
import { ToolDenied, ToolError, type Executor, type ToolContext } from './context.js';
import { glob } from './glob.js';
import { grep } from './grep.js';
import { list } from './list.js';
import { read } from './read.js';

export { ToolDenied, ToolError, type Executor, type ToolContext, type ToolReply } from './context.js';

export type Executors = Readonly<Record<string, Executor>>;

export const EXECUTORS: Readonly<Record<ToolName, Executor>> = { glob, grep, list, read };

export type ToolRun = {
  readonly status: ToolStatus;
  readonly text: string;
  readonly change?: FileChange | undefined;
  readonly approval?: ApprovalRecord | undefined;
  readonly images?: readonly ImageAttachment[] | undefined;
  readonly widget?: WidgetRef | undefined;
  readonly editorAction?: EditorAction | undefined;
  readonly todo?: TodoList | undefined;
  readonly loaded?: readonly string[] | undefined;
};

const isFsError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';

export const describeCall = (use: ToolUseBlock, executors: Executors): string =>
  Object.hasOwn(executors, use.name) ? executors[use.name]!.describe(use.input) : `${use.name} ${JSON.stringify(use.input)}`;

/** Runs one tool use. Anything the model got wrong comes back as an `error` result for it to read. */
export async function runTool(use: ToolUseBlock, ctx: ToolContext, executors: Executors): Promise<ToolRun> {
  if (!Object.hasOwn(executors, use.name)) {
    return { status: 'error', text: `unknown tool ${use.name}; the tools are ${Object.keys(executors).sort().join(', ')}` };
  }
  try {
    const reply = await executors[use.name]!.run(use.input, ctx);
    return typeof reply === 'string' ? { status: 'ok', text: reply } : { status: 'ok', ...reply };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    if (error instanceof ToolDenied) return { status: 'denied', text: error.message, approval: error.approval };
    if (error instanceof ToolError) return { status: 'error', text: error.message };
    if (isFsError(error)) return { status: 'error', text: `${use.name} failed: ${error.message}` };
    throw error;
  }
}
