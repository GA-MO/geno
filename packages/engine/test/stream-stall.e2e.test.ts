import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chatAnswer, fakeOpenAiServer, type ChatReply } from './fake-openai.js';
import { answer, fakeTransport, type Reply } from './fake-transport.js';
import { runCli } from './helpers.js';

// A stall waits out its limit and the backoff before the next try, so each case takes about two seconds.
const STALL_TEST_MS = 15_000;
const LIMITS = { GCODE_STREAM_FIRST_BYTE_TIMEOUT_MS: '400', GCODE_STREAM_IDLE_TIMEOUT_MS: '400' };
// A live stream's gaps stay four times inside its limit, so a loaded machine's late timer does not read as silence.
const LIVE_LIMITS = { GCODE_STREAM_FIRST_BYTE_TIMEOUT_MS: '1000', GCODE_STREAM_IDLE_TIMEOUT_MS: '1000' };
const LIVE_GAP_MS = 250;
const usage = { input: 10, cacheRead: 0, cacheWrite: 0 };

const home = () => mkdtemp(path.join(tmpdir(), 'gcode-stall-'));

describe('a model call that goes quiet, on the Messages wire (Model Studio)', () => {
  async function chatOver(replies: readonly Reply[], limits = LIMITS) {
    const transport = fakeTransport(replies);
    const env = { GCODE_HOME: await home(), GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'test-key', DASHSCOPE_BASE_URL: 'https://dashscope.test/apps/anthropic', ...limits };
    const result = await runCli(['chat', 'hi'], env, { fetch: transport.fetch });
    return { ...result, requests: transport.requests.length };
  }

  it('retries a call that got no answer at all, not even headers', { timeout: STALL_TEST_MS }, async () => {
    const result = await chatOver([{ ...answer('Never.', usage), hang: true }, answer('Back.', usage)]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Back.');
    expect(result.stderr).toMatch(/^retry 1 in 1\.0s: the model sent no response for 0\.4s$/m);
    expect(result.requests).toBe(2);
  });

  it('retries a stream that went quiet after it began thinking', { timeout: STALL_TEST_MS }, async () => {
    const result = await chatOver([{ ...answer('Never.', usage), stallAfter: 3 }, answer('Back.', usage)]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Back.');
    expect(result.stderr).toMatch(/^retry 1 in 1\.0s: the model stopped responding for 0\.4s$/m);
  });

  it('fails the turn when the retry goes quiet too, naming the setting to raise', { timeout: STALL_TEST_MS }, async () => {
    const result = await chatOver([{ ...answer('Never.', usage), hang: true }, { ...answer('Never.', usage), hang: true }, answer('Not asked for.', usage)]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/the model sent no response for 0\.4s.*GCODE_STREAM_FIRST_BYTE_TIMEOUT_MS/);
    expect(result.requests).toBe(2);
  });

  it('keeps a slow stream whose every gap is shorter than the limit, however long it runs', { timeout: STALL_TEST_MS }, async () => {
    const result = await chatOver([{ ...answer('Slow and steady.', usage, { chunk: 2 }), everyMs: LIVE_GAP_MS }], LIVE_LIMITS);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Slow and steady.');
    expect(result.stderr).toBe('');
  });

  it('counts the provider’s keepalive pings as the stream being alive', { timeout: STALL_TEST_MS }, async () => {
    const reply = answer('After a long think.', usage);
    const pings = Array.from({ length: 8 }, () => ({ type: 'ping' }));
    const result = await chatOver([{ events: [reply.events[0]!, ...pings, ...reply.events.slice(1)], everyMs: LIVE_GAP_MS }], LIVE_LIMITS);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('After a long think.');
    expect(result.stderr).toBe('');
  });
});

describe('a model call that goes quiet, on the Chat Completions wire', () => {
  let servers: { close(): Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers = [];
  });

  async function chatOver(replies: readonly ChatReply[], limits = LIMITS) {
    const server = await fakeOpenAiServer(replies);
    servers.push(server);
    const env = { GCODE_HOME: await home(), GCODE_PROVIDER: 'openai', GCODE_MODEL: 'gpt-fake', OPENAI_API_KEY: 'sk-test-0123456789', GCODE_OPENAI_BASE_URL: server.url, ...limits };
    const result = await runCli(['chat', 'hi'], env);
    return { ...result, requests: server.chats().length };
  }
  const chatUsage = { prompt: 10, completion: 5, cached: 0 };

  it('retries a call that got no answer at all, not even headers', { timeout: STALL_TEST_MS }, async () => {
    const result = await chatOver([{ ...chatAnswer('Never.', chatUsage), hang: true }, chatAnswer('Back.', chatUsage)]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Back.');
    expect(result.stderr).toMatch(/^retry 1 in 1\.0s: the model sent no response for 0\.4s$/m);
    expect(result.requests).toBe(2);
  });

  it('retries a stream that went quiet after some reasoning and text', { timeout: STALL_TEST_MS }, async () => {
    const result = await chatOver([{ ...chatAnswer('Never said in full.', chatUsage), stallAfter: 2 }, chatAnswer('Back.', chatUsage)]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Back.');
    expect(result.stderr).toMatch(/^retry 1 in 1\.0s: the model stopped responding for 0\.4s$/m);
  });

  it('fails the turn when the retry goes quiet too, naming the setting to raise', { timeout: STALL_TEST_MS }, async () => {
    const quiet = { ...chatAnswer('Never.', chatUsage), stallAfter: 1 };
    const result = await chatOver([quiet, quiet, chatAnswer('Not asked for.', chatUsage)]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/the model stopped responding for 0\.4s.*GCODE_STREAM_IDLE_TIMEOUT_MS/);
    expect(result.requests).toBe(2);
  });

  it('keeps a slow stream whose every gap is shorter than the limit, however long it runs', { timeout: STALL_TEST_MS }, async () => {
    const result = await chatOver([{ ...chatAnswer('A slow but steady answer here.', chatUsage), everyMs: LIVE_GAP_MS }], LIVE_LIMITS);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('A slow but steady answer here.');
    expect(result.stderr).toBe('');
  });

  it('counts keepalive comments as the stream being alive', { timeout: STALL_TEST_MS }, async () => {
    const late = chatAnswer('Late.', chatUsage);
    const result = await chatOver([{ chunks: late.chunks.slice(1), everyMs: 1200, keepAliveMs: LIVE_GAP_MS }], LIVE_LIMITS);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Late.');
    expect(result.stderr).toBe('');
  });
});
