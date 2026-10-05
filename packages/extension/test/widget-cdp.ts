import type { Webview, Window } from './cdp.js';

/**
 * Reaching into widget frames over CDP. A sandboxed srcdoc frame is isolated in a process of its own, so each widget
 * is its own `iframe` target, found by the name the panel gives its frame.
 */

type TargetInfo = { readonly targetId: string; readonly type: string; readonly url: string };
type Session = { send<T = any>(method: string, params?: Record<string, unknown>): Promise<T> };

const sessions = new Map<string, Session>();

async function sessionFor(window: Window, targetId: string): Promise<Session> {
  let session = sessions.get(targetId);
  if (session === undefined) {
    const { sessionId } = await window.browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    session = { send: (method, params) => window.browser.send(method, params ?? {}, sessionId) };
    sessions.set(targetId, session);
  }
  return session;
}

/** The session of the widget frame named `name`, or undefined when no such frame is loaded. */
async function widgetSession(window: Window, name: string): Promise<Session | undefined> {
  const { targetInfos } = await window.browser.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
  for (const target of targetInfos.filter((t) => t.type === 'iframe' && t.url === 'about:srcdoc')) {
    const session = await sessionFor(window, target.targetId);
    const named = await session.send('Runtime.evaluate', { expression: 'window.name', returnByValue: true }).catch(() => undefined);
    if (named?.result?.value === name) return session;
  }
  return undefined;
}

/** Runs `expression` in the widget frame named `name`, or returns undefined when no such frame is loaded. */
export async function inWidget<T>(window: Window, name: string, expression: string): Promise<T | undefined> {
  const session = await widgetSession(window, name);
  if (session === undefined) return undefined;
  const { result, exceptionDetails } = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails !== undefined) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value as T;
}

/**
 * Clicks the first `selector` match inside the widget frame named `name`, at its center. The events go to the frame's
 * own target: sent to the panel, they would reach the widget's process only through the compositor's hit testing,
 * which a window nobody sees never updates, so a click after a scroll would land where the widget used to be.
 */
export async function clickInWidget(window: Window, name: string, selector: string): Promise<void> {
  const session = await widgetSession(window, name);
  if (session === undefined) throw new Error(`no widget frame ${name}`);
  const at = await inWidget<{ x: number; y: number } | string>(
    window,
    name,
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return 'no ' + ${JSON.stringify(selector)}; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  if (typeof at !== 'object' || at === null) throw new Error(String(at));
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await session.send('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 });
}

/** The window's top-level pages: the workbench, and any window a widget managed to open. */
export async function pages(window: Window): Promise<string[]> {
  const { targetInfos } = await window.browser.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
  return targetInfos.filter((t) => t.type === 'page').map((t) => t.url);
}

export async function closeOtherPages(window: Window, keep: (url: string) => boolean): Promise<void> {
  const { targetInfos } = await window.browser.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
  for (const t of targetInfos) if (t.type === 'page' && !keep(t.url)) await window.browser.send('Target.closeTarget', { targetId: t.targetId });
}

/**
 * Turns off every Content Security Policy for the panel and for each frame it opens from now on, as a weakened
 * sandbox for red runs. New frames start paused, so the bypass is in place before their first script.
 */
export async function bypassCsp(window: Window, view: Webview): Promise<void> {
  window.browser.on('Target.attachedToTarget', (params: { sessionId: string; waitingForDebugger: boolean }) => {
    const child = params.sessionId;
    void (async () => {
      await window.browser.send('Page.enable', {}, child).catch(() => undefined);
      await window.browser.send('Page.setBypassCSP', { enabled: true }, child).catch(() => undefined);
      if (params.waitingForDebugger) await window.browser.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => undefined);
    })();
  });
  await view.send('Page.enable');
  await view.send('Page.setBypassCSP', { enabled: true });
  await view.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
}
