import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { isToolName, TOOL_NAMES, type ToolName, type ToolStatus } from '@g-code/core';
import { ToolError, type Executor, type ToolContext } from './context.js';
import { glob } from './glob.js';
import { grep } from './grep.js';
import { list } from './list.js';
import { read } from './read.js';

export { ToolError, type ToolContext } from './context.js';

export const EXECUTORS: Readonly<Record<ToolName, Executor>> = { glob, grep, list, read };

export type ToolRun = { readonly status: ToolStatus; readonly text: string };

const isFsError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';

export const describeCall = (use: ToolUseBlock): string =>
  isToolName(use.name) ? EXECUTORS[use.name].describe(use.input) : `${use.name} ${JSON.stringify(use.input)}`;

/** Runs one tool use. Anything the model got wrong comes back as an `error` result for it to read. */
export async function runTool(use: ToolUseBlock, ctx: ToolContext): Promise<ToolRun> {
  if (!isToolName(use.name)) {
    return { status: 'error', text: `unknown tool ${use.name}; the tools are ${TOOL_NAMES.join(', ')}` };
  }
  try {
    return { status: 'ok', text: await EXECUTORS[use.name].run(use.input, ctx) };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    if (error instanceof ToolError) return { status: 'error', text: error.message };
    if (isFsError(error)) return { status: 'error', text: `${use.name} failed: ${error.message}` };
    throw error;
  }
}
