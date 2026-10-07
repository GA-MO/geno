import type { EditorAction, AppliedRule, Snippet, AskUserAnswer, BackendShown, ChildEnd, ChildStatus, AskUserAnswers, AskUserRequest, CheckpointRef, HunkStatus, JobState, MemoryEntry, PreviewTag, MemoryScope, Waiting, TodoList } from '@g-code/core';
import type { AttachmentView, OpenTarget, OutgoingAttachment, PickedFile, Refused } from './attachment-model.js';
import type { ArenaFromView, ArenaToView } from './arena-model.js';
import type { ComposerFromView, ComposerToView } from './composer-model.js';
import type { LanesFromView, LanesToView } from './lanes-model.js';
import type { McpFromView, McpToView } from './mcp-model.js';
import type { PermissionsFromView, PermissionsToView } from './permissions-model.js';
import type { SkillsFromView, SkillsToView } from './skills-model.js';
import type { SettingsFromView, SettingsToView } from './settings-model.js';
import type { SteerFromView, SteerShown, SteerToView } from './steer-model.js';
import type { RewindFromView, RewindToView } from './rewind-model.js';
import type { UsageFromView, UsageToView } from './usage-model.js';
import type { SpinoffFromView, SpinoffToView } from './spinoff-model.js';
import type { ChapterFromView, ChapterToView } from './chapter-model.js';
import type { ChapterMark } from '@g-code/core/chapters';
import type { Spinoff, SpinoffShown } from '@g-code/core/spinoff';
import type { PrStatusFromView, PrStatusToView } from './pr-status-model.js';
import type { PageFromView } from './page-model.js';
import type { WidgetTheme } from '@g-code/core/widget-frame';
import type { MentionCompletion } from './mentions.js';
import type { CommandOption, SentCommand } from './slash.js';
import type { CompactMark } from '@g-code/core/compact';
import type { ReviewMode } from '../review/mode.js';

/**
 * The chat transcript, the one model the panel renders. The extension owns it and sends every change as an
 * Action; the webview runs the same reducer (transcript.ts) and renders the result, so replaying or
 * resending the whole transcript can never leave the view out of step.
 */
export type Transcript = {
  readonly model: string;
  readonly turns: readonly Turn[];
  /** The external agent the session runs on, fixed when it starts; undefined for Geno's own loop. */
  readonly backend?: BackendShown | undefined;
};

export type Turn = {
  readonly id: string;
  readonly prompt: string;
  /** The engine's event number of the prompt, which rewind and fork name the turn by; undefined until the engine says. */
  readonly seq?: number | undefined;
  readonly blocks: readonly Block[];
  readonly status: TurnStatus;
  /** Milliseconds since the epoch, stamped by the extension; `endedAt` is undefined while the turn runs. */
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  /** Undefined until the turn ends, and for a turn that failed before the model answered. */
  readonly usage: Usage | undefined;
  /** A passing status while the turn runs, such as a retry; the next output or the turn's end clears it. */
  readonly notice?: string | undefined;
  /** The model call the turn waits on, offline or for a rate limit; undefined once it went out. */
  readonly waiting?: Waiting | undefined;
  /** Time the turn spent in waits that ended, which its clock leaves out. */
  readonly waitedMs?: number | undefined;
  /** Images and files the user sent with the prompt. */
  readonly attachments?: readonly AttachmentView[] | undefined;
  /** The session's approval mode when the prompt was sent; undefined for a turn replayed from an older log. */
  readonly mode?: string | undefined;
  /** The `/` command the prompt invoked, which the bubble shows as a chip and its arguments. */
  readonly command?: SentCommand | undefined;
  /** The subagents the turn started, by their own session ids, in the order they started. */
  readonly children?: Readonly<Record<string, Child>> | undefined;
  /** Why Geno started the turn by itself, such as "woke: 2 tasks finished"; undefined for a turn the user sent. */
  readonly wake?: string | undefined;
  /** The chapter the user marked at this message, drawn above it. */
  readonly chapter?: ChapterMark | undefined;
};

/**
 * A subagent: a child session one of the turn's `agent` calls started. Its own work streams under its session id and
 * builds `turn`, whose prompt is the task, so the panel draws a child with the same rail as any turn.
 */
