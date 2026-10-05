/** The widget fixture's prompts and widgets, shared by the suite inside VS Code and the test that launches it. */
export const FILES = { 'README.md': '# fixture\n' } as const;

export const PROMPTS = { speed: 'Show where a run spends its time', grow: 'Draw a list I can grow' } as const;

export const SPEED_TITLE = 'Where a run spends its time';
export const LOADING = ['Laying out the bars', 'Adding the labels'] as const;

/** A widget that grows a row per click, through an inline handler, with a link to approve and one it forges on load. */
export const GROW = `<style>
  .g { width: 100%; font-family: var(--font); color: var(--fg); }
  .row { padding: 6px 8px; margin: 4px 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
  button { font: inherit; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--fg); }
  a { color: var(--accent); }
</style>
<div class="g">
  <p id="swatch" style="color: var(--chart-1)">Series one</p>
  <button id="more" onclick="add()">More rows</button>
  <a id="docs" href="https://example.com/docs">Read the docs</a>
  <div id="rows"></div>
</div>
<script>
  function add() {
    const row = document.createElement('div');
    row.className = 'row';
    row.textContent = 'Row ' + (document.querySelectorAll('.row').length + 1);
    document.getElementById('rows').append(row);
  }
  parent.postMessage({ type: 'gcode-widget', kind: 'link', href: 'https://forged.example/' }, '*');
</script>`;

export const GROW_TITLE = 'A list that grows';
export const DOCS = 'https://example.com/docs';
