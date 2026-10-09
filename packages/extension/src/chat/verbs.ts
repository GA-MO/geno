import { mcpCall } from './mcp-model.js';

/**
 * What a tool is doing and did, and how its step names what it acted on. `target` reshapes the engine's target, the
 * words its title gives after the tool's name; without it the step shows that target as is. The webview bundles this
 * file, so it imports only pure modules.
 */
type Verb = { readonly running: string; readonly finished: string; readonly target?: (target: string) => string };

const verb = (running: string, finished: string, target?: (target: string) => string): Verb => ({ running, finished, ...(target === undefined ? {} : { target }) });

const hostOf = (target: string): string => {
  try {
    return new URL(target.split(' ')[0]!).host || target;
  } catch {
    return target;
  }
};

/** `web_fetch monitor "query words"` names the tools it loads, then what it searched for. */
const toolNames = (target: string): string => (target.match(/"[^"]*"|\S+/g) ?? []).join(', ');

const none = (): string => '';

/** `show_files a.png b.png` names its files; one shows by its name, more by their count. */
const fileCount = (target: string): string => {
  const files = target.split(' ').filter((file) => file !== '');
  return files.length === 1 ? files[0]!.slice(files[0]!.lastIndexOf('/') + 1) : `${files.length} files`;
};

/** Every tool Geno offers; an MCP call reads as its tool's own name, with its server beside it. */
export const VERBS: Readonly<Record<string, Verb>> = {
  read: verb('Reading', 'Read'),
  grep: verb('Searching for', 'Searched for'),
  glob: verb('Finding', 'Found'),
  list: verb('Listing', 'Listed'),
  edit: verb('Editing', 'Edited'),
  notebook_edit: verb('Editing', 'Edited'),
  bash: verb('Running', 'Ran'),
  bash_output: verb('Reading the output of', 'Read the output of'),
  check: verb('Checking for problems', 'Checked for problems'),
  monitor: verb('Watching', 'Watched'),
  schedule_wakeup: verb('Setting a wake-up', 'Set a wake-up'),
  task_stop: verb('Stopping', 'Stopped'),
  list_agents: verb('Listing background work', 'Listed background work'),
  todo: verb('Updating the todo list', 'Updated the todo list', none),
  skill: verb('Loading skill', 'Used skill'),
  tool_search: verb('Loading tools:', 'Loaded tools:', toolNames),
  recall: verb('Searching earlier chats for', 'Searched earlier chats for'),
  agent: verb('Delegating to', 'Delegated to'),
  message_agent: verb('Messaging', 'Messaged'),
  report: verb('Reporting back', 'Reported back', none),
  structured_output: verb('Reporting back', 'Reported back', none),
  ask_user: verb('Asking you', 'Asked you'),
  remember: verb('Remembering', 'Remembered', none),
  web_fetch: verb('Fetching', 'Fetched', hostOf),
  web_search: verb('Searching the web for', 'Searched the web for'),
  show_widget: verb('Drawing', 'Drew'),
  show_files: verb('Showing', 'Showed', fileCount),
  open_file: verb('Opening', 'Opened'),
  reveal: verb('Revealing', 'Revealed'),
  show_diff: verb('Opening the diff of', 'Showed the diff of'),
  read_terminal: verb('Reading the terminal', 'Read the terminal'),
  watch_pr: verb('Checking the PR', 'Checked the PR'),
  preview_start: verb('Starting the dev server', 'Started the dev server'),
  preview_list: verb('Listing the dev servers', 'Listed the dev servers'),
  preview_logs: verb('Reading the dev server logs', 'Read the dev server logs'),
  preview_stop: verb('Stopping the dev server', 'Stopped the dev server'),
  spawn_task: verb('Suggesting a task:', 'Suggested a task:'),
  dismiss_task: verb('Withdrawing task', 'Withdrew task'),
  schedule_task: verb('Scheduling', 'Scheduled', (target) => target.replace(/^create /, '')),
  workflow: verb('Starting workflow', 'Started workflow'),
  mark_chapter: verb('Starting chapter', 'Started chapter'),
};

export const verbOf = (name: string, running: boolean): string => {
  const known = VERBS[name];
  return known === undefined ? (mcpCall(name)?.tool ?? name) : running ? known.running : known.finished;
};

/** What the step names as the call's target, in the words the user reads. */
export const targetOf = (name: string, target: string): string => VERBS[name]?.target?.(target) ?? target;
