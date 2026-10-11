/**
 * The `vscode` module for the chat host when it runs under the web host: the bundle aliases `vscode` to this file. It
 * carries the members the chat host uses, backed by Node and by the browser page. What only an editor can do (open a
 * file, reveal it, its diagnostics, terminals and buffers) is either empty or told to the page as what VS Code would
 * have done, since the user keeps VS Code open on the same folder.
 */
import { spawn } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type * as vscode from 'vscode';
import { affects, configurationOf, type SettingsFile } from './settings.js';

/** A question the page asks the user in its overlay; every one can be dismissed, which answers `cancel`. */
export type UiRequest =
  | { readonly kind: 'message'; readonly severity: 'info' | 'warning' | 'error'; readonly text: string; readonly detail?: string; readonly modal: boolean; readonly items: readonly string[] }
  | { readonly kind: 'input'; readonly title?: string; readonly prompt?: string; readonly value?: string; readonly placeholder?: string; readonly password: boolean }
  | { readonly kind: 'pick'; readonly title?: string; readonly placeholder?: string; readonly many: boolean; readonly items: readonly { readonly label: string; readonly description?: string; readonly detail?: string }[] }
  /** Stands in for the open and save dialogs: a path typed in, relative to the workspace or absolute. */
  | { readonly kind: 'path'; readonly title: string; readonly action: string; readonly value?: string; readonly many: boolean };

export type UiAnswer = { readonly kind: 'cancel' } | { readonly kind: 'item'; readonly index: number } | { readonly kind: 'items'; readonly indexes: readonly number[] } | { readonly kind: 'text'; readonly value: string };

/** What the page does without asking: a toast, a link it opens, text it copies. */
export type Note =
  | { readonly kind: 'toast'; readonly text: string; readonly link?: { readonly label: string; readonly url: string } }
  | { readonly kind: 'open'; readonly url: string }
  | { readonly kind: 'clipboard'; readonly text: string };

/** The browser side the shim talks to; the web server implements it. */
export type Page = {
  readonly origin: string;
  ask(request: UiRequest): Promise<UiAnswer>;
  notify(note: Note): void;
  post(webview: string, message: unknown): void;
};

export type ShimHost = {
  readonly workspace: string;
  readonly trusted: boolean;
  readonly settings: SettingsFile;
  readonly page: Page;
  /** rg, for findFiles; undefined walks the folder instead. */
  readonly rg: string | undefined;
};

let host: ShimHost | undefined;
const configured = (): ShimHost => {
  if (host === undefined) throw new Error('the vscode shim is used before configureShim');
  return host;
};

export class Disposable {
  static from(...items: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => items.forEach((item) => item.dispose()));
  }
  constructor(private readonly callOnDispose: () => unknown) {}
  dispose(): void {
    this.callOnDispose();
  }
}

export class EventEmitter<T> {
  private listeners = new Set<(event: T) => unknown>();
  readonly event = (listener: (event: T) => unknown, thisArg?: unknown, disposables?: { dispose(): unknown }[]): Disposable => {
    const bound = (event: T) => listener.call(thisArg, event);
    this.listeners.add(bound);
    const disposable = new Disposable(() => this.listeners.delete(bound));
    disposables?.push(disposable);
    return disposable;
  };
  fire(event: T): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

/** An event that never fires, for what has no counterpart here, such as terminals. */
const never = <T>(): vscode.Event<T> => new EventEmitter<T>().event;

export class CancellationError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'Canceled';
  }
}

export class CancellationTokenSource {
  private readonly cancelled = new EventEmitter<void>();
  readonly token: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: this.cancelled.event };
  cancel(): void {
    (this.token as { isCancellationRequested: boolean }).isCancellationRequested = true;
    this.cancelled.fire();
  }
  dispose(): void {
    this.cancelled.dispose();
  }
}

const URI = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/;
const encodePath = (value: string) => value.split('/').map(encodeURIComponent).join('/');

