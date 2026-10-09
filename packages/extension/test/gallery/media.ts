import { paintPng, type Rgb } from '../../../core/test/png.js';

/**
 * The images the show_files states show, painted here so no binary file sits in the repository. The gallery server
 * and the webview test serve them under /gallery-media/, which those states give the panel as a root.
 */
type Rect = readonly [x0: number, y0: number, x1: number, y1: number, color: Rgb];

const paint = (width: number, height: number, background: Rgb, rects: readonly Rect[]): Buffer =>
  paintPng(width, height, (x, y) => rects.findLast(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1)?.[4] ?? background);

const PAPER: Rgb = [248, 248, 246];
const WHITE: Rgb = [255, 255, 255];
const INK: Rgb = [38, 52, 84];
const GREY: Rgb = [214, 216, 222];
const RED: Rgb = [214, 64, 58];
const GREEN: Rgb = [46, 160, 92];
const BLUE: Rgb = [90, 120, 200];

/** A sign-in page: before, its button runs off the card in red; after, it sits inside the card in green. */
const page = (fixed: boolean): Buffer =>
  paint(480, 320, PAPER, [
    [0, 0, 480, 36, INK],
    [16, 12, 120, 24, [230, 232, 240]],
    [110, 70, 370, 280, WHITE],
    [130, 92, 290, 104, GREY],
    [130, 124, 350, 148, GREY],
    [130, 162, 350, 186, GREY],
    fixed ? [130, 214, 350, 246, GREEN] : [250, 220, 420, 252, RED],
  ]);

const phone = (fixed: boolean): Buffer =>
  paint(240, 420, PAPER, [
    [0, 0, 240, 44, INK],
    [16, 70, 224, 90, GREY],
    [16, 104, 224, 130, GREY],
    [16, 144, 224, 170, GREY],
    fixed ? [16, 196, 224, 232, GREEN] : [60, 200, 240, 236, RED],
  ]);

const chart = (): Buffer =>
  paint(480, 300, WHITE, [
    [40, 260, 450, 262, INK],
    [40, 40, 42, 262, INK],
    ...[120, 80, 150, 60, 190].map((top, i): Rect => [70 + i * 74, top, 120 + i * 74, 260, i === 4 ? GREEN : BLUE]),
  ]);

const MEDIA: Readonly<Record<string, () => Buffer>> = {
  'before.png': () => page(false),
  'after.png': () => page(true),
  'phone-before.png': () => phone(false),
  'phone-after.png': () => phone(true),
  'chart.png': chart,
};

/** The PNG for a path under /gallery-media/, or undefined for any other path. */
export function galleryMedia(pathname: string): Buffer | undefined {
  const name = /^\/gallery-media\/([\w.-]+)$/.exec(pathname)?.[1];
  return name === undefined || !Object.hasOwn(MEDIA, name) ? undefined : MEDIA[name]!();
}
