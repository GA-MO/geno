import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  asCompletionId,
  buildFimPrompt,
  completionText,
  DEFAULT_FIM_BUDGET,
  DEFAULT_MAX_LINES,
  firstFilter,
  remainderAfter,
  streamFim,
  TabCache,
  type CompletionId,
  type CompletionSource,
  type FimPrompt,
  type FimResult,
  type Outcome,
  type Snippet,
} from '@g-code/core/tab';
import type { TabLog } from './log.js';
import { ACCEPT_COMMAND, type OutcomeTracker } from './tracker.js';

export type TabSettings = {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly debounceMs: number;
  readonly nextEdit: boolean;
  readonly nextEditEndpoint: string;
};

export const readSettings = (): TabSettings => {
  const config = vscode.workspace.getConfiguration('gcode.tab');
  return {
    enabled: config.get('enabled', true),
    endpoint: config.get('endpoint', 'http://127.0.0.1:8012'),
    debounceMs: config.get('debounceMs', 250),
    nextEdit: config.get('nextEdit', false),
    nextEditEndpoint: config.get('nextEditEndpoint', 'http://127.0.0.1:8013'),
  };
};

const MAX_SNIPPET_FILES = 3;
const MAX_SNIPPET_FILE_CHARS = 200_000;
// A cancelled call's request lives this long so the next keystroke's call can adopt it if its typing matches.
const ADOPT_GRACE_MS = 100;

/** One model call, shared by every provider call whose typing has run ahead of it. */
type Flight = {
  readonly result: Promise<FimResult | undefined>;
  readonly controller: AbortController;
  done: boolean;
  users: number;
};

type Answer = {
  readonly source: CompletionSource;
  readonly result: FimResult;
  readonly text: string;
  readonly sentAt: string;
  readonly waitedMs: number;
};

export const debounce = (ms: number, token: vscode.CancellationToken): Promise<boolean> =>
  new Promise((resolve) => {
    const listener = token.onCancellationRequested(() => {
      clearTimeout(timer);
      listener.dispose();
      resolve(false);
    });
    const timer = setTimeout(() => {
      listener.dispose();
      resolve(!token.isCancellationRequested);
    }, ms);
  });

/** The flight's result, or undefined as soon as the caller is cancelled; the last caller to leave aborts it. */
function join(flight: Flight, token: vscode.CancellationToken): Promise<FimResult | undefined> {
  flight.users++;
  const leave = () => {
    if (--flight.users === 0) setTimeout(() => flight.users === 0 && flight.controller.abort(), ADOPT_GRACE_MS);
  };
  return new Promise((resolve) => {
    const listener = token.onCancellationRequested(() => {
      listener.dispose();
      leave();
      resolve(undefined);
    });
    void flight.result.then((result) => {
      if (token.isCancellationRequested) return;
      listener.dispose();
      leave();
      resolve(result);
    });
  });
}

export function snippetsFor(document: vscode.TextDocument): Snippet[] {
  const visible = new Set(vscode.window.visibleTextEditors.map((e) => e.document));
  return vscode.workspace.textDocuments
    .filter((d) => d !== document && d.uri.scheme === 'file' && d.getText().length <= MAX_SNIPPET_FILE_CHARS)
    .sort((a, b) => Number(visible.has(b)) - Number(visible.has(a)))
    .slice(0, MAX_SNIPPET_FILES)
    .map((d) => ({ path: vscode.workspace.asRelativePath(d.uri), text: d.getText() }));
}

function cursorOf(document: vscode.TextDocument): { version: number; offset: number } {
  const editor = vscode.window.activeTextEditor;
  const offset = editor?.document === document ? document.offsetAt(editor.selection.active) : -1;
  return { version: document.version, offset };
}

export class TabProvider implements vscode.InlineCompletionItemProvider {
  readonly #cache = new TabCache<Flight>();
  #model = 'unknown';

