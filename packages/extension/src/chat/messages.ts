import type { AppliedRule, AskUserAnswer, AskUserAnswers, AskUserRequest, HunkStatus, MemoryEntry, MemoryScope } from '@g-code/core';
import type { AttachmentView, OpenTarget, OutgoingAttachment, PickedFile, Refused } from './attachment-model.js';
import type { ComposerFromView, ComposerToView } from './composer-model.js';
import type { McpFromView, McpToView } from './mcp-model.js';
import type { SettingsFromView, SettingsToView } from './settings-model.js';
import type { WidgetTheme } from './widget-frame.js';
import type { MentionCompletion } from './mentions.js';
import type { CommandOption, SentCommand } from './slash.js';

/**
 * The chat transcript, the one model the panel renders. The extension owns it and sends every change as an
 * Action; the webview runs the same reducer (transcript.ts) and renders the result, so replaying or
 * resending the whole transcript can never leave the view out of step.
 */
export type Transcript = { readonly model: string; readonly turns: readonly Turn[] };

export type Turn = {
  readonly id: string;
  readonly prompt: string;
  readonly blocks: readonly Block[];
  readonly status: TurnStatus;
  /** Milliseconds since the epoch, stamped by the extension; `endedAt` is undefined while the turn runs. */
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  /** Undefined until the turn ends, and for a turn that failed before the model answered. */
  readonly usage: Usage | undefined;
  /** A passing status while the turn runs, such as a retry; the next output or the turn's end clears it. */
  readonly notice?: string | undefined;
  /** Images and files the user sent with the prompt. */
  readonly attachments?: readonly AttachmentView[] | undefined;
  /** The session's approval mode when the prompt was sent; undefined for a turn replayed from an older log. */
  readonly mode?: string | undefined;
  /** The `/` command the prompt invoked, which the bubble shows as a chip and its arguments. */
  readonly command?: SentCommand | undefined;
};

export type TurnStatus = 'streaming' | 'done' | 'stopped' | 'failed';

export type Usage = { readonly model: string; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number | null };

/** What the assistant did in a turn, in the order it happened. */
export type Block = TextBlock | ToolBlock | PermissionBlock | ErrorBlock;

export type TextBlock = { readonly kind: 'text'; readonly id: string; readonly text: string };

/** The ACP tool kinds the engine sends; anything else shows as `other`. */
export const TOOL_KINDS = ['read', 'search', 'edit', 'execute', 'other'] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/** `cancelled` is a tool still running when its turn ended. */
export type ToolStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** One tool call. An edit that reached the editor carries its diff, and renders as an edit card. */
export type ToolBlock = {
  readonly kind: 'tool';
  readonly id: string;
  /** The tool's name, such as `read` or `bash`. */
  readonly name: string;
  /** What it acts on: a path, a pattern or a command. */
  readonly target: string;
  readonly toolKind: ToolKind;
  readonly status: ToolStatus;
  /** Milliseconds since the epoch, stamped by the extension as the updates arrive. */
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly output: string | undefined;
  readonly diff: FileDiff | undefined;
  /** Images the tool returned, such as a read of a PNG, shown as thumbnails on the step. */
  readonly images?: readonly ToolImage[] | undefined;
  /** A flagged command Auto settled without asking: the classifier's verdict and its reason. */
  readonly auto?: AutoDecision | undefined;
  /** What a show_widget call draws: its loading lines while the model writes it, then the widget. */
  readonly widget?: ToolWidget | undefined;
};

/**
 * A widget's life on its step: drafting while the model writes it, ready with the stored html once the call ran,
 * missing when a loaded session's attachments folder no longer holds it.
 */
export type ToolWidget =
  | { readonly state: 'drafting'; readonly title: string | undefined; readonly loading: readonly string[] }
  | { readonly state: 'ready'; readonly title: string; readonly sha256: string; readonly html: string }
  | { readonly state: 'missing'; readonly title: string };

/** An image file a tool returned; `path` is absolute. */
export type ToolImage = { readonly path: string; readonly name: string };

export type AutoDecision = { readonly verdict: 'allow' | 'deny'; readonly reason: string };

