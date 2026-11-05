import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseVotes } from './agree.mjs';
import { CHECKS, contrastRatio, regressions, score } from './checks.mjs';
import { decodePng } from './png.mjs';
import { decide, pairVerdict, parseOptions } from './rules.mjs';
import { roundsOf, spentBy } from './logs.mjs';
import { behaviour } from './stats.mjs';
import { FEEDBACK, PROMPT } from './task.mjs';

describe('parseOptions', () => {
  it('fills the defaults the results doc names', () => {
    expect(parseOptions([])).toMatchObject({ round: 'l1', runs: 3, model: 'claude-sonnet-5-5', budget: 15, parallel: 3, judge: 'api', stability: 9 });
  });
  it.each([
    [['--runs', '0'], /--runs must be a whole number from 1 to 5/],
    [['--runs', '-2'], /--runs/],
    [['--runs', '2.5'], /--runs/],
    [['--runs', '1e3'], /--runs/],
    [['--runs', ''], /--runs/],
    [['--budget', 'NaN'], /--budget/],
    [['--budget', '0'], /--budget/],
    [['--budget', '-5'], /--budget/],
    [['--budget', '1000000'], /--budget/],
    [['--round', '../../etc'], /--round/],
    [['--round', 'R1 x'], /--round/],
    [['--model', 'claude-opus-5-5'], /Opus judges/],
    [['--judge', 'gpt'], /--judge/],
    [['--only', 'deploy'], /--only/],
    [['--parallel', '99'], /--parallel/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseOptions(argv)).toThrow(message);
  });
  it('refuses an unknown flag instead of ignoring it', () => {
    expect(() => parseOptions(['--rounds', '3'])).toThrow();
  });
});

describe('the win rule', () => {
  const side = (o = {}) => ({ brief: 30, quality: 25, motion: 25, judgeWins: 6, costUsd: 3, ...o });
  it('gives the win to a side that is no worse on every check group and wins 6 of 9 pairs', () => {
    expect(decide({ claude: side({ judgeWins: 2 }), geno: side() }, 9)).toEqual({ winner: 'geno', cheaper: 'same' });
  });
  it('is a tie at 5 of 9 pairs, naming the cheaper side', () => {
    expect(decide({ claude: side({ judgeWins: 4, costUsd: 2 }), geno: side({ judgeWins: 5 }) }, 9)).toEqual({ winner: 'tie', cheaper: 'claude' });
  });
  it('is a tie when the judge winner passes fewer checks in any group', () => {
    expect(decide({ claude: side({ judgeWins: 1 }), geno: side({ judgeWins: 8, motion: 24 }) }, 9).winner).toBe('tie');
  });
  it('scales the pairs needed with the runs', () => {
    expect(decide({ claude: side({ judgeWins: 3 }), geno: side({ judgeWins: 0 }) }, 4).winner).toBe('claude');
  });
  it('counts a pair only when both orders agree', () => {
    expect(pairVerdict({ winner: 'A' }, { winner: 'B' })).toBe('claude');
    expect(pairVerdict({ winner: 'A' }, { winner: 'A' })).toBe('tie');
    expect(pairVerdict({ winner: 'tie' }, { winner: 'A' })).toBe('tie');
  });
});

describe('score', () => {
  it('fails every check with the reason when the page could not be measured', () => {
    const s = score({ fatal: 'there is no index.html' });
    expect(Object.values(s).every((r) => !r.pass && r.detail === 'there is no index.html')).toBe(true);
    expect(Object.keys(s)).toHaveLength(CHECKS.length);
  });
  it('fails the checks of a session that broke and names why, instead of throwing', () => {
    const s = score({ errors: { reduced: 'the page stopped answering (Runtime.evaluate)' } });
    expect(s['reduced-motion']).toMatchObject({ pass: false, detail: 'could not measure: the page stopped answering (Runtime.evaluate)' });
    expect(s.plans.pass).toBe(false);
  });
  it('lists the checks that passed before and fail after', () => {
    expect(regressions({ a: { pass: true }, b: { pass: false }, c: { pass: true } }, { a: { pass: false }, b: { pass: true }, c: { pass: true } })).toEqual(['a']);
  });
});

