import { describe, expect, it } from 'vitest';
import { AGENT_PROMPTS } from '@g-code/core';
import { say, scripted, sessionIdOf, WIRES, type AnthropicWireModel, type Wire } from './scripted.js';

const OPUS: AnthropicWireModel = { provider: 'anthropic', model: 'claude-opus-5-5' };
const APPENDED = 'Answer every question in French.';

describe.each(WIRES)('the system prompt on the %s wire', (wire: Wire) => {
  it('T-ASM-05 --append-system-prompt text ends the system prompt, and a resumed run sends the same bytes', async () => {
    const { workspace, cli, openings } = await scripted(wire, [say('One.'), say('Two.')]);
    const first = await cli(['agent', '--workspace', workspace, '--append-system-prompt', APPENDED, 'Hi.']);
    expect(first.code).toBe(0);
    expect((await cli(['agent', '--session', sessionIdOf(first.stdout), '--append-system-prompt', APPENDED, 'Again.'])).code).toBe(0);
    const [one, two] = openings();
    expect(one!.system.endsWith(`\n\n${APPENDED}`)).toBe(true);
    expect(two!.system).toBe(one!.system);
  });

  it('T-ASM-05 the workspace setting appends its text, and the flag replaces it', async () => {
    const settings = { 'a.ts': 'export const a = 1;\n', '.gcode.json': JSON.stringify({ appendSystemPrompt: 'Use tabs.' }) };
    const { workspace, cli, openings } = await scripted(wire, [say('One.'), say('Two.')], settings);
    expect((await cli(['agent', '--workspace', workspace, 'Hi.'])).code).toBe(0);
    expect((await cli(['agent', '--workspace', workspace, '--append-system-prompt', APPENDED, 'Hi.'])).code).toBe(0);
    const [setting, flag] = openings();
    expect(setting!.system.endsWith('\n\nUse tabs.')).toBe(true);
    expect(flag!.system.endsWith(`\n\n${APPENDED}`)).toBe(true);
    expect(flag!.system).not.toContain('Use tabs.');
  });

  it("A/B-01 a cheap or unknown model's prompt opens with the rules tier", async () => {
    const { workspace, cli, openings } = await scripted(wire, [say('One.')]);
    expect((await cli(['agent', '--workspace', workspace, 'Hi.'])).code).toBe(0);
    expect(openings()[0]!.system.startsWith(AGENT_PROMPTS.rules)).toBe(true);
  });
});

describe('the prompt tier on the Anthropic wire', () => {
  it('A/B-01 a strong model gets the principles tier', async () => {
    const { workspace, cli, openings } = await scripted('anthropic', [say('One.')], undefined, OPUS);
    expect((await cli(['agent', '--workspace', workspace, 'Hi.'])).code).toBe(0);
    expect(openings()[0]!.system.startsWith(AGENT_PROMPTS.principles)).toBe(true);
  });

  it('T-ASM-06 a Haiku 4.5 request carries no effort, which Haiku refuses', async () => {
    const { workspace, cli, bodies } = await scripted('anthropic', [say('One.')], undefined, { provider: 'anthropic', model: 'claude-haiku-4-5' });
    expect((await cli(['agent', '--workspace', workspace, 'Hi.'])).code).toBe(0);
    expect(bodies()[0]).not.toHaveProperty('output_config');
  });
});
