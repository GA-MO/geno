import { SHELL_TOOLS } from './agent.js';
import type { CommandScope } from './approval.js';
import { CLAUDE_TOOL_NAMES } from './hooks.js';
import { NOTEBOOK_EDIT_TOOL } from './notebook.js';
import { parseRule, RULE_EFFECTS, type NewRule } from './permission-rules.js';

/** A Claude Code deny on a whole tool, such as `WebFetch`, and a Geno tool it stops; `Bash` stops every shell tool. */
export type DeniedTool = { readonly tool: string; readonly text: string };

/** What Geno takes from the `permissions` of one Claude Code settings file, and the rules it cannot apply. */
export type ClaudePermissions = {
  readonly rules: readonly NewRule[];
  readonly deniedTools: readonly DeniedTool[];
  /** `additionalDirectories` as written, for the engine to resolve against the workspace. */
  readonly directories: readonly string[];
  readonly skipped: readonly string[];
};

// Every Claude Code rule is a tool name, alone or with its argument in parentheses.
const CLAUDE_RULE = /^(\w+)(?:\((.*)\))?$/s;
const GENO_FORMS: ReadonlySet<string> = new Set(['Bash', 'Read', 'Edit', 'WebFetch']);

// Claude Code's Edit rules cover every tool that edits files, NotebookEdit among them.
const BARE_DENIES: Readonly<Record<string, readonly string[]>> = { Bash: SHELL_TOOLS, Edit: ['edit', NOTEBOOK_EDIT_TOOL] };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The rules of a Claude Code settings file Geno can apply: `Bash(...)`, `Read(...)`, `Edit(...)`, `WebFetch(domain:...)`
 * and MCP names as Geno parses them in Settings, a deny on a bare tool name, and `additionalDirectories`. Parameter
 * rules of other tools and a bare allow or ask are skipped.
 */
export function claudePermissions(settings: unknown, scope: CommandScope): ClaudePermissions {
  const permissions = isRecord(settings) ? settings['permissions'] : undefined;
  const rules: NewRule[] = [];
  const deniedTools: DeniedTool[] = [];
  const directories: string[] = [];
  const skipped: string[] = [];
  if (!isRecord(permissions)) return { rules, deniedTools, directories, skipped };
  const added = permissions['additionalDirectories'];
  if (Array.isArray(added)) {
    for (const entry of added) {
      if (typeof entry === 'string' && entry.trim() !== '') directories.push(entry.trim());
      else skipped.push(`additionalDirectories ${JSON.stringify(entry)}`);
    }
  } else if (added !== undefined) skipped.push('additionalDirectories (not a list)');
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
      if (text.startsWith('mcp__') || (form?.[2] !== undefined && GENO_FORMS.has(tool!))) {
        const parsed = parseRule(effect, text, scope);
        if (parsed.ok) rules.push(parsed.rule);
        else skipped.push(text);
      } else if (form === null || tool === undefined) skipped.push(text);
      else if (form[2] === undefined) {
        const genoTools = BARE_DENIES[tool] ?? (CLAUDE_TOOL_NAMES[tool] === undefined ? [] : [CLAUDE_TOOL_NAMES[tool]]);
        if (effect === 'deny' && genoTools.length > 0) deniedTools.push(...genoTools.map((genoTool) => ({ tool: genoTool, text })));
        else skipped.push(text);
      } else skipped.push(text);
    }
  }
  return { rules, deniedTools, directories, skipped };
}