export type Child = {
  readonly id: string;
  /** The parent's `agent` call it runs under. */
  readonly toolId: string;
  readonly role: string;
  readonly model: string;
  readonly status: ChildStatus;
  /** Milliseconds since the epoch, as the extension saw the start and the end. */
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly turns: number;
  /** Known once it ends; null for a model with no price. */
  readonly costUsd: number | null | undefined;
  readonly turn: Turn;
  /** Its parent's turn ended first and marked it cancelled; its own end, when it comes, still counts. */
  readonly endedByParent?: true | undefined;
};

/** What a child's own stream adds to its turn. Its questions ask on the parent's call, so they are the parent's. */
export const CHILD_ACTIONS = ['text', 'notice', 'tool', 'diff', 'steer', 'compact'] as const;
export type ChildAction = Extract<Action, { readonly type: (typeof CHILD_ACTIONS)[number] }>;

export type TurnStatus = 'streaming' | 'done' | 'stopped' | 'failed';

export type Usage = { readonly model: string; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number | null };

/** What the assistant did in a turn, in the order it happened. */
export type Block = TextBlock | ToolBlock | PermissionBlock | ErrorBlock | SteerBlock | CompactBlock;

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
  /** A bash call's own words for what its command does, shown as the step's title. */
  readonly description?: string | undefined;
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
  /** The whole list a todo call set, once it ran. */
  readonly todo?: TodoList | undefined;
  /** The task a spawn_task call suggested, as it stands now. */
  readonly spinoff?: Spinoff | undefined;
  /** The chapter a mark_chapter call started. */
  readonly chapter?: ChapterMark | undefined;
  /** The background command a bash call started, as the engine last reported it. */
  readonly background?: BackgroundStep | undefined;
  /** What an open_file, reveal or show_diff call showed in the editor, which its step shows again. */
  readonly editorAction?: EditorAction | undefined;
};

/**
 * A background command on its step: its job id, its state, and the end of its output so far. A dev server that
 * preview_start ran also carries its command line and its name and URL.
 */
export type BackgroundStep = { readonly id: string; readonly state: JobState; readonly tail: string; readonly command?: string | undefined; readonly preview?: PreviewTag | undefined };

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

/** A file an edit changed, as hunks the review controller tracks by the same ids. `change` is the engine's id for the edit. */
export type FileDiff = { readonly path: string; readonly change: string; readonly hunks: readonly DiffHunk[] };

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
  /** The asking bash call's description, when it gave one. */
  readonly description?: string | undefined;
  readonly options: readonly PermissionChoice[];
  readonly outcome: PermissionOutcome;
  /** Why the classifier would not decide, when Auto asked it first. */
  readonly classifier?: string | undefined;
  readonly ask?: PermissionAsk | undefined;
  /** The call it asks about. Its own update can reach the panel after the question does. */
  readonly toolId?: string | undefined;
  /** An edit, which an external agent asks about, reads as one; any other call as a command. */
  readonly toolKind?: ToolKind | undefined;
  /** The pattern "Always allow in this workspace" saves, when the engine offers one. */
  readonly rule?: string | undefined;
};

export type ErrorBlock = { readonly kind: 'error'; readonly id: string; readonly message: string };

/** A message that joined the running turn where it landed: after the tool steps before it, before the model's next answer. */
export type SteerBlock = { readonly kind: 'steer'; readonly id: string; readonly seq: number; readonly shown: SteerShown };

/** Where the context was compacted (U47): the model reads the summary in place of what came before it. */
export type CompactBlock = { readonly kind: 'compact'; readonly id: string; readonly mark: CompactMark };

/**
 * A change to the transcript. Everything but `reset`, `model` and `review` applies to the last turn, the only
 * one that can still change. `at` is when the extension saw the update, so a replay keeps the durations.
 */
