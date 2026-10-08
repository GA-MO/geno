import { describe, expect, it } from 'vitest';
import { call, say, scripted, WIRES, type AnthropicWireModel } from './scripted.js';

const OPUS: AnthropicWireModel = { provider: 'anthropic', model: 'claude-opus-5-5' };
const FLASH: AnthropicWireModel = { provider: 'modelstudio', model: 'qwen3.8-flash' };

type CacheControl = { readonly type: string; readonly ttl?: string };
type Block = { readonly type: string; readonly text?: string; readonly cache_control?: CacheControl };
type Body = { readonly system: readonly Block[]; readonly messages: readonly { readonly content: string | readonly Block[] }[] };

/** Every cache breakpoint of a request, the system blocks' first. */
const breakpoints = (body: Body): CacheControl[] =>
  [...body.system, ...body.messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content))].flatMap((block) => (block.cache_control === undefined ? [] : [block.cache_control]));

/** One tool round, so the second request carries a tool result breakpoint as well as the system one. */
async function bodiesOf(model: AnthropicWireModel): Promise<Body[]> {
  const { workspace, cli, bodies } = await scripted('anthropic', [call('Looking.', [{ id: 'tu_read', name: 'read', input: { path: 'a.ts' } }]), say('Done.')], undefined, model);
  expect((await cli(['agent', '--workspace', workspace, '--non-interactive', 'Read a.ts.'])).code).toBe(0);
  return bodies();
}

// Request fields are the Anthropic wire's: Chat Completions has no cache_control, thinking or output_config.
describe('request assembly on the Anthropic wire', () => {
  it('T-ASM-01 caches the system prompt and every breakpoint for 1 h on Anthropic, with no billing header', async () => {
    const sent = await bodiesOf(OPUS);
    for (const body of sent) {
      expect(body.system.length).toBeGreaterThan(0);
      for (const block of body.system) expect(block.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
      expect(body.system.some((block) => block.text?.startsWith('x-anthropic-billing-header'))).toBe(false);
      expect(breakpoints(body).every((control) => control.ttl === '1h')).toBe(true);
    }
    expect(breakpoints(sent[1]!)).toHaveLength(2);
  });

  it('T-ASM-01 keeps the default TTL on Model Studio until a longer one is tested there', async () => {
    for (const body of await bodiesOf(FLASH)) expect(breakpoints(body).every((control) => control.ttl === undefined)).toBe(true);
  });

  it('T-ASM-06 a session at effort medium asks for adaptive thinking and the full 128,000 output tokens', async () => {
    const { cli, bodies } = await scripted('anthropic', [say('Hello.')], undefined, OPUS);
    expect((await cli(['chat', '--effort', 'medium', 'Hi.'])).code).toBe(0);
    expect(bodies()[0]).toMatchObject({
      model: 'claude-opus-5-5',
      output_config: { effort: 'medium' },
      thinking: { type: 'adaptive', display: 'omitted' },
      max_tokens: 128_000,
    });
  });

  it('T-ASM-06 near a full window, max_tokens shrinks so the input and the answer fit the window', async () => {
    const input = 950_000;
    const { workspace, cli, bodies } = await scripted('anthropic', [call('Looking.', [{ id: 'tu_read', name: 'read', input: { path: 'a.ts' } }], { input }), say('Done.')], undefined, OPUS);
    // A 950,000-token call is priced at Opus rates, past the default budget.
    expect((await cli(['agent', '--workspace', workspace, '--non-interactive', '--max-cost', '10', 'Read a.ts.'])).code).toBe(0);
    const [first, next] = bodies() as { max_tokens: number }[];
    expect(first!.max_tokens).toBe(128_000);
    expect(next!.max_tokens).toBeGreaterThan(0);
    expect(input + next!.max_tokens).toBeLessThanOrEqual(1_000_000 - 1_000);
    expect(next!.max_tokens).toBeGreaterThan(1_000_000 - input - 2_000);
  });
});

describe('T-ASM-15 eager input streaming', () => {
  type Tools = { readonly tools?: readonly { readonly name?: string; readonly eager_input_streaming?: boolean }[] };
  const sent = async (wire: (typeof WIRES)[number], model?: AnthropicWireModel): Promise<Tools[]> => {
    const { workspace, cli, bodies } = await scripted(wire, [call('Looking.', [{ id: 'tu_read', name: 'read', input: { path: 'a.ts' } }]), say('Done.')], undefined, model);
    expect((await cli(['agent', '--workspace', workspace, '--non-interactive', 'Read a.ts.'])).code).toBe(0);
    return bodies() as Tools[];
  };

  it('T-ASM-15 every tool on the Anthropic API has eager_input_streaming: true, and a streamed tool call still runs', async () => {
    const bodies = await sent('anthropic', OPUS);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.tools!.length).toBeGreaterThan(5);
      for (const tool of body.tools!) expect(tool, tool.name).toMatchObject({ eager_input_streaming: true });
    }
  });

  it('T-ASM-15 a Chat Completions request and Model Studio\'s Anthropic endpoint never carry it', async () => {
    for (const body of [...(await sent('openai')), ...(await sent('anthropic', FLASH))]) {
      expect(body.tools!.length).toBeGreaterThan(5);
      expect(JSON.stringify(body)).not.toContain('eager_input_streaming');
    }
  });
});
