import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  asCompletionId,
  buildNextEditPrompt,
  parseNextEdit,
  streamNextEdit,
  type CompletionId,
  type FimResult,
  type NextEdit,
  type NextEditPrompt,
  type Outcome,
} from '@g-code/core/tab';
import type { EditHistoryTracker } from './history.js';
import type { TabLog } from './log.js';
import { debounce, snippetsFor, TabProvider, type TabSettings } from './provider.js';
import { ACCEPT_COMMAND } from './tracker.js';

/**
 * Whether this VS Code lets the extension use the inline-edit proposal: Insiders run with the proposal enabled.
 * Stable strips the proposal, and its guarded getter then throws.
 */
export function inlineEditsAvailable(): boolean {
  try {
    return vscode.languages.inlineCompletionsUnificationState !== undefined;
  } catch {
    return false;
  }
}

/** How VS Code ended a shown inline edit. An accept is logged by the item's command, which also checks persistence. */
function outcomeOf(reason: vscode.InlineCompletionEndOfLifeReason): Outcome | undefined {
  const kinds = vscode.InlineCompletionEndOfLifeReasonKind;
  if (reason.kind === kinds.Accepted) return undefined;
  if (reason.kind === kinds.Ignored && reason.userTypingDisagreed) return { kind: 'typed-over' };
  return { kind: 'rejected' };
}

type Asked = { readonly result: FimResult; readonly sentAt: string } | 'cancelled' | undefined;

export class NextEditProvider {
  readonly #shown = new WeakMap<vscode.InlineCompletionItem, CompletionId>();
  #model = 'unknown';

  constructor(
    private readonly settings: () => TabSettings,
    private readonly log: TabLog,
    private readonly history: EditHistoryTracker,
  ) {}

  async provide(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const settings = this.settings();
    const offset = document.offsetAt(position);
    const version = document.version;
    const prompt = buildNextEditPrompt(
      this.history.history,
      { path: vscode.workspace.asRelativePath(document.uri), text: document.getText() },
      offset,
      snippetsFor(document),
    );
    const asked = await this.#ask(prompt, settings, token);
    if (asked === undefined) return undefined;
    if (asked === 'cancelled') {
      this.#record(document, offset, version, prompt, undefined, null, { kind: 'cancelled' });
      return undefined;
    }

    const prediction = parseNextEdit(asked.result.text, prompt.inputs.region);
    const stale = document.version !== version;
    const edit = prediction.kind === 'edit' ? prediction : null;
    const outcome: Outcome = stale
      ? { kind: 'suppressed', filter: 'stale' }
      : edit === null
        ? { kind: 'suppressed', filter: 'empty' }
        : { kind: 'shown' };
    const id = this.#record(document, offset, version, prompt, asked, edit, outcome);
    if (outcome.kind !== 'shown' || edit === null) return undefined;
    const item = this.#item(document, position, id, edit);
    this.#shown.set(item, id);
    return [item];
  }

  endOfLife(item: vscode.InlineCompletionItem, reason: vscode.InlineCompletionEndOfLifeReason): void {
    const id = this.#shown.get(item);
    const outcome = id && outcomeOf(reason);
    if (id === undefined || outcome === undefined) return;
    this.log({ kind: 'outcome', id, at: new Date().toISOString(), outcome });
  }

  async #ask(prompt: NextEditPrompt, settings: TabSettings, token: vscode.CancellationToken): Promise<Asked> {
    if (token.isCancellationRequested || !(await debounce(settings.debounceMs, token))) return undefined;
    const controller = new AbortController();
    const listener = token.onCancellationRequested(() => controller.abort());
    const sentAt = new Date().toISOString();
    try {
      const result = await streamNextEdit({
        fetch: globalThis.fetch,
        endpoint: settings.nextEditEndpoint,
        prompt,
        signal: controller.signal,
        now: () => performance.now(),
      });
      this.#model = result.model ?? this.#model;
      return { result, sentAt };
    } catch {
      return token.isCancellationRequested ? 'cancelled' : undefined;
    } finally {
      listener.dispose();
    }
  }

  #record(
    document: vscode.TextDocument,
    offset: number,
    version: number,
    prompt: NextEditPrompt,
    asked: Exclude<Asked, 'cancelled'>,
    edit: Extract<NextEdit, { kind: 'edit' }> | null,
    outcome: Outcome,
  ): CompletionId {
    const id = asCompletionId(randomUUID());
    this.log({
      kind: 'request',
      request: {
        id,
        kind: 'next-edit',
        path: document.uri.fsPath,
        version,
        offset,
        inputs: prompt.inputs,
        model: asked?.result.model ?? this.#model,
        source: 'model',
        promptTokens: asked?.result.promptTokens ?? prompt.tokens,
        sentAt: asked?.sentAt ?? new Date().toISOString(),
        ttftMs: asked?.result.ttftMs ?? null,
        latencyMs: asked?.result.latencyMs ?? null,
        text: edit?.text ?? null,
        edit: edit && { start: edit.start, end: edit.end, text: edit.text },
        outcome,
        persisted: 'unknown',
      },
    });
    return id;
  }

  /** An inline edit; one away from the cursor also gets a labelled display location so VS Code can point to it. */
  #item(document: vscode.TextDocument, position: vscode.Position, id: CompletionId, edit: Extract<NextEdit, { kind: 'edit' }>) {
    const range = new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end));
    const item = new vscode.InlineCompletionItem(edit.text, range, {
      title: 'Accept next edit',
      command: ACCEPT_COMMAND,
      arguments: [document.uri, id, edit.text],
    });
    item.isInlineEdit = true;
    if (!range.contains(position)) {
      item.displayLocation = {
        range,
        kind: vscode.InlineCompletionDisplayLocationKind.Label,
        label: `Next edit at line ${range.start.line + 1}`,
      };
    }
    return item;
  }
}

/** Sends each request to next-edit or FIM by the current setting, so toggling it needs no reload. */
export class TabRouter implements vscode.InlineCompletionItemProvider {
  constructor(
    private readonly settings: () => TabSettings,
    private readonly fim: TabProvider,
    private readonly nextEdit: NextEditProvider,
  ) {}

  provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ) {
    const settings = this.settings();
    if (settings.nextEdit && settings.enabled && context.selectedCompletionInfo === undefined) {
      return this.nextEdit.provide(document, position, token);
    }
    return this.fim.provideInlineCompletionItems(document, position, context, token);
  }

  handleEndOfLifetime(item: vscode.InlineCompletionItem, reason: vscode.InlineCompletionEndOfLifeReason): void {
    this.nextEdit.endOfLife(item, reason);
  }
}
