import { execFile } from 'node:child_process';
import * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import {
  BACKGROUND_STOP_METHOD,
  isLive,
  LANE_DISCARD_METHOD,
  LANE_NEW_METHOD,
  LANES_METHOD,
  needsYouCount,
  placeTasks,
  SCHEDULE_ACT_METHOD,
  SCHEDULES_METHOD,
  TASKS_METHOD,
  type ScheduleActRequest,
  type SchedulesRequest,
  type SchedulesResponse,
  type ScheduleView,
  type Attention,
  type BackgroundStopRequest,
  type LaneDiscardRequest,
  type LaneNewRequest,
  type LaneNewResponse,
  type LanesRequest,
  type LanesResponse,
  type PlacedTask,
  type TaskRecord,
  type TasksResponse,
  type TaskUpdate,
  WAKE_CANCEL_METHOD,
  type WakeCancelRequest,
} from '@g-code/core';
import type { Connection } from './engine.js';
import { revealOf, type LanesFromView, type SeenMarkers, type LanesListing, type LanesToView } from './lanes-model.js';
import { attentionNotice, channelsOf, noticeText, osNotification, type AttentionNotice } from './notices.js';
import type { SeenStore } from './seen.js';

export const OS_NOTIFICATIONS_SETTING = 'gcode.tasks.osNotifications';


