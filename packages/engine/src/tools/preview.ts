import { stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  BACKGROUND_TAIL_LINES,
  filterLog,
  jobEndText,
  missingLaunchText,
  notStartedText,
  PREVIEW_LOG_LEVELS,
  PREVIEW_LOG_LINES,
  PREVIEW_PAGE_TIMEOUT_S,
  PREVIEW_READY_TIMEOUT_S,
  previewListText,
  previewLogsText,
  previewStartText,
  previewStatusOf,
  unknownLaunchText,
  type ApprovalRecord,
  type BackgroundJob,
  type EndedJobState,
  type LaunchConfig,
  type LaunchConfigs,
  type PreviewServer,
  type PreviewToolName,
} from '@g-code/core';
import { answers, checkPage, devCommand, readLaunchConfigs, untilAnswers } from '../preview.js';
import { NO_BACKGROUND, type SessionBackground } from './background.js';
import { ALWAYS, executor, optional, resolveWritable, ToolError, type Executor, type ToolContext } from './context.js';

/** Runs a launch entry in the background under bash's approval and sandbox, in `cwd`, a real folder in the workspace. */
export type StartServer = (config: LaunchConfig, cwd: string, ctx: ToolContext) => Promise<{ readonly job: BackgroundJob; readonly approval: ApprovalRecord | undefined }>;

type Server = BackgroundJob & { readonly preview: NonNullable<BackgroundJob['preview']> };

const isServer = (job: BackgroundJob): job is Server => job.preview !== undefined;

/** The session's dev servers, newest first, and how each is now; the port is probed only for a server that runs. */
async function serversOf({ jobs, sessionId }: SessionBackground): Promise<{ readonly job: Server; readonly server: PreviewServer }[]> {
  const servers = jobs.jobs(sessionId).filter(isServer);
  return Promise.all(
    servers.map(async (job) => ({
      job,
      server: { ...job.preview, job: job.id, command: job.command, status: previewStatusOf(job.state, job.state.status === 'running' && (await answers(job.preview.url))) },
    })),
  );
}

function pickEntry(launch: LaunchConfigs, name: string | undefined): LaunchConfig {
  if (name !== undefined) {
    const config = launch.configs.find((entry) => entry.name === name);
    if (config === undefined) throw new ToolError(unknownLaunchText(name, launch));
    return config;
  }
  if (launch.configs.length === 1) return launch.configs[0]!;
  if (launch.configs.length === 0) throw new ToolError(`No usable launch entry in ${launch.files.join(' or ')}: ${launch.problems.join('; ')}`);
  throw new ToolError(`The launch file has ${launch.configs.length} entries; name one: ${launch.configs.map((entry) => entry.name).join(', ')}.`);
}

async function folderOf(config: LaunchConfig, ctx: ToolContext): Promise<string> {
  if (config.cwd === undefined) return ctx.workspace;
  const folder = await resolveWritable(ctx, config.cwd);
  const found = await stat(folder).catch(() => undefined);
  if (found?.isDirectory() !== true) throw new ToolError(`"${config.name}" in ${config.file} runs in ${config.cwd}, which is not a folder in the workspace`);
  return folder;
}

const withApproval = (text: string, approval: ApprovalRecord | undefined) => (approval === undefined ? text : { text, approval });

