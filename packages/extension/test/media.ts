import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluate, type Webview, type Window } from './cdp.js';

/**
 * Recordings of the chat panel for the docs: a GIF of the rainbow edge, and a performance trace of the panel.
 * Both act on the window over the DevTools protocol, as the screenshots do.
 */

type Clip = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/** Where the g-code webview sits in the window, for clipping a capture to the panel. */
export async function panelClip(window: Window): Promise<Clip> {
  const { result } = await window.page.send('Runtime.evaluate', {
    expression: `(() => {
      const frame = [...document.querySelectorAll('iframe')].find((f) => f.src.includes('extensionId=g-code.g-code') && f.getBoundingClientRect().width > 0);
      const r = frame.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
    returnByValue: true,
  });
  return result.value as Clip;
}

/** Captures just the panel, at `scale` times its CSS size, for details such as a 1px rail or a 6px scrollbar. */
export async function capturePanel(window: Window, file: string, scale = 2): Promise<void> {
  const { data } = await window.page.send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { ...(await panelClip(window)), scale } });
  await writeFile(file, Buffer.from(data, 'base64'));
}

/** The rainbow's running animations in the panel, paused at `t` of their cycle (0 to 1), or all resumed. */
const RAINBOW = `doc.getAnimations().filter((a) => a.animationName === 'rainbow-run')`;
export const seekRainbow = (view: Webview, t: number) =>
  evaluate<number>(view, `${RAINBOW}.map((a) => (a.pause(), a.currentTime = a.effect.getTiming().duration * ${t})).length`);
export const pauseRainbow = (view: Webview) => evaluate<number>(view, `${RAINBOW}.map((a) => a.pause()).length`);
export const playRainbow = (view: Webview) => evaluate<number>(view, `${RAINBOW}.map((a) => a.play()).length`);

/**
 * One cycle of the rainbow as `frames` stills, each with the animations seeked to its point in the cycle, so the
 * frames are evenly spaced however long a capture takes; stitched into a looping GIF at the cycle's own speed.
 */
export async function recordRainbow(window: Window, view: Webview, file: string, frames = 12): Promise<string[]> {
  const clip = await panelClip(window);
  const dir = await mkdtemp(path.join(tmpdir(), 'gcode-rainbow-'));
  const stills: string[] = [];
  const duration = await evaluate<number>(view, `${RAINBOW}[0]?.effect.getTiming().duration ?? 0`);
  if (duration === 0) throw new Error('no running rainbow to record');
  for (let i = 0; i < frames; i++) {
    await seekRainbow(view, i / frames);
    // The panel's renderer draws the seeked frame on its own schedule; a capture before then shows the last one.
    await evaluate(view, `new Promise((done) => doc.defaultView.requestAnimationFrame(() => doc.defaultView.requestAnimationFrame(() => setTimeout(done, 50))))`);
    const { data } = await window.page.send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
    const still = path.join(dir, `${String(i).padStart(2, '0')}.png`);
    await writeFile(still, Buffer.from(data, 'base64'));
    stills.push(still);
  }
  await playRainbow(view);
  const gif = spawnSync('python3', [path.resolve('scripts/frames-to-gif.py'), file, String(Math.round(duration / frames)), ...stills], { encoding: 'utf8' });
  if (gif.status !== 0) throw new Error(`frames-to-gif failed: ${gif.stderr}`);
  return stills;
}

type TraceEvent = { readonly name: string; readonly ph: string; readonly pid: number; readonly tid: number; readonly ts: number; readonly dur?: number; readonly args?: any };

/** What a trace says the panel's renderer did: main-thread busy time and frames drawn, over the traced span. */
export type PanelCost = { readonly seconds: number; readonly busyMs: number; readonly busyPercent: number; readonly frames: number; readonly fps: number };

/** Records a DevTools performance trace of the whole window for `ms`, and returns its events. */
export async function trace(window: Window, ms: number): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  // A busy trace sends more events at once than a spread can pass as arguments.
  const offData = window.browser.on('Tracing.dataCollected', ({ value }) => {
    for (const event of value) events.push(event);
  });
  const done = new Promise<void>((resolve) => {
    const off = window.browser.on('Tracing.tracingComplete', () => (off(), resolve()));
  });
  await window.browser.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'toplevel', '__metadata'],
    },
  });
  await new Promise((r) => setTimeout(r, ms));
  await window.browser.send('Tracing.end');
  await done;
  offData();
  return events;
}

/**
 * The panel's cost in a trace: the busy time of its renderer's main thread, as the sum of its top-level tasks,
 * and the frames that renderer's compositor drew.
 */
export function panelCost(events: readonly TraceEvent[], pid: number): PanelCost {
  const main = events.find((e) => e.ph === 'M' && e.name === 'thread_name' && e.pid === pid && e.args?.name === 'CrRendererMain')?.tid;
  if (main === undefined) throw new Error(`the trace has no main thread for renderer ${pid}`);
  // The span runs from the trace's start; a few events carry older timestamps, from work begun before it.
  const start = events.find((e) => e.name === 'TracingStartedInBrowser')?.ts ?? events.filter((e) => e.ph !== 'M' && e.ts > 0).reduce((least, e) => Math.min(least, e.ts), Infinity);
  const timed = events.filter((e) => e.ph !== 'M' && e.ts >= start);
  const seconds = (timed.reduce((latest, e) => Math.max(latest, e.ts + (e.dur ?? 0)), start) - start) / 1e6;
  const busyUs = timed.filter((e) => e.pid === pid && e.tid === main && e.ph === 'X' && e.name === 'RunTask').reduce((sum, e) => sum + (e.dur ?? 0), 0);
  const drawn = timed.filter((e) => e.pid === pid && e.name === 'DrawFrame').length;
  return { seconds, busyMs: busyUs / 1000, busyPercent: busyUs / 1e4 / seconds, frames: drawn, fps: drawn / seconds };
}

/**
 * The renderer that hosts the g-code webview: the process whose script ran in a document at the webview's
 * address. A trace in which the panel ran no script names none, so a caller keeps the first one found.
 */
export function webviewPid(events: readonly TraceEvent[]): number | undefined {
  return events.find((e) => {
    const url = e.args?.data?.url;
    return typeof url === 'string' && url.startsWith('vscode-webview://') && url.includes('extensionId=g-code.g-code');
  })?.pid;
}
