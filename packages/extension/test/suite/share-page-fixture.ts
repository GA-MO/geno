/** The shared page fixture (U66), used by the suite inside VS Code and by the test that launches it and opens the pages. */

/** A chart the answer shows from the workspace, which the page carries as a data URI. */
const CHART = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60" viewBox="0 0 240 60"><rect width="240" height="60" rx="8" fill="#199e70"/><text x="12" y="36" fill="#fff" font-family="sans-serif" font-size="18">cache hits 92%</text></svg>';

export const FILES = { 'README.md': '# fixture\n', 'shots/chart.svg': CHART } as const;

export const PROMPT = 'Why is the build slow?';

export const WIDGET_TITLE = 'Build time by step';

/**
 * The widget draws bars with its script, and tries every way out a page has: a remote image, a fetch, an image made in
 * script, a stylesheet and a font. The page's policy has to stop each one.
 */
export const WIDGET = `<style>
  .bars { width: 100%; font-family: var(--font); color: var(--fg); }
  .bar { min-width: max-content; height: 22px; margin: 6px 0; border-radius: 8px; background: var(--chart-1); color: #fff; padding: 0 8px; font-size: 13px; line-height: 22px; }
  @font-face { font-family: Remote; src: url(https://fonts.example/remote.woff2); }
</style>
<div class="bars" id="bars"></div>
<img src="https://beacon.example/pixel.png" alt="">
<link rel="stylesheet" href="https://cdn.example/style.css">
<script>
  const steps = [['Type check', 64], ['Bundle', 24], ['Lint', 12]];
  for (const [name, share] of steps) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.width = share + '%';
    bar.textContent = name + ' ' + share + '%';
    document.getElementById('bars').append(bar);
  }
  fetch('https://api.example/track').catch(() => {});
  new Image().src = 'https://beacon.example/script.png';
</script>`;

export const DIAGRAM = 'flowchart LR\n  A[Source] --> B[Type check] --> C[Bundle]';

export const HEADING = 'Where the build time goes';

export const ANSWER = [
  `## ${HEADING}`,
  'Type checking takes **64%** of the build. See the [TypeScript docs](https://www.typescriptlang.org/docs/) on project references.',
  '![Cache hits](shots/chart.svg)',
  `\`\`\`mermaid\n${DIAGRAM}\n\`\`\``,
  '```ts\nexport default { compilerOptions: { incremental: true } };\n```',
  '| Step | Share |\n| --- | ---: |\n| Type check | 64% |\n| Bundle | 24% |',
].join('\n\n');

export const PAGES = { widget: 'geno-pages/build-time-by-step.html', answer: 'geno-pages/why-is-the-build-slow.html' } as const;
