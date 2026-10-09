import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { credentialPlaces, inCredentialPlace, isSecretPath, ruleHome, ruleText, type ApprovalRecord, type PathRule, type PathTool, type ChapterMark, type ShownFiles, type ChildNote, type Denial, type EditorAction, type PermissionHookAnswer, type FileChange, type FileStamp, type ImageAttachment, type SpinoffNote, type TodoList, type TurnEvent, type WakeArrival, type WidgetRef } from '@g-code/core';
import type { Files } from '../files.js';
import type { PermissionStore } from '../permissions.js';
import { isMissing } from '../store.js';

export type ToolContext = {
  /** Real path of the workspace root. */
  readonly workspace: string;
  /** This session's spill directory, readable though outside the workspace. */
  readonly spillDir: string;
  /** The session's model's spill limit: a longer result goes to the spill directory. */
  readonly spillChars: number;
  /** Real paths of other roots the read tools may see but nothing may change, such as installed plugins. */
  readonly readRoots: readonly string[];
  /**
   * The home's credential places (`credentialPlaces`), under the home as named and as its real path. The read tools take
   * them as credentials files wherever they are reached from, an added `~` included.
   */
  readonly credentialPlaces: readonly string[];
  /** Real paths beyond the workspace an edit may write: the directories the user added as writable. Absent is none. */
  readonly writeRoots?: readonly string[] | undefined;
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
  /**
   * A PreToolUse hook allowed the call, or the user said yes to a hook's question about it: a command's own question and
   * the classifier are answered, but not its refusals or what Geno always asks (`ruledDenial`).
   */
  readonly hookAllowed?: true | undefined;
  /** The user's PermissionRequest hooks for this call, asked where a card would show; absent when none would run. */
  readonly permissionRequest?: PermissionAsk | undefined;
  /** The workspace's path rule that governs a tool on an absolute path; absent when the workspace has none. */
  readonly pathRule?: ((tool: PathTool, file: string) => PathRule | undefined) | undefined;
  /** The workspace's rules, read at each call, and where an answer "for this workspace" saves one; absent outside a session. */
  readonly permissions?: Pick<PermissionStore, 'list' | 'add'> | undefined;
};

/** Asks a call's PermissionRequest hooks about the card `denial` would show. */
export type PermissionAsk = (denial: Denial) => Promise<PermissionHookAnswer>;

/**
 * Thrown where a PermissionRequest hook allowed a call with an `updatedInput`, already in Geno's shape: the call runs
 * again with that input, its own checks judging the new input, and the hook's allow answering any card it shows.
 */
export class PermissionRerun extends Error {
  constructor(readonly input: Readonly<Record<string, unknown>>) {
    super('a PermissionRequest hook changed the call');
  }
}

/** A failure the model caused or can work around. It becomes an `error` tool result, never a crash. */
export class ToolError extends Error {}

/** A call the user turned down before it ran. It becomes a `rejected` tool result, which ends the turn. */
export class ToolRejected extends ToolError {
  constructor(
    message: string,
    readonly approval?: ApprovalRecord,
  ) {
    super(message);
  }
}

/** A command that was refused before it ran. It becomes a `denied` tool result. */
export class ToolDenied extends ToolError {
  constructor(
    message: string,
    readonly approval: ApprovalRecord,
  ) {
    super(message);
  }
}

/**
 * What a tool tells the model, the file edit it made, how its command was approved, and images, a widget an editor action
 * or a todo list it returns, if any. `status: 'error'` marks a result that ran but failed, such as a command's non-zero exit.
 */
