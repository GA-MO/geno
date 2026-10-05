/// <reference lib="dom" />
import { h } from './dom.js';
import { compose, crop, PALETTE, SIZE, type Frame, type Grid, type Ink } from './sprite.js';

type Area = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

const WHOLE: Area = { x: 0, y: 0, width: SIZE, height: SIZE };

/**
 * A canvas of one pixel per sprite pixel, which the stylesheet scales by a whole number with pixelated rendering,
 * so Noodle stays crisp. It repaints only when the picture changes.
 */
export function spriteCanvas(className: string, area: Area = WHOLE) {
  const element = h('canvas', { class: `dino ${className}`, width: area.width, height: area.height, 'aria-hidden': 'true' });
  const context = element.getContext('2d');
  let shown = '';

  function paint(grid: Grid): void {
    const key = grid.join('');
    if (key === shown || context === null) return;
    shown = key;
    context.clearRect(0, 0, area.width, area.height);
    grid.forEach((row, y) => {
      for (const run of row.matchAll(/([^.])\1*/g)) {
        context.fillStyle = PALETTE[run[1] as Ink];
        context.fillRect(run.index, y, run[0].length, 1);
      }
    });
    element.dataset['frame'] = key;
  }

  return { element, draw: (frame: Frame) => paint(crop(compose(frame), area)) };
}
