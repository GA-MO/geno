/**
 * The dinosaur g-code wears, named once. The build copies its activity-bar mask and 128px icon to the
 * `dist/dino/` paths package.json points at, and bakes its avatar into the chat webview, so switching to
 * another variant is this one line.
 */
export const DINO = 'media/noodle-box-a';

export const DINO_FILES = { mono: `${DINO}-mono.svg`, avatar: `${DINO}-avatar.svg`, icon: `${DINO}-128.png` } as const;

/** Where the build puts the files package.json names. */
export const DINO_DIST = { mono: 'dist/dino/mono.svg', icon: 'dist/dino/icon.png' } as const;

type Pixel = { readonly x: number; readonly y: number; readonly fill: string };

/** The avatar's pixels, one per cell, from the whole-pixel rects the dino generator writes. */
function pixelsOf(svg: string): Pixel[] {
  const rects = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="(#[0-9a-f]{6})"\/>/gi)];
  return rects.flatMap(([, x, y, w, h, fill]) =>
    Array.from({ length: Number(w) * Number(h) }, (_, i) => ({ x: Number(x) + (i % Number(w)), y: Number(y) + Math.floor(i / Number(w)), fill: fill!.toLowerCase() })),
  );
}

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/**
 * The avatar with a closed eyelid drawn over its eye, in a `lid` group the panel shows for a blink frame. The
 * eye is the white shine and the darkest color, the pupil; the lid paints those cells in the body color, the
 * most common one, and draws the closed eye as a line of the pupil color along the eye's bottom row.
 */
export function withEyelid(svg: string): string {
  const pixels = pixelsOf(svg);
  const counts = new Map<string, number>();
  for (const p of pixels) counts.set(p.fill, (counts.get(p.fill) ?? 0) + 1);
  const body = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  const pupil = [...counts.keys()].sort((a, b) => luminance(a) - luminance(b))[0]!;
  const eye = pixels.filter((p) => p.fill === '#ffffff' || p.fill === pupil);
  if (eye.length === 0) throw new Error('the avatar has no eye to blink');
  const bottom = Math.max(...eye.map((p) => p.y));
  const lid = eye.map((p) => `<rect x="${p.x}" y="${p.y}" width="1" height="1" fill="${p.y === bottom ? pupil : body}"/>`).join('');
  return svg.replace(/<\/svg>\s*$/, `<g class="lid">${lid}</g></svg>`);
}