export type Action =
  | { readonly type: 'reset'; readonly transcript: Transcript }
  | { readonly type: 'model'; readonly model: string }
  /** The session's backend, as its start or load said, or again once its first turn names the lane. */
  | { readonly type: 'backend'; readonly backend: BackendShown | undefined }
  | {
      readonly type: 'turn-start';
      readonly id: string;
      readonly at: number;
      readonly prompt: string;
      readonly attachments?: readonly AttachmentView[] | undefined;
      readonly mode?: string | undefined;
      readonly command?: SentCommand | undefined;
      readonly seq?: number | undefined;
      readonly wake?: string | undefined;
      readonly chapter?: ChapterMark | undefined;
    }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'notice'; readonly text: string }
  /** The turn's model call waits, or its wait moved on; null once the call goes out. */
  | { readonly type: 'waiting'; readonly at: number; readonly waiting: Waiting | null }
  /** Starts a tool call or updates one; an absent field keeps its value. */
  | {
      readonly type: 'tool';
      readonly id: string;
      readonly at: number;
      readonly name?: string;
      readonly target?: string;
      readonly description?: string;
      readonly toolKind?: ToolKind;
      readonly status?: ToolStatus;
      readonly output?: string;
      readonly images?: readonly ToolImage[];
      readonly auto?: AutoDecision;
      readonly widget?: ToolWidget;
      readonly editorAction?: EditorAction;
      readonly todo?: TodoList;
      readonly chapter?: ChapterMark;
      /** An offer sets this call's card; a move, such as from dismiss_task, changes the card with its id. */
      readonly spinoff?: SpinoffShown;
    }
  | { readonly type: 'diff'; readonly toolId: string; readonly at: number; readonly diff: FileDiff }
  /** A background command changed; it may belong to any turn, since it outlives the one that started it. */
  | { readonly type: 'background'; readonly toolId: string; readonly job: BackgroundStep }
  /** A suggested task changed outside any tool call, such as by the user's Start; it may be on any turn. */
  | { readonly type: 'spinoff'; readonly shown: SpinoffShown }
  /** The user marked, renamed or removed the chapter at the message of turn `turn`; it may be any turn. */
  | { readonly type: 'chapter'; readonly turn: string; readonly mark: ChapterMark | null }
  /** The review status of hunks, whichever surface decided them; hunks the transcript lacks are ignored. */
  | { readonly type: 'review'; readonly hunks: Readonly<Record<string, HunkStatus>> }
  | {
      readonly type: 'permission';
      readonly id: string;
      readonly command: string;
      readonly reason: string;
      readonly description?: string | undefined;
      readonly options: readonly PermissionChoice[];
      readonly classifier?: string | undefined;
      readonly ask?: PermissionAsk | undefined;
      readonly toolId?: string | undefined;
      readonly toolKind?: ToolKind | undefined;
      readonly rule?: string | undefined;
    }
  /** `answer` settles a question card; otherwise `optionId` is the choice, undefined when the request was cancelled. */
  | { readonly type: 'permission-done'; readonly id: string; readonly optionId: string | undefined; readonly answer?: AskUserAnswer | undefined }
  | { readonly type: 'error'; readonly message: string }
  /** A steer the engine logged in the running turn at `seq`. */
  | { readonly type: 'steer'; readonly seq: number; readonly shown: SteerShown }
  /** The engine's compaction chunk, live or replayed; once per seq. */
  | { readonly type: 'compact'; readonly mark: CompactMark }
  | { readonly type: 'turn-end'; readonly at: number; readonly status: Exclude<TurnStatus, 'streaming'>; readonly usage: Usage | undefined; readonly seq?: number | undefined }
  | { readonly type: 'child-start'; readonly id: string; readonly toolId: string; readonly role: string; readonly task: string; readonly model: string; readonly at: number }
  | { readonly type: 'child'; readonly id: string; readonly action: ChildAction }
  | { readonly type: 'child-end'; readonly id: string; readonly at: number; readonly end: ChildEnd; readonly turns: number; readonly costUsd: number | null };

/** How the panel looks: dark glass with a rainbow edge on live work, or VS Code's native styling (`gcode.ui.style`). */
export const UI_STYLES = ['glass', 'native'] as const;
export type UiStyle = (typeof UI_STYLES)[number];

/** How much of a turn the panel draws (`gcode.chat.detail`): compact folds its work behind one line; full draws every step. */
export const CHAT_DETAILS = ['compact', 'full'] as const;
export type ChatDetail = (typeof CHAT_DETAILS)[number];

/** The panel's look from settings, which the page carries as `data-style`, `data-detail` and `data-review` on its body. */
export type Look = { readonly style: UiStyle; readonly detail: ChatDetail; readonly review: ReviewMode };

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
  /** The session it was forked from, which the row links to. */
  readonly forkedFrom?: { readonly id: string; readonly title: string } | undefined;
};