describe('the brief checks read meaning, not heading words', () => {
  const page = (headings: { text: string; body: string }[], extra = {}) => ({ errors: {}, brief: { text: 'x'.repeat(4000), headings, blocks: [], subscribes: [], links: [], ...extra } });
  it('finds an FAQ under an editorial heading, and needs both freshness and grinding', () => {
    expect(score(page([{ text: 'Freshness and grinding, answered.', body: 'How fresh is it? Roasted Monday. Can you grind it? Yes.' }])).faq.pass).toBe(true);
    expect(score(page([{ text: 'Questions', body: 'How fresh is it? Very. Do you ship abroad? No.' }])).faq).toMatchObject({ pass: false, detail: 'no FAQ covers both freshness and grinding' });
  });
  it('does not count the hero heading, whose section is the whole page', () => {
    const all = 'Questions? Is it fresh? Can you grind? farms, organic certification, packaging '.repeat(60);
    const s = score({ errors: {}, brief: { text: all, headings: [{ text: 'BeanCraft', body: all }], blocks: [], subscribes: [], links: [] } });
    expect([s.faq.pass, s.sustainability.pass]).toEqual([false, false]);
  });
  it('takes a PDF the page builds as a blob behind a link that says PDF', () => {
    expect(score(page([], { links: [{ href: 'blob:http://127.0.0.1/1f2e', text: 'Download the brew guide (PDF)', download: false }] })).pdf.pass).toBe(true);
    expect(score(page([], { links: [{ href: 'blob:http://127.0.0.1/1f2e', text: 'Open', download: false }] })).pdf.pass).toBe(false);
    expect(score(page([], { links: [{ href: 'not a url', text: 'PDF', download: true }] })).pdf.pass).toBe(false);
  });
});

describe('contrastRatio', () => {
  it('matches WCAG for black on white and blends translucent text', () => {
    expect(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 0);
    expect(contrastRatio([0, 0, 0, 0], [255, 255, 255, 1])).toBeCloseTo(1, 5);
  });
});

describe('parseVotes', () => {
  it('reads the code the page shows', () => {
    expect(parseVotes('1A-2b-3T', 3)).toEqual({ 1: 'A', 2: 'B', 3: 'T' });
    expect(parseVotes(' 1a, 2b ,3t ', 3)).toEqual({ 1: 'A', 2: 'B', 3: 'T' });
  });
  it.each([
    ['', /no vote for 1, 2, 3/],
    [undefined, /no vote for/],
    ['1A-2B', /no vote for 3/],
    ['1A-1B-2B-3A', /pair 1 is voted twice/],
    ['1A-2B-3X', /"3X" is not a vote/],
    ['1A-2B-3A-4B', /no pair 4/],
    ['A-B-T', /"A" is not a vote/],
    ['1A-2B-3T%00', /is not a vote/],
  ])('refuses %j', (code, message) => {
    expect(() => parseVotes(code, 3)).toThrow(message);
  });
});

describe('decodePng', () => {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const png = (color: number, rows: number[][]) => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(rows[0].length / (color === 6 ? 4 : 3), 0);
    header.writeUInt32BE(rows.length, 4);
    header[8] = 8;
    header[9] = color;
    const raw = Buffer.concat(rows.map((r) => Buffer.from([0, ...r])));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  };
  it('reads RGB pixels', () => {
    const img = decodePng(png(2, [[255, 0, 0, 0, 255, 0]]));
    expect([img.width, img.height, [...img.data]]).toEqual([2, 1, [255, 0, 0, 0, 255, 0]]);
  });
  it('refuses what is not a PNG, and a palette PNG it cannot read', () => {
    expect(() => decodePng(Buffer.from('GIF89a'))).toThrow('not a PNG');
    expect(() => decodePng(Buffer.alloc(0))).toThrow('not a PNG');
    expect(() => decodePng(png(3, [[0, 0, 0]]))).toThrow(/only 8-bit/);
  });
});

describe('behaviour', () => {
  it('counts a write over a file that existed as a rewrite, and screenshots by name or input', () => {
    const steps = [
      { kind: 'tool', name: 'write', input: { file_path: '/w/index.html', content: 'take a screenshot' } },
      { kind: 'tool', name: 'browser_take_screenshot', input: {} },
      { kind: 'tool', name: 'browser', input: { action: 'screenshot' } },
      { kind: 'tool', name: 'edit', input: { file_path: '/w/index.html' }, error: true },
      { kind: 'tool', name: 'bash', input: { command: "sed -i '' s/a/b/ index.html" } },
    ];
    expect(behaviour(steps, ['index.html'])).toEqual({ screenshots: 2, edits: 1, writes: 1, rewrites: 1, shellWrites: 1, toolErrors: 1, toolCalls: 5 });
    expect(behaviour(steps).rewrites).toBe(0);
    expect(behaviour([])).toMatchObject({ screenshots: 0, toolCalls: 0 });
  });
});

