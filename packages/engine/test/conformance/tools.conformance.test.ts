import { afterEach, describe, expect, it } from 'vitest';
import { call, closeServers, say, scripted, WIRES, type SeenResult, type Wire } from './scripted.js';

afterEach(closeServers);

const COMMANDS = { failing: 'cat missing.txt', passing: 'cat a.ts' } as const;

/** Runs one non-interactive turn in which the model calls bash with `command`, and returns the result it got back. */
async function bashResult(wire: Wire, command: string): Promise<SeenResult> {
  const { workspace, cli, seen } = await scripted(wire, [call('', [{ id: 'tu_bash', name: 'bash', input: { command } }]), say('Done.')]);
  expect((await cli(['agent', '--workspace', workspace, '--non-interactive', 'Run it.'])).code).toBe(0);
  return seen()[1]!.results[0]!;
}

describe.each(WIRES)('tools on the %s wire', (wire) => {
  it('T-TOOL-12 a non-zero exit is an error result that says the exit code first', async () => {
    const failed = await bashResult(wire, COMMANDS.failing);
    expect(failed.error).toBe(true);
    expect(failed.text).toMatch(/^Exit code 1\n.*missing\.txt.*No such file or directory\n\[exit code 1\]$/s);

    const passed = await bashResult(wire, COMMANDS.passing);
    expect(passed).toEqual({ id: 'tu_bash', error: false, text: 'export const a = 1;\n[exit code 0]' });
  });
});
