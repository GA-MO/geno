import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ApprovalRecord, ChildNote, EditorAction, FileChange, ImageAttachment, SpinoffNote, TodoList, TurnEvent, WakeArrival, WidgetRef } from '@g-code/core';
import type { Files } from '../files.js';
import { isMissing } from '../store.js';

export type ToolContext = {
  /** Real path of the workspace root. */
  readonly workspace: string;
  /** This session's spill directory, readable though outside the workspace. */
  readonly spillDir: string;
  /** Real paths of other roots the read tools may see but nothing may change, such as installed plugins. */
  readonly readRoots: readonly string[];
  /** This session's attachments folder, where an image a tool returns is stored by its hash. */
  readonly attachmentsDir: string;
  readonly rg: string;
  readonly signal: AbortSignal;
  /** Where read and edit get file text, and the unsaved buffers grep and glob search. list sees only the disk. */
  readonly files: Files;
  /** The session so far, read when a tool needs the conversation, such as the request a command serves. */
  readonly events: () => readonly TurnEvent[];
  /**
   * Settles once every earlier call of this tool's batch has finished. A tool that ran beside others awaits it before
   * it touches state they share, so that state changes in the turn's order.
   */
  readonly earlierCalls: () => Promise<void>;
  /** The model's id for the call being run; absent outside a run. */
  readonly toolUseId?: string | undefined;
  /** Logs a subagent starting or ending, or a wake-up being scheduled, in this session's log; absent outside a run. */
  readonly logNote?: ((note: ChildNote | WakeArrival) => Promise<void>) | undefined;
};

/** A failure the model caused or can work around. It becomes an `error` tool result, never a crash. */
export class ToolError extends Error {}

/** A command that was refused before it ran. It becomes a `denied` tool result. */
export class ToolDenied extends ToolError {
  constructor(
    message: string,
    readonly approval: ApprovalRecord,
  ) {
    super(message);
  }
}

/** What a tool tells the model, the file edit it made, how its command was approved, and images, a widget an editor action or a todo list it returns, if any. */
export type ToolReply =
  | string
  | {
      readonly text: string;
      readonly change?: FileChange | undefined;
      readonly approval?: ApprovalRecord | undefined;
      readonly images?: readonly ImageAttachment[] | undefined;
      readonly widget?: WidgetRef | undefined;
      readonly editorAction?: EditorAction | undefined;
      readonly todo?: TodoList | undefined;
      /** The deferred tools a tool_search call loaded. */
      readonly loaded?: readonly string[] | undefined;
      readonly spinoff?: SpinoffNote | undefined;
    };

/** A tool's executor, typed on its parsed input. */
export type ToolDef<I> = {
  readonly input: z.ZodType<I>;
  /** Whether a call may run beside others of its turn: it changes nothing and asks nobody. Absent means never. */
  readonly concurrent?: (input: I) => boolean;
  /** The one-line form printed when the model calls the tool. */
  describe(input: I): string;
  run(input: I, ctx: ToolContext): Promise<ToolReply>;
};

/** An executor that takes the model's raw input. */
export type Executor = {
  readonly input: z.ZodType;
  readonly concurrent?: (raw: unknown) => boolean;
  describe(raw: unknown): string;
  run(raw: unknown, ctx: ToolContext): Promise<ToolReply>;
};

export function executor<I>(def: ToolDef<I>): Executor {
  return {
    input: def.input,
    ...(def.concurrent === undefined
      ? {}
      : {
          concurrent: (raw: unknown) => {
            const parsed = def.input.safeParse(raw);
            return parsed.success && def.concurrent!(parsed.data);
          },
        }),
    describe(raw) {
      const parsed = def.input.safeParse(raw);
      return parsed.success ? def.describe(parsed.data) : JSON.stringify(raw);
    },
    async run(raw, ctx) {
      const parsed = def.input.safeParse(raw);
      if (!parsed.success) throw new ToolError(`invalid input: ${z.prettifyError(parsed.error)}`);
      return def.run(parsed.data, ctx);
    },
  };
}

const within = (root: string, target: string): boolean =>
  target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

async function realOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** The real path of `raw` (relative to the workspace, or absolute), rejected unless it is inside a readable root. */
export async function resolveInside(ctx: ToolContext, raw: string): Promise<string> {
  const target = path.resolve(ctx.workspace, raw);
  const outside = new ToolError(`${raw} is outside the workspace`);
  // realpath follows every symlink, so a link that points out of the workspace is caught here.
  const real = await realOrUndefined(target);
  if (real === undefined) {
    if ([ctx.workspace, ctx.spillDir, ...ctx.readRoots].some((root) => within(root, target))) {
      throw new ToolError(`no such file or directory: ${raw}`);
    }
    throw outside;
  }
  const spillRoot = await realOrUndefined(ctx.spillDir);
  const roots = [ctx.workspace, ...(spillRoot === undefined ? [] : [spillRoot]), ...ctx.readRoots];
  if (roots.some((root) => within(root, real))) return real;
  throw outside;
}

/** The real path to write for `raw`, which may not exist yet; rejected unless it lands inside the workspace. */
export async function resolveWritable(ctx: ToolContext, raw: string): Promise<string> {
  const target = path.resolve(ctx.workspace, raw);
  const outside = new ToolError(`${raw} is outside the workspace`);
  if (!within(ctx.workspace, target)) throw outside;
  let existing = target;
  let real: string | undefined;
  while ((real = await realOrUndefined(existing)) === undefined) existing = path.dirname(existing);
  const resolved = path.join(real, path.relative(existing, target));
  if (!within(ctx.workspace, resolved)) throw outside;
  return resolved;
}

/** How a path inside the workspace is shown to the model. Spill files keep their absolute path. */
export function displayPath(ctx: ToolContext, real: string): string {
  const relative = path.relative(ctx.workspace, real);
  if (relative === '') return '.';
  return relative === '..' || relative.startsWith(`..${path.sep}`) ? real : relative;
}

/** For a tool that only reads, so may always run beside others. */
export const ALWAYS = (): boolean => true;

export const optional = <T extends z.ZodType>(schema: T) =>
  // A model may send null for an argument it means to leave out.
  schema.nullish().transform((value) => value ?? undefined);
