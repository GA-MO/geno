import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { GENO_NOTE, WORKSPACE_TRUST_CAPABILITY } from '@g-code/core';
import { gcodeAgent } from '../src/serve.js';
import { call, say, scripted } from './conformance/scripted.js';

const CONTEXT = 'prettier formatted the file; it now uses single quotes.';

// A repository's own formatter hook, as a team commits it for Claude Code: a stand-in for `prettier --write "$file"`.
const FORMAT = [
  '#!/bin/sh',
  'in=$(cat)',
  `file=$(printf '%s' "$in" | sed -n 's/.*"file_path":"\\([^"]*\\)".*/\\1/p')`,
  `[ -n "$file" ] || exit 0`,
  `tr '"' "'" < "$file" > "$file.formatted" && mv "$file.formatted" "$file"`,
  `printf '%s\\n' '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: CONTEXT } })}'`,
  'exit 0',
  '',
].join('\n');

describe('a PostToolUse formatter hook in the workspace, over ACP', () => {
  it('formats the file the model wrote, inside the sandbox, and the model reads that it did', async () => {
    const write = { id: 'tu_write', name: 'edit', input: { path: 'src/posts.ts', new_str: 'export const posts = { slug: "posts" };\n', create: true } };
    const run = await scripted('anthropic', [call('', [write]), say('Wrote the collection.')]);
    const hooks = path.join(run.workspace, '.claude', 'hooks');
    await mkdir(hooks, { recursive: true });
    await writeFile(path.join(hooks, 'format.sh'), FORMAT);
    await chmod(path.join(hooks, 'format.sh'), 0o755);
    const command = '"$CLAUDE_PROJECT_DIR"/.claude/hooks/format.sh';
    await writeFile(path.join(run.workspace, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command }] }] } }));

    await acp.client({ name: 'e2e' }).connectWith(gcodeAgent(run.io, run.store, { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { _meta: { [WORKSPACE_TRUST_CAPABILITY]: true } } });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: run.workspace, mcpServers: [] });
      await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Add a posts collection.' }] });
    });

    expect(await readFile(path.join(run.workspace, 'src', 'posts.ts'), 'utf8')).toBe("export const posts = { slug: 'posts' };\n");
    const [result] = run.seen()[1]!.results;
    expect(result).toMatchObject({ id: 'tu_write', error: false });
    expect(result!.text.endsWith(`${GENO_NOTE} PostToolUse:Write hook additional context: ${CONTEXT}`)).toBe(true);
  });
});
