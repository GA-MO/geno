import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import {
  ARENA_COMPARE_METHOD,
  ARENA_LANE_STATUSES,
  ARENA_NEW_METHOD,
  ARENA_PICK_METHOD,
  ARENA_PREVIEW_METHOD,
  ARENA_STATUSES,
  ARENAS_METHOD,
  hunkIdOf,
  parseBestOfN,
  type ArenaCompareRequest,
  type ArenaCompareResponse,
  type ArenaNewRequest,
  type ArenaNewResponse,
  type ArenaPickRequest,
  type ArenaPreviewRequest,
  type ArenaPreviewResponse,
  type ArenaRun,
  type ArenasRequest,
  type ArenasResponse,
  type ArenaUpdate,
} from '@g-code/core';
import type { ArenaAsk, ArenaFromView, ArenaNotice, ArenaPreview, ArenaState, ArenaToView, LaneDiff } from './arena-model.js';
import { EMPTY_ARENA } from './arena-model.js';
import type { Connection } from './engine.js';

/** The engine's `_gcode/arenaUpdate`. The engine is Geno's own; this keeps a torn message from reaching the pane as a run. */
export const arenaUpdate = z.object({
  run: z.looseObject({
    id: z.string(),
    task: z.string(),
    createdAt: z.string(),
    status: z.enum(ARENA_STATUSES),
    winner: z.string().nullable(),
    lanes: z.array(z.looseObject({ lane: z.string(), letter: z.string(), sessionId: z.string(), status: z.enum(ARENA_LANE_STATUSES) })),
  }),
}).transform((update) => update as unknown as ArenaUpdate);

