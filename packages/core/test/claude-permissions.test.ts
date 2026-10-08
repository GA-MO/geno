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

  it('skips each rule Geno cannot apply and keeps the rest', () => {
    const parsed = claudePermissions(
      {
        permissions: {
          allow: ['WebFetch(domain:example.com)', 'mcp__github__create_issue', 'Read(//etc/**)', 'Bash(*)', 'Bash(git * main)', 'Bash(sh -c:*)', 42, 'Bash(ls:*)'],
          ask: ['WebSearch'],
          deny: ['NoSuchTool', 'Agent(Explore)', 'not a rule'],
        },
      },
      scope,
    );
    expect(parsed.rules).toEqual([{ effect: 'allow', pattern: ['ls'] }]);
    expect(parsed.deniedTools).toEqual([]);
    expect(parsed.skipped).toEqual([
      'WebFetch(domain:example.com)',
      'mcp__github__create_issue',
      'Read(//etc/**)',
      'Bash(*)',
      'Bash(git * main)',
      'Bash(sh -c:*)',
      '42',
      'WebSearch',
      'NoSuchTool',
      'Agent(Explore)',
      'not a rule',
    ]);
  });

  it('reads nothing from a file without permissions, and names a list that is not one', () => {
    expect(claudePermissions({ hooks: {} }, scope)).toEqual({ rules: [], deniedTools: [], skipped: [] });
    expect(claudePermissions('x', scope)).toEqual({ rules: [], deniedTools: [], skipped: [] });
    expect(claudePermissions({ permissions: { deny: 'Bash', allow: ['Bash(ls *)'] } }, scope)).toEqual({
      rules: [{ effect: 'allow', pattern: ['ls'] }],
      deniedTools: [],
      skipped: ['deny (not a list)'],
    });
  });
});
