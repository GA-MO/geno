// A scripted external ACP agent, standing in for Cursor's `agent acp` in tests. FAKE_ACP_SCRIPT names a JSON file:
// what session/new offers, and per prompt the steps to play. Every call it gets goes to the script's log as JSON lines.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

export type FakeStep =
  | { readonly text: string }
  | { readonly tool: { readonly id: string; readonly kind: acp.ToolKind; readonly title: string; readonly rawInput?: unknown; readonly locations?: readonly string[] } }
  | { readonly done: { readonly id: string; readonly status: 'completed' | 'failed'; readonly output?: string } }
  | { readonly write: { readonly path: string; readonly text: string } }
  /** Asks permission for tool `id`; an allow goes on, a reject fails the tool and the rest of the steps still play. */
  | { readonly ask: { readonly id: string; readonly kind?: acp.ToolKind; readonly title?: string; readonly rawInput?: unknown; readonly options?: readonly acp.PermissionOption[] } }
  | { readonly waitCancel: true }
  | { readonly crash: number }
  | { readonly cost: number };

export type FakeScript = {
  readonly log: string;
  readonly loadSession?: boolean;
  /** As session/new returns it. */
  readonly setup: { readonly modes?: acp.SessionModeState; readonly configOptions?: acp.SessionConfigOption[] };
  /** Keyed by a word the prompt contains; the first key found wins. */
  readonly turns: Readonly<Record<string, readonly FakeStep[]>>;
};

export const CURSOR_OPTIONS: acp.PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

/** Cursor 2026.10.01's session/new, cut to three models. */
export const CURSOR_SETUP: FakeScript['setup'] = {
  modes: {
    currentModeId: 'agent',
    availableModes: [
      { id: 'agent', name: 'Agent' },
      { id: 'plan', name: 'Plan' },
      { id: 'ask', name: 'Ask' },
    ],
  },
  configOptions: [
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'agent', options: [{ value: 'agent', name: 'Agent' }, { value: 'plan', name: 'Plan' }, { value: 'ask', name: 'Ask' }] },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'default[]',
      options: [
        { value: 'default[]', name: 'Auto' },
        { value: 'composer-2.5[fast=true]', name: 'composer-2.5' },
        { value: 'grok-4.7[fast=true]', name: 'grok-4.7' },
      ],
    },
  ],
};

const main = async () => {
  const script: FakeScript = JSON.parse(readFileSync(process.env['FAKE_ACP_SCRIPT']!, 'utf8'));
  const log = (entry: Record<string, unknown>) => appendFileSync(script.log, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
  const key = process.env['CURSOR_API_KEY'];
  log({ start: { argv: process.argv.slice(2), cwd: process.cwd(), key: key === undefined ? null : createHash('sha256').update(key).digest('hex').slice(0, 12), noOpenBrowser: process.env['NO_OPEN_BROWSER'] ?? null } });
  const cwds = new Map<string, string>();
  const cancels = new Map<string, () => void>();
  let sessions = 0;
  const app = acp
    .agent({ name: 'fake-cursor' })
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      log({ method: 'initialize', params });
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: script.loadSession === true, promptCapabilities: { image: true } },
        authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }],
      };
    })
    .onRequest(acp.methods.agent.session.new, ({ params }) => {
      const sessionId = `fake-${process.pid}-${sessions++}`;
      cwds.set(sessionId, params.cwd);
      log({ method: 'session/new', params, sessionId });
      return { sessionId, ...script.setup };
    })
    .onRequest(acp.methods.agent.session.load, ({ params }) => {
      cwds.set(params.sessionId, params.cwd);
      log({ method: 'session/load', params });
      return { ...script.setup };
    })
    .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
      log({ method: 'session/set_config_option', params });
      return { configOptions: script.setup.configOptions ?? [] };
    })
    .onRequest(acp.methods.agent.session.setMode, ({ params }) => {
      log({ method: 'session/set_mode', params });
      return {};
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      log({ method: 'session/cancel', params });
      cancels.get(params.sessionId)?.();
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const text = params.prompt.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      log({ method: 'session/prompt', params });
      const { sessionId } = params;
      const cwd = cwds.get(sessionId) ?? process.cwd();
      const steps = Object.entries(script.turns).find(([word]) => text.includes(word))?.[1] ?? [{ text: `no script for: ${text}` }];
      const update = (u: acp.SessionUpdate) => client.notify(acp.methods.client.session.update, { sessionId, update: u });
      let cancelled = false;
      const cancelledNow = new Promise<void>((resolve) => cancels.set(sessionId, () => ((cancelled = true), resolve())));
      for (const step of steps) {
        if (cancelled) break;
        if ('text' in step) await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.text } });
        if ('tool' in step) {
          const { id, kind, title, rawInput, locations } = step.tool;
          await update({ sessionUpdate: 'tool_call', toolCallId: id, kind, title, status: 'in_progress', rawInput, locations: (locations ?? []).map((p) => ({ path: path.resolve(cwd, p) })) });
        }
        if ('done' in step) {
          const { id, status, output } = step.done;
          await update({ sessionUpdate: 'tool_call_update', toolCallId: id, status, ...(output === undefined ? {} : { content: [{ type: 'content', content: { type: 'text', text: output } }] }) });
        }
        if ('write' in step) {
          const file = path.resolve(cwd, step.write.path);
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, step.write.text);
        }
        if ('ask' in step) {
          const { id, kind, title, rawInput, options } = step.ask;
          const answer = await client.request(acp.methods.client.session.requestPermission, {
            sessionId,
            toolCall: { toolCallId: id, ...(kind === undefined ? {} : { kind }), ...(title === undefined ? {} : { title }), ...(rawInput === undefined ? {} : { rawInput }), status: 'pending' },
            options: [...(options ?? CURSOR_OPTIONS)],
          });
          log({ permission: { id, outcome: answer.outcome } });
          const allowed = answer.outcome.outcome === 'selected' && (options ?? CURSOR_OPTIONS).find((o) => o.optionId === (answer.outcome as { optionId: string }).optionId)?.kind.startsWith('allow');
          if (!allowed) await update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'rejected' } }] });
        }
        if ('waitCancel' in step) await cancelledNow;
        if ('crash' in step) {
          process.stderr.write('fake agent: boom\n');
          process.exit(step.crash);
        }
        if ('cost' in step) await update({ sessionUpdate: 'usage_update', used: 0, size: 0, cost: { amount: step.cost, currency: 'USD' } });
      }
      return { stopReason: cancelled ? 'cancelled' : 'end_turn' };
    });
  const connection = app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
  await connection.closed;
};

if (process.env['FAKE_ACP_SCRIPT'] !== undefined) await main();
