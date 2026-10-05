/**
 * Drives the VS Code window over the Chrome DevTools Protocol the way a user does: real mouse and key events
 * sent to the workbench page, aimed at elements found inside an extension's webview.
 */

type Target = { readonly type: string; readonly url: string; readonly webSocketDebuggerUrl: string };

type Connection = {
  /** `sessionId` addresses a target attached through this connection. */
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  /** Calls `listener` with the params of every `method` event until the returned function is called. */
  on(method: string, listener: (params: any) => void): () => void;
  close(): void;
};

async function connect(url: string): Promise<Connection> {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let next = 0;
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const listeners = new Set<{ readonly method: string; readonly listener: (params: any) => void }>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
    if (message.method !== undefined) for (const l of listeners) if (l.method === message.method) l.listener(message.params);
    const waiter = message.id === undefined ? undefined : waiting.get(message.id);
    if (waiter === undefined) return;
    waiting.delete(message.id!);
    if (message.error !== undefined) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        waiting.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
      }),
    on: (method, listener) => {
      const entry = { method, listener };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    close: () => socket.close(),
  };
}

type Session = { send<T = any>(method: string, params?: Record<string, unknown>): Promise<T> };

/** The workbench page, and the window's out-of-process frames attached so far, by target id. */
export type Window = { readonly page: Session; readonly browser: Connection; readonly frames: Map<string, Session> };

const sessionOn = (browser: Connection, sessionId: string): Session => ({ send: (method, params) => browser.send(method, params, sessionId) });

async function attach(browser: Connection, targetId: string): Promise<Session> {
  const { sessionId } = await browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  return sessionOn(browser, sessionId);
}

/** Connects to the window's workbench page through the browser endpoint, which can also reach its frames. */
export async function connectWindow(port: number): Promise<Window> {
  const { webSocketDebuggerUrl } = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const browser = await connect(webSocketDebuggerUrl);
  const { targetInfos } = await browser.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
  const target = targetInfos.find((t) => t.type === 'page' && t.url.includes('workbench'));
  if (target === undefined) throw new Error('no workbench page');
  return { browser, page: await attach(browser, target.targetId), frames: new Map() };
}

type TargetInfo = { readonly targetId: string; readonly type: string; readonly url: string };

/**
 * Has the window draw a frame. A test window usually sits behind others, and Chromium draws nothing for a
 * window nobody sees: animation callbacks wait, and the workbench builds a newly shown webview only on its
 * next frame. A one-pixel capture forces the frame a visible window would have drawn anyway.
 */
const frame = (window: Window): Promise<unknown> => window.page.send('Page.captureScreenshot', { clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } });

const PANEL_DOCUMENT = `document.getElementById('active-frame')?.contentDocument`;

/** An extension's webview: its frame's session, which takes both script and input. */
export type Webview = Session;

/**
 * The webview of `extensionId` whose document holds `ready`. A webview hidden and shown again can leave its
 * old frame listed for a moment, which this skips.
 */
export async function webview(window: Window, extensionId: string, ready: string): Promise<Webview> {
  await frame(window);
  const { targetInfos } = await window.browser.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
  const webviews = targetInfos.filter((t) => t.type === 'iframe' && t.url.startsWith('vscode-webview://') && t.url.includes(`extensionId=${extensionId}`));
  for (const target of webviews) {
    let session = window.frames.get(target.targetId);
    if (session === undefined) {
      session = await attach(window.browser, target.targetId);
      window.frames.set(target.targetId, session);
    }
    const probe = await session.send('Runtime.evaluate', { expression: `!!${PANEL_DOCUMENT}?.querySelector(${JSON.stringify(ready)})`, returnByValue: true }).catch(() => undefined);
    if (probe?.result.value === true) return session;
  }
  throw new Error(`no loaded webview of ${extensionId} among ${webviews.length}`);
}

/**
 * Runs `expression` against the webview's document, bound as `doc`; VS Code nests the extension's document in
 * a same-origin `active-frame` of its webview host page. The result must be JSON.
 */
export async function evaluate<T>(view: Webview, expression: string): Promise<T> {
  const source = `(() => { const doc = ${PANEL_DOCUMENT}; return (${expression}); })()`;
  const { result, exceptionDetails } = await view.send('Runtime.evaluate', { expression: source, returnByValue: true, awaitPromise: true });
  if (exceptionDetails !== undefined) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value as T;
}

/*
 * Input goes to the webview's own frame. Sent to the workbench page instead, it would reach the webview only
 * through the compositor's hit testing, which a window nobody sees never updates, so the page would keep it.
 */

/** Clicks the first `selector` match whose trimmed text is `text` when given, at its center. */
export async function click(view: Webview, selector: string, text?: string): Promise<void> {
  const at = await evaluate<{ x: number; y: number } | string>(
    view,
    `(() => {
      const frame = document.getElementById('active-frame').getBoundingClientRect();
      const all = [...doc.querySelectorAll(${JSON.stringify(selector)})];
      const el = all.find((e) => ${JSON.stringify(text ?? null)} === null || e.textContent.trim() === ${JSON.stringify(text ?? null)});
      if (!el) return 'no ' + ${JSON.stringify(selector)} + ' ' + ${JSON.stringify(text ?? '')} + ' among ' + all.length;
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: frame.x + r.x + r.width / 2, y: frame.y + r.y + r.height / 2 };
    })()`,
  );
  if (typeof at === 'string') throw new Error(at);
  await view.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
  await view.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', clickCount: 1 });
  await view.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 });
}

/** `commands` are the editing commands the browser runs for a key that edits text, as a real keystroke would. */
const KEYS: Readonly<Record<string, { readonly key: string; readonly code: string; readonly keyCode: number; readonly text?: string; readonly commands?: readonly string[] }>> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8, commands: ['deleteBackward'] },
  selectAll: { key: 'a', code: 'KeyA', keyCode: 65, commands: ['selectAll'] },
};

/** CDP's modifier bits. */
const MODIFIERS: Readonly<Record<string, number>> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

export async function press(view: Webview, name: string, modifiers: readonly string[] = []): Promise<void> {
  const { key, code, keyCode, text, commands } = KEYS[name]!;
  const bits = modifiers.reduce((sum, m) => sum | MODIFIERS[m]!, 0);
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: bits };
  await view.send('Input.dispatchKeyEvent', {
    type: text === undefined ? 'rawKeyDown' : 'keyDown',
    ...base,
    ...(text === undefined ? {} : { text }),
    ...(commands === undefined ? {} : { commands }),
  });
  await view.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

export const typeText = (view: Webview, text: string): Promise<unknown> => view.send('Input.insertText', { text });
