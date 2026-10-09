import {
  AGENT_TOOL,
  AGENT_TOOL_DEFINITIONS,
  APPROVAL_MODES,
  chapterToolDefinitions,
  editorActionToolDefinitions,
  MESSAGE_AGENT_TOOL_DEFINITION,
  readTerminalToolDefinitions,
  REPORT_TOOL_DEFINITION,
  scheduleToolDefinitions,
  spinoffToolDefinitions,
  STRUCTURED_OUTPUT_TOOL,
  TOOL_SEARCH_TOOL,
  USER_TOOL_NAMES,
  userToolDefinitions,
  webToolDefinitions,
  widgetToolDefinitions,
  workflowToolDefinitions,
} from '@g-code/core';
import { describe, expect, it } from 'vitest';
import { targetOf, VERBS, verbOf } from '../src/chat/verbs.js';

/** Every tool the engine can offer a model, in any mode, with every surface attached. */
const offered = [
  ...AGENT_TOOL_DEFINITIONS,
  ...userToolDefinitions(new Set(USER_TOOL_NAMES)),
  ...webToolDefinitions(true),
  MESSAGE_AGENT_TOOL_DEFINITION,
  REPORT_TOOL_DEFINITION,
  ...APPROVAL_MODES.flatMap((mode) =>
    [widgetToolDefinitions, editorActionToolDefinitions, readTerminalToolDefinitions, spinoffToolDefinitions, scheduleToolDefinitions, workflowToolDefinitions, chapterToolDefinitions].flatMap((definitions) => definitions(mode, true)),
  ),
].map((tool) => tool.name);
const names = [...new Set([...offered, AGENT_TOOL, TOOL_SEARCH_TOOL, STRUCTURED_OUTPUT_TOOL])].sort();

describe('the step verbs', () => {
  it('cover every tool the engine offers, so no step shows a raw tool name', () => {
    expect(names.length).toBeGreaterThan(30);
    expect(names.filter((name) => VERBS[name] === undefined)).toEqual([]);
    for (const name of names) expect(`${verbOf(name, false)} ${verbOf(name, true)}`, name).not.toContain('_');
  });

  it('read an MCP call as its tool, with its server beside it', () => {
    expect(verbOf('mcp__github__create_issue', false)).toBe('create_issue');
  });

  it.each([
    ['tool_search', 'web_fetch monitor', 'Loaded tools: web_fetch, monitor'],
    ['tool_search', '"pdf tools"', 'Loaded tools: "pdf tools"'],
    ['skill', 'poteto-mode', 'Used skill poteto-mode'],
    ['task_stop', 'bg-1', 'Stopped bg-1'],
    ['web_fetch', 'https://docs.stripe.com/api/charges from character 80000', 'Fetched docs.stripe.com'],
    ['ask_user', 'Where should the switcher live?', 'Asked you Where should the switcher live?'],
    ['remember', 'project', 'Remembered'],
    ['agent', 'explore: find callers of getUser', 'Delegated to explore: find callers of getUser'],
    ['show_files', 'shots/before.png shots/after.png', 'Showed 2 files'],
    ['show_files', 'shots/after.png', 'Showed after.png'],
  ])('name a finished %s call by what it did', (name, target, line) => {
    expect([verbOf(name, false), targetOf(name, target)].filter((part) => part !== '').join(' ')).toBe(line);
  });
});
