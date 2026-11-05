import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseVotes } from './agree.mjs';
import { CHECKS, contrastRatio, regressions, score } from './checks.mjs';
import { decodePng } from './png.mjs';
import { decide, pairVerdict, parseOptions } from './rules.mjs';
import { behaviour } from './stats.mjs';

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
