import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  CHECK_BUCKETS,
  ciLogOf,
  failingJobsOf,
  PR_REVIEW_DECISIONS,
  PR_STATES,
  prWatchText,
  redactSecrets,
  type CiLog,
  type PrCheck,
  type PrLookup,
  type PrWatchEnd,
  type PullRequest,
} from '@g-code/core';
import type { Env } from './child-env.js';

const exec = promisify(execFile);

/**
 * The only gh commands Geno runs, all read-only. Each builds its whole argv, so nothing the model or a log says can
 * add a flag or a subcommand; gh runs with no shell, outside the bash sandbox, as web_fetch does, because it needs the
 * network and the user's own login.
 */
export type GhCall = { readonly kind: 'pr-view' } | { readonly kind: 'pr-checks' } | { readonly kind: 'failed-log'; readonly job: string };

const PR_FIELDS = 'number,title,url,state,isDraft,reviewDecision,headRefName';
const CHECK_FIELDS = 'name,workflow,bucket,link';

export const GH_ARGV: { readonly [K in GhCall['kind']]: (call: Extract<GhCall, { kind: K }>) => readonly string[] } = {
  'pr-view': () => ['pr', 'view', '--json', PR_FIELDS],
  'pr-checks': () => ['pr', 'checks', '--json', CHECK_FIELDS],
  'failed-log': ({ job }) => {
    if (!/^\d+$/.test(job)) throw new Error(`not a job id: ${job}`);
    return ['run', 'view', '--job', job, '--log-failed'];
  },
};

export const argvOf = (call: GhCall): readonly string[] => (GH_ARGV[call.kind] as (call: GhCall) => readonly string[])(call);

/** What gh needs of the engine's environment: where it is, its config and login, and a proxy. Never a provider key. */
const GH_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'GH_CONFIG_DIR',
  'GH_HOST',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
] as const;

/** Never a prompt, a pager, colour or an update notice: gh answers once and exits. */
const GH_QUIET = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1', CLICOLOR: '0', GH_SPINNER_DISABLED: '1' };

export function ghEnv(env: Env): Record<string, string> {
  const picked = GH_ENV_KEYS.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]] as const]));
  return { ...Object.fromEntries(picked), ...GH_QUIET };
}

export const GH_LIMITS = { timeoutMs: 30_000, stdoutChars: 2 * 1024 * 1024, stderrChars: 4_000 } as const;

export type GhResult =
  | { readonly kind: 'ran'; readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }
  | { readonly kind: 'missing' };

/** Runs one allowed gh command in `cwd`. */
export type Gh = (call: GhCall, cwd: string, signal?: AbortSignal) => Promise<GhResult>;

// VS Code started from the Dock may see a PATH without Homebrew's directories, so they are tried after PATH.
const WELL_KNOWN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

async function findGh(env: Env): Promise<string | undefined> {
  for (const dir of [...(env['PATH'] ?? '').split(path.delimiter).filter(Boolean), ...WELL_KNOWN_DIRS]) {
    const candidate = path.join(dir, 'gh');
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return undefined;
}

function run(file: string, argv: readonly string[], cwd: string, env: Record<string, string>, signal: AbortSignal | undefined): Promise<GhResult> {
  return new Promise((resolve) => {
    const child = spawn(file, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > GH_LIMITS.stdoutChars) stdout = stdout.slice(-GH_LIMITS.stdoutChars);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < GH_LIMITS.stderrChars) stderr += chunk.toString('utf8').slice(0, GH_LIMITS.stderrChars - stderr.length);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, GH_LIMITS.timeoutMs);
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    const done = (result: GhResult) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    child.on('error', (error: NodeJS.ErrnoException) => done(error.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'ran', code: null, stdout, stderr: error.message, timedOut }));
    child.on('close', (code) => done({ kind: 'ran', code, stdout, stderr, timedOut }));
  });
}

/** The user's gh, found on the engine's PATH or in Homebrew's directories, or `missing`. */
export function ghCli(env: Env): Gh {
  const childEnv = ghEnv(env);
  let found: Promise<string | undefined> | undefined;
  return async (call, cwd, signal) => {
    found ??= findGh(env);
    const file = await found;
    if (file === undefined) {
      found = undefined;
      return { kind: 'missing' };
    }
    return run(file, argvOf(call), cwd, childEnv, signal);
  };
}

const prSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    state: z.enum(PR_STATES),
    isDraft: z.boolean(),
    reviewDecision: z.union([z.enum(PR_REVIEW_DECISIONS), z.literal('')]).nullish(),
    headRefName: z.string(),
  })
  .transform(
    ({ headRefName, reviewDecision, ...pr }): PullRequest => ({ ...pr, reviewDecision: reviewDecision === '' || reviewDecision == null ? null : reviewDecision, branch: headRefName }),
  );

