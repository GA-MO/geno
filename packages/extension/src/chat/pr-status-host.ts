import * as vscode from 'vscode';
import { PR_STATUS_METHOD, type PrLookup, type PrStatusRequest, type PrStatusResponse } from '@g-code/core';
import type { Connection } from './engine.js';
import { GH_HELP_URL, nextRefreshMs, prRefreshOf, prStatusLine, type PrStatusFromView, type PrStatusLine, type PrStatusToView } from './pr-status-model.js';

export type PrStatusChat = {
  readonly connection: () => Promise<Connection>;
  /** The folder whose branch the line is about: the shown chat's lane, else the workspace. */
  readonly folder: () => string | undefined;
  readonly visible: () => boolean;
  readonly post: (message: PrStatusToView) => void;
};

/**
 * Keeps the status line above the composer: asks the engine, which runs the user's gh, what the folder's branch
 * has. It looks when the panel shows, the window regains focus, a turn ends or HEAD moves, at most every 30 s, and
 * every minute by itself only while a check is pending and the panel is visible.
 */
export class PrStatusHost {
  private line: PrStatusLine | undefined;
  private url: string | undefined;
  private lookedAt = 0;
  private looking = false;
  private stale = false;
  private helpHidden = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly watchers: vscode.Disposable[] = [];
  private readonly policy = prRefreshOf(process.env);

  constructor(private readonly chat: PrStatusChat) {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const head = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.git/HEAD'));
      this.watchers.push(head, head.onDidChange(() => this.refresh(true)), head.onDidCreate(() => this.refresh(true)));
    }
  }

  current(): PrStatusToView {
    return { type: 'pr-status', line: this.line };
  }

  readonly handlers: { readonly [K in PrStatusFromView['type']]: (message: Extract<PrStatusFromView, { type: K }>) => void } = {
    'open-pr': () => {
      const target = this.line?.kind === 'help' ? GH_HELP_URL : this.url;
      if (target?.startsWith('https://') === true) void vscode.env.openExternal(vscode.Uri.parse(target));
    },
    'hide-pr-help': () => {
      this.helpHidden = true;
      if (this.line?.kind === 'help') this.show(undefined);
    },
  };

  /** Looks again, unless it looked within the last 30 s; `now` skips that wait, as for a new view or a moved HEAD. */
  refresh(now = false): void {
    if (this.looking) return;
    if (!now && Date.now() - this.lookedAt < this.policy.minGapMs) return;
    this.looking = true;
    void this.look().finally(() => (this.looking = false));
  }

  /** The panel showed again: a look the timer skipped while it was hidden runs now. */
  shown(): void {
    this.refresh(this.stale);
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.dispose();
  }

  private async look(): Promise<void> {
    clearTimeout(this.timer);
    this.stale = false;
    const cwd = this.chat.folder();
    if (cwd === undefined) return;
    let lookup: PrLookup;
    try {
      const { agent } = await this.chat.connection();
      lookup = await agent.request<PrStatusResponse, PrStatusRequest>(PR_STATUS_METHOD, { cwd });
    } catch (error) {
      lookup = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
    this.lookedAt = Date.now();
    if (lookup.kind !== 'failed') this.url = lookup.kind === 'pr' ? lookup.pr.url : undefined;
    this.show(prStatusLine(lookup, this.line, this.helpHidden));
    const next = nextRefreshMs(lookup, this.policy);
    if (next === undefined) return;
    this.timer = setTimeout(() => {
      if (this.chat.visible()) this.refresh(true);
      else this.stale = true;
    }, next);
  }

  private show(line: PrStatusLine | undefined): void {
    this.line = line;
    this.chat.post(this.current());
  }
}