describe('roundsOf', () => {
  const job = () => mkdtempSync(path.join(tmpdir(), 'landing-job-'));
  const jsonl = (rows: object[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
  it("takes Claude Code's running session total apart into rounds instead of adding it up", () => {
    const dir = job();
    writeFileSync(path.join(dir, 'claude.jsonl'), jsonl([{ type: 'hp-user', text: PROMPT }, { type: 'result', total_cost_usd: 0.2373 }, { type: 'hp-user', text: FEEDBACK }, { type: 'result', total_cost_usd: 0.3513 }]));
    const [a, b] = roundsOf(dir, 'claude');
    expect([a.costUsd, b.costUsd].map((c) => Math.round(c * 1e4) / 1e4)).toEqual([0.2373, 0.114]);
    expect(spentBy(dir, 'claude')).toBeCloseTo(0.3513, 6);
  });
  it('adds a total that went down, as a count that started again', () => {
    const dir = job();
    writeFileSync(path.join(dir, 'claude.jsonl'), jsonl([{ type: 'result', total_cost_usd: 0.3 }, { type: 'hp-user', text: FEEDBACK }, { type: 'result', total_cost_usd: 0.1 }]));
    expect(roundsOf(dir, 'claude').map((r) => r.costUsd)).toEqual([0.3, 0.1]);
  });
  it("counts Geno's whole-file edit(create) as a write, and its cost per round", () => {
    const dir = job();
    const id = '7d719fc9-54b6-4d7b-b74d-7342baf1002f';
    writeFileSync(path.join(dir, 'geno.out'), `session: ${id}\n`);
    mkdirSync(path.join(dir, 'home/.gcode/sessions'), { recursive: true });
    writeFileSync(path.join(dir, `home/.gcode/sessions/${id}.jsonl`), jsonl([
      { kind: 'user', content: PROMPT },
      { kind: 'assistant', costUsd: 0.5, content: [{ type: 'tool_use', id: 't1', name: 'edit', input: { path: 'index.html', create: true, new_str: '<html>' } }] },
      { kind: 'user', content: FEEDBACK },
      { kind: 'assistant', costUsd: 0.25, content: [{ type: 'tool_use', id: 't2', name: 'edit', input: { path: 'index.html', create: true, new_str: '<html>' } }, { type: 'tool_use', id: 't3', name: 'edit', input: { path: 'index.html', old_str: 'a', new_str: 'b' } }] },
    ]));
    const [a, b] = roundsOf(dir, 'geno');
    expect([a.costUsd, b.costUsd]).toEqual([0.5, 0.25]);
    expect([a.behaviour.writes, a.behaviour.edits, b.behaviour.writes, b.behaviour.rewrites, b.behaviour.edits]).toEqual([1, 0, 1, 1, 1]);
  });
  const failedStart = jsonl([{ type: 'result', total_cost_usd: 0.24 }, { type: 'hp-user', text: FEEDBACK }, { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 }, { type: 'result', total_cost_usd: 0.35 }]);
  it('skips the zero total of a failed start', () => {
    const dir = job();
    writeFileSync(path.join(dir, 'claude.jsonl'), failedStart);
    expect(roundsOf(dir, 'claude').map((r) => Math.round(r.costUsd * 100) / 100)).toEqual([0.24, 0.11]);
  });
  it('still counts the spend of a run whose last log line a crash cut off', () => {
    const dir = job();
    writeFileSync(path.join(dir, 'claude.jsonl'), `${failedStart}{"type":"result","total_co`);
    expect(spentBy(dir, 'claude')).toBeCloseTo(0.35, 6);
  });
  it('reads a run that never started as zero, not a crash', () => {
    const dir = job();
    expect(roundsOf(dir, 'claude').map((r) => r.costUsd)).toEqual([0, 0]);
    expect(roundsOf(dir, 'geno').map((r) => r.behaviour.toolCalls)).toEqual([0, 0]);
    expect(spentBy(dir, 'geno')).toBe(0);
  });
});

describe('the shipping check names every weekday', () => {
  const page = (body: string) => ({ errors: {}, brief: { text: 'x'.repeat(4000), headings: [{ text: 'Delivery', body }], blocks: [], subscribes: [], links: [] } });
  it.each([['We ship every Wednesday.', true], ['Roast Tuesday, ship Thursday.', true], ['Ships Saturdays.', true], ['Roasted Mon–Tue, ships Wed.', true], ['Sun-dried beans ship fast.', false], ['We ship quickly.', false], ['Wednesday-roasted, shipped the same day.', true]])('%s', (body, pass) => {
    expect(score(page(body)).shipping.pass).toBe(pass);
  });
});
