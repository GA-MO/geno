// Asks Model Studio one short question per variant and prints what each effort or thinking setting did.
// Usage: node scripts/effort-probe.mjs [variant...]; variants: low, medium, high, none, thinking-disabled.
// Reads DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL from the repo's .env and never prints either.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const env = { ...parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8')), ...process.env };
const key = env.DASHSCOPE_API_KEY;
const base = env.DASHSCOPE_BASE_URL;
if (!key || !base) throw new Error('set DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL in .env');

const VARIANTS = {
  low: { output_config: { effort: 'low' } },
  medium: { output_config: { effort: 'medium' } },
  high: { output_config: { effort: 'high' } },
  none: {},
  'thinking-disabled': { output_config: { effort: 'medium' }, thinking: { type: 'disabled' } },
};

const QUESTION = 'How many times does the letter r appear in "strawberry raspberry cranberry"? Reply with only the number.';

async function probe(variant) {
  const body = { model: 'qwen3.8-flash', max_tokens: 4000, stream: true, messages: [{ role: 'user', content: QUESTION }], ...VARIANTS[variant] };
  const started = performance.now();
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) return { variant, status: response.status, error: text.slice(0, 500) };
  const events = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)));
  const blocks = events.filter((e) => e.type === 'content_block_start').map((e) => e.content_block.type);
  const thinkingChars = events.reduce((n, e) => n + (e.delta?.type === 'thinking_delta' ? e.delta.thinking.length : 0), 0);
  const answer = events.map((e) => (e.delta?.type === 'text_delta' ? e.delta.text : '')).join('');
  const usage = events.findLast((e) => e.type === 'message_delta')?.usage;
  const sent = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'messages'));
  return { variant, sent, status: response.status, ms: Math.round(performance.now() - started), blocks, thinkingChars, answer, usage };
}

for (const variant of process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(VARIANTS)) {
  if (!Object.hasOwn(VARIANTS, variant)) throw new Error(`unknown variant ${variant}; one of ${Object.keys(VARIANTS).join(', ')}`);
  console.log(JSON.stringify(await probe(variant)));
}
