import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  AGENT_EDIT_FORMAT,
  baseOf,
  EDIT_FORMAT_SPECS,
  EDIT_SYSTEM_PROMPT,
  INLINE_EDIT_MAX_TURNS,
  selectionEditPrompt,
  type BaseRead,
  type InlineEditTarget,
  type TurnEvent,
} from '@g-code/core';
import type { OpenSession } from './chat.js';
import { shadowRepoFor, takeCheckpoint } from './checkpoints.js';
import type { Io } from './command.js';
import { drive, type DriveResult, type Limits, type Surface } from './drive.js';
import { EngineError } from './errors.js';
import type { Store } from './store.js';
import { editExecutor, type Diagnostics } from './tools/agent.js';

export type InlineEditOptions = {
  readonly maxCostUsd: Limits['maxCostUsd'];
  readonly surface: Surface;
  readonly diagnostics: Diagnostics | undefined;
};

/**
 * Cmd-K: one edit of a selection, in the session's log like any turn. The file and its problems are in the
 * prompt, so the model gets only the edit tool, and its edit lands through the same applier as the agent's.
 */
export async function runInlineEdit(
  io: Io,
  store: Store,
  opened: OpenSession,
  target: InlineEditTarget,
  instruction: string,
  options: InlineEditOptions,
): Promise<DriveResult> {
  const { session } = opened.log;
  const file = await realpath(target.path).catch(() => target.path);
  const relative = path.relative(session.workspace, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new EngineError(`${target.path} is outside the workspace`);
  const text = await options.surface.files.read(file);
  if (text === null) throw new EngineError(`${relative} does not exist`);
  const diagnostics = options.diagnostics === undefined ? [] : await options.diagnostics([file]);
  const prompt = selectionEditPrompt({ path: relative, text, startLine: target.startLine, endLine: target.endLine, instruction, diagnostics });

  const reads = new Map<string, BaseRead>([[file, baseOf(text, null)]]);
  const repo = shadowRepoFor(store, session.workspace);
  const mode = {
    tools: [EDIT_FORMAT_SPECS[AGENT_EDIT_FORMAT].tool],
    executors: { edit: editExecutor(reads, async () => undefined) },
    system: EDIT_SYSTEM_PROMPT,
    beforeCall: (events: readonly TurnEvent[]) => takeCheckpoint(repo, session.id, events),
  };
  return drive(io, store, opened, prompt, { maxTurns: INLINE_EDIT_MAX_TURNS, maxCostUsd: options.maxCostUsd }, mode, options.surface);
}