/** A file an edit changed, as hunks the review controller tracks by the same ids. */
export type FileDiff = { readonly path: string; readonly hunks: readonly DiffHunk[] };

export type DiffHunk = {
  readonly id: string;
  /** 1-based line of the new text in the file right after the edit. */
  readonly line: number;
  readonly removed: readonly string[];
  readonly added: readonly string[];
  readonly status: HunkStatus;
};

export type PermissionChoice = { readonly optionId: string; readonly name: string; readonly kind: string };

export type PermissionOutcome =
  | { readonly kind: 'open' }
  | { readonly kind: 'chosen'; readonly optionId: string }
  /** A question card's answers, keyed by question id. */
  | { readonly kind: 'answered'; readonly answers: AskUserAnswers }
  /** The user declined a question card, with Skip or Esc. */
  | { readonly kind: 'skipped' }
  | { readonly kind: 'cancelled' };

/**
 * What a card asks besides running a command: to keep a note across sessions (`remember`), or one to four questions
 * (`ask_user`), each with its options and an Other answer in the user's own words.
 */
export type PermissionAsk = { readonly kind: 'memory'; readonly text: string; readonly scope: MemoryScope } | { readonly kind: 'question'; readonly request: AskUserRequest };

/**
 * The engine waiting on the user: before it runs a command its rules hold back, or, with `ask`, before it keeps a
 * note or for the answer to a question. Every such card is one of these, so whatever shows a waiting card shows all.
 */
export type PermissionBlock = {
  readonly kind: 'permission';
  readonly id: string;
  readonly command: string;
  readonly reason: string;
  readonly options: readonly PermissionChoice[];
  readonly outcome: PermissionOutcome;
  /** Why the classifier would not decide, when Auto asked it first. */
  readonly classifier?: string | undefined;
  readonly ask?: PermissionAsk | undefined;
  /** The call it asks about. Its own update can reach the panel after the question does. */
  readonly toolId?: string | undefined;
};

export type ErrorBlock = { readonly kind: 'error'; readonly id: string; readonly message: string };

/**
 * A change to the transcript. Everything but `reset`, `model` and `review` applies to the last turn, the only
 * one that can still change. `at` is when the extension saw the update, so a replay keeps the durations.
 */
export type Action =
  | { readonly type: 'reset'; readonly transcript: Transcript }
  | { readonly type: 'model'; readonly model: string }
  | {
      readonly type: 'turn-start';
      readonly id: string;
      readonly at: number;
      readonly prompt: string;
      readonly attachments?: readonly AttachmentView[] | undefined;
      readonly mode?: string | undefined;
      readonly command?: SentCommand | undefined;
    }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'notice'; readonly text: string }
  /** Starts a tool call or updates one; an absent field keeps its value. */
  | {
      readonly type: 'tool';
      readonly id: string;
      readonly at: number;
      readonly name?: string;
      readonly target?: string;
      readonly toolKind?: ToolKind;
      readonly status?: ToolStatus;
      readonly output?: string;
      readonly images?: readonly ToolImage[];
      readonly auto?: AutoDecision;
      readonly widget?: ToolWidget;
    }
  | { readonly type: 'diff'; readonly toolId: string; readonly at: number; readonly diff: FileDiff }
  /** The review status of hunks, whichever surface decided them; hunks the transcript lacks are ignored. */
  | { readonly type: 'review'; readonly hunks: Readonly<Record<string, HunkStatus>> }
  | {
      readonly type: 'permission';
      readonly id: string;
      readonly command: string;
      readonly reason: string;
      readonly options: readonly PermissionChoice[];
      readonly classifier?: string | undefined;
      readonly ask?: PermissionAsk | undefined;
      readonly toolId?: string | undefined;
    }
  /** `answer` settles a question card; otherwise `optionId` is the choice, undefined when the request was cancelled. */
  | { readonly type: 'permission-done'; readonly id: string; readonly optionId: string | undefined; readonly answer?: AskUserAnswer | undefined }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'turn-end'; readonly at: number; readonly status: Exclude<TurnStatus, 'streaming'>; readonly usage: Usage | undefined };

/** How the panel looks: dark glass with a rainbow edge on live work, or VS Code's native styling (`gcode.ui.style`). */
export const UI_STYLES = ['glass', 'native'] as const;
export type UiStyle = (typeof UI_STYLES)[number];

