import { denialFor, type ApprovalMode, type CommandScope, type Denial, type ExternalRuleId, type Verdicts } from './approval.js';
import { EXTERNAL_TOOL_STEPS, externalTitle, externalToolUse, type ExternalAccess, type ExternalCall } from './backends.js';

// Permissions: an external agent's `session/request_permission` through Geno's approval modes.

/**
 * The permission table. Ask asks the user about everything the agent asks about. Auto lets the classifier decide
 * what Geno's own rules do not settle, and reads inside the workspace run. Plan refuses everything but reads.
 */
export const EXTERNAL_RULES: Readonly<Record<ExternalAccess, { readonly rule: ExternalRuleId; readonly reason: string; readonly verdicts: Verdicts }>> = {
  read: { rule: 'external-read', reason: 'an external agent reading inside the workspace', verdicts: { plan: 'allow', ask: 'ask', auto: 'allow', 'non-interactive': 'allow' } },
  write: { rule: 'external-write', reason: 'an external agent changing files', verdicts: { plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'deny' } },
  command: { rule: 'external-command', reason: 'an external agent running a command', verdicts: { plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'deny' } },
  other: { rule: 'external-other', reason: 'an external agent’s tool', verdicts: { plan: 'deny', ask: 'ask', auto: 'classify', 'non-interactive': 'deny' } },
};

const inside = (workspace: string, file: string): boolean => file === workspace || file.startsWith(workspace.endsWith('/') ? workspace : `${workspace}/`);

/** What a permission request touches: a read anywhere but the workspace counts as other. */
export function accessOf(call: ExternalCall, workspace: string): ExternalAccess {
  const { access } = EXTERNAL_TOOL_STEPS[call.kind];
  if (access === 'read' && !call.locations.every((file) => inside(workspace, file))) return 'other';
  return access;
}

/**
 * What settles one permission request before anyone is asked, or undefined when it may run. A command in Auto goes
 * through Geno's own command rules first, so `rm -rf` outside the workspace still asks and a safe command runs.
 */
export function externalDenialFor(call: ExternalCall, scope: CommandScope, mode: ApprovalMode): Denial | undefined {
  const access = accessOf(call, scope.workspace);
  const { rule, reason, verdicts } = EXTERNAL_RULES[access];
  const verdict = verdicts[mode];
  const use = externalToolUse(call, scope.workspace);
  const shown = externalTitle(use);
  if (access === 'command' && mode === 'auto') {
    const command = String(use.input['command']);
    return denialFor(command, scope, mode);
  }
  if (verdict === 'allow') return undefined;
  return { rule, reason, command: shown, verdict };
}

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
export type AgentPermissionOption = { readonly optionId: string; readonly kind: PermissionOptionKind | string };

/**
 * The option Geno answers with, or undefined to cancel the request. Geno never picks an `_always` option: it would
 * change the agent's own saved permissions, which outlive the lane and are not Geno's to change.
 */
export function externalAnswer(options: readonly AgentPermissionOption[], verdict: 'allow' | 'deny'): string | undefined {
  const once = (kind: PermissionOptionKind) => options.find((option) => option.kind === kind)?.optionId;
  if (verdict === 'allow') return once('allow_once') ?? once('reject_once');
  return once('reject_once');
}
