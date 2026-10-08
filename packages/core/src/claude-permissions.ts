import type { CommandScope } from './approval.js';
import { CLAUDE_TOOL_NAMES } from './hooks.js';
import { parseRule, RULE_EFFECTS, type NewRule } from './permission-rules.js';

/** A Claude Code deny on a whole tool, such as `WebFetch`, and the Geno tool it stops. */
export type DeniedTool = { readonly tool: string; readonly text: string };

/** What Geno takes from the `permissions` of one Claude Code settings file, and the rules it cannot apply. */
export type ClaudePermissions = {
  readonly rules: readonly NewRule[];
  readonly deniedTools: readonly DeniedTool[];
  readonly skipped: readonly string[];
};

// Every Claude Code rule is a tool name, alone or with its argument in parentheses.
const CLAUDE_RULE = /^(\w+)(?:\((.*)\))?$/s;
const GENO_FORMS: ReadonlySet<string> = new Set(['Bash', 'Read', 'Edit']);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The rules of a Claude Code settings file Geno can apply: `Bash(...)`, `Read(...)` and `Edit(...)` as Geno parses them
 * in Settings, and a deny on a bare tool name. Parameter rules of other tools, MCP names and a bare allow or ask are skipped.
 */
export function claudePermissions(settings: unknown, scope: CommandScope): ClaudePermissions {
  const permissions = isRecord(settings) ? settings['permissions'] : undefined;
  const rules: NewRule[] = [];
  const deniedTools: DeniedTool[] = [];
  const skipped: string[] = [];
  if (!isRecord(permissions)) return { rules, deniedTools, skipped };
  for (const effect of RULE_EFFECTS) {
    const list = permissions[effect];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      skipped.push(`${effect} (not a list)`);
      continue;
    }
    for (const entry of list) {
      if (typeof entry !== 'string') {
        skipped.push(JSON.stringify(entry));
        continue;
      }
      const text = entry.trim();
      const form = CLAUDE_RULE.exec(text);
      const tool = form?.[1];
      if (form === null || tool === undefined) skipped.push(text);
      else if (form[2] === undefined) {
        const genoTool = CLAUDE_TOOL_NAMES[tool];
        if (effect === 'deny' && genoTool !== undefined) deniedTools.push({ tool: genoTool, text });
        else skipped.push(text);
      } else if (!GENO_FORMS.has(tool)) skipped.push(text);
      else {
        const parsed = parseRule(effect, text, scope);
        if (parsed.ok) rules.push(parsed.rule);
        else skipped.push(text);
      }
    }
  }
  return { rules, deniedTools, skipped };
}
