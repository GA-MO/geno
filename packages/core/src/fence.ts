/**
 * Text another agent or a background job wrote, on its way into a session's context. Geno frames its own text with
 * the tags and bracketed lines below; text from outside must not be able to pose as either. This file imports nothing,
 * so the webview can bundle what imports it.
 */

/** Every tag Geno frames context with. */
export const HARNESS_TAGS = [
  'subagent_report',
  'parent_message',
  'project_instructions',
  'global_instructions',
  'project_rule',
  'context_item',
  'memory',
  'available_skills',
  'compacted_context',
  'user_messages',
  'recalled_sessions',
  'terminal_output',
  'ci_log',
] as const;

/** How Geno's own notices start a line. */
const HARNESS_LINE_STARTS = ['Geno', 'Background command', 'Monitor ', 'Scheduled wake-up', 'PR watch'] as const;

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TAG_SOURCE = `<\\s*(/?)\\s*(${HARNESS_TAGS.join('|')})\\b`;
const LINE_SOURCE = `^([ \\t]*)\\[(?=${HARNESS_LINE_STARTS.map(escaped).join('|')})`;

/** A harness tag loses its angle bracket and a harness line its square one, so neither reads as Geno's. */
export const neutralize = (text: string): string => text.replace(new RegExp(TAG_SOURCE, 'gi'), '‹$1$2').replace(new RegExp(LINE_SOURCE, 'gm'), '$1‹');

export const indentLines = (text: string): string =>
  text
    .split('\n')
    .map((line) => (line === '' ? '' : `  ${line}`))
    .join('\n');

export type InstructionPattern = { readonly name: string; readonly pattern: RegExp };

/** Text that reads as an instruction to the agent reading it, rather than as a finding. */
export const INSTRUCTION_PATTERNS: readonly InstructionPattern[] = [
  { name: 'harness-tag', pattern: new RegExp(TAG_SOURCE, 'i') },
  { name: 'harness-line', pattern: new RegExp(LINE_SOURCE, 'm') },
  { name: 'role-frame', pattern: /<\s*\/?\s*(system|system-reminder|system_prompt|instructions)\b[^>]*>|^[ \t]*(system|developer)\s*:/im },
  { name: 'override', pattern: /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+)?(of\s+)?(the\s+|your\s+|my\s+)?(previous|prior|above|earlier|system|original)\s+(instructions|rules|prompts?|messages?)\b/i },
  {
    name: 'approval-claim',
    pattern: /\b(user|operator)\s+(has\s+|have\s+|already\s+)*(approved|authori[sz]ed|consented|pre-?approved)\b|\bpre-?(approved|authori[sz]ed)\b|\byou\s+(now\s+)?have\s+(the user's\s+|my\s+|full\s+)?(permission|approval)\b/i,
  },
  { name: 'settings-edit', pattern: /\b(edit|change|update|add|write|modify|append)\b[^\n]{0,60}(AGENTS\.md|CLAUDE\.md|\.gcode\.json|settings\.json|permission (rules|settings))/i },
  { name: 'destructive-command', pattern: /\brm\s+-[a-z]*(r[a-z]*f|f[a-z]*r)|\bgit\s+(push\s+(-f\b|--force)|reset\s+--hard|clean\s+-[a-z]*f)|\b(curl|wget)\b[^\n|]*\|\s*(ba|z)?sh\b/i },
];

/** The names of the patterns `text` matches, in table order. */
export const instructionPatternsIn = (text: string): string[] => INSTRUCTION_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);

export const REPORT_TAG = 'subagent_report';
const REPORT_OPEN = new RegExp(`^<${REPORT_TAG}\\b[^>]*>\\n`, 'm');
const REPORT_CLOSE = `\n</${REPORT_TAG}>`;

/** How the banner `childReport` puts first in a report's fence starts. */
export const BANNER_START = '[Geno: this report matched instruction-shaped patterns';

/** What the child wrote, as `childReport` fenced it, without the indent or the banner; text with no fence is read as it is. */
export function reportBody(fenced: string): string {
  const open = REPORT_OPEN.exec(fenced);
  if (open === null) return fenced;
  const start = open.index + open[0].length;
  const end = fenced.indexOf(REPORT_CLOSE, start);
  return fenced
    .slice(start, end === -1 ? undefined : end)
    .split('\n')
    .flatMap((line) => (line.startsWith(BANNER_START) ? [] : [line.startsWith('  ') ? line.slice(2) : line]))
    .join('\n');
}
