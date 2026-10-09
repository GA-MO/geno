/// <reference lib="dom" />

/**
 * Everything that runs past either edge of the panel, as `tag.class` and how far past: an element whose box crosses
 * an edge, and a scroller that scrolls sideways. Code and a diff's lines may scroll sideways and a line may end in an ellipsis,
 * by design; anything else past the edge is cut off or needs a sideways scroll. The gallery shows it on each frame;
 * the webview test passes it to the page, so it reads only `doc` and its window.
 */
export function overflowing(doc: Document = document): string[] {
  const SIDEWAYS = 'pre, code, table, .diagram-canvas, .tray';
  const SCROLLERS = '.hunk-lines';
  const view = doc.defaultView!;
  const right = doc.documentElement.clientWidth + 0.5;
  const style = (e: Element) => view.getComputedStyle(e);
  const name = (e: Element) => `${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className.trim() !== '' ? `.${e.className.trim().split(/\s+/).join('.')}` : ''}`;
  const meant = (e: Element): boolean => {
    for (let p: Element | null = e; p !== null && p !== doc.body; p = p.parentElement) {
      if (p.matches(SIDEWAYS)) return true;
      const s = style(p);
      // Inside a scroller, which scrolls to it; the scroller itself is judged on its own.
      if (p !== e && (s.overflowX === 'auto' || s.overflowX === 'scroll')) return true;
      if (s.textOverflow === 'ellipsis' && s.overflowX !== 'visible') return true;
      // A hidden or fixed element, such as a closed menu kept in place, or one sliding in from off the panel.
      if (s.visibility === 'hidden' || s.position === 'fixed' || Number(s.opacity) === 0) return true;
    }
    return false;
  };
  const lines: string[] = [];
  for (const e of doc.body.querySelectorAll('*')) {
    if (e.getClientRects().length === 0) continue;
    const box = e.getBoundingClientRect();
    if (box.width === 0 || box.height === 0 || (box.right <= right && box.left >= -0.5) || meant(e)) continue;
    // Only the outermost of a run of overflowing boxes, so one cause reads as one line.
    const parent = e.parentElement;
    if (parent !== null && parent !== doc.body) {
      const outer = parent.getBoundingClientRect();
      if ((outer.right > right || outer.left < -0.5) && !meant(parent)) continue;
    }
    lines.push(`${name(e)} ${box.right > right ? `${Math.round(box.right - right)}px past the right` : `${Math.round(-box.left)}px past the left`}`);
  }
  for (const e of doc.body.querySelectorAll('*')) {
    const { overflowX } = style(e);
    if ((overflowX === 'auto' || overflowX === 'scroll') && e.scrollWidth > e.clientWidth + 1 && !e.matches(SCROLLERS) && !meant(e)) lines.push(`${name(e)} scrolls sideways by ${e.scrollWidth - e.clientWidth}px`);
  }
  const page = doc.scrollingElement;
  if (page !== null && page.scrollWidth > page.clientWidth) lines.push(`the page scrolls sideways by ${page.scrollWidth - page.clientWidth}px`);
  return lines;
}