  constructor(
    private readonly settings: () => TabSettings,
    private readonly log: TabLog,
    private readonly tracker: OutcomeTracker,
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const settings = this.settings();
    if (!settings.enabled || context.selectedCompletionInfo !== undefined) return undefined;

    const offset = document.offsetAt(position);
    const requested = { version: document.version, offset };
    const text = document.getText();
    const prompt = buildFimPrompt(
      {
        repo: vscode.workspace.getWorkspaceFolder(document.uri)?.name ?? path.basename(path.dirname(document.uri.fsPath)),
        path: vscode.workspace.asRelativePath(document.uri),
        prefix: text.slice(0, offset),
        suffix: text.slice(offset),
        snippets: snippetsFor(document),
      },
      DEFAULT_FIM_BUDGET,
    );

    const answer = (await this.#reuse(prompt, token)) ?? (await this.#ask(prompt, settings, token));
    if (answer === undefined) return undefined;
    if (answer === 'cancelled') {
      this.#record(document, offset, requested.version, prompt, undefined, { kind: 'cancelled' });
      return undefined;
    }

    const continuing = this.tracker.showing(document.uri, offset);
    if (continuing?.shown.text === answer.text) return [this.#item(document, position, continuing.id, answer.text)];

    const filter = firstFilter({
      text: answer.text,
      suffix: prompt.inputs.suffix,
      maxLines: DEFAULT_MAX_LINES,
      requested,
      current: cursorOf(document),
    });
    const id = this.#record(
      document,
      offset,
      requested.version,
      prompt,
      answer,
      filter === undefined ? { kind: 'shown' } : { kind: 'suppressed', filter },
    );
    if (filter !== undefined) return undefined;
    this.tracker.shown(document.uri, id, { offset, text: answer.text });
    return [this.#item(document, position, id, answer.text)];
  }

  /** A cached or still-streaming result whose text starts with what the user typed since it was asked for. */
  async #reuse(prompt: FimPrompt, token: vscode.CancellationToken): Promise<Answer | undefined> {
    const hit = this.#cache.find(prompt.inputs.prefix, prompt.inputs.suffix);
    if (hit === undefined) return undefined;
    const source = hit.value.done ? 'cache' : 'in-flight';
    const sentAt = new Date().toISOString();
    const started = performance.now();
    const result = await join(hit.value, token);
    const text = result && remainderAfter(completionText(result.text), hit.typed);
    if (result === undefined || text === undefined) return undefined;
    return { source, result, text, sentAt, waitedMs: performance.now() - started };
  }

  async #ask(prompt: FimPrompt, settings: TabSettings, token: vscode.CancellationToken) {
    if (token.isCancellationRequested || !(await debounce(settings.debounceMs, token))) return undefined;
    const controller = new AbortController();
    const result = streamFim({
      fetch: globalThis.fetch,
      endpoint: settings.endpoint,
      prompt,
      signal: controller.signal,
      now: () => performance.now(),
    }).catch(() => undefined);
    const flight: Flight = { result, controller, done: false, users: 0 };
    this.#cache.put(prompt.inputs.prefix, prompt.inputs.suffix, flight);
    void result.then((r) => {
      flight.done = true;
      if (r === undefined) this.#cache.delete(flight);
    });
    const sentAt = new Date().toISOString();
    const answer = await join(flight, token);
    if (answer === undefined) return token.isCancellationRequested ? ('cancelled' as const) : undefined;
    this.#model = answer.model ?? this.#model;
    return { source: 'model', result: answer, text: completionText(answer.text), sentAt, waitedMs: 0 } satisfies Answer;
  }

  #record(
    document: vscode.TextDocument,
    offset: number,
    version: number,
    prompt: FimPrompt,
    answer: Answer | undefined,
    outcome: Outcome,
  ): CompletionId {
    const id = asCompletionId(randomUUID());
    const fromModel = answer?.source === 'model';
    this.log({
      kind: 'request',
      request: {
        id,
        kind: 'fim',
        path: document.uri.fsPath,
        version,
        offset,
        inputs: prompt.inputs,
        model: answer?.result.model ?? this.#model,
        source: answer?.source ?? 'model',
        promptTokens: answer?.result.promptTokens ?? prompt.tokens,
        sentAt: answer?.sentAt ?? new Date().toISOString(),
        ttftMs: answer === undefined ? null : fromModel ? answer.result.ttftMs : answer.waitedMs,
        latencyMs: answer === undefined ? null : fromModel ? answer.result.latencyMs : answer.waitedMs,
        text: answer?.text ?? null,
        outcome,
        persisted: 'unknown',
      },
    });
    return id;
  }

  #item(document: vscode.TextDocument, position: vscode.Position, id: CompletionId, text: string) {
    return new vscode.InlineCompletionItem(text, new vscode.Range(position, position), {
      title: 'Accept completion',
      command: ACCEPT_COMMAND,
      arguments: [document.uri, id, text],
    });
  }
}
