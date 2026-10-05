import { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import {
  BASE_HASH_META,
  DIAGNOSTICS_CAPABILITY,
  DIAGNOSTICS_METHOD,
  SEVERITIES,
  spillNotice,
  STALE_BASE_ERROR,
  type DiagnosticsRequest,
  type DoneReason,
  type ToolStatus,
  type TurnEvent,
} from '@g-code/core';
import { LIMIT_FLAGS, limitsOf, runAgent } from './agent.js';
import { resumeSession, startSession } from './chat.js';
import { UsageError, type Command, type Io } from './command.js';
import { workspaceDir, type Limits, type Surface } from './drive.js';
import { DISK_FILES, type Files } from './files.js';
import type { Store } from './store.js';
import type { Approver, Diagnostics } from './tools/agent.js';
import { ToolError } from './tools/context.js';

const RESOURCE_NOT_FOUND = -32002;

const STOP_REASONS: Readonly<Record<DoneReason, acp.StopReason>> = {
  end_turn: 'end_turn',
  'max-turns': 'max_turn_requests',
  // ACP has no budget stop; the turn limit is the nearest, and the logged error says which it was.
  budget: 'max_turn_requests',
  refusal: 'refusal',
  error: 'end_turn',
};

const TOOL_STATUS: Readonly<Record<ToolStatus, acp.ToolCallStatus>> = { ok: 'completed', error: 'failed', denied: 'failed' };

const TOOL_KINDS: Readonly<Record<string, acp.ToolKind>> = {
  read: 'read',
  grep: 'search',
  glob: 'search',
  list: 'search',
  edit: 'edit',
  bash: 'execute',
  check: 'execute',
};

const PERMISSION_OPTIONS: acp.PermissionOption[] = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

const diagnosticsResponse = z.object({
  diagnostics: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().positive(),
      character: z.number().int().positive(),
      severity: z.enum(SEVERITIES),
      message: z.string(),
      source: z.string().nullable(),
    }),
  ),
});

type Peer = { readonly files: boolean; readonly diagnostics: boolean };

type Updates = { send(update: acp.SessionUpdate): void; flush(): Promise<void> };

/** Session updates in order. Notifications are fire-and-forget for the loop, but must all precede the turn's response. */
function updates(client: acp.AgentContext, sessionId: string, io: Io): Updates {
  let sent = Promise.resolve();
  return {
    send(update) {
      sent = sent
        .then(() => client.notify(acp.methods.client.session.update, { sessionId, update }))
        .catch((error: unknown) => io.err(`session/update failed: ${String(error)}`));
    },
    flush: () => sent,
  };
}

const textUpdate = (text: string): acp.SessionUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

type EventOf<K extends TurnEvent['kind']> = Extract<TurnEvent, { kind: K }>;

const LOGGED: { readonly [K in TurnEvent['kind']]?: (event: EventOf<K>) => acp.SessionUpdate } = {
  'tool-result': (event) => ({
    sessionUpdate: 'tool_call_update',
    toolCallId: event.toolUseId,
    status: TOOL_STATUS[event.status],
    content: [{ type: 'content', content: { type: 'text', text: 'spill' in event ? spillNotice(event.spill) : event.output } }],
  }),
  // ACP's notices are unstable, so a failure reaches the user as agent text, as the spec suggests.
  error: (event) => textUpdate(`\n\n[${event.error}] ${event.message}`),
};

function loggedUpdate<K extends TurnEvent['kind']>(event: EventOf<K>): acp.SessionUpdate | undefined {
  return (LOGGED[event.kind] as ((e: EventOf<K>) => acp.SessionUpdate) | undefined)?.(event);
}

