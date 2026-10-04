import { describe, expect, it } from 'vitest';
import { buildFimPrompt, DEFAULT_FIM_BUDGET, streamFim } from '../src/tab/index.js';

const sse = (chunks: object[]): Response => {
  const encoder = new TextEncoder();
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  // Split mid-line so the decoder has to carry a partial line across reads.
  const cut = Math.floor(text.length / 2);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text.slice(0, cut)));
      controller.enqueue(encoder.encode(text.slice(cut)));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
};

describe('streamFim', () => {
  it('joins streamed text and reads the final chunk for model, prompt size and timings', async () => {
    let clock = 0;
    let sent: { url: string; body: unknown } | undefined;
    const result = await streamFim({
      endpoint: 'http://127.0.0.1:9',
      prompt: buildFimPrompt({ repo: 'r', path: 'a.ts', prefix: 'const a = ', suffix: '', snippets: [] }, DEFAULT_FIM_BUDGET),
      now: () => (clock += 5),
      fetch: async (url, init) => {
        sent = { url: String(url), body: JSON.parse(String(init?.body)) };
        return sse([
          { content: '', stop: false },
          { content: 'return ', stop: false },
          { content: 'a;', stop: false },
          {
            content: '',
            stop: true,
            model: 'qwen',
            tokens_evaluated: 12,
            timings: { prompt_n: 12, prompt_ms: 30, predicted_n: 3, predicted_ms: 20 },
          },
        ]);
      },
    });
    expect(sent!.url).toBe('http://127.0.0.1:9/completion');
    expect(sent!.body).toMatchObject({ stream: true, cache_prompt: true, temperature: 0 });
    expect((sent!.body as { stop: string[] }).stop).toContain('\n');
    expect(result).toEqual({
      text: 'return a;',
      model: 'qwen',
      ttftMs: 5,
      latencyMs: 10,
      promptTokens: 12,
      timings: { promptTokens: 12, promptMs: 30, predictedTokens: 3, predictedMs: 20 },
    });
  });
});
