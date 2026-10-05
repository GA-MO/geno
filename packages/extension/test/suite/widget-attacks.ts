/**
 * Widgets that each try one way out of the sandbox. `base` is the test server, which records every request that
 * reaches it; each widget writes what happened to it in its own `data-attack` attribute, which the test reads from
 * inside the frame. A widget that got out shows it outside the frame too: a request, or a mark on the panel.
 */
const attempt = (name: string, body: string) =>
  `<p>${name}</p><script>
const note = (what) => document.body.setAttribute('data-attack', what);
try {
  const result = (() => { ${body} })();
  note('ran');
  if (result && typeof result.then === 'function') result.then(() => note('resolved'), (error) => note('rejected: ' + error.message));
} catch (error) {
  note('threw ' + error.name);
}
</script>`;

export const ATTACKS = {
  fetch: (base: string) => attempt('fetch', `return fetch('${base}/attack/fetch', { mode: 'no-cors' });`),
  img: (base: string) => attempt('img', `const image = new Image(); image.src = '${base}/attack/img'; document.body.append(image);`),
  'parent-document': () => attempt('parent.document', `parent.document.body.setAttribute('data-pwned', 'parent-document');`),
  'top-location': (base: string) => attempt('top.location', `top.location.href = '${base}/attack/top-location';`),
  'local-storage': () => attempt('localStorage', `localStorage.setItem('geno-pwned', 'local-storage');`),
  form: (base: string) =>
    attempt(
      'form post',
      `const form = document.createElement('form'); form.method = 'post'; form.action = '${base}/attack/form';
       const field = document.createElement('input'); field.name = 'secret'; field.value = 'widget'; form.append(field);
       document.body.append(form); form.submit();`,
    ),
  // VS Code hands any other URL a new window opens to the system browser, so the popup opens blank and then navigates.
  'window-open': (base: string) =>
    attempt('window.open', `const opened = window.open('about:blank'); if (opened === null) throw new Error('null'); opened.location.href = '${base}/attack/window-open';`),
} as const;

export type AttackName = keyof typeof ATTACKS;
export const ATTACK_NAMES = Object.keys(ATTACKS) as AttackName[];
