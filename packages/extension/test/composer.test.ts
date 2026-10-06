import { describe, expect, it } from 'vitest';
import { composerView, NO_FACTS, type ComposerFacts, type ComposerInput } from '../src/chat/composer-model.js';
import type { McpListing } from '../src/chat/mcp-model.js';
import type { Action, Transcript } from '../src/chat/messages.js';
import { headerOf } from '../src/chat/rail.js';
import { emptyTranscript, reduce } from '../src/chat/transcript.js';

const STARTED = 1_000_000;
const transcriptOf = (...actions: Action[]): Transcript => actions.reduce(reduce, emptyTranscript('qwen3.8-flash'));
const start: Action = { type: 'turn-start', id: 't1', at: STARTED, prompt: 'Check the page' };
const end: Action = { type: 'turn-end', at: STARTED + 5000, status: 'done', usage: undefined };
const browse = (id: string, url: string): Action => ({ type: 'tool', id, at: STARTED + 1, name: 'mcp__browser__navigate_page', target: JSON.stringify({ url }), toolKind: 'other', status: 'completed' });

const EFFORT = {
  current: 'medium',
  options: [
    { value: 'low', name: 'Low' },
    { value: 'medium', name: 'Medium' },
    { value: 'high', name: 'High' },
  ],
};
const facts = (more: Partial<ComposerFacts> = {}): ComposerFacts => ({ ...NO_FACTS, provider: 'modelstudio', effort: EFFORT, bahtPerUsd: 32, ...more });
const browser = (status: 'ready' | 'stopped'): McpListing => ({
  kind: 'loaded',
  problems: [],
  servers: [
    {
      name: 'browser',
      source: 'builtin',
      startsOn: 'first-use',
      hash: 'h',
      definition: { kind: 'stdio', command: 'npx', args: [] } as never,
      state: status === 'ready' ? ({ status: 'ready' } as never) : ({ status: 'stopped' } as never),
      tools: ['navigate_page'],
    },
  ],
});
const input = (more: Partial<ComposerInput> = {}): ComposerInput => ({
  transcript: emptyTranscript('qwen3.8-flash'),
  facts: facts(),
  mcp: { kind: 'loading' },
  queued: undefined,
  now: STARTED,
  ...more,
});

describe('composerView, idle', () => {
  it('sends, names the model with its effort, and asks for the first change on an empty chat', () => {
    const view = composerView(input());
    expect(view.action).toBe('send');
    expect(view.running).toBeUndefined();
    expect(view.model).toEqual({ name: 'qwen3.8-flash', effort: 'Medium' });
    expect(view.placeholder).toBe('Describe the change you want, @ to add context, / for commands');
    expect(composerView(input({ transcript: transcriptOf(start, end) })).placeholder).toBe('Ask a follow-up, @ to add context, / for commands');
  });

  it('leaves the effort out until the engine offers it', () => {
    expect(composerView(input({ facts: facts({ effort: undefined }) })).model).toEqual({ name: 'qwen3.8-flash', effort: undefined });
  });

  it('offers each model and each effort, marks the current ones, and notes the cache cost of an effort change on Model Studio', () => {
    const models = [
      { provider: 'modelstudio', providerLabel: 'Alibaba Model Studio', model: 'qwen3.8-flash' },
      { provider: 'modelstudio', providerLabel: 'Alibaba Model Studio', model: 'qwen3.7-plus' },
      { provider: 'openrouter', providerLabel: 'OpenRouter', model: 'qwen3.8-flash' },
    ];
    const { menu } = composerView(input({ facts: facts({ models }) }));
    expect(menu.models.map((m) => `${m.provider}/${m.model}:${m.current}`)).toEqual(['modelstudio/qwen3.8-flash:true', 'modelstudio/qwen3.7-plus:false', 'openrouter/qwen3.8-flash:false']);
    expect(menu.efforts.map((e) => `${e.value}:${e.current}`)).toEqual(['low:false', 'medium:true', 'high:false']);
    expect(menu.note).toBe('A change mid-chat rewrites Model Studio’s cache once.');
    expect(composerView(input({ facts: facts({ models, provider: 'openrouter' }) })).menu.note).toBeUndefined();
  });
});

describe('composerView, the context ring', () => {
  it('is empty before any model call', () => {
    const { ring } = composerView(input());
    expect(ring.fraction).toBe(0);
    expect(ring.title).toBe('Context: nothing yet');
  });

  it('fills with the context over the window and gives the numbers', () => {
    const { ring } = composerView(input({ facts: facts({ context: { used: 250_000, window: 1_000_000 } }) }));
    expect(ring).toMatchObject({ fraction: 0.25, high: false, title: 'Context: 250,000 of 1,000,000 tokens (25%)' });
  });

  it('turns high at 80%, and says Geno has no compact yet', () => {
    const { ring } = composerView(input({ facts: facts({ context: { used: 800_000, window: 1_000_000 } }) }));
    expect(ring.high).toBe(true);
    expect(ring.title).toBe('Context: 800,000 of 1,000,000 tokens (80%). Start a new chat to free it; Geno cannot compact a chat yet.');
    expect(composerView(input({ facts: facts({ context: { used: 799_999, window: 1_000_000 } }) })).ring.high).toBe(false);
  });

  it('stays full rather than overflowing, and shows the tokens alone when the window is unknown', () => {
    expect(composerView(input({ facts: facts({ context: { used: 1_200_000, window: 1_000_000 } }) })).ring.fraction).toBe(1);
    const unknown = composerView(input({ facts: facts({ context: { used: 4_200, window: undefined } }) })).ring;
    expect(unknown).toMatchObject({ fraction: undefined, high: false, title: 'Context: 4,200 tokens. Geno does not know this model’s window.' });
  });
});