/** The editor's buffers, through ACP's client file system. */
function editorFiles(client: acp.AgentContext, sessionId: string): Files {
  const failure = (verb: string, file: string, error: unknown) =>
    new ToolError(`the editor could not ${verb} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  return {
    async read(file) {
      try {
        return (await client.request(acp.methods.client.fs.readTextFile, { sessionId, path: file })).content;
      } catch (error) {
        if (error instanceof acp.RequestError && error.code === RESOURCE_NOT_FOUND) return null;
        throw failure('read', file, error);
      }
    },
    async write(file, text, baseHash) {
      try {
        await client.request(acp.methods.client.fs.writeTextFile, {
          sessionId,
          path: file,
          content: text,
          _meta: { [BASE_HASH_META]: baseHash },
        });
        return 'written';
      } catch (error) {
        if (error instanceof acp.RequestError && error.code === STALE_BASE_ERROR.code) return 'stale-base';
        throw failure('write', file, error);
      }
    },
  };
}

function editorDiagnostics(client: acp.AgentContext, sessionId: string): Diagnostics {
  return async (paths) => {
    const raw = await client.request<unknown, DiagnosticsRequest>(DIAGNOSTICS_METHOD, { sessionId, paths });
    const parsed = diagnosticsResponse.safeParse(raw);
    if (!parsed.success) throw new ToolError(`the editor sent malformed diagnostics: ${z.prettifyError(parsed.error)}`);
    return parsed.data.diagnostics;
  };
}

type Turn = { readonly surface: Surface; readonly approve: Approver; readonly updates: Updates };

/** One prompt turn's view of the editor: what the loop shows, reads and writes, and asks permission for. */
function editorTurn(client: acp.AgentContext, sessionId: string, peer: Peer, io: Io): Turn {
  const sent = updates(client, sessionId, io);
  // Tools run one at a time, so the last one started is the one asking.
  let running: acp.ToolCallId = '';
  return {
    updates: sent,
    surface: {
      files: peer.files ? editorFiles(client, sessionId) : DISK_FILES,
      watcher: {
        text: (delta) => sent.send(textUpdate(delta)),
        toolStart(use, title) {
          running = use.id;
          sent.send({ sessionUpdate: 'tool_call', toolCallId: use.id, title, kind: TOOL_KINDS[use.name] ?? 'other', status: 'in_progress', rawInput: use.input });
        },
        logged(event) {
          const update = loggedUpdate(event);
          if (update !== undefined) sent.send(update);
        },
      },
    },
    async approve(denial) {
      await sent.flush();
      const { outcome } = await client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: running, title: `Allow \`${denial.command}\`? It uses ${denial.reason}.`, kind: 'execute', status: 'pending' },
        options: PERMISSION_OPTIONS,
      });
      return outcome.outcome === 'selected' && outcome.optionId === 'allow';
    },
  };
}

const promptText = (blocks: readonly acp.ContentBlock[]): string =>
  blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();

/** The engine as an ACP agent. Each prompt runs `gcode agent`'s loop on the session's log. */
export function gcodeAgent(io: Io, store: Store, limits: Limits): acp.AgentApp {
  let peer: Peer = { files: false, diagnostics: false };
  const turns = new Map<string, AbortController | undefined>();

  return acp
    .agent({ name: 'gcode' })
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      const { fs, _meta } = params.clientCapabilities ?? {};
      peer = { files: fs?.readTextFile === true && fs.writeTextFile === true, diagnostics: _meta?.[DIAGNOSTICS_CAPABILITY] === true };
      return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false }, agentInfo: { name: 'gcode', version: '0.0.0' } };
    })
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      const workspace = await workspaceDir(io.cwd, params.cwd);
      const opened = await startSession(store, io, { workspace, provider: undefined, model: undefined, effort: undefined });
      const { id } = opened.log.session;
      turns.set(id, undefined);
      io.err(`session: ${id} log: ${opened.log.file}`);
      return { sessionId: id };
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const { sessionId } = params;
      if (!turns.has(sessionId)) throw acp.RequestError.invalidParams({ sessionId }, `no session ${sessionId}`);
      if (turns.get(sessionId) !== undefined) throw acp.RequestError.invalidRequest({ sessionId }, 'a turn is already running');
      const text = promptText(params.prompt);
      if (text === '') throw acp.RequestError.invalidParams({ sessionId }, 'the prompt has no text');

      const controller = new AbortController();
      turns.set(sessionId, controller);
      const turn = editorTurn(client, sessionId, peer, io);
      try {
        const opened = await resumeSession(store, io, sessionId);
        const result = await runAgent({ ...io, interrupts: () => controller.signal }, store, opened, text, {
          limits,
          check: undefined,
          checkAfterEdit: true,
          approve: turn.approve,
          surface: turn.surface,
          diagnostics: peer.diagnostics ? editorDiagnostics(client, sessionId) : undefined,
        });
        await turn.updates.flush();
        return { stopReason: controller.signal.aborted ? 'cancelled' : STOP_REASONS[result.reason] };
      } finally {
        turns.set(sessionId, undefined);
      }
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      turns.get(params.sessionId)?.abort();
    });
}

export const serve: Command = async (args, { io, store }) => {
  const { values } = parseArgs({ args, strict: true, options: { stdio: { type: 'boolean', default: false }, ...LIMIT_FLAGS } });
  if (!values.stdio) throw new UsageError('serve needs --stdio, the only transport');
  // stdout carries the protocol, so everything the engine prints goes to stderr.
  const quiet: Io = { ...io, out: io.err, write: () => {} };
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  const connection = gcodeAgent(quiet, store, limitsOf(values)).connect(stream);
  quiet.err(`gcode serve: ACP v${acp.PROTOCOL_VERSION} on stdio, sessions in ${store.sessionsDir}`);
  await connection.closed;
  return 0;
};
