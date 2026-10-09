import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { terminalConfirm } from '../src/terminal-confirm.js';

describe('terminalConfirm (ISSUES.md G-10)', () => {
  it('refuses a card with no terminal and says so on stderr', async () => {
    const stderr = new PassThrough();
    let said = '';
    stderr.on('data', (chunk: Buffer) => (said += chunk.toString()));
    const answer = await terminalConfirm(Object.assign(new PassThrough(), { isTTY: false }), stderr)('Allow `rm -rf build`? It deletes a folder.');
    expect(answer).toBe(false);
    expect(said).toBe('Allow `rm -rf build`? It deletes a folder. There is no terminal to answer, so it was refused.\n');
  });

  it('takes a yes typed at a terminal', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const pending = terminalConfirm(stdin, new PassThrough())('Allow it?');
    stdin.write('yes\n');
    expect(await pending).toBe(true);
  });
});