export type ToolReply =
  | string
  | {
      readonly text: string;
      readonly status?: 'error';
      readonly change?: FileChange | undefined;
      readonly approval?: ApprovalRecord | undefined;
      readonly images?: readonly ImageAttachment[] | undefined;
      readonly widget?: WidgetRef | undefined;
      readonly editorAction?: EditorAction | undefined;
      readonly todo?: TodoList | undefined;
      /** The deferred tools a tool_search call loaded. */
      readonly loaded?: readonly string[] | undefined;
      readonly spinoff?: SpinoffNote | undefined;
      readonly chapter?: ChapterMark | undefined;
      readonly shown?: ShownFiles | undefined;
      /** The file a read showed or an edit wrote, as the model now knows it. */
      readonly file?: FileStamp | undefined;
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

export const within = (root: string, target: string): boolean =>
  target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

export async function realOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** A missing path, with the root a relative path resolves against, as Claude Code names its working directory. */
export const missingPath = (ctx: Pick<ToolContext, 'workspace'>, raw: string): ToolError =>
  new ToolError(`no such file or directory: ${raw}. Relative paths start at the workspace root, ${ctx.workspace}.`);

/** The real path of `raw` (relative to the workspace, or absolute), rejected unless it is inside a readable root. */
export async function resolveInside(ctx: ToolContext, raw: string): Promise<string> {
  const target = path.resolve(ctx.workspace, raw);
  const outside = new ToolError(`${raw} is outside the workspace`);
  // realpath follows every symlink, so a link that points out of the workspace is caught here.
  const real = await realOrUndefined(target);
  if (real === undefined) {
    if ([ctx.workspace, ctx.spillDir, ...ctx.readRoots].some((root) => within(root, target))) {
      throw missingPath(ctx, raw);
    }
    throw outside;
  }
  const spillRoot = await realOrUndefined(ctx.spillDir);
  const roots = [ctx.workspace, ...(spillRoot === undefined ? [] : [spillRoot]), ...ctx.readRoots];
  if (roots.some((root) => within(root, real))) return real;
  throw outside;
}

/** The real path to write for `raw`, which may not exist yet; rejected unless it lands inside the workspace or a writable root. */
export async function resolveWritable(ctx: ToolContext, raw: string): Promise<string> {
  const target = path.resolve(ctx.workspace, raw);
  const outside = new ToolError(`${raw} is outside the workspace`);
  const roots = [ctx.workspace, ...(ctx.writeRoots ?? [])];
  if (!roots.some((root) => within(root, target))) throw outside;
  let existing = target;
  let real: string | undefined;
  while ((real = await realOrUndefined(existing)) === undefined) existing = path.dirname(existing);
  const resolved = path.join(real, path.relative(existing, target));
  if (!roots.some((root) => within(root, resolved))) throw outside;
  return resolved;
}

/** The places `ctx.credentialPlaces` holds for `home`: by its path, and by its real path when that differs. */
export async function credentialPlacesOf(home: string): Promise<string[]> {
  const real = await realOrUndefined(home);
  return [...new Set([home, ...(real === undefined ? [] : [real])])].flatMap(credentialPlaces);
}

/**
 * Whether `target`, an absolute path inside a readable root, is a credentials file by the rule that makes `cat .env` ask,
 * judged below that root, so the folders above the workspace do not count, or is in one of the home's credential places.
 */
export function isSecret(ctx: ToolContext, target: string): boolean {
  if (inCredentialPlace(ctx.credentialPlaces, target)) return true;
  const root = [ctx.workspace, ctx.spillDir, ...ctx.readRoots].find((r) => within(r, target));
  return root !== undefined && isSecretPath(path.relative(root, target).split(path.sep).join('/'));
}

/** The `read` rule a search meets at `target`. An ask counts as a refusal there, as a search cannot stop to ask. */
export const searchRule = (ctx: ToolContext, target: string): PathRule | undefined => ctx.pathRule?.('read', target);

export const pathRuleRefusal = (tool: string, shown: string, rule: PathRule): string =>
  `${shown} is off limits to ${tool}: the user's workspace rule \`${ruleText(rule)}\` in ${ruleHome(rule)} ${
    rule.effect === 'deny' ? 'denies reading it. Do not try to get its contents another way; if the task needs it, say so in your answer' : 'asks before it is read, and a search cannot ask. Call read on the file instead, which asks the user'
  }.`;

export const secretRefusal = (tool: string, shown: string): string =>
  `${shown} is off limits to ${tool}: it matches Geno's built-in rule for credentials files (.env files, keys, .ssh and the like), whose contents would reach the model provider. Do not try to get its contents another way. If the task needs a value from it, ask the user.`;

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
