import { mcpCall } from './mcp-model.js';

/** What each engine tool is doing, and did. The webview bundles this file, so it imports only pure modules. */
const VERBS: Readonly<Record<string, readonly [running: string, finished: string]>> = {
  read: ['Reading', 'Read'],
  grep: ['Searching for', 'Searched for'],
  glob: ['Finding', 'Found'],
  list: ['Listing', 'Listed'],
  edit: ['Editing', 'Edited'],
  bash: ['Running', 'Ran'],
  check: ['Checking for problems', 'Checked for problems'],
  agent: ['Delegating to', 'Delegated to'],
  open_file: ['Opening', 'Opened'],
  reveal: ['Revealing', 'Revealed'],
  show_diff: ['Opening the diff of', 'Showed the diff of'],
  read_terminal: ['Reading the terminal', 'Read the terminal'],
  watch_pr: ['Checking the PR', 'Checked the PR'],
  preview_start: ['Starting the dev server', 'Started the dev server'],
  preview_list: ['Listing the dev servers', 'Listed the dev servers'],
  preview_logs: ['Reading the dev server logs', 'Read the dev server logs'],
  preview_stop: ['Stopping the dev server', 'Stopped the dev server'],
};

/** An MCP call reads as its tool's own name, with its server beside it. */
export const verbOf = (name: string, running: boolean): string => VERBS[name]?.[running ? 0 : 1] ?? mcpCall(name)?.tool ?? name;