export class Uri {
  static file(fsPath: string): Uri {
    return new Uri('file', '', path.resolve(fsPath).split(path.sep).join('/'), '', '');
  }
  static parse(value: string, _strict?: boolean): Uri {
    const match = URI.exec(value)!;
    const decode = (part: string | undefined) => {
      try {
        return decodeURIComponent(part ?? '');
      } catch {
        return part ?? '';
      }
    };
    return new Uri(match[2] ?? 'file', decode(match[4]), decode(match[5]), decode(match[7]), decode(match[9]));
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return base.with({ path: path.posix.join(base.path, ...segments) });
  }
  static from(components: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(components.scheme, components.authority ?? '', components.path ?? '', components.query ?? '', components.fragment ?? '');
  }
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string,
  ) {}
  get fsPath(): string {
    return path.normalize(this.path);
  }
  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.authority ?? this.authority, change.path ?? this.path, change.query ?? this.query, change.fragment ?? this.fragment);
  }
  toString(skipEncoding = false): string {
    const encode = skipEncoding ? (value: string) => value : encodeURIComponent;
    return `${this.scheme}:${this.authority !== '' || this.scheme === 'file' ? `//${this.authority}` : ''}${skipEncoding ? this.path : encodePath(this.path)}${this.query === '' ? '' : `?${skipEncoding ? this.query : encodeURI(this.query)}`}${this.fragment === '' ? '' : `#${encode(this.fragment)}`}`;
  }
  toJSON(): unknown {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(start: Position | number, end: Position | number, endLine?: number, endCharacter?: number) {
    this.start = typeof start === 'number' ? new Position(start, end as number) : start;
    this.end = typeof start === 'number' ? new Position(endLine!, endCharacter!) : (end as Position);
  }
  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
}

export class Selection extends Range {
  get anchor(): Position {
    return this.start;
  }
  get active(): Position {
    return this.end;
  }
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: unknown,
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class MarkdownString {
  constructor(public value = '') {}
  appendMarkdown(value: string): this {
    this.value += value;
    return this;
  }
  appendText(value: string): this {
    this.value += value;
    return this;
  }
}

/** The review's Changes view and CodeLens are bundled with the chat host but never created here; these keep them loadable. */
export class TreeItem {
  constructor(
    readonly label: unknown,
    readonly collapsibleState?: TreeItemCollapsibleState,
  ) {}
}

export class CodeLens {
  constructor(
    readonly range: Range,
    readonly command?: unknown,
  ) {}
}

export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7,
}

export class RelativePattern {
  readonly baseUri: Uri;
  constructor(
    base: Uri | string | { readonly uri: Uri },
    readonly pattern: string,
  ) {
    this.baseUri = typeof base === 'string' ? Uri.file(base) : base instanceof Uri ? base : base.uri;
  }
}

/** The edits applyEdit writes: whole replacements of ranges, which is all the chat host makes. */
export class WorkspaceEdit {
  readonly edits: { readonly uri: Uri; readonly range: Range; readonly text: string }[] = [];
  replace(uri: Uri, range: Range, text: string): void {
    this.edits.push({ uri, range, text });
  }
  insert(uri: Uri, at: Position, text: string): void {
    this.edits.push({ uri, range: new Range(at, at), text });
  }
  delete(uri: Uri, range: Range): void {
    this.edits.push({ uri, range, text: '' });
  }
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}
export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
}
export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}
export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}
export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}
export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}
export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

const FS_CODES: Readonly<Record<string, string>> = {
  ENOENT: 'FileNotFound',
  EEXIST: 'FileExists',
  ENOTDIR: 'FileNotADirectory',
  EISDIR: 'FileIsADirectory',
  EACCES: 'NoPermissions',
  EPERM: 'NoPermissions',
};

export class FileSystemError extends Error {
  static FileNotFound = (uri?: Uri | string) => new FileSystemError(String(uri ?? ''), 'FileNotFound');
  static FileExists = (uri?: Uri | string) => new FileSystemError(String(uri ?? ''), 'FileExists');
  static FileNotADirectory = (uri?: Uri | string) => new FileSystemError(String(uri ?? ''), 'FileNotADirectory');
  static FileIsADirectory = (uri?: Uri | string) => new FileSystemError(String(uri ?? ''), 'FileIsADirectory');
  static NoPermissions = (uri?: Uri | string) => new FileSystemError(String(uri ?? ''), 'NoPermissions');
  static Unavailable = (uri?: Uri | string) => new FileSystemError(String(uri ?? ''), 'Unavailable');
  constructor(
    message: string,
    readonly code = 'Unknown',
  ) {
    super(message);
  }
}

/** Node's error as VS Code's, which the chat host tells apart by `code`. */
const fsError = (error: unknown): never => {
  const node = error as NodeJS.ErrnoException;
  throw new FileSystemError(node.message, FS_CODES[node.code ?? ''] ?? 'Unavailable');
};

