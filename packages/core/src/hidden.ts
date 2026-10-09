import type { AgentToolName } from './agent.js';

// Zero-width and bidirectional controls, the BOM and Unicode tag characters: invisible text that can hide instructions.
const HIDDEN = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/gu;
const ESCAPED = /\[U\+([0-9A-F]{4,5})\]/g;

export const stripHidden = (text: string): string => text.replace(HIDDEN, '');

/** Each hidden character as a visible escape such as `[U+200B]`, for text whose exact bytes an edit must match. */
export const showHidden = (text: string): string =>
  text.replace(HIDDEN, (char) => `[U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`);

/** The characters showHidden escaped, back in place; an escape of any other character stays as written. */
export const restoreHidden = (text: string): string =>
  text.replace(ESCAPED, (escape, hex: string) => {
    const char = String.fromCodePoint(Number.parseInt(hex, 16));
    return stripHidden(char) === '' ? char : escape;
  });

/**
 * What each built-in tool's text does with hidden characters. `show` is for the workspace's own bytes and its commands'
 * output, which an edit must match and the user should see. `strip` is for text from elsewhere. A tool outside this
 * table, such as web_fetch, an MCP tool, a subagent or a terminal read, strips.
 */
const HIDDEN_IN: Readonly<Record<AgentToolName, 'show' | 'strip'>> = {
  bash: 'show',
  bash_output: 'show',
  check: 'show',
  edit: 'show',
  glob: 'show',
  grep: 'show',
  list: 'show',
  list_agents: 'show',
  monitor: 'show',
  notebook_edit: 'show',
  preview_list: 'show',
  preview_logs: 'show',
  preview_start: 'show',
  preview_stop: 'show',
  read: 'show',
  recall: 'strip',
  schedule_wakeup: 'strip',
  show_files: 'show',
  skill: 'strip',
  task_stop: 'show',
  todo: 'strip',
  watch_pr: 'strip',
};

/** A tool's text as the model gets it. */
export const toolText = (tool: string, text: string): string =>
  Object.hasOwn(HIDDEN_IN, tool) && HIDDEN_IN[tool as AgentToolName] === 'show' ? showHidden(text) : stripHidden(text);
