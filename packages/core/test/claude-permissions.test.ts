import { describe, expect, it } from 'vitest';
import { claudePermissions } from '../src/claude-permissions.js';

const scope = { workspace: '/ws', tempDir: '/tmp/t', home: '/home/u' };

describe('claudePermissions', () => {
  it('B/B-58 takes Bash(x:*) and Bash(x *) as prefix rules, an allow Bash(x) as exact, and Read and Edit as path rules', () => {
    const parsed = claudePermissions(
      { permissions: { allow: ['Bash(npm run test:*)', 'Bash(git status *)', 'Bash(npm test)'], ask: ['Bash(git push:*)'], deny: ['Read(./.env)', 'Edit(secrets/**)', 'Bash(curl)'] } },
      scope,
    );
    expect(parsed).toEqual({
      rules: [
        { effect: 'allow', pattern: ['npm', 'run', 'test'] },
        { effect: 'allow', pattern: ['git', 'status'] },
        { effect: 'allow', pattern: ['npm', 'test'], exact: true },
        { effect: 'ask', pattern: ['git', 'push'] },
        { effect: 'deny', tool: 'read', path: './.env' },
        { effect: 'deny', tool: 'edit', path: 'secrets/**' },
        { effect: 'deny', pattern: ['curl'] },
      ],
      deniedTools: [],
      directories: [],
      skipped: [],
    });
  });

  it('B/B-63 B/B-64 takes WebFetch(domain:...) as a web_fetch domain rule and an MCP name, with its wildcards, as an MCP rule', () => {
    const parsed = claudePermissions(
      {
        permissions: {
          allow: ['WebFetch(domain:nextjs.org)', 'WebFetch(domain:*.github.com)', 'mcp__github__get_issue'],
          ask: ['mcp__linear__*'],
          deny: ['WebFetch(domain:evil.example)', 'mcp__my-server'],
        },
      },
      scope,
    );
    expect(parsed).toEqual({
      rules: [
        { effect: 'allow', tool: 'web_fetch', domain: 'nextjs.org' },
        { effect: 'allow', tool: 'web_fetch', domain: '*.github.com' },
        { effect: 'allow', mcp: 'mcp__github__get_issue' },
        { effect: 'ask', mcp: 'mcp__linear__*' },
        { effect: 'deny', tool: 'web_fetch', domain: 'evil.example' },
        { effect: 'deny', mcp: 'mcp__my-server' },
      ],
      deniedTools: [],
      directories: [],
      skipped: [],
    });
  });

  it('B/B-65 maps a bare-tool deny to the Geno tool, Write to edit, and Bash to every tool that runs a shell command', () => {
    const parsed = claudePermissions({ permissions: { deny: ['WebFetch', 'Bash', 'Write', 'Task'] } }, scope);
    expect(parsed.deniedTools).toEqual([
      { tool: 'web_fetch', text: 'WebFetch' },
      { tool: 'bash', text: 'Bash' },
      { tool: 'check', text: 'Bash' },
      { tool: 'monitor', text: 'Bash' },
      { tool: 'preview_start', text: 'Bash' },
      { tool: 'edit', text: 'Write' },
      { tool: 'agent', text: 'Task' },
    ]);
    expect(parsed.skipped).toEqual([]);
  });

  it('B/B-17 a bare Edit deny stops notebook_edit as well as edit, and a bare NotebookEdit deny stops notebook_edit alone', () => {
    expect(claudePermissions({ permissions: { deny: ['Edit', 'NotebookEdit'] } }, scope).deniedTools).toEqual([
      { tool: 'edit', text: 'Edit' },
      { tool: 'notebook_edit', text: 'Edit' },
      { tool: 'notebook_edit', text: 'NotebookEdit' },
    ]);
  });

  it('skips each rule Geno cannot apply and keeps the rest', () => {
    const parsed = claudePermissions(
      {
        permissions: {
          allow: ['WebFetch(https://example.com)', 'WebFetch(domain:https://example.com/docs)', 'mcp__github__create:issue', 'Read(//etc/**)', 'Bash(*)', 'Bash(git * main)', 'Bash(sh -c:*)', 42, 'Bash(ls:*)'],
          ask: ['WebSearch', 'Browser(domain:example.com)'],
          deny: ['NoSuchTool', 'Agent(Explore)', 'not a rule'],
        },
      },
      scope,
    );
    expect(parsed.rules).toEqual([{ effect: 'allow', pattern: ['ls'] }]);
    expect(parsed.deniedTools).toEqual([]);
    expect(parsed.skipped).toEqual([
      'WebFetch(https://example.com)',
      'WebFetch(domain:https://example.com/docs)',
      'mcp__github__create:issue',
      'Read(//etc/**)',
      'Bash(*)',
      'Bash(git * main)',
      'Bash(sh -c:*)',
      '42',
      'WebSearch',
      'Browser(domain:example.com)',
      'NoSuchTool',
      'Agent(Explore)',
      'not a rule',
    ]);
  });

  it('B/B-68 takes additionalDirectories as written, and skips an entry that is not a path', () => {
    const parsed = claudePermissions({ permissions: { additionalDirectories: ['../shared', ' ~/notes ', 7, ''] } }, scope);
    expect(parsed.directories).toEqual(['../shared', '~/notes']);
    expect(parsed.skipped).toEqual(['additionalDirectories 7', 'additionalDirectories ""']);
    expect(claudePermissions({ permissions: { additionalDirectories: '../shared' } }, scope)).toMatchObject({ directories: [], skipped: ['additionalDirectories (not a list)'] });
  });

  it('reads nothing from a file without permissions, and names a list that is not one', () => {
    expect(claudePermissions({ hooks: {} }, scope)).toEqual({ rules: [], deniedTools: [], directories: [], skipped: [] });
    expect(claudePermissions('x', scope)).toEqual({ rules: [], deniedTools: [], directories: [], skipped: [] });
    expect(claudePermissions({ permissions: { deny: 'Bash', allow: ['Bash(ls *)'] } }, scope)).toEqual({
      rules: [{ effect: 'allow', pattern: ['ls'] }],
      deniedTools: [],
      directories: [],
      skipped: ['deny (not a list)'],
    });
  });
});
