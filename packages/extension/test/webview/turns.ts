import type { Action, ToolKind, Usage } from '../../src/chat/messages.js';
import type { FakeHost } from './host.js';

/** A tool call as the fixtures write it, the input the model sent; the engine titles it `<name> <target>`. */
export type Call = { readonly narration: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> };

/** The ACP kind the engine gives each of its tools. */
const KINDS: Readonly<Record<string, ToolKind>> = { read: 'read', grep: 'search', glob: 'search', edit: 'edit', write: 'edit', bash: 'execute' };

/** What the engine names as the call's target in its title, by tool. */
const targetOf = ({ input }: Pick<Call, 'input'>): string => String(input['path'] ?? input['pattern'] ?? input['command'] ?? '');

export const usageOf = (model: string, inputTokens = 1000, outputTokens = 30): Usage => ({ model, inputTokens, outputTokens, costUsd: 0.0004 });

/** A turn the user sent, as the extension starts it once the engine takes the prompt. */
export const turnStart = (id: string, prompt: string, mode = 'ask'): Action => ({ type: 'turn-start', id, at: Date.now(), prompt, mode });

/** A tool call starting, as the extension turns the engine's tool_call update into an action. */
export const toolStart = (id: string, call: Pick<Call, 'name' | 'input'>): Action => ({
  type: 'tool',
  id,
  at: Date.now(),
  name: call.name,
  target: targetOf(call),
  ...(call.name === 'bash' && typeof call.input['description'] === 'string' ? { description: call.input['description'] } : {}),
  toolKind: KINDS[call.name] ?? 'other',
  status: 'running',
});

export const toolEnd = (id: string, status: 'completed' | 'failed', output: string): Action => ({ type: 'tool', id, at: Date.now(), status, output });

/** An edit's diff, as the review controller reports the edit reaching the file. */
export const editDiff = (toolId: string, path: string, line: number, removed: string, added: string): Action => ({
  type: 'diff',
  toolId,
  at: Date.now(),
  diff: { path, change: `${toolId}-change`, hunks: [{ id: `${toolId}-h0`, line, removed: [removed], added: [added], status: 'pending' }] },
});

/**
 * One model round of the fake transport's toolCall: its narration, then the call, run to `status`. An edit carries
 * its diff, as the engine's edit reaches the editor before it reports done.
 */
export async function round(host: FakeHost, id: string, call: Call, status: 'completed' | 'failed' = 'completed'): Promise<void> {
  await host.act({ type: 'text', text: call.narration }, toolStart(id, call));
  if (call.name === 'edit') await host.act(editDiff(id, String(call.input['path']), 2, String(call.input['old_str']), String(call.input['new_str'])));
  await host.act(toolEnd(id, status, status === 'failed' ? `error: ${targetOf(call)} not found` : `ok: ${targetOf(call)}`));
}

export const PERMISSION_OPTIONS = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
] as const;
