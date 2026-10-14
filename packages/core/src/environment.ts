import { GENO_NOTE } from './fence.js';
import { laneSentence, type LanePlace } from './lanes.js';
import { specOf, type ProviderName } from './providers.js';

/** The workspace's git state when the session started. */
export type GitSnapshot = {
  /** Absent on a detached HEAD. */
  readonly branch?: string | undefined;
  /** `git status --short`, at most `GIT_STATUS_LINES` of it. */
  readonly status: readonly string[];
  /** The status lines past those. */
  readonly moreStatus: number;
  /** `git log --oneline`, newest first. */
  readonly commits: readonly string[];
};

/** What the workspace's package.json says, for the tasks a model would otherwise read it for. */
export type ProjectFacts = {
  /** Such as `pnpm 11.3.0` from its packageManager field, or `npm` from a lockfile; absent when neither says. */
  readonly packageManager?: string | undefined;
  /** The scripts named in `KEY_SCRIPTS`, with their commands. */
  readonly scripts: readonly (readonly [name: string, command: string])[];
  /** Every other script, by name. */
  readonly otherScripts: readonly string[];
  /** The installed (else declared) version of each package in `KEY_PACKAGES` the project has. */
  readonly versions: readonly (readonly [name: string, version: string])[];
};

/**
 * The facts a model cannot infer about where it runs, recorded once when a session starts. It is kept in the
 * session-start event like the loaded context, so every request of the session, and of a resume, sends the same bytes.
 * The workspace and the model come from the session itself.
 */
export type Environment = {
  /** The local date, YYYY-MM-DD. */
  readonly date: string;
  /** `process.platform`, such as darwin. */
  readonly platform: string;
  /** Such as `Darwin 27.0.0`. */
  readonly osVersion: string;
  /** The name of the user's login shell, from $SHELL; absent when unset. */
  readonly loginShell?: string | undefined;
  /** The session's own temp folder, which commands may write without approval. */
  readonly scratchpad: string;
  /** Absent when the workspace is not in a git repository; `omitted` in one whose status the session was not given. */
  readonly git?: GitSnapshot | 'omitted' | undefined;
  /** Absent when the workspace has no package.json. */
  readonly project?: ProjectFacts | undefined;
  /** The lane the workspace is, when it is one; absent for the main checkout. */
  readonly lane?: LanePlace | undefined;
};

export const GIT_STATUS_LINES = 20;
export const GIT_COMMITS = 5;
export const KEY_SCRIPTS = ['dev', 'build', 'start', 'test', 'lint', 'typecheck', 'check', 'format'] as const;
export const KEY_PACKAGES = ['next', 'payload', 'react'] as const;

/** What Geno's bash runs each command with: the sandbox wraps it in `bash -c` (sandbox-runtime's default shell). */
const COMMAND_SHELL = 'bash';

const PLATFORM_NOTES: Readonly<Record<string, string>> = {
  darwin: ' (macOS). Commands use the BSD tools, so GNU-only flags may fail.',
};

function gitSection(git: GitSnapshot): string {
  const more = git.moreStatus === 0 ? [] : [`(${git.moreStatus} more lines; run git status to see them)`];
  return [
    'Git status when this session started. It is a snapshot and will not update during the session; run git status for the current state.',
    `Current branch: ${git.branch ?? 'none (detached HEAD)'}`,
    ...(git.status.length === 0 ? ['Status: clean'] : ['Status:', ...git.status, ...more]),
    ...(git.commits.length === 0 ? ['Recent commits: none'] : ['Recent commits:', ...git.commits]),
  ].join('\n');
}

function projectSection(project: ProjectFacts): string {
  return [
    `Package manager: ${project.packageManager ?? 'unknown (no packageManager field or lockfile)'}`,
    ...(project.scripts.length === 0 ? [] : ['Scripts in package.json:', ...project.scripts.map(([name, command]) => ` - ${name}: ${command}`)]),
    ...(project.otherScripts.length === 0 ? [] : [`Other scripts: ${project.otherScripts.join(', ')}`]),
    ...(project.versions.length === 0 ? [] : [`Versions: ${project.versions.map(([name, version]) => `${name} ${version}`).join(', ')}`]),
  ].join('\n');
}

type SessionFacts = { readonly workspace: string; readonly model: string; readonly provider: ProviderName };

/** How the environment block starts. */
export const ENVIRONMENT_HEADING = `${GENO_NOTE} The environment of this session`;

/** The environment as the session's opening message shows it: the facts, then the project, then the git snapshot. */
export function renderEnvironment(env: Environment, session: SessionFacts): string {
  const facts = [
    `${ENVIRONMENT_HEADING}, recorded when this session started. It will not update; run a command for the current state.`,
    ` - Workspace: ${session.workspace}`,
    ` - Is a git repository: ${env.git !== undefined}`,
    ...(env.lane === undefined ? [] : [` - Lane: ${laneSentence(env.lane)}`]),
    ` - Platform: ${env.platform}${PLATFORM_NOTES[env.platform] ?? ''}`,
    ` - OS version: ${env.osVersion}`,
    ` - Shell: the bash tool runs each command with ${COMMAND_SHELL} -c in the workspace${env.loginShell === undefined ? '' : `; the user's login shell is ${env.loginShell}`}.`,
    ` - Scratchpad directory: ${env.scratchpad}. Use it for temporary files, such as scripts and intermediate output, instead of /tmp or the workspace. It is this session's own, and writing there needs no approval.`,
    ` - Date: ${env.date}, the local date when this session started. Run date for the current time.`,
    ` - Model: ${session.model} on ${specOf(session.provider).label}`,
  ].join('\n');
  return [facts, ...(env.project === undefined ? [] : [projectSection(env.project)]), ...(env.git === undefined || env.git === 'omitted' ? [] : [gitSection(env.git)])].join('\n\n');
}