/** What the pane needs of the chat: the apply and graft turns, which put each hunk under the chat's review. */
export type ArenaChat = {
  readonly applyLane: (name: string) => Promise<unknown>;
  readonly graftLane: (name: string, hunks: readonly string[]) => Promise<unknown>;
  readonly defaultMode: () => string;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const USAGE = 'Type /best-of-n with 2 to 4 lanes and the task, such as /best-of-n 3 Make the header sticky. Add --vary seeds, effort or models to choose how the lanes differ.';

/** A run whose lanes all ended has diffs worth comparing. */
const settled = (run: ArenaRun): boolean => run.status !== 'running';

/**
 * The best-of-n runs of this folder, for the Arena pane. The engine runs them and tells every window of each step;
 * this keeps the last state of each run, and what the pane shows, so a new webview picks up where the last one was.
 */
export class ArenaHost {
  private state: ArenaState = EMPTY_ARENA;
  private asked = 0;
  private readonly compared = new Set<string>();

  constructor(
    private readonly connection: () => Promise<Connection>,
    private readonly post: (message: ArenaToView) => void,
    private readonly chat: ArenaChat,
  ) {}

  current(): ArenaState {
    return this.state;
  }

  /** A new connection to the engine: the folder's runs, which a reloaded window knows nothing of. */
  async connected(connection: Connection): Promise<void> {
    const { arenas } = await connection.agent.request<ArenasResponse, ArenasRequest>(ARENAS_METHOD, { cwd: connection.cwd });
    for (const run of arenas.toReversed()) this.upsert(run, false);
    this.publish();
  }

  updated({ run }: ArenaUpdate): void {
    this.upsert(run, true);
    this.publish();
  }

  /** `/best-of-n <args>`: the preview card, or with no arguments the newest run. A mistake shows on the card. */
  async begin(args: string): Promise<void> {
    if (args.trim() === '' && this.state.runs.length > 0) {
      this.set({ preview: undefined, shown: this.state.runs[0]!.id });
    } else {
      const parsed = parseBestOfN(args);
      if ('error' in parsed) this.set({ preview: { kind: 'invalid', error: `${parsed.error} ${USAGE}` } });
      else void this.ask({ task: parsed.task, n: parsed.n, variety: parsed.variety });
    }
    this.post({ type: 'show-arena' });
  }

  /** Opens the pane on a run, as the Tasks list does. */
  show(id: string): void {
    this.set({ preview: undefined, shown: id });
    this.post({ type: 'show-arena' });
  }

  private set(patch: Partial<ArenaState>): void {
    this.state = { ...this.state, ...patch };
    this.publish();
  }

  private publish(): void {
    this.post({ type: 'arena', state: this.state });
    // Only the run on show is compared, once; a window can know many old runs.
    const shown = this.state.runs.find((run) => run.id === this.state.shown) ?? this.state.runs[0];
    if (shown !== undefined && settled(shown) && !this.compared.has(shown.id)) {
      this.compared.add(shown.id);
      void this.compare(shown.id);
    }
  }

  private notice(id: string, notice: ArenaNotice): void {
    this.set({ notices: { ...this.state.notices, [id]: notice } });
  }

  /**
   * A step of a run replaces what the window knew of it. `live` marks an engine update; a listing never overrides a
   * run the window already heard about, since the update may be newer than the file it listed.
   */
  private upsert(run: ArenaRun, live: boolean): void {
    const known = this.state.runs.some((r) => r.id === run.id);
    if (known && !live) return;
    const runs = [run, ...this.state.runs.filter((r) => r.id !== run.id)].toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.state = { ...this.state, runs };
  }

  private async compare(id: string): Promise<void> {
    try {
      const { agent, cwd } = await this.connection();
      const { diffs } = await agent.request<ArenaCompareResponse, ArenaCompareRequest>(ARENA_COMPARE_METHOD, { cwd, id });
      const lanes: LaneDiff[] = diffs.map(({ lane, changes }) => ({
        lane,
        files: changes.map((change) => ({
          path: change.path,
          hunks: change.hunks.map((hunk, i) => ({ id: hunkIdOf(change, i), startLine: hunk.startLine, lineCount: hunk.lineCount, oldText: hunk.oldText, newText: hunk.newText })),
        })),
      }));
      this.set({ diffs: { ...this.state.diffs, [id]: lanes } });
    } catch (error) {
      this.notice(id, { tone: 'failed', text: `Could not read the lanes’ changes: ${messageOf(error)}` });
    }
  }

  private async ask(ask: ArenaAsk): Promise<void> {
    const asked = ++this.asked;
    this.set({ preview: { kind: 'loading', ask } });
    let preview: ArenaPreview;
    try {
      const { agent, cwd } = await this.connection();
      const answer = await agent.request<ArenaPreviewResponse, ArenaPreviewRequest>(ARENA_PREVIEW_METHOD, { cwd, n: ask.n, ...(ask.variety === undefined ? {} : { variety: ask.variety }) });
      preview = { kind: 'ready', ask, preview: answer.preview, variants: answer.variants };
    } catch (error) {
      preview = { kind: 'failed', ask, message: messageOf(error) };
    }
    // A slow answer never replaces a newer question's.
    if (asked === this.asked) this.set({ preview });
  }

  private async start(ask: ArenaAsk): Promise<void> {
    const before = this.state.preview;
    if (before?.kind !== 'ready') return;
    this.set({ preview: { ...before, kind: 'starting' } });
    try {
      const { agent, cwd } = await this.connection();
      const { run } = await agent.request<ArenaNewResponse, ArenaNewRequest>(ARENA_NEW_METHOD, {
        cwd,
        task: ask.task,
        n: ask.n,
        ...(ask.variety === undefined ? {} : { variety: ask.variety }),
        mode: this.chat.defaultMode(),
      });
      // Its first updates can arrive before this answer, and are newer.
      this.upsert(run, false);
      this.set({ preview: undefined, shown: run.id });
    } catch (error) {
      this.set({ preview: { kind: 'failed', ask, message: messageOf(error) } });
    }
  }

  private async pick(id: string, lane: string): Promise<void> {
    const letter = this.state.runs.find((run) => run.id === id)?.lanes.find((l) => l.lane === lane)?.letter ?? lane;
    try {
      this.notice(id, { tone: 'busy', text: `Applying lane ${letter} in the chat…` });
      const { agent, cwd } = await this.connection();
      const { run } = await agent.request<ArenaNewResponse, ArenaPickRequest>(ARENA_PICK_METHOD, { cwd, id, lane });
      this.upsert(run, true);
      await this.chat.applyLane(lane);
      this.notice(id, { tone: 'ok', text: `Lane ${letter} is applied in the chat. Tick hunks of another lane below to graft them over it.` });
    } catch (error) {
      this.notice(id, { tone: 'failed', text: messageOf(error) });
    }
  }

  private async graft(id: string, lane: string, hunks: readonly string[]): Promise<void> {
    try {
      await this.chat.graftLane(lane, hunks);
      this.notice(id, { tone: 'ok', text: `Grafted from lane ${lane} in the chat.` });
    } catch (error) {
      this.notice(id, { tone: 'failed', text: messageOf(error) });
    }
  }

  readonly handlers: { readonly [K in ArenaFromView['type']]: (message: Extract<ArenaFromView, { type: K }>) => void } = {
    'arena-preview': ({ ask }) => void this.ask(ask),
    'arena-start': ({ ask }) => void this.start(ask),
    'arena-cancel': () => {
      this.asked++;
      this.set({ preview: undefined });
    },
    'arena-stop': ({ id }) =>
      void (async () => {
        const run = this.state.runs.find((r) => r.id === id);
        const { agent } = await this.connection();
        for (const lane of run?.lanes ?? []) if (lane.status === 'running') await agent.notify(acp.methods.agent.session.cancel, { sessionId: lane.sessionId });
      })().catch((error: unknown) => this.notice(id, { tone: 'failed', text: messageOf(error) })),
    'arena-pick': ({ id, lane }) => void this.pick(id, lane),
    'arena-graft': ({ id, lane, hunks }) => void this.graft(id, lane, hunks),
  };
}
