/** What the extension tells the chat webview. Replaying every message in order rebuilds the view. */
export type ToView =
  | { readonly type: 'user'; readonly text: string }
  | { readonly type: 'text'; readonly text: string }
  /** A tool call starting, or an update to one; an undefined field keeps its earlier value. */
  | { readonly type: 'tool'; readonly id: string; readonly title: string | undefined; readonly status: string | undefined }
  | { readonly type: 'permission'; readonly id: string; readonly title: string; readonly options: readonly PermissionChoice[] }
  | { readonly type: 'permission-done'; readonly id: string }
  | { readonly type: 'turn'; readonly running: boolean; readonly stopReason: string | undefined }
  | { readonly type: 'error'; readonly message: string };

export type PermissionChoice = { readonly optionId: string; readonly name: string };

/** What the webview asks of the extension. */
export type FromView =
  | { readonly type: 'ready' }
  | { readonly type: 'send'; readonly text: string }
  | { readonly type: 'stop' }
  | { readonly type: 'permission'; readonly id: string; readonly optionId: string };