export function previewExecutors(background: SessionBackground | undefined, start: StartServer): Readonly<Record<PreviewToolName, Executor>> {
  const own = (): SessionBackground => {
    if (background === undefined) throw new ToolError(NO_BACKGROUND);
    return background;
  };

  const reported = async (kind: 'started' | 'reused', job: Server, ctx: ToolContext): Promise<string> => {
    const { jobs, sessionId } = own();
    const began = Date.now();
    const outcome = await untilAnswers(job.preview.url, jobs.kept(sessionId, job.id).ended, PREVIEW_READY_TIMEOUT_S * 1000, ctx.signal);
    const now = jobs.jobs(sessionId).find((each) => each.id === job.id) ?? job;
    const tail = outcome === 'ready' ? '' : filterLog(jobs.kept(sessionId, job.id).text, { level: 'all', lines: BACKGROUND_TAIL_LINES }).lines.join('\n');
    const server: PreviewServer = { ...job.preview, job: job.id, command: job.command, status: previewStatusOf(now.state, outcome === 'ready') };
    const page = outcome === 'ready' ? await checkPage(job.preview.url, PREVIEW_PAGE_TIMEOUT_S * 1000, ctx.signal) : undefined;
    return previewStartText({ kind, server, waitedS: Math.round((Date.now() - began) / 1000), tail, page });
  };

  /** The server a read names, or the session's only one; the newest that runs wins over one that ended. */
  const named = async (name: string | undefined) => {
    const servers = await serversOf(own());
    const names = [...new Set(servers.map(({ server }) => server.name))];
    const wanted = name ?? (names.length === 1 ? names[0] : undefined);
    if (wanted === undefined) throw new ToolError(names.length === 0 ? 'No dev server was started in this session. Start one with preview_start.' : `This session started ${names.join(', ')}; name one.`);
    const matching = servers.filter(({ server }) => server.name === wanted);
    const chosen = matching.find(({ job }) => job.state.status === 'running') ?? matching[0];
    if (chosen === undefined) throw new ToolError(notStartedText(wanted, servers.map(({ server }) => server)));
    return chosen;
  };

  return {
    preview_start: executor({
      input: z.strictObject({ name: optional(z.string().trim().min(1)) }),
      describe: ({ name }) => `preview_start ${name ?? ''}`.trimEnd(),
      async run({ name }, ctx) {
        const session = own();
        const launch = await readLaunchConfigs(ctx.workspace);
        if (launch.files.length === 0) throw new ToolError(missingLaunchText(await devCommand(ctx.workspace)));
        const config = pickEntry(launch, name);
        const running = session.jobs.jobs(session.sessionId).find((job): job is Server => isServer(job) && job.preview.name === config.name && job.state.status === 'running');
        if (running !== undefined) return reported('reused', running, ctx);
        if (await answers(config.url)) return previewStartText({ kind: 'taken', config });
        const cwd = await folderOf(config, ctx);
        const { job, approval } = await start(config, cwd, ctx);
        return withApproval(await reported('started', job as Server, ctx), approval);
      },
    }),
    preview_list: executor({
      input: z.strictObject({}),
      describe: () => 'preview_list',
      concurrent: ALWAYS,
      async run(_input, ctx) {
        const servers = await serversOf(own());
        return previewListText(await readLaunchConfigs(ctx.workspace), servers.map(({ server }) => server));
      },
    }),
    preview_logs: executor({
      input: z.strictObject({
        name: optional(z.string().trim().min(1)),
        level: optional(z.enum(PREVIEW_LOG_LEVELS)),
        search: optional(z.string().min(1)),
        lines: optional(z.number().int().positive().max(PREVIEW_LOG_LINES.max)),
      }),
      describe: ({ name, level, search }) => ['preview_logs', name, level, search === undefined ? undefined : JSON.stringify(search)].filter((part) => part !== undefined).join(' '),
      concurrent: ALWAYS,
      async run({ name, level = 'all', search, lines = PREVIEW_LOG_LINES.default }) {
        const { jobs, sessionId } = own();
        const { job, server } = await named(name);
        const filter = { level, search, lines };
        return previewLogsText(server, filterLog(jobs.kept(sessionId, job.id).text, filter), filter);
      },
    }),
    preview_stop: executor({
      input: z.strictObject({ name: z.string().trim().min(1) }),
      describe: ({ name }) => `preview_stop ${name}`,
      async run({ name }) {
        const { jobs, sessionId } = own();
        const { job } = await named(name);
        if (job.state.status !== 'running') return `The dev server "${name}" (${job.id}) already ${jobEndText(job.state as EndedJobState)}.`;
        const ended = await jobs.stop(sessionId, job.id, 'model');
        return `Stopped the dev server "${name}" (${job.id}): it ${jobEndText(ended.state as EndedJobState)}.`;
      },
    }),
  };
}