const checksSchema = z.array(
  z.object({ name: z.string(), workflow: z.string().nullish(), bucket: z.enum(CHECK_BUCKETS), link: z.string().nullish() }).transform(
    ({ name, workflow, bucket, link }): PrCheck => ({ name, workflow: workflow ?? '', bucket, link: link ?? '' }),
  ),
);

/** gh's answer as JSON, read with `schema`, or why it could not be read. */
export function parseGhJson<T>(schema: z.ZodType<T>, stdout: string): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { ok: false, message: 'gh did not answer with JSON' };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: `gh answered with JSON Geno cannot read: ${z.prettifyError(parsed.error).split('\n')[0]}` };
}

export const parsePr = (stdout: string) => parseGhJson(prSchema, stdout);
export const parseChecks = (stdout: string) => parseGhJson(checksSchema, stdout);

const firstLine = (text: string): string => redactSecrets(text.trim().split('\n')[0] ?? '').slice(0, 200);

/** What a gh failure means, read from its exit code and its message. gh exits with 4 when it needs a login. */
export function ghFailure(result: Extract<GhResult, { kind: 'ran' }>): PrLookup {
  const { code, stderr, timedOut } = result;
  if (timedOut) return { kind: 'failed', message: `gh took longer than ${GH_LIMITS.timeoutMs / 1000}s` };
  if (code === 4 || /gh auth login|not logged in|authentication required/i.test(stderr)) return { kind: 'gh-logged-out' };
  const noPr = /no pull requests? found for branch "([^"]*)"/i.exec(stderr);
  if (noPr !== null || /no pull requests? found/i.test(stderr)) return { kind: 'no-pr', branch: noPr?.[1] };
  if (/not a git repository|none of the git remotes|no git remotes|unable to determine base repository|could not determine (?:the )?(?:base )?repo/i.test(stderr)) return { kind: 'not-github' };
  return { kind: 'failed', message: firstLine(stderr) || `gh exited with code ${code ?? 'none'}` };
}

const NO_CHECKS = /no checks reported/i;

/** Whether the folder's git remotes name GitHub, to tell a missing gh from a repository gh has nothing to say about. */
export type GithubRemote = (cwd: string) => Promise<boolean>;

export const githubRemote: GithubRemote = async (cwd) => {
  try {
    const { stdout } = await exec('git', ['config', '--get-regexp', String.raw`^remote\..*\.url$`], { cwd, timeout: 5_000 });
    return /github/i.test(stdout);
  } catch {
    return false;
  }
};

/** The folder's branch's PR and its checks, as one look. */
export async function lookUpPr(gh: Gh, cwd: string, githubRemote: GithubRemote, signal?: AbortSignal): Promise<PrLookup> {
  const view = await gh({ kind: 'pr-view' }, cwd, signal);
  if (view.kind === 'missing') return (await githubRemote(cwd)) ? { kind: 'gh-missing' } : { kind: 'not-github' };
  if (view.code !== 0) return ghFailure(view);
  const pr = parsePr(view.stdout);
  if (!pr.ok) return { kind: 'failed', message: pr.message };
  const checks = await gh({ kind: 'pr-checks' }, cwd, signal);
  if (checks.kind === 'missing') return { kind: 'gh-missing' };
  // gh exits 8 while checks are pending and 1 when one failed, after printing them all.
  if (checks.stdout.trim() !== '') {
    const parsed = parseChecks(checks.stdout);
    return parsed.ok ? { kind: 'pr', pr: pr.value, checks: parsed.value } : { kind: 'failed', message: parsed.message };
  }
  if (checks.code === 0 || NO_CHECKS.test(checks.stderr)) return { kind: 'pr', pr: pr.value, checks: [] };
  return ghFailure(checks);
}

/** The failing checks' log tails a report carries. A log gh cannot print is left out. */
export async function failingLogs(gh: Gh, cwd: string, checks: readonly PrCheck[], signal?: AbortSignal): Promise<CiLog[]> {
  const logs = await Promise.all(
    failingJobsOf(checks).map(async ({ check, job }) => {
      const result = await gh({ kind: 'failed-log', job }, cwd, signal);
      return result.kind === 'ran' && result.code === 0 ? [ciLogOf(check.name, result.stdout)] : [];
    }),
  );
  return logs.flat();
}

/** What a watch that ended tells the model, with the failing logs for a failure. */
export async function prReport(gh: Gh, cwd: string, end: PrWatchEnd, signal?: AbortSignal): Promise<string> {
  const logs = end.kind === 'settled' && end.outcome === 'failed' ? await failingLogs(gh, cwd, end.checks, signal) : [];
  return prWatchText(end, logs);
}
