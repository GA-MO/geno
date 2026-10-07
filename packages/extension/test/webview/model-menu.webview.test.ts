import { afterAll, describe, expect, it } from 'vitest';
import { closeBrowser, openPanel } from './harness.js';

afterAll(closeBrowser);

type Box = { readonly top: number; readonly bottom: number; readonly scrollable: boolean; readonly lastVisible: boolean; readonly checkedVisible: boolean };

describe('the model menu', () => {
  it('stays inside the panel and scrolls when an agent offers many models, with the current one in view', async () => {
    const panel = await openPanel();
    await panel.page.setViewportSize({ width: 360, height: 640 });
    await panel.click('.composer-model');
    await panel.waitFor('the model menu to open', () => panel.eval<boolean>("!doc.querySelector('#model-menu').hidden"));
    const box = await panel.eval<Box>(`(() => {
      const menu = doc.querySelector('#model-menu');
      const keys = menu.querySelector('[data-action="models"]');
      const rows = Array.from({ length: 43 }, (_, i) => {
        const li = doc.createElement('li');
        li.className = 'model-option';
        li.setAttribute('role', 'menuitemradio');
        li.tabIndex = -1;
        li.textContent = 'model-' + i;
        if (i === 30) li.setAttribute('aria-checked', 'true');
        return li;
      });
      for (const row of rows) menu.insertBefore(row, keys);
      const checked = menu.querySelector('[aria-checked="true"]');
      const r = menu.getBoundingClientRect();
      const inMenu = (el) => { const b = el.getBoundingClientRect(); return b.top >= r.top - 1 && b.bottom <= r.bottom + 1; };
      menu.scrollTop = menu.scrollHeight;
      const lastVisible = inMenu(menu.lastElementChild);
      menu.scrollTop = 0;
      checked.focus();
      return { top: r.top, bottom: r.bottom, scrollable: menu.scrollHeight > menu.clientHeight, lastVisible, checkedVisible: inMenu(checked) };
    })()`);
    expect(box.top, 'the menu starts below the top of the panel').toBeGreaterThanOrEqual(0);
    expect(box.scrollable, 'the rows scroll inside the menu').toBe(true);
    expect(box.lastVisible, 'scrolling reaches the last row').toBe(true);
    expect(box.checkedVisible, 'the focused current model is scrolled into view').toBe(true);
  });
});