/** How much of a turn the panel draws (`gcode.chat.detail`): compact folds its work behind one line; full draws every step. */
export const CHAT_DETAILS = ['compact', 'full'] as const;
export type ChatDetail = (typeof CHAT_DETAILS)[number];

/** The panel's look from settings, which the page carries as `data-style` and `data-detail` on its body. */
export type Look = { readonly style: UiStyle; readonly detail: ChatDetail };

/** An approval mode the session can be in, as the engine advertises it through ACP. */
export type ModeOption = { readonly id: string; readonly name: string; readonly description: string | undefined };

/** The session's approval modes and the one it is in. */
export type Modes = { readonly current: string; readonly available: readonly ModeOption[] };

/**
 * What the panel's header names: the workspace folder, and the session's title, undefined until its first prompt.
 * The start page also shows the folder's branch, undefined outside a repository.
 */
export type Header = { readonly project: string; readonly title: string | undefined; readonly branch: string | undefined };

/** The history lists this project's sessions, or every project's. */
export const HISTORY_SCOPES = ['project', 'all'] as const;
export type HistoryScope = (typeof HISTORY_SCOPES)[number];

/** One past session in the history list. */
export type HistoryRow = {
  readonly id: string;
  readonly title: string;
  /** The session's workspace, absolute. */
  readonly workspace: string;
  /** The name of the session's workspace folder. */
  readonly project: string;
  /** False for another project's session, which opens in that project's window. */
  readonly here: boolean;
  /** Milliseconds since the epoch. */
  readonly updatedAt: number;
  readonly turns: number;
  readonly costUsd: number | null;
  /** The session the panel shows. */
  readonly current: boolean;
};

/** What the extension tells the chat webview: transcript changes, answers to its requests, its style and header. */
export type ToView =
  | Action
  | { readonly type: 'completions'; readonly id: number; readonly items: readonly MentionCompletion[] }
  | { readonly type: 'look'; readonly look: Look }
  /** Files the user picked or dropped from the explorer, read by the extension, for the composer to attach. */
  | { readonly type: 'picked'; readonly files: readonly PickedFile[]; readonly refused: readonly Refused[] }
  /** The workspace folders and the webview addresses they are served at, for images in the transcript. */
  | { readonly type: 'roots'; readonly roots: readonly WebviewRoot[] }
  | { readonly type: 'header'; readonly header: Header }
  /** Whether the VS Code window has the focus; Noodle rests while it does not. */
  | { readonly type: 'window-focus'; readonly focused: boolean }
  | { readonly type: 'modes'; readonly modes: Modes }
  /** The `/` commands the session offers, for the composer's picker. */
  | { readonly type: 'commands'; readonly commands: readonly CommandOption[] }
  /** The History action: open the list. */
  | { readonly type: 'show-history' }
  /** Closes the list, after a session was chosen or a new chat started. */
  | { readonly type: 'hide-history' }
  | { readonly type: 'history'; readonly scope: HistoryScope; readonly rows: readonly HistoryRow[] }
  | { readonly type: 'history-failed'; readonly scope: HistoryScope; readonly message: string }
  | McpToView
  | SettingsToView
  | ContextToView
  | ComposerToView;

/** What a rules or memory pane shows: nothing yet, the engine's answer, or why it failed. */
export type Listing<T> = { readonly kind: 'loading' } | ({ readonly kind: 'loaded' } & T) | { readonly kind: 'failed'; readonly message: string };

export type RulesListing = Listing<{ readonly rules: readonly AppliedRule[]; readonly globalFile: string }>;
export type MemoryListing = Listing<{ readonly entries: readonly MemoryEntry[] }>;

/** The rules and memory panes, which the `/rules` and `/memory` built-ins open. */
export type ContextToView =
  | { readonly type: 'rules'; readonly listing: RulesListing }
  | { readonly type: 'show-rules' }
  | { readonly type: 'memory'; readonly listing: MemoryListing }
  | { readonly type: 'show-memory' };

