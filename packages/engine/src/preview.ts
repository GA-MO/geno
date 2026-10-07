import { readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { connect } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { devServerCommand, LAUNCH_FILES, launchUrlOf, mergeLaunchFiles, pageTitleOf, type LaunchConfig, type LaunchConfigs, type LaunchFile, type PageCheck } from '@g-code/core';
import { isMissing } from './store.js';

const entrySchema = z.looseObject({
  name: z.string().trim().min(1),
  runtimeExecutable: z.string().min(1),
  runtimeArgs: z.array(z.string()).default([]),
  port: z.number().int().min(1).max(65535),
  url: z.string().optional(),
  cwd: z.string().min(1).optional(),
});

const fileSchema = z.looseObject({ configurations: z.array(z.unknown()) });

const issueText = (error: z.ZodError): string => error.issues.map((issue) => `${issue.path.join('.') || 'the entry'}: ${issue.message}`).join('; ');

/** One launch file's text as entries. Each entry parses on its own, so one bad entry leaves the others usable. */
export function parseLaunchFile(file: string, text: string): LaunchFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { file, configs: [], problems: [`it is not JSON: ${(error as Error).message}`] };
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) return { file, configs: [], problems: ['it has no configurations list'] };
  const configs: LaunchConfig[] = [];
  const problems: string[] = [];
  parsed.data.configurations.forEach((value, index) => {
    const entry = entrySchema.safeParse(value);
    if (!entry.success) return void problems.push(`configurations[${index}]: ${issueText(entry.error)}`);
    const { name, runtimeExecutable, runtimeArgs, port, cwd } = entry.data;
    const url = launchUrlOf(port, entry.data.url);
    if (!url.ok) return void problems.push(`"${name}": ${url.why}`);
    configs.push({ name, runtimeExecutable, runtimeArgs, port, url: url.url, ...(cwd === undefined ? {} : { cwd }), file });
  });
  return { file, configs, problems };
}

/** The workspace's launch entries, from every launch file it has. */
export async function readLaunchConfigs(workspace: string): Promise<LaunchConfigs> {
  const files = await Promise.all(
    LAUNCH_FILES.map(async (file) => {
      try {
        return parseLaunchFile(file, await readFile(path.join(workspace, file), 'utf8'));
      } catch (error) {
        if (isMissing(error)) return undefined;
        return { file, configs: [], problems: [`it cannot be read: ${(error as Error).message}`] };
      }
    }),
  );
  return mergeLaunchFiles(files.filter((file) => file !== undefined));
}

/** The dev script package.json names, as a command, for a launch file the model is to write. */
export async function devCommand(workspace: string): Promise<string | undefined> {
  try {
    const [manifest, files] = await Promise.all([readFile(path.join(workspace, 'package.json'), 'utf8'), readdir(workspace)]);
    return devServerCommand(JSON.parse(manifest), new Set(files));
  } catch {
    return undefined;
  }
}

const PROBE_MS = 500;

/**
 * Whether something accepts a connection on the URL's port. Node tries every address the host resolves to, IPv6 and
 * IPv4, since a dev server may listen on either. A name under .localhost resolves to this machine by standard.
 */
export function answers(raw: string): Promise<boolean> {
  const url = new URL(raw);
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  const host = url.hostname.endsWith('.localhost') ? 'localhost' : url.hostname.replace(/^\[(.*)\]$/, '$1');
  return new Promise((resolve) => {
    const socket = connect({ host, port, autoSelectFamily: true, timeout: PROBE_MS });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const POLL_MS = 250;

/** Waits until the URL answers, the server ends, the time is up or the call is cancelled, and says which came first. */
export async function untilAnswers(url: string, ended: Promise<unknown>, timeoutMs: number, signal: AbortSignal): Promise<'ready' | 'ended' | 'timeout'> {
  let over = false;
  void ended.then(() => (over = true));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (over) return 'ended';
    if (await answers(url)) return 'ready';
    if (over) return 'ended';
    if (Date.now() >= deadline || signal.aborted) return 'timeout';
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Bytes of a page read for its title. */
const PAGE_BYTES = 64 * 1024;

/**
 * One GET of the server's origin, as the browser's first load would make it, which also has a dev server such as
 * Next.js compile the page. A redirect is reported, never followed. The certificate of a local https server is not
 * checked, since dev servers sign their own.
 */
export function checkPage(url: string, timeoutMs: number, signal: AbortSignal): Promise<PageCheck> {
  const client = url.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    const request = client.get(url, { timeout: timeoutMs, signal, rejectUnauthorized: false, headers: { accept: 'text/html' } }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (location !== undefined) {
        response.destroy();
        return resolve({ kind: 'answered', status, location });
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length >= PAGE_BYTES) response.destroy();
      });
      response.on('close', () => resolve({ kind: 'answered', status, title: pageTitleOf(body) }));
    });
    request.on('timeout', () => request.destroy(new Error(`no response within ${Math.round(timeoutMs / 1000)}s`)));
    request.on('error', (error) => resolve({ kind: 'no-answer', why: error.message }));
  });
}
