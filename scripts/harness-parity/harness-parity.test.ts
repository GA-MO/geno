import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from './page.mjs';
import { fromClaudeStream, spendSince } from './transcript.mjs';

const jsonl = (events: object[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

describe('fromClaudeStream', () => {
  const costOf = (events: object[]) => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'hp-stream-')), 'claude.jsonl');
    writeFileSync(file, jsonl(events));
    return fromClaudeStream(file).costUsd;
  };

  it("counts a resumed session's running total once, not once per segment", () => {
    expect(costOf([{ type: 'hp-user', text: 'a' }, { type: 'result', total_cost_usd: 0.2 }, { type: 'hp-user', text: 'go on' }, { type: 'result', total_cost_usd: 0.3 }, { type: 'hp-user', text: 'go on' }, { type: 'result', total_cost_usd: 0.45 }])).toBeCloseTo(0.45, 9);
  });

  it('adds a total that went down whole, and skips a failed start that reports zero or nothing', () => {
    expect(costOf([{ type: 'result', total_cost_usd: 0.3 }, { type: 'result', total_cost_usd: 0 }, { type: 'result' }, { type: 'result', total_cost_usd: 0.1 }, { type: 'result', total_cost_usd: 0.25 }])).toBeCloseTo(0.55, 9);
  });

  it('prices each line from the running total before it', () => {
    expect([spendSince(0, 0.2), spendSince(0.2, 0.2), spendSince(0.2, 0), spendSince(0.5, 0.1)]).toEqual([0.2, 0, 0, 0.1]);
  });
});

describe('serve', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'hp-serve-'));
  const root = path.join(parent, 'site');
  let server: http.Server;
  let slashed: http.Server;
  mkdirSync(path.join(parent, 'site-old'), { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'index.html'), 'inside');
  writeFileSync(path.join(parent, 'site-old', 'secret.html'), 'sibling');
  writeFileSync(path.join(parent, 'secret.html'), 'parent');

  beforeAll(async () => {
    server = await serve(root);
    slashed = await serve(`${root}${path.sep}`);
  });
  afterAll(() => {
    server.close();
    slashed.close();
  });

  const get = (rawPath: string, from = server) =>
    new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: (from.address() as AddressInfo).port, path: rawPath }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
    });

  it('serves the root and the files inside it, with or without a trailing separator on the root', async () => {
    for (const from of [server, slashed]) {
      expect(await get('/', from)).toEqual({ status: 200, body: 'inside' });
      expect(await get('/index.html', from)).toEqual({ status: 200, body: 'inside' });
    }
  });

  it.each([['/..%2fsite-old/secret.html'], ['/..%2fsecret.html'], ['/..%2f..%2f..%2fetc/hosts'], ['/%2e%2e%2fsite-old%2fsecret.html']])('refuses %s, outside the root', async (rawPath) => {
    expect((await get(rawPath)).status).toBe(404);
  });

  it('answers a path that is not valid percent-encoding with 400 and keeps serving', async () => {
    expect((await get('/%E0%A4%A')).status).toBe(400);
    expect((await get('/index.html')).status).toBe(200);
  });
});