/** Each is answered by a `rules` or `memory` message, but `open-file`, which opens an editor tab. */
export type ContextFromView =
  | { readonly type: 'rules-list' }
  /** `file` is absolute. */
  | { readonly type: 'open-file'; readonly file: string }
  /** Creates the global rules file when missing and opens it. */
  | { readonly type: 'edit-global-rules' }
  | { readonly type: 'memory-list' }
  | { readonly type: 'memory-edit'; readonly id: string; readonly text: string }
  | { readonly type: 'memory-delete'; readonly id: string };

/** A widget's actions: `theme` is the panel's widget theme as it is now, which a download or a tab keeps. */
export type WidgetFromView =
  /** A link a widget asked to open, which the user approved under the widget. */
  | { readonly type: 'widget-link'; readonly href: string }
  | { readonly type: 'widget-open'; readonly toolId: string; readonly theme: WidgetTheme }
  | { readonly type: 'widget-download'; readonly toolId: string; readonly theme: WidgetTheme }
  /** The panel could not put the image on the clipboard, so the extension offers to save it. `png` is base64. */
  | { readonly type: 'widget-image'; readonly title: string; readonly png: string };

/** What the widget tab is told, and what its page asks. */
export type ToWidgetTab = { readonly type: 'show'; readonly html: string; readonly theme: WidgetTheme };
export type FromWidgetTab = { readonly type: 'ready' } | { readonly type: 'widget-link'; readonly href: string };

/** A folder the webview may load images from: its absolute path and the address of that folder inside the webview. */
export type WebviewRoot = { readonly path: string; readonly uri: string };

/** What the webview asks of the extension. */
export type FromView =
  | { readonly type: 'ready' }
  /** `@` mentions in the text are resolved by the extension when it sends. */
  | { readonly type: 'send'; readonly text: string; readonly attachments?: readonly OutgoingAttachment[] }
  /** Files dropped from the explorer, as `file:` URIs, for the extension to read. */
  | { readonly type: 'attach-uris'; readonly uris: readonly string[] }
  /** Opens the native file picker to attach files. */
  | { readonly type: 'pick-files' }
  /** Opens an image or file the transcript shows in an editor tab. */
  | { readonly type: 'open'; readonly target: OpenTarget }
  /** Asks what an `@` mention typed so far could be; answered by a `completions` message with the same id. */
  | { readonly type: 'complete'; readonly id: number; readonly query: string }
  /**
   * The `/` picker or the model menu opened: the extension opens the session, if there is none yet, so the engine
   * lists its commands and offers its effort.
   */
  | { readonly type: 'want-commands' }
  | { readonly type: 'stop' }
  | { readonly type: 'permission'; readonly id: string; readonly optionId: string }
  /** The user's answers to a question card, or their refusal. */
  | { readonly type: 'answer'; readonly id: string; readonly answer: AskUserAnswer }
  /** Keep or undo hunks, one from a hunk's buttons or every pending one of a turn from its changes card. */
  | { readonly type: 'keep'; readonly hunks: readonly string[] }
  | { readonly type: 'undo'; readonly hunks: readonly string[] }
  /** Opens the file a hunk is in, at the hunk. */
  | { readonly type: 'reveal'; readonly hunk: string }
  | { readonly type: 'copy'; readonly text: string }
  /** Opens the Models and Keys page. */
  | { readonly type: 'choose-model' }
  /** Opens a diagram full size in an editor tab. */
  | { readonly type: 'open-diagram'; readonly source: string }
  | WidgetFromView
  /** Switches the session's approval mode; the engine confirms with the modes. */
  | { readonly type: 'set-mode'; readonly modeId: string }
  /** After a Plan turn: leave Plan and tell the agent to carry out the plan. */
  | { readonly type: 'start-building' }
  /** Asks for the history list; answered by `history` or `history-failed`. */
  | { readonly type: 'list-sessions'; readonly scope: HistoryScope }
  | { readonly type: 'open-session'; readonly id: string; readonly workspace: string }
  /** The list is answered again once the change is made. */
  | { readonly type: 'rename-session'; readonly id: string; readonly title: string; readonly scope: HistoryScope }
  | { readonly type: 'delete-session'; readonly id: string; readonly scope: HistoryScope }
  | McpFromView
  | SettingsFromView
  | ContextFromView
  | ComposerFromView;
