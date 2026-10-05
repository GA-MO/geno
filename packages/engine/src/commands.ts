// Portions ported from Pi (https://github.com/earendil-works/pi) at b2b5c42, Copyright (c) 2025 Mario Zechner, MIT License.

import { existsSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import {
  builtinCommands,
  COMMAND_META,
  expandInvocation,
  isSessionMode,
  mergeCommands,
  SESSION_MODES,
  type CommandMeta,
  type CommandSource,
  type EngineBuiltin,
  type Expansion,
  type SessionMode,
  type SlashCommand,
} from '@g-code/core';
import type { Command, Io } from './command.js';
import { workspaceDir } from './drive.js';
import { parseFrontmatter, readIfFile, shownPath, SKILL_ROOTS, sortedEntries } from './project-context.js';
import type { Store } from './store.js';

type Source = { readonly kind: 'prompt' | 'skill'; readonly scope: CommandSource; readonly dir: (workspace: string, home: string) => string };

/** In precedence order: the first command of a name wins, after the built-ins, which nothing shadows. */
const SOURCES: readonly Source[] = [
  { kind: 'prompt', scope: 'workspace', dir: (workspace) => path.join(workspace, '.agents', 'commands') },
  { kind: 'prompt', scope: 'workspace', dir: (workspace) => path.join(workspace, '.claude', 'commands') },
  ...SKILL_ROOTS.map((root): Source => ({ kind: 'skill', scope: 'workspace', dir: (workspace) => path.join(workspace, root) })),
  { kind: 'prompt', scope: 'global', dir: (_, home) => path.join(home, 'commands') },
  { kind: 'skill', scope: 'global', dir: (_, home) => path.join(home, 'skills') },
];

/** `~/.g-code`, or GCODE_HOME: the store keeps everything under it. */
export const homeOf = (store: Store): string => path.dirname(store.sessionsDir);

const text = (value: string | readonly string[] | undefined): string => (typeof value === 'string' ? value.trim() : '');

/** Pi's fallback for a template without a description: its first line, cut to 60 characters. */
const firstLine = (body: string): string => {
  const line = body.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}...` : line;
};

type Loader = (dir: string, scope: CommandSource, show: (file: string) => string) => Promise<SlashCommand[]>;

const LOADERS: Readonly<Record<Source['kind'], Loader>> = {
  async prompt(dir, scope, show) {
    const commands: SlashCommand[] = [];
    for (const entry of await sortedEntries(dir)) {
      if (!entry.name.endsWith('.md')) continue;
      const file = path.join(dir, entry.name);
      const raw = await readIfFile(file);
      if (raw === undefined) continue;
      const { fields, body } = parseFrontmatter(raw);
      const hint = text(fields['argument-hint']);
      commands.push({
        kind: 'prompt',
        name: entry.name.slice(0, -'.md'.length),
        description: text(fields['description']) || firstLine(body),
        hint: hint === '' ? undefined : hint,
        scope,
        path: show(file),
        template: body.trim(),
      });
    }
    return commands;
  },
  async skill(dir, scope, show) {
    const skills: SlashCommand[] = [];
    for (const entry of await sortedEntries(dir)) {
      const file = path.join(dir, entry.name, 'SKILL.md');
      const raw = await readIfFile(file);
      if (raw === undefined) continue;
      const { fields } = parseFrontmatter(raw);
      const description = text(fields['description']);
      if (description === '') continue;
      const hint = text(fields['argument-hint']);
      skills.push({ kind: 'skill', name: text(fields['name']) || entry.name, description, hint: hint === '' ? undefined : hint, scope, path: show(file), text: raw });
    }
    return skills;
  },
};

/** The built-ins, then the workspace's commands and skills, then the global ones. */
export async function loadCommands(workspace: string, home: string): Promise<SlashCommand[]> {
  const show = (file: string) => shownPath(workspace, file);
  const groups = await Promise.all(SOURCES.map((source) => LOADERS[source.kind](source.dir(workspace, home), source.scope, show)));
  return mergeCommands([builtinCommands(), ...groups]);
}

const metaOf = (command: SlashCommand): CommandMeta => (command.kind === 'builtin' ? { kind: command.kind, runs: command.runs } : { kind: command.kind });

export const availableCommands = (commands: readonly SlashCommand[]): acp.AvailableCommand[] =>
  commands.map((command) => ({
    name: command.name,
    description: command.description,
    input: command.hint === undefined ? null : { hint: command.hint },
    _meta: { [COMMAND_META]: metaOf(command) },
  }));

/**
 * Calls `onChange` once per burst of changes to any source folder. A folder that does not exist yet is caught by
 * watching its nearest existing parent inside the workspace or home, and the watch moves down once it appears.
 */
export function watchCommands(workspace: string, home: string, onChange: () => void, debounceMs = 200): () => void {
  let watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const fired = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (closed) return;
      arm();
      onChange();
    }, debounceMs).unref();
  };
  const targets = () => {
    const found = new Map<string, boolean>();
    for (const source of SOURCES) {
      const root = source.scope === 'workspace' ? workspace : home;
      let dir = source.dir(workspace, home);
      while (!existsSync(dir) && dir !== root && dir.startsWith(root)) dir = path.dirname(dir);
      if (!existsSync(dir)) continue;
      // The source folder itself is watched deep, for edits to a skill's SKILL.md; a parent only for the folder appearing.
      const deep = dir === source.dir(workspace, home);
      found.set(dir, (found.get(dir) ?? false) || deep);
    }
    return found;
  };
  const arm = () => {
    for (const watcher of watchers) watcher.close();
    watchers = [...targets()].flatMap(([dir, recursive]) => {
      try {
        return [watch(dir, { persistent: false, recursive }, fired).on('error', fired)];
      } catch {
        return [];
      }
    });
  };
  arm();
  return () => {
    closed = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}

/** What the engine does with the built-ins it runs; the reply is shown as agent text, and no model call is made. */
export type BuiltinContext = { setMode(mode: SessionMode): Promise<void> };

const ENGINE_ACTIONS: Readonly<Record<EngineBuiltin, (args: string, ctx: BuiltinContext) => Promise<string>>> = {
  async mode(args, ctx) {
    if (!isSessionMode(args)) return `Usage: /mode ${SESSION_MODES.join(' | ')}`;
    await ctx.setMode(args);
    return `Approval mode: ${args}.`;
  },
  rules: async () => 'Rules are not available yet.',
  memory: async () => 'Memory is not available yet.',
};

const isEngineBuiltin = (name: string): name is EngineBuiltin => Object.hasOwn(ENGINE_ACTIONS, name);

export async function runBuiltin(expansion: Extract<Expansion, { kind: 'builtin' }>, ctx: BuiltinContext): Promise<string> {
  if (isEngineBuiltin(expansion.name)) return ENGINE_ACTIONS[expansion.name](expansion.args, ctx);
  return `/${expansion.name} runs in the editor, and this client does not offer it.`;
}

export type SessionCommands = {
  /** Publishes the session's commands now, and again whenever its command folders change what they list. */
  attach(client: acp.AgentContext, sessionId: string, workspace: string): void;
  /** What the prompt becomes, read from the folders as they are now; undefined when it names no command. */
  expand(sessionId: string, text: string): Promise<Expansion | undefined>;
};

export function sessionCommands(home: string, io: Io, debounceMs?: number): SessionCommands {
  const sessions = new Map<string, { readonly workspace: string; readonly stop: () => void }>();
  return {
    attach(client, sessionId, workspace) {
      sessions.get(sessionId)?.stop();
      let published = '';
      const publish = async () => {
        const listed = availableCommands(await loadCommands(workspace, home));
        const shown = JSON.stringify(listed);
        if (shown === published) return;
        published = shown;
        await client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: listed } });
      };
      const send = () => void publish().catch((error: unknown) => io.err(`could not publish the commands of ${sessionId}: ${String(error)}`));
      const stop = watchCommands(workspace, home, send, debounceMs);
      sessions.set(sessionId, { workspace, stop });
      // After the response that names the session, so the editor knows which session the list is for.
      setImmediate(send);
    },
    async expand(sessionId, text) {
      const session = sessions.get(sessionId);
      if (session === undefined || !text.startsWith('/')) return undefined;
      return expandInvocation(await loadCommands(session.workspace, home), text);
    },
  };
}

const ORIGIN: { readonly [K in SlashCommand['kind']]: (command: Extract<SlashCommand, { kind: K }>) => string } = {
  builtin: ({ runs }) => `built-in, ${runs === 'client' ? 'editor' : 'engine'}`,
  prompt: ({ path }) => path,
  skill: ({ path }) => path,
};

const originOf = (command: SlashCommand): string => (ORIGIN[command.kind] as (c: SlashCommand) => string)(command);

export const commandsList: Command = async (args, { io, store }) => {
  const { values } = parseArgs({ args, strict: true, options: { workspace: { type: 'string', default: '.' } } });
  const commands = await loadCommands(await workspaceDir(io.cwd, values.workspace), homeOf(store));
  for (const command of commands) {
    const usage = command.hint === undefined ? `/${command.name}` : `/${command.name} ${command.hint}`;
    io.out(`${usage.padEnd(20)} ${originOf(command)}    ${command.description}`);
  }
  return 0;
};