describe('composerView, the tray', () => {
  it('shows the browser while it runs, at the host it last opened', () => {
    const transcript = transcriptOf(start, browse('b1', 'http://localhost:5173/'), browse('b2', 'http://localhost:3000/about'));
    expect(composerView(input({ transcript, mcp: browser('ready') })).browser).toEqual({ label: 'Browser · localhost:3000', title: 'The browser is open at http://localhost:3000/about' });
  });

  it('names the browser alone before it opened a page, and hides it while stopped', () => {
    expect(composerView(input({ mcp: browser('ready') })).browser).toEqual({ label: 'Browser', title: 'The browser is running' });
    expect(composerView(input({ transcript: transcriptOf(start, browse('b1', 'http://localhost:3000/')), mcp: browser('stopped') })).browser).toBeUndefined();
  });

  it('shows a queued follow-up', () => {
    expect(composerView(input({ queued: 'and the footer too' })).queued).toBe('and the footer too');
  });
});

describe('composerView, running', () => {
  const running = transcriptOf(start);

  it('stops, asks for a follow-up to queue, and shows the time and the cost in baht, and no agents pill until a subagent runs', () => {
    const view = composerView(input({ transcript: running, now: STARTED + 65_000, facts: facts({ turnCostUsd: 0.0125 }) }));
    expect(view.action).toBe('stop');
    expect(view.placeholder).toBe('Queue a follow-up…');
    expect(view.running).toEqual({
      elapsed: '1:05',
      cost: { text: '฿0.40', title: '$0.0125 at ฿32 to the US dollar' },
    });
  });

  it('counts from zero, shows no cost before the first call, and says unknown for an unpriced model', () => {
    expect(composerView(input({ transcript: running, now: STARTED + 400 })).running).toMatchObject({ elapsed: '0:00', cost: undefined });
    expect(composerView(input({ transcript: running, facts: facts({ turnCostUsd: null }) })).running?.cost).toEqual({ text: '฿ unknown', title: 'This model has no price in Geno’s table' });
  });

  it('shows a cost under a satang as such, and hours past the hour', () => {
    const view = composerView(input({ transcript: running, now: STARTED + 3_725_000, facts: facts({ turnCostUsd: 0.0001 }) }));
    expect(view.running).toMatchObject({ elapsed: '1:02:05', cost: { text: '<฿0.01' } });
  });
});

describe('composerView, waiting', () => {
  const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const offline = { kind: 'offline', since: STARTED + 10_000, retryAt: STARTED + 22_000, resetAt: null, message: 'Connection error.: fetch failed: connect ECONNREFUSED' } as const;
  const waitsOffline: Action = { type: 'waiting', at: STARTED + 10_000, waiting: offline };

  it('shows the wait in place of the clock, with its failure as the title, and stops the clock while it waits', () => {
    const waiting = transcriptOf(start, waitsOffline);
    expect(composerView(input({ transcript: waiting, now: STARTED + 10_000 }), clock).running).toMatchObject({
      elapsed: '0:10',
      wait: { kind: 'offline', text: 'Offline, retrying in 12s', title: offline.message },
    });
    expect(composerView(input({ transcript: waiting, now: STARTED + 50_000 }), clock).running?.elapsed).toBe('0:10');
  });

  it('keeps an ended wait out of the clock once the call went out', () => {
    const resumed = transcriptOf(start, waitsOffline, { type: 'waiting', at: STARTED + 70_000, waiting: null });
    expect(composerView(input({ transcript: resumed, now: STARTED + 80_000 }), clock).running).toMatchObject({ elapsed: '0:20', wait: undefined });
  });

  it('names the time a limit resets', () => {
    const resetAt = Date.parse('2026-10-06T14:05:00Z');
    const limited = transcriptOf(start, { type: 'waiting', at: STARTED + 1000, waiting: { kind: 'limited', since: STARTED + 1000, retryAt: null, resetAt, message: '429' } });
    expect(composerView(input({ transcript: limited, now: STARTED + 2000 }), clock).running?.wait).toEqual({ kind: 'limited', text: 'Limited until 14:05', title: '429' });
  });

  it('leaves the waits out of the time a turn worked, once it ended', () => {
    const ended = transcriptOf(start, waitsOffline, { type: 'turn-end', at: STARTED + 70_000, status: 'done', usage: undefined });
    expect(ended.turns[0]).toMatchObject({ waiting: undefined, waitedMs: 60_000 });
    expect(headerOf(ended.turns[0]!, (ms) => `${ms / 1000}s`)).toBe('worked for 10s');
    expect(headerOf(transcriptOf(start, waitsOffline).turns[0]!, String)).toBe('waiting for the network');
  });
});
