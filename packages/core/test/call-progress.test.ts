import { describe, expect, it } from 'vitest';
import { progressLabel, type CallProgress } from '../src/call-progress.js';

const at = 1_000_000;
const going: CallProgress = { requestAt: at, lastByteAt: null, limitMs: 180_000, writing: null, tokens: 0 };

describe('progressLabel', () => {
  it('says Thinking while a call has written nothing yet and is not long silent', () => {
    expect(progressLabel(going, at + 5_000)).toBe('Thinking');
    expect(progressLabel({ ...going, lastByteAt: at + 800 }, at + 20_000)).toBe('Thinking');
  });

  it('names what the model writes and about how many tokens it streamed', () => {
    const streaming = { ...going, lastByteAt: at + 10_000 };
    expect(progressLabel({ ...streaming, writing: { kind: 'thinking' }, tokens: 640 }, at + 10_500)).toBe('Thinking · ↓ 640 tokens');
    expect(progressLabel({ ...streaming, writing: { kind: 'tool', name: 'edit', target: 'src/game.ts' }, tokens: 7851 }, at + 10_500)).toBe('Writing edit src/game.ts · ↓ 7.9k tokens');
    expect(progressLabel({ ...streaming, writing: { kind: 'tool', name: 'bash' }, tokens: 61_234 }, at + 10_500)).toBe('Writing bash · ↓ 61.2k tokens');
    expect(progressLabel({ ...streaming, writing: { kind: 'text' }, tokens: 123_456 }, at + 10_500)).toBe('Writing the answer · ↓ 123k tokens');
  });

  it('says how long a call has had no response once that passes 30 s, and how long it waits', () => {
    expect(progressLabel(going, at + 29_999)).toBe('Thinking');
    expect(progressLabel(going, at + 42_000)).toBe('No response from the model after 42s · waiting up to 3m');
  });

  it('says how long ago a stream went quiet, whatever it wrote before', () => {
    const quiet: CallProgress = { ...going, lastByteAt: at + 1_000, writing: { kind: 'thinking' }, tokens: 3_200 };
    expect(progressLabel(quiet, at + 1_000 + 95_000)).toBe('The model went quiet 1m 35s ago · waiting up to 3m');
  });

  it('leaves out the wait when nothing watches the call', () => {
    expect(progressLabel({ ...going, limitMs: null }, at + 60_000)).toBe('No response from the model after 1m');
  });
});
