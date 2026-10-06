import { execFile } from 'node:child_process';
import * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import {
  isLive,
  LANE_DISCARD_METHOD,
  LANE_NEW_METHOD,
  LANES_METHOD,
  TASK_NOTICES,
  TASKS_METHOD,
  type LaneDiscardRequest,
  type LaneNewRequest,
  type LaneNewResponse,
  type LanesRequest,
  type LanesResponse,
  type TaskNotice,
  type TaskNoticeKind,
  type TaskRecord,
  type TasksResponse,
  type TaskUpdate,
} from '@g-code/core';
import type { Connection } from './engine.js';
import type { LanesFromView, LanesListing, LanesToView } from './lanes-model.js';
import { BACKEND_LABELS } from './backends-host.js';
import { channelsOf, noticeText, osNotification } from './notices.js';

export const OS_NOTIFICATIONS_SETTING = 'gcode.tasks.osNotifications';

/** What the panel does for the panes: open a session, apply a lane through the shown chat, know what it shows. */
export type TaskChat = {
  readonly shown: () => string | undefined;
  readonly panelVisible: () => boolean;
  readonly openTask: (sessionId: string, workspace: string) => Promise<void>;
  readonly applyLane: (name: string) => Promise<unknown>;
  /** A task of the shown session ended in the background, such as one the panel adopted after a reload. */
  readonly ended: (task: TaskRecord) => void;
  readonly defaultMode: () => string;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const warn = (error: unknown): void => void vscode.window.showWarningMessage(messageOf(error));

const SHOW: Readonly<Record<TaskNotice['severity'], (message: string, ...items: string[]) => Thenable<string | undefined>>> = {
  info: (message, ...items) => vscode.window.showInformationMessage(message, ...items),
  warning: (message, ...items) => vscode.window.showWarningMessage(message, ...items),
  error: (message, ...items) => vscode.window.showErrorMessage(message, ...items),
};

/**
 * The engine's tasks and the lanes of this folder, for the Tasks and Lanes panes, and the notices their changes
 * call for. The engine tells every connected window about each change; this window shows a notice by the trigger
 * table, and also the notices of changes that came while no window was connected.
 */
export class TaskHost implements vscode.Disposable {
  private readonly tasks = new Map<string, TaskRecord>();
  private lanes: LanesListing = { kind: 'loading' };
  private lanesAsked = 0;

  constructor(
    private readonly connection: () => Promise<Connection>,
    private readonly post: (message: LanesToView) => void,
    private readonly chat: TaskChat,
    private readonly badge: (running: number) => void,
  ) {}

  dispose(): void {}

  /** A new connection to the engine: what it runs now, and the notices no window heard. */
  async connected(connection: Connection): Promise<void> {
    const { tasks, missed } = await connection.agent.request<TasksResponse>(TASKS_METHOD, {});
    this.tasks.clear();
    for (const task of tasks) this.tasks.set(task.sessionId, task);
    this.changed();
    for (const { sessionId, kind } of missed) {
      const task = this.tasks.get(sessionId);
      if (task !== undefined) this.tell(kind, task);
    }
  }

  updated({ task, notice }: TaskUpdate): void {
    const before = this.tasks.get(task.sessionId);
    this.tasks.set(task.sessionId, task);
    this.changed();
    if (before !== undefined && isLive(before.status) && !isLive(task.status) && task.sessionId === this.chat.shown()) this.chat.ended(task);
    if (notice !== null) this.tell(notice, task);
    if (task.lane !== null && before?.status !== task.status) void this.listLanes();
  }

  /** The tasks as the pane last heard them, for a webview created later. */
  current(): { readonly tasks: readonly TaskRecord[]; readonly lanes: LanesListing } {
    return { tasks: [...this.tasks.values()], lanes: this.lanes };
  }

  get(sessionId: string): TaskRecord | undefined {
    return this.tasks.get(sessionId);
  }

  /** The session the panel shows changed, so the Tasks pane marks another row. */
  reshow(): void {
    this.changed();
  }

  private changed(): void {
    this.post({ type: 'tasks', tasks: [...this.tasks.values()], shown: this.chat.shown(), backends: BACKEND_LABELS });
    this.badge([...this.tasks.values()].filter((task) => isLive(task.status) && task.sessionId !== this.chat.shown()).length);
  }

  private tell(kind: TaskNoticeKind, task: TaskRecord): void {
    const notice = TASK_NOTICES[kind]!;
    const channels = channelsOf({ shown: task.sessionId === this.chat.shown(), focused: vscode.window.state.focused, panelVisible: this.chat.panelVisible() });
    const text = noticeText(notice, task);
    if (channels.os && process.platform === 'darwin' && vscode.workspace.getConfiguration().get<boolean>(OS_NOTIFICATIONS_SETTING, true)) {
      const [file, args] = osNotification('Geno', text);
      execFile(file, [...args], { timeout: 10_000 }, () => {});
    }
    if (!channels.toast) return;
    void SHOW[notice.severity](text, 'Open').then((choice) => {
      if (choice === 'Open') void this.chat.openTask(task.sessionId, task.workspace).catch(warn);
    });
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
    'task-open': ({ sessionId }) => {
      const task = this.tasks.get(sessionId);
      if (task !== undefined) void this.chat.openTask(sessionId, task.workspace).catch(warn);
    },
    'task-stop': ({ sessionId }) =>
      void this.connection()
        .then(({ agent }) => agent.notify(acp.methods.agent.session.cancel, { sessionId }))
        .catch(warn),
  };
}