/** Where a search found a session: the turn it opens at, null when only the title matched, and the line to show. */
export type HistoryHit = {
  readonly id: string;
  /** `at` is in milliseconds since the epoch. */
  readonly turn: { readonly number: number; readonly seq: number; readonly at: number } | null;
  readonly snippet: Snippet;
  readonly matchingTurns: number;
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
  /** The sessions whose text holds every word of `query`, best first. */
  | { readonly type: 'history-hits'; readonly scope: HistoryScope; readonly query: string; readonly hits: readonly HistoryHit[] }
  | { readonly type: 'history-hits-failed'; readonly scope: HistoryScope; readonly query: string; readonly message: string }
  /** After a search result opened its session: scroll to that turn, by the transcript's turn id. */
  | { readonly type: 'reveal-turn'; readonly turn: string }
  | McpToView
  | SettingsToView
  | PermissionsToView
  | SkillsToView
  | ContextToView
  | ComposerToView
  | LanesToView
  | ArenaToView
  | SteerToView
  | RewindToView
  | UsageToView
  | SpinoffToView
  | PrStatusToView
  | ChapterToView;

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

/** A widget's actions: `theme` is the panel's widget theme as it is now, which a tab keeps. */
export type WidgetFromView =
  /** A link a widget asked to open, which the user approved under the widget. */
  | { readonly type: 'widget-link'; readonly href: string }
  | { readonly type: 'widget-open'; readonly toolId: string; readonly theme: WidgetTheme }
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
  /** Cuts the running turn's wait short: its model call goes out at once. */
  | { readonly type: 'retry-now' }
  /** Stops one running subagent; its parent goes on with what the child had. */
  | { readonly type: 'cancel-child'; readonly id: string }
  /** Stops a background command of the shown session by its job id. */
  | { readonly type: 'stop-background'; readonly id: string }
  /** The composer gained or lost a draft, which holds back a turn Geno would start by itself. */
  | { readonly type: 'drafting'; readonly typing: boolean }
  | { readonly type: 'permission'; readonly id: string; readonly optionId: string }
  /** The user's answers to a question card, or their refusal. */
  | { readonly type: 'answer'; readonly id: string; readonly answer: AskUserAnswer }
  /** Keep or undo hunks, one from a hunk's buttons or every pending one of a turn from its changes card. */
  | { readonly type: 'keep'; readonly hunks: readonly string[] }
  | { readonly type: 'undo'; readonly hunks: readonly string[] }
  /** Opens the file a hunk is in, at the hunk. */
  | { readonly type: 'reveal'; readonly hunk: string }
  /** Auto review: restores the checkpoint before a turn. `later` when turns after it changed files too, which it undoes as well. */
  | { readonly type: 'undo-turn'; readonly checkpoint: CheckpointRef; readonly later: boolean }
  /** Auto review: a file a turn changed, in a diff against the checkpoint before that turn. */
  | { readonly type: 'open-change'; readonly path: string; readonly checkpoint: CheckpointRef }
  /** Shows again what an editor tool's step showed. */
  | { readonly type: 'editor-action'; readonly action: EditorAction }
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
  /** Searches the text of the scope's sessions; answered by `history-hits` or `history-hits-failed`. */
  | { readonly type: 'search-sessions'; readonly scope: HistoryScope; readonly query: string }
  /** `turnSeq` opens the session scrolled to that turn, as a search result does. */
  | { readonly type: 'open-session'; readonly id: string; readonly workspace: string; readonly turnSeq?: number | undefined }
  /** The list is answered again once the change is made. */
  | { readonly type: 'rename-session'; readonly id: string; readonly title: string; readonly scope: HistoryScope }
  | { readonly type: 'delete-session'; readonly id: string; readonly scope: HistoryScope }
  | McpFromView
  | SettingsFromView
  | PermissionsFromView
  | SkillsFromView
  | ContextFromView
  | ComposerFromView
  | LanesFromView
  | ArenaFromView
  | SteerFromView
  | RewindFromView
  | UsageFromView
  | SpinoffFromView
  | PrStatusFromView
  | ChapterFromView
  | PageFromView;
