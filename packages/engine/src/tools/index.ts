import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { toolText, type ApprovalRecord, type ChapterMark, type EditorAction, type FileChange, type FileStamp, type ImageAttachment, type SpinoffNote, type TodoList, type ToolName, type ToolStatus, type WidgetRef } from '@g-code/core';
import { ToolDenied, ToolError, ToolRejected, type Executor, type ToolContext } from './context.js';
import { glob } from './glob.js';
import { grep } from './grep.js';
import { list } from './list.js';
import { read } from './read.js';

export { PermissionRerun, ToolDenied, ToolError, ToolRejected, type PermissionAsk, type Executor, type ToolContext, type ToolReply } from './context.js';

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
  readonly spinoff?: SpinoffNote | undefined;
  readonly chapter?: ChapterMark | undefined;
  readonly file?: FileStamp | undefined;
};

const isFsError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';

export const describeCall = (use: ToolUseBlock, executors: Executors): string =>
  Object.hasOwn(executors, use.name) ? executors[use.name]!.describe(use.input) : `${use.name} ${JSON.stringify(use.input)}`;

/**
 * Runs one tool use. Anything the model got wrong comes back as an `error` result for it to read. Hidden characters in
 * the text are shown or stripped, by the tool (`toolText`).
 */
export async function runTool(use: ToolUseBlock, ctx: ToolContext, executors: Executors): Promise<ToolRun> {
  const run = await runExecutor(use, ctx, executors);
  return { ...run, text: toolText(use.name, run.text) };
}

/** Writing tools other harnesses have; models trained on those harnesses call them here. */
const WRITE_TOOL_NAMES = new Set(['create', 'write', 'create_file', 'write_file', 'Write']);

function unknownTool(name: string, executors: Executors): string {
  const tools = Object.keys(executors).sort().join(', ');
  return WRITE_TOOL_NAMES.has(name) && Object.hasOwn(executors, 'edit')
    ? `unknown tool ${name}; to create or overwrite a file, call edit with create: true and the whole content as new_str. The tools are ${tools}`
    : `unknown tool ${name}; the tools are ${tools}`;
}

async function runExecutor(use: ToolUseBlock, ctx: ToolContext, executors: Executors): Promise<ToolRun> {
  if (!Object.hasOwn(executors, use.name)) return { status: 'error', text: unknownTool(use.name, executors) };
  try {
    const reply = await executors[use.name]!.run(use.input, ctx);
    return typeof reply === 'string' ? { status: 'ok', text: reply } : { status: 'ok', ...reply };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    if (error instanceof ToolRejected) return { status: 'rejected', text: error.message, approval: error.approval };
    if (error instanceof ToolDenied) return { status: 'denied', text: error.message, approval: error.approval };
    if (error instanceof ToolError) return { status: 'error', text: error.message };
    if (isFsError(error)) return { status: 'error', text: `${use.name} failed: ${error.message}` };
    throw error;
  }
}
