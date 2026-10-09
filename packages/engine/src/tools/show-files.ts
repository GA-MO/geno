import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { formatBytes, parseShowFilesInput, SHOW_FILES_LIMITS, SHOW_FILES_TOOL, shownKindOf, shownText, showFilesTitle, type ApprovalRecord, type ShowEntry, type ShowFilesInput, type ShownFiles } from '@g-code/core';
import { executor, ToolDenied, ToolError, ToolRejected, type Executor, type ToolContext } from './context.js';

/**
 * Where a path the model named lands, once the user's rules and questions let it through; it throws a ToolError to
 * refuse that file, or ToolRejected when the user said no, which ends the turn.
 */
export type ShowGate = (ctx: ToolContext, given: string) => Promise<{ readonly real: string; readonly approval?: ApprovalRecord | undefined }>;

const isFsError = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';

/** show_files: each file goes through `gate` and the size limits on its own, so one refused file leaves the others shown. */
export function showFilesExecutor(gate: ShowGate): Executor {
  return executor<ShowFilesInput>({
    input: z.unknown().transform((raw, ctx) => {
      const parsed = parseShowFilesInput(raw);
      if (parsed.ok) return parsed.value;
      ctx.addIssue({ code: 'custom', message: parsed.problem });
      return z.NEVER;
    }),
    describe: showFilesTitle,
    async run({ files, caption, layout }, ctx) {
      const entries: ShowEntry[] = [];
      let approval: ApprovalRecord | undefined;
      let total = 0;
      for (const given of files) {
        try {
          const passed = await gate(ctx, given);
          approval ??= passed.approval;
          const info = await stat(passed.real);
          if (!info.isFile()) throw new ToolError(`${given} is a directory; name the files in it`);
          if (info.size > SHOW_FILES_LIMITS.fileBytes) throw new ToolError(`${given} is ${formatBytes(info.size)}; ${SHOW_FILES_TOOL} shows files up to ${formatBytes(SHOW_FILES_LIMITS.fileBytes)}`);
          if (total + info.size > SHOW_FILES_LIMITS.callBytes) throw new ToolError(`one call shows up to ${formatBytes(SHOW_FILES_LIMITS.callBytes)} in all; show ${given} in another call`);
          total += info.size;
          entries.push({ kind: 'shown', given, path: passed.real, name: path.basename(passed.real), bytes: info.size, show: shownKindOf(passed.real) });
        } catch (error) {
          if (error instanceof ToolRejected || ctx.signal.aborted) throw error;
          if (error instanceof ToolDenied) approval ??= error.approval;
          if (!(error instanceof ToolError) && !isFsError(error)) throw error;
          entries.push({ kind: 'refused', given, reason: error.message });
        }
      }
      const shown: ShownFiles = { ...(caption === undefined ? {} : { caption }), layout, files: entries };
      const none = entries.every((entry) => entry.kind === 'refused');
      return { text: shownText(shown), shown, ...(approval === undefined ? {} : { approval }), ...(none ? { status: 'error' as const } : {}) };
    },
  });
}