/** What the panel does for the panes: open a session, apply a lane through the shown chat, know what it shows. */
export type TaskChat = {
  readonly shown: () => string | undefined;
  readonly panelVisible: () => boolean;
  readonly openTask: (sessionId: string, workspace: string) => Promise<void>;
  /** Opens the Arena pane on a run. */
  readonly openArena: (id: string) => void;
  readonly applyLane: (name: string) => Promise<unknown>;
  /** A task of the shown session ended in the background, such as one the panel adopted after a reload. */
  readonly ended: (task: TaskRecord) => void;
  readonly defaultMode: () => string;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const warn = (error: unknown): void => void vscode.window.showWarningMessage(messageOf(error));

const SHOW: Readonly<Record<AttentionNotice['severity'], (message: string, ...items: string[]) => Thenable<string | undefined>>> = {
  info: (message, ...items) => vscode.window.showInformationMessage(message, ...items),
  warning: (message, ...items) => vscode.window.showWarningMessage(message, ...items),
  error: (message, ...items) => vscode.window.showErrorMessage(message, ...items),
};

/**
 * The engine's tasks and the lanes of this folder, for the Tasks and Lanes panes, and the notices their changes
 * call for. The engine tells every connected window about each change; this window places each top-level task, with
 * its children rolled in, by what it needs of the user, and tells the user when one moves into Needs you or Ready.
 * Notices of changes that came while no window was connected come with the list.
 */
export class TaskHost implements vscode.Disposable {
  private readonly tasks = new Map<string, TaskRecord>();
  private lanes: LanesListing = { kind: 'loading' };
  private lanesAsked = 0;
  private schedules: readonly ScheduleView[] = [];

  constructor(
    private readonly connection: () => Promise<Connection>,
    private readonly post: (message: LanesToView) => void,
    private readonly chat: TaskChat,
    private readonly badge: (needsYou: number) => void,
    private readonly seen: SeenStore,
  ) {}

  dispose(): void {}

  /** A new connection to the engine: what it runs now, its scheduled tasks, and the notices no window heard. */
  async connected(connection: Connection): Promise<void> {
    void connection.agent
      .request<SchedulesResponse, SchedulesRequest>(SCHEDULES_METHOD, { cwd: connection.cwd })
      .then((listing) => this.scheduled(listing))
      .catch(() => {});
    const { tasks, missed } = await connection.agent.request<TasksResponse>(TASKS_METHOD, {});
    this.tasks.clear();
    for (const task of tasks) this.tasks.set(task.sessionId, task);
    this.changed();
    const roots = new Set(missed.flatMap(({ sessionId }) => (this.tasks.has(sessionId) ? [this.rootOf(this.tasks.get(sessionId)!)] : [])));
    for (const root of roots) {
      const placed = this.placementOf(root);
      const notice = placed && attentionNotice({ kind: 'working' }, placed.attention);
      if (placed !== undefined && notice !== undefined) this.tell(notice, placed.task);
    }
  }

  updated({ task }: TaskUpdate): void {
    const before = this.tasks.get(task.sessionId);
    const root = this.rootOf(task);
    const was = this.placementOf(root)?.attention;
    this.tasks.set(task.sessionId, task);
    const now = this.placementOf(root);
    if (before !== undefined && isLive(before.status) && !isLive(task.status) && task.sessionId === this.chat.shown()) this.chat.ended(task);
    const notice = now && attentionNotice(was, now.attention);
    if (now !== undefined && notice !== undefined) this.tell(notice, now.task);
    this.changed();
    if (task.lane !== null && before?.status !== task.status) void this.listLanes();
  }

  scheduled({ tasks }: SchedulesResponse): void {
    this.schedules = tasks;
    this.post({ type: 'schedules', tasks });
  }

  /** The tasks as the pane last heard them, for a webview created later. */
  current(): { readonly tasks: readonly TaskRecord[]; readonly lanes: LanesListing; readonly seen: SeenMarkers; readonly schedules: readonly ScheduleView[] } {
    return { tasks: [...this.tasks.values()], lanes: this.lanes, seen: this.seen.current(), schedules: this.schedules };
  }

  get(sessionId: string): TaskRecord | undefined {
    return this.tasks.get(sessionId);
  }

  /** The session the panel shows changed, or the panel came into view, so the Tasks pane marks another row. */
  reshow(): void {
    this.changed();
  }

  /** The user looked at a session or an Arena run, such as in the Arena pane. */
  saw(id: string): void {
    if (this.markSeen(id)) this.changed();
  }

  /** The top-level task a task rolls up into: its parent while the list holds it, or itself. */
  private rootOf(task: TaskRecord): string {
    return task.parent != null && this.tasks.has(task.parent) ? task.parent : task.sessionId;
  }

  private placed(): PlacedTask[] {
    return placeTasks([...this.tasks.values()], this.seen.current());
  }

  private placementOf(root: string): PlacedTask | undefined {
    return this.placed().find((placed) => placed.task.sessionId === root);
  }

  /** Moves the marker only past a change it has not seen, so the file is written once per change. */
  private markSeen(id: string): boolean {
    const due = this.placementOf(id)?.returnedAt ?? this.tasks.get(id)?.returnedAt;
    if (due == null || due <= (this.seen.current()[id] ?? -Infinity)) return false;
    return this.seen.mark(id, Math.max(Date.now(), due));
  }

  private changed(): void {
    const shown = this.chat.shown();
    // The chat in view, in a window in front, is a session the user sees as it changes.
    if (shown !== undefined && this.chat.panelVisible() && vscode.window.state.focused) this.markSeen(shown);
    this.post({ type: 'tasks', tasks: [...this.tasks.values()], shown, seen: this.seen.current() });
    this.badge(needsYouCount(this.placed()));
  }

  private tell(notice: AttentionNotice, task: TaskRecord): void {
    const channels = channelsOf({ shown: task.sessionId === this.chat.shown(), focused: vscode.window.state.focused, panelVisible: this.chat.panelVisible() });
    const text = noticeText(notice, task);
    if (channels.os && notice.os && process.platform === 'darwin' && vscode.workspace.getConfiguration().get<boolean>(OS_NOTIFICATIONS_SETTING, true)) {
      const [file, args] = osNotification('Geno', text);
      execFile(file, [...args], { timeout: 10_000 }, () => {});
    }
    if (!channels.toast) return;
    void SHOW[notice.severity](text, 'Open').then((choice) => {
      if (choice === 'Open') this.open(task.sessionId);
    });
  }

  /** Opens a top-level task at what it needs of the user: the card, Retry now, or the end of the transcript. */
  private open(root: string): void {
    const placed = this.placementOf(root);
    const attention: Attention = placed?.attention ?? { kind: 'done' };
    const at = attention.kind === 'needs-you' ? attention.at : root;
    const task = this.tasks.get(at);
    if (task === undefined) return;
    // Opening from the list is the user looking, whether or not the window has the focus.
    if (this.markSeen(root)) this.changed();
    if (task.kind === 'arena') return this.chat.openArena(at);
    void this.chat
      .openTask(at, task.workspace)
      .then(() => this.post({ type: 'task-reveal', reveal: revealOf(attention) }))
      .catch(warn);
  }

  private async listLanes(): Promise<void> {
    const asked = ++this.lanesAsked;
    let listing: LanesListing;
    try {
      const { agent, cwd } = await this.connection();
      listing = { kind: 'loaded', ...(await agent.request<LanesResponse, LanesRequest>(LANES_METHOD, { cwd })) };
    } catch (error) {
      listing = { kind: 'failed', message: messageOf(error) };
    }
    // A slow answer never replaces a newer one.
    if (asked !== this.lanesAsked) return;
    this.lanes = listing;
    this.post({ type: 'lanes', listing });
  }

  private lane(name: string) {
    return this.lanes.kind === 'loaded' ? this.lanes.lanes.find((lane) => lane.name === name) : undefined;
  }

  readonly handlers: { readonly [K in LanesFromView['type']]: (message: Extract<LanesFromView, { type: K }>) => void } = {
    'lanes-list': () => void this.listLanes(),
    'lane-new': ({ text }) =>
      void (async () => {
        const { agent, cwd } = await this.connection();
        await agent.request<LaneNewResponse, LaneNewRequest>(LANE_NEW_METHOD, { cwd, prompt: text, mode: this.chat.defaultMode() });
        await this.listLanes();
      })().catch((error: unknown) => {
        warn(error);
        void this.listLanes();
      }),
    'lane-open': ({ name }) => {
      const lane = this.lane(name);
      if (lane?.session != null) void this.chat.openTask(lane.session.id, lane.path).catch(warn);
    },
    'lane-apply': ({ name }) =>
      void this.chat
        .applyLane(name)
        .catch(() => {})
        .finally(() => void this.listLanes()),
    'lane-discard': ({ name, discardChanges }) =>
      void (async () => {
        const { agent, cwd } = await this.connection();
        await agent.request<unknown, LaneDiscardRequest>(LANE_DISCARD_METHOD, { cwd, name, discardChanges });
      })()
        .catch(warn)
        .finally(() => void this.listLanes()),
    'task-open': ({ sessionId }) => this.open(this.tasks.has(sessionId) ? this.rootOf(this.tasks.get(sessionId)!) : sessionId),
    'task-seen': ({ id }) => this.saw(id),
    'task-origin': ({ sessionId, workspace }) => void this.chat.openTask(sessionId, workspace).catch(warn),
    'task-stop': ({ sessionId }) =>
      void this.connection()
        .then(({ agent }) => agent.notify(acp.methods.agent.session.cancel, { sessionId }))
        .catch(warn),
    'task-job-stop': ({ sessionId, id }) =>
      void this.connection()
        .then(({ agent }) => agent.request<unknown, BackgroundStopRequest>(BACKGROUND_STOP_METHOD, { sessionId, id }))
        .catch(warn),
    'schedule-act': ({ id, action }) =>
      void (async () => {
        const { agent, cwd } = await this.connection();
        this.scheduled(await agent.request<SchedulesResponse, ScheduleActRequest>(SCHEDULE_ACT_METHOD, { cwd, id, action }));
      })().catch(warn),
    'task-wake-cancel': ({ sessionId }) =>
      void this.connection()
        .then(({ agent }) => agent.request<unknown, WakeCancelRequest>(WAKE_CANCEL_METHOD, { sessionId }))
        .catch(warn),
  };
}
