// Lays a page's screenshots out as a few contact sheets, rendered by headless Chrome, so the judge and the owner see
// the whole page in four images: the first screen at 1280, the page at 1280, the page at 375, and the motion strip.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect, launch } from '../page.mjs';
import { removeDir } from './measure.mjs';

const LAYOUTS = {
  desktop: { prefix: 'desktop-', cols: 3, tile: 640 },
  phone: { prefix: 'phone-', cols: 7, tile: 260 },
  motion: { prefix: 'motion-', cols: 4, tile: 480 },
};

const html = (files, { cols, tile }) => `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; background: #d9d9d9; }
  .grid { display: grid; grid-template-columns: repeat(${cols}, ${tile}px); gap: 6px; padding: 6px; width: max-content; }
  img { width: ${tile}px; display: block; }
  figure { margin: 0; position: relative; }
  figcaption { position: absolute; left: 4px; top: 4px; font: 600 13px system-ui; background: #000c; color: #fff; padding: 1px 6px; border-radius: 4px; }
</style><div class="grid">${files.map((f, i) => `<figure><img src="${f}"><figcaption>${i + 1}</figcaption></figure>`).join('')}</div>`;

/** Writes `sheet-desktop.jpg`, `sheet-phone.jpg` and `sheet-motion.jpg` next to the shots; returns the four image files. */
export async function makeSheets(shots, measures) {
  const lists = { desktop: measures.tiles1280 ?? [], phone: measures.tiles375 ?? [], motion: measures.motion ?? [] };
  const near = mkdtempSync(path.join(shots, '.chrome-'));
  const { chrome, profile, wsUrl } = await launch(near);
  const cdp = await connect(wsUrl);
  const out = { hero: lists.desktop[0] ? path.join(shots, lists.desktop[0]) : undefined };
  try {
    await cdp.send('Page.enable');
    for (const [name, layout] of Object.entries(LAYOUTS)) {
      const files = lists[name].filter((f) => f.startsWith(layout.prefix) && existsSync(path.join(shots, f)));
      if (files.length === 0) continue;
      const page = path.join(shots, `.sheet-${name}.html`);
      writeFileSync(page, html(files, layout));
      const width = Math.min(files.length, layout.cols) * (layout.tile + 6) + 6;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Page.navigate', { url: pathToFileURL(page).href });
      await new Promise((r) => setTimeout(r, 900));
      const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector(".grid").getBoundingClientRect().height', returnByValue: true });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, clip: { x: 0, y: 0, width, height: result.value, scale: 1 }, captureBeyondViewport: true });
      out[name] = path.join(shots, `sheet-${name}.jpg`);
      writeFileSync(out[name], Buffer.from(shot.data, 'base64'));
      rmSync(page);
    }
  } finally {
    cdp.close();
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await exited;
    await removeDir(profile);
    await removeDir(near);
  }
  return out;
}