const typeOf = (entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileType =>
  entry.isSymbolicLink() ? FileType.SymbolicLink : entry.isDirectory() ? FileType.Directory : entry.isFile() ? FileType.File : FileType.Unknown;

const fs = {
  stat: (uri: Uri) => stat(uri.fsPath).then((s) => ({ type: typeOf(s), ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size }), fsError),
  readFile: (uri: Uri) => readFile(uri.fsPath).then((bytes) => new Uint8Array(bytes), fsError),
  async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
    await mkdir(path.dirname(uri.fsPath), { recursive: true }).catch(fsError);
    await writeFile(uri.fsPath, content).catch(fsError);
  },
  createDirectory: (uri: Uri) => mkdir(uri.fsPath, { recursive: true }).then(() => undefined, fsError),
  readDirectory: (uri: Uri) => readdir(uri.fsPath, { withFileTypes: true }).then((entries) => entries.map((e): [string, FileType] => [e.name, typeOf(e)]), fsError),
  delete: (uri: Uri, options?: { recursive?: boolean }) => rm(uri.fsPath, { recursive: options?.recursive === true }).catch(fsError),
  rename: (from: Uri, to: Uri) => rename(from.fsPath, to.fsPath).catch(fsError),
  copy: (from: Uri, to: Uri) => copyFile(from.fsPath, to.fsPath).catch(fsError),
  isWritableFileSystem: () => true,
};

/**
 * A file's text as a document, for the bridge's writes: no editor holds it, so it is never dirty, `save` has nothing
 * to do, and applyEdit writes straight to disk and updates it.
 */
