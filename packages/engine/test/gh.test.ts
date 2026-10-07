import { describe, expect, it } from 'vitest';
import { argvOf, ghEnv, ghFailure, lookUpPr, parseChecks, parsePr, prReport, type Gh, type GhCall, type GhResult } from '../src/gh.js';

const PR_JSON = JSON.stringify({ number: 7, title: 'Fix it', url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: true, reviewDecision: '', headRefName: 'fix', extra: 1 });
const ran = (code: number, stdout = '', stderr = ''): Extract<GhResult, { kind: 'ran' }> => ({ kind: 'ran', code, stdout, stderr, timedOut: false });

/** A gh that answers each call kind from a table and records the calls. */
function scripted(answers: Partial<Record<GhCall['kind'], GhResult>>) {
  const calls: GhCall[] = [];
  const gh: Gh = async (call) => {
    calls.push(call);
    return answers[call.kind] ?? ran(2, '', 'unexpected');
  };
  return { gh, calls };
}

describe('the gh commands Geno runs', () => {
  it('are the three read-only commands, with the whole argv fixed', () => {
    expect(argvOf({ kind: 'pr-view' })).toEqual(['pr', 'view', '--json', 'number,title,url,state,isDraft,reviewDecision,headRefName']);
    expect(argvOf({ kind: 'pr-checks' })).toEqual(['pr', 'checks', '--json', 'name,workflow,bucket,link']);
    expect(argvOf({ kind: 'failed-log', job: '123' })).toEqual(['run', 'view', '--job', '123', '--log-failed']);
  });

  it('refuse a job id that could smuggle a flag', () => {
    expect(() => argvOf({ kind: 'failed-log', job: '1 --web' })).toThrow('not a job id');
    expect(() => argvOf({ kind: 'failed-log', job: '--repo=evil/x' })).toThrow('not a job id');
  });

  it("see gh's login and proxy but never a provider key, and never prompt or page", () => {
    const env = ghEnv({ PATH: '/bin', HOME: '/h', GH_TOKEN: 'ghp_x', HTTPS_PROXY: 'http://p', DASHSCOPE_API_KEY: 'sk-1', ANTHROPIC_API_KEY: 'sk-2', BRAVE_SEARCH_API_KEY: 'b' });
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      GH_TOKEN: 'ghp_x',
      HTTPS_PROXY: 'http://p',
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_PAGER: 'cat',
      PAGER: 'cat',
      NO_COLOR: '1',
      CLICOLOR: '0',
      GH_SPINNER_DISABLED: '1',
    });
  });
});

describe("reading gh's answers", () => {
  it('reads a PR, with an empty review decision as none and unknown fields ignored', () => {
    expect(parsePr(PR_JSON)).toEqual({ ok: true, value: { number: 7, title: 'Fix it', url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: true, reviewDecision: null, branch: 'fix' } });
  });

  it('refuses JSON it cannot read, such as a bucket gh never had', () => {
    expect(parseChecks(JSON.stringify([{ name: 'a', workflow: '', bucket: 'weird', link: '' }]))).toMatchObject({ ok: false });
    expect(parsePr('not json')).toEqual({ ok: false, message: 'gh did not answer with JSON' });
  });

  it.each<[string, GhResult & { kind: 'ran' }, string]>([
    ['exit 4 is a login', { kind: 'ran', code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login', timedOut: false }, 'gh-logged-out'],
    ['no PR', { kind: 'ran', code: 1, stdout: '', stderr: 'no pull requests found for branch "main"', timedOut: false }, 'no-pr'],
    ['not a repository', { kind: 'ran', code: 1, stdout: '', stderr: 'failed to run git: fatal: not a git repository', timedOut: false }, 'not-github'],
    ['no GitHub remote', { kind: 'ran', code: 1, stdout: '', stderr: 'none of the git remotes configured for this repository point to a known GitHub host', timedOut: false }, 'not-github'],
    ['a timeout', { kind: 'ran', code: null, stdout: '', stderr: '', timedOut: true }, 'failed'],
    ['anything else', { kind: 'ran', code: 1, stdout: '', stderr: 'error connecting to api.github.com\nmore', timedOut: false }, 'failed'],
  ])('%s', (_, result, kind) => {
    expect(ghFailure(result).kind).toBe(kind);
  });

  it('keeps one redacted line of a failure', () => {
    expect(ghFailure(ran(1, '', `HTTP 401: Bad credentials token=ghp_${'a'.repeat(36)}\nsecond`))).toEqual({ kind: 'failed', message: 'HTTP 401: Bad credentials token=[redacted]' });
  });
});

describe('one look at the branch', () => {
  const checks = JSON.stringify([{ name: 'test', workflow: 'CI', bucket: 'pending', link: 'https://github.com/o/r/actions/runs/1/job/2' }]);

  it('takes the checks gh printed although it exits 8 while one is pending', async () => {
    const { gh } = scripted({ 'pr-view': ran(0, PR_JSON), 'pr-checks': ran(8, checks) });
    expect(await lookUpPr(gh, '/w', async () => true)).toMatchObject({ kind: 'pr', pr: { number: 7 }, checks: [{ name: 'test', bucket: 'pending' }] });
  });

  it('reads "no checks reported" as a PR with no checks yet', async () => {
    const { gh } = scripted({ 'pr-view': ran(0, PR_JSON), 'pr-checks': ran(1, '', "no checks reported on the 'fix' branch") });
    expect(await lookUpPr(gh, '/w', async () => true)).toMatchObject({ kind: 'pr', checks: [] });
  });

  it('tells a missing gh in a GitHub repository from a folder gh has nothing to say about', async () => {
    const missing: Gh = async () => ({ kind: 'missing' });
    expect(await lookUpPr(missing, '/w', async () => true)).toEqual({ kind: 'gh-missing' });
    expect(await lookUpPr(missing, '/w', async () => false)).toEqual({ kind: 'not-github' });
  });

  it('reads the failing log of each failing Actions check for a failure, and none for a pass', async () => {
    const pr = { number: 7, title: 'Fix it', url: 'u', state: 'OPEN' as const, isDraft: false, reviewDecision: null, branch: 'fix' };
    const failing = [{ name: 'test', workflow: 'CI', bucket: 'fail' as const, link: 'https://github.com/o/r/actions/runs/1/job/2' }];
    const { gh, calls } = scripted({ 'failed-log': ran(0, 'test\tstep\t2026-01-01T00:00:00Z boom') });
    expect(await prReport(gh, '/w', { kind: 'settled', outcome: 'failed', pr, checks: failing })).toContain('<ci_log check="test">\nboom\n</ci_log>');
    expect(calls).toEqual([{ kind: 'failed-log', job: '2' }]);
    await prReport(gh, '/w', { kind: 'settled', outcome: 'passed', pr, checks: [] });
    expect(calls).toHaveLength(1);
  });
});
