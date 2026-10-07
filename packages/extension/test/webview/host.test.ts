import { describe, expect, it } from 'vitest';
import type { ToView } from '../../src/chat/messages.js';
import { FakeHost } from './host.js';

describe('FakeHost', () => {
  const hostOf = () => {
    const delivered: ToView[] = [];
    const host = new FakeHost(async (message) => void delivered.push(message), { model: 'm', turns: [] });
    return { host, delivered };
  };

  it('returns each message of a type once, in order, including ones sent before the wait', async () => {
    const { host } = hostOf();
    host.receive({ type: 'send', text: 'one' });
    host.receive({ type: 'stop' });
    const first = host.next('send');
    const second = host.next('send');
    host.receive({ type: 'send', text: 'two' });
    expect([(await first).text, (await second).text]).toEqual(['one', 'two']);
    expect(await host.next('stop')).toEqual({ type: 'stop' });
  });

  it('names what the view did send when the awaited message never comes', async () => {
    const { host } = hostOf();
    host.receive({ type: 'ready' });
    await expect(host.next('stop', 50)).rejects.toThrow('the view sent no stop within 50ms; it sent ready');
  });

  it('applies each action with the extension reducer before delivering it', async () => {
    const { host, delivered } = hostOf();
    await host.act({ type: 'turn-start', id: 't0', at: 1, prompt: 'hi' }, { type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' });
    expect(host.transcript.turns.map((t) => [t.prompt, t.blocks])).toEqual([['hi', [{ kind: 'text', id: expect.any(String), text: 'Hello' }]]]);
    expect(delivered.map((m) => m.type)).toEqual(['turn-start', 'text', 'text']);
  });

  it('runs a handler that waits for a later message beside the others, and reports the first that threw', async () => {
    const { host } = hostOf();
    const order: string[] = [];
    host.on('send', async () => {
      await host.next('stop');
      order.push('send saw stop');
    });
    host.on('stop', () => {
      order.push('stop');
      throw new Error('stop failed');
    });
    host.receive({ type: 'send', text: 'x' });
    host.receive({ type: 'stop' });
    await expect(host.settled()).rejects.toThrow('stop failed');
    expect(order).toEqual(['stop', 'send saw stop']);
  });
});