class FileDocument {
  readonly isDirty = false;
  readonly isClosed = false;
  readonly isUntitled = false;
  readonly languageId = 'plaintext';
  readonly eol = 1;
  version = 1;
  constructor(
    readonly uri: Uri,
    public text: string,
  ) {}
  get fileName(): string {
    return this.uri.fsPath;
  }
  private get lines(): string[] {
    return this.text.split('\n');
  }
  get lineCount(): number {
    return this.lines.length;
  }
  lineAt(line: number | Position) {
    const index = typeof line === 'number' ? line : line.line;
    const text = this.lines[index] ?? '';
    return { lineNumber: index, text, range: new Range(index, 0, index, text.length), isEmptyOrWhitespace: text.trim() === '' };
  }
  validatePosition(position: Position): Position {
    const lines = this.lines;
    if (position.line >= lines.length) return new Position(lines.length - 1, lines.at(-1)!.length);
    const line = Math.max(0, position.line);
    return new Position(line, Math.min(Math.max(0, position.character), lines[line]!.length));
  }
  validateRange(range: Range): Range {
    return new Range(this.validatePosition(range.start), this.validatePosition(range.end));
  }
  offsetAt(position: Position): number {
    const at = this.validatePosition(position);
    return this.lines.slice(0, at.line).reduce((sum, line) => sum + line.length + 1, 0) + at.character;
  }
  positionAt(offset: number): Position {
    const before = this.text.slice(0, Math.max(0, offset)).split('\n');
    return new Position(before.length - 1, before.at(-1)!.length);
  }
  getText(range?: Range): string {
    return range === undefined ? this.text : this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }
  save(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

const documents = new Map<string, FileDocument>();

async function openTextDocument(target: Uri | string): Promise<FileDocument> {
  const uri = typeof target === 'string' ? Uri.file(target) : target;
  const text = new TextDecoder().decode(await fs.readFile(uri));
  const document = documents.get(uri.fsPath) ?? new FileDocument(uri, text);
  document.text = text;
  documents.set(uri.fsPath, document);
  return document;
}

async function applyEdit(edit: WorkspaceEdit): Promise<boolean> {
  const files = new Map<string, WorkspaceEdit['edits'][number][]>();
  for (const one of edit.edits) files.set(one.uri.fsPath, [...(files.get(one.uri.fsPath) ?? []), one]);
  for (const [file, edits] of files) {
    const document = await openTextDocument(Uri.file(file));
    const spans = edits.map((one) => ({ from: document.offsetAt(one.range.start), to: document.offsetAt(one.range.end), text: one.text })).sort((a, b) => b.from - a.from);
    let text = document.text;
    for (const span of spans) text = text.slice(0, span.from) + span.text + text.slice(span.to);
    await writeFile(file, text);
    document.text = text;
    document.version++;
  }
  return true;
}

const folderUri = () => Uri.file(configured().workspace);

function asRelativePath(target: Uri | string, includeWorkspaceFolder?: boolean): string {
  const file = typeof target === 'string' ? target : target.fsPath;
  const relative = path.relative(configured().workspace, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return file;
  const shown = relative.split(path.sep).join('/');
  return includeWorkspaceFolder === true ? `${path.basename(configured().workspace)}/${shown}` : shown;
}

const SKIPPED = new Set(['.git', 'node_modules']);
const WALK_LIMIT = 50_000;

async function walk(dir: string, limit: number, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (found.length >= limit) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !SKIPPED.has(entry.name)) await walk(full, limit, found);
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

const rgFiles = (rg: string, cwd: string): Promise<string[] | undefined> =>
  new Promise((resolve) => {
    const child = spawn(rg, ['--files', '--hidden', '--glob', '!.git'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => resolve(code === 0 || code === 1 ? out.split('\n').filter(Boolean).map((file) => path.join(cwd, file)) : undefined));
  });

/** The workspace's files, as rg lists them (so .gitignore holds), that match `include`; `exclude` is ignored. */
async function findFiles(include: string | RelativePattern, _exclude?: unknown, maxResults = Number.POSITIVE_INFINITY): Promise<Uri[]> {
  const base = typeof include === 'string' ? configured().workspace : include.baseUri.fsPath;
  const pattern = typeof include === 'string' ? include : include.pattern;
  const rg = configured().rg;
  const files = (rg === undefined ? undefined : await rgFiles(rg, base)) ?? (await walk(base, WALK_LIMIT));
  const matching = pattern === '**/*' || pattern === '**' ? files : files.filter((file) => path.matchesGlob(path.relative(base, file), pattern));
  return matching.slice(0, maxResults).map((file) => Uri.file(file));
}

/** A watcher on one plain file, such as .git/HEAD for the branch; a glob is not watched. */
function createFileSystemWatcher(pattern: RelativePattern | string) {
  const changed = new EventEmitter<Uri>();
  const created = new EventEmitter<Uri>();
  const deleted = new EventEmitter<Uri>();
  let watcher: FSWatcher | undefined;
  if (pattern instanceof RelativePattern && !/[*?[{]/.test(pattern.pattern)) {
    const file = path.join(pattern.baseUri.fsPath, pattern.pattern);
    try {
      watcher = watch(file, () => changed.fire(Uri.file(file)));
      watcher.on('error', () => watcher?.close());
    } catch {
      watcher = undefined;
    }
  }
  return {
    ignoreCreateEvents: false,
    ignoreChangeEvents: false,
    ignoreDeleteEvents: false,
    onDidChange: changed.event,
    onDidCreate: created.event,
    onDidDelete: deleted.event,
    dispose: () => {
      watcher?.close();
      changed.dispose();
      created.dispose();
      deleted.dispose();
    },
  };
}

const configurationChanged = new EventEmitter<vscode.ConfigurationChangeEvent>();

/** Tells the chat host its settings changed; the settings file calls it after each write. */
export const settingsChanged = (keys: readonly string[]): void => configurationChanged.fire({ affectsConfiguration: (section: string) => affects(keys, section) });

export const workspace = {
  get workspaceFolders() {
    return [{ uri: folderUri(), name: path.basename(configured().workspace), index: 0 }];
  },
  get name() {
    return path.basename(configured().workspace);
  },
  get isTrusted() {
    return configured().trusted;
  },
  getWorkspaceFolder: (uri: Uri) => (asRelativePath(uri) === uri.fsPath ? undefined : workspace.workspaceFolders[0]),
  fs,
  getConfiguration: (section?: string) => configurationOf(configured().settings, section),
  onDidChangeConfiguration: configurationChanged.event,
  onDidGrantWorkspaceTrust: never<void>(),
  asRelativePath,
  findFiles,
  /** No editor holds a buffer here, so the engine always reads the disk and no buffer is unsaved. */
  textDocuments: [] as readonly FileDocument[],
  openTextDocument,
  applyEdit,
  createFileSystemWatcher,
  onDidChangeTextDocument: never<unknown>(),
  onDidOpenTextDocument: never<unknown>(),
  onDidCloseTextDocument: never<unknown>(),
  onDidSaveTextDocument: never<unknown>(),
  onDidChangeWorkspaceFolders: never<unknown>(),
  registerTextDocumentContentProvider: () => new Disposable(() => {}),
};

const registered = new Map<string, (...args: unknown[]) => unknown>();

const shownPath = (target: unknown): string => (target instanceof Uri ? asRelativePath(target) : typeof target === 'string' ? target : 'the file');

/** What VS Code would have done for a command only an editor runs, said in the page instead. */
const EDITOR_COMMANDS: Readonly<Record<string, (...args: unknown[]) => string>> = {
  'vscode.open': (uri) => `Open ${shownPath(uri)}`,
  'vscode.openFolder': (uri) => `Open the folder ${uri instanceof Uri ? uri.fsPath : String(uri)} in a new window`,
  'vscode.diff': (_left, _right, title) => `Show the diff ${typeof title === 'string' ? title : ''}`.trim(),
  revealInExplorer: (uri) => `Reveal ${shownPath(uri)} in the Explorer`,
  revealFileInOS: (uri) => `Reveal ${shownPath(uri)} in the Finder`,
  'workbench.action.openSettings': (query) => `Open Settings at ${String(query ?? '')}; here, edit ${configured().settings.file}`,
};

const toast = (text: string) => configured().page.notify({ kind: 'toast', text });

/** Says in the page what VS Code would have done, and logs it. */
function editorOnly(what: string): void {
  process.stderr.write(`[editor] ${what}\n`);
  toast(`In VS Code: ${what}`);
}

export const commands = {
  registerCommand(id: string, run: (...args: unknown[]) => unknown): Disposable {
    registered.set(id, run);
    return new Disposable(() => registered.delete(id));
  },
  async executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined> {
    const run = registered.get(id);
    if (run !== undefined) return (await run(...args)) as T;
    // The page is the only view, always shown, and nothing reads a context key here.
    if (id.endsWith('.focus') || id === 'setContext') return undefined;
    if (id.startsWith('gcode.review.')) {
      editorOnly('Keep and undo of reviewed changes run in VS Code’s review, which the web host does not load');
      return undefined;
    }
    editorOnly(EDITOR_COMMANDS[id]?.(...args) ?? `Run the command ${id}`);
    return undefined;
  },
  getCommands: async () => [...registered.keys()],
};

type MessageItem = string | { readonly title: string };
type MessageOptions = { readonly modal?: boolean; readonly detail?: string };

async function showMessage(severity: 'info' | 'warning' | 'error', text: string, ...rest: unknown[]): Promise<MessageItem | undefined> {
  const [first, ...more] = rest;
  const options = first !== undefined && typeof first === 'object' && !('title' in (first as object)) ? (first as MessageOptions) : undefined;
  const items = (options === undefined ? rest : more) as MessageItem[];
  process.stderr.write(`[${severity}] ${text}\n`);
  const answer = await configured().page.ask({
    kind: 'message',
    severity,
    text,
    modal: options?.modal === true,
    items: items.map((item) => (typeof item === 'string' ? item : item.title)),
    ...(options?.detail === undefined ? {} : { detail: options.detail }),
  });
  return answer.kind === 'item' ? items[answer.index] : undefined;
}

type InputOptions = { readonly title?: string; readonly prompt?: string; readonly value?: string; readonly placeHolder?: string; readonly password?: boolean };

async function showInputBox(options: InputOptions = {}): Promise<string | undefined> {
  const answer = await configured().page.ask({
    kind: 'input',
    password: options.password === true,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    ...(options.value === undefined ? {} : { value: options.value }),
    ...(options.placeHolder === undefined ? {} : { placeholder: options.placeHolder }),
  });
  return answer.kind === 'text' ? answer.value : undefined;
}

type PickItem = string | { readonly label: string; readonly description?: string; readonly detail?: string };

async function showQuickPick(given: readonly PickItem[] | Thenable<readonly PickItem[]>, options: { readonly title?: string; readonly placeHolder?: string; readonly canPickMany?: boolean } = {}): Promise<unknown> {
  const items = await given;
  const answer = await configured().page.ask({
    kind: 'pick',
    many: options.canPickMany === true,
    items: items.map((item) => (typeof item === 'string' ? { label: item } : { label: item.label, ...(item.description === undefined ? {} : { description: item.description }), ...(item.detail === undefined ? {} : { detail: item.detail }) })),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.placeHolder === undefined ? {} : { placeholder: options.placeHolder }),
  });
  if (answer.kind === 'item') return items[answer.index];
  if (answer.kind === 'items') return answer.indexes.map((index) => items[index]);
  return undefined;
}

const typedPaths = (text: string): Uri[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => Uri.file(path.resolve(configured().workspace, line)));

async function showOpenDialog(options: { readonly canSelectMany?: boolean; readonly openLabel?: string; readonly title?: string } = {}): Promise<Uri[] | undefined> {
  const answer = await configured().page.ask({ kind: 'path', title: options.title ?? 'Open', action: options.openLabel ?? 'Open', many: options.canSelectMany === true });
  return answer.kind === 'text' && typedPaths(answer.value).length > 0 ? typedPaths(answer.value) : undefined;
}

async function showSaveDialog(options: { readonly defaultUri?: Uri; readonly saveLabel?: string; readonly title?: string } = {}): Promise<Uri | undefined> {
  const value = options.defaultUri === undefined ? undefined : asRelativePath(options.defaultUri);
  const answer = await configured().page.ask({ kind: 'path', title: options.title ?? 'Save', action: options.saveLabel ?? 'Save', many: false, ...(value === undefined ? {} : { value }) });
  return answer.kind === 'text' ? typedPaths(answer.value)[0] : undefined;
}

/** Runs the task, saying its title in a toast; nothing here can cancel it. */
async function withProgress<R>(options: { readonly title?: string }, task: (progress: { report(value: unknown): void }, token: vscode.CancellationToken) => Thenable<R>): Promise<R> {
  if (options.title !== undefined) toast(options.title);
  return task({ report: () => {} }, new CancellationTokenSource().token);
}

/** An output channel, as lines on stderr under its name. */
function createOutputChannel(name: string) {
  let partial = '';
  const write = (text: string) => {
    const lines = (partial + text).split('\n');
    partial = lines.pop()!;
    for (const line of lines) process.stderr.write(`[${name}] ${line}\n`);
  };
  return {
    name,
    append: write,
    appendLine: (line: string) => write(`${line}\n`),
    replace: write,
    clear: () => {},
    show: () => {},
    hide: () => {},
    dispose: () => {},
  };
}

/** A webview whose page is a browser tab: what the host posts goes to the page by SSE, and what the page posts comes back. */
export class WebviewChannel {
  html = '';
  options: vscode.WebviewOptions = {};
  private readonly received = new EventEmitter<unknown>();
  readonly onDidReceiveMessage = this.received.event;
  /** Disposes the view or tab this webview belongs to, as closing it in VS Code would. */
  close: () => void = () => {};
  constructor(readonly id: string) {}
  get cspSource(): string {
    return configured().page.origin;
  }
  /** Files are served under /vscode-resource by their path, and only inside the webview's localResourceRoots. */
  asWebviewUri(uri: Uri): Uri {
    return Uri.parse(`${configured().page.origin}/vscode-resource${encodePath(uri.path)}`);
  }
  postMessage(message: unknown): Promise<boolean> {
    configured().page.post(this.id, message);
    return Promise.resolve(true);
  }
  receive(message: unknown): void {
    this.received.fire(message);
  }
}

/** Every webview the host made, by id: the chat view is `chat`, and each editor tab one of its own. */
export const webviews = new Map<string, WebviewChannel>();

export function webviewView(id: string) {
  const webview = new WebviewChannel(id);
  webviews.set(id, webview);
  const disposed = new EventEmitter<void>();
  const dispose = () => {
    webviews.delete(id);
    disposed.fire();
  };
  webview.close = dispose;
  return {
    webview,
    viewType: id,
    visible: true,
    title: undefined as string | undefined,
    description: undefined as string | undefined,
    badge: undefined as vscode.ViewBadge | undefined,
    onDidChangeVisibility: never<void>(),
    onDidDispose: disposed.event,
    show: () => {},
    dispose,
  };
}

let panels = 0;

/** An editor tab, such as a full-size diagram, opens as a browser tab of its own; the page offers its link. */
function createWebviewPanel(viewType: string, title: string, _column: unknown, options: vscode.WebviewOptions = {}) {
  const view = webviewView(`${viewType}-${++panels}`);
  view.webview.options = options;
  const url = `${configured().page.origin}/view/${view.webview.id}`;
  configured().page.notify({ kind: 'open', url });
  configured().page.notify({ kind: 'toast', text: `${title} opens in a tab of its own.`, link: { label: 'Open', url } });
  return {
    ...view,
    title,
    viewType,
    active: true,
    viewColumn: ViewColumn.One,
    iconPath: undefined,
    onDidChangeViewState: never<unknown>(),
    reveal: () => configured().page.notify({ kind: 'open', url }),
  };
}

const providers = new Map<string, vscode.WebviewViewProvider>();

/** The provider registered for a view, which the web host resolves once its page exists. */
export const viewProvider = (id: string): vscode.WebviewViewProvider | undefined => providers.get(id);

/** No editor exists: the page says what would have opened, and the caller gets an editor that does nothing. */
async function showTextDocument(target: Uri | FileDocument, options?: { readonly selection?: Range }) {
  const uri = target instanceof Uri ? target : target.uri;
  const line = options?.selection === undefined ? '' : ` at line ${options.selection.start.line + 1}`;
  editorOnly(`Open ${asRelativePath(uri)}${line}`);
  const document = await openTextDocument(uri).catch(() => new FileDocument(uri, ''));
  const selection = options?.selection ?? new Range(0, 0, 0, 0);
  return { document, selection, selections: [selection], visibleRanges: [], options: {}, viewColumn: ViewColumn.One, revealRange: () => {}, edit: async () => false, setDecorations: () => {} };
}

const windowState = new EventEmitter<vscode.WindowState>();

export const window = {
  showInformationMessage: (text: string, ...rest: unknown[]) => showMessage('info', text, ...rest),
  showWarningMessage: (text: string, ...rest: unknown[]) => showMessage('warning', text, ...rest),
  showErrorMessage: (text: string, ...rest: unknown[]) => showMessage('error', text, ...rest),
  showInputBox,
  showQuickPick,
  showOpenDialog,
  showSaveDialog,
  withProgress,
  createOutputChannel,
  createWebviewPanel,
  registerWebviewViewProvider(id: string, provider: vscode.WebviewViewProvider): Disposable {
    providers.set(id, provider);
    return new Disposable(() => providers.delete(id));
  },
  showTextDocument,
  activeTextEditor: undefined,
  visibleTextEditors: [],
  /** The page has no say in focus yet, so the window counts as focused and notices stay in the page. */
  state: { focused: true, active: true },
  onDidChangeWindowState: windowState.event,
  onDidChangeActiveTextEditor: never<unknown>(),
  onDidChangeTextEditorSelection: never<unknown>(),
  onDidChangeVisibleTextEditors: never<unknown>(),
  terminals: [] as readonly unknown[],
  activeTerminal: undefined,
  onDidStartTerminalShellExecution: never<unknown>(),
  onDidEndTerminalShellExecution: never<unknown>(),
  onDidCloseTerminal: never<unknown>(),
  onDidOpenTerminal: never<unknown>(),
  createTextEditorDecorationType: () => ({ key: 'none', dispose: () => {} }),
  registerTreeDataProvider: () => new Disposable(() => {}),
};

let clipboard = '';

export const env = {
  appName: 'Geno web',
  appRoot: '',
  language: 'en',
  machineId: 'geno-web',
  sessionId: 'geno-web',
  uriScheme: 'vscode',
  shell: process.env['SHELL'] ?? '/bin/sh',
  clipboard: {
    readText: async () => clipboard,
    async writeText(text: string): Promise<void> {
      clipboard = text;
      configured().page.notify({ kind: 'clipboard', text });
    },
  },
  async openExternal(uri: Uri): Promise<boolean> {
    configured().page.notify({ kind: 'open', url: uri.toString(true) });
    return true;
  },
  asExternalUri: async (uri: Uri) => uri,
};

/** No language server runs here, so there are no diagnostics and no providers. */
export const languages = {
  getDiagnostics: (_uri?: Uri) => [],
  registerInlineCompletionItemProvider: () => new Disposable(() => {}),
  registerCodeLensProvider: () => new Disposable(() => {}),
  onDidChangeDiagnostics: never<unknown>(),
};

export const extensions = { getExtension: () => undefined, all: [] };

export const version = '1.95.0-web';

export function configureShim(configured: ShimHost): void {
  host = configured;
}
