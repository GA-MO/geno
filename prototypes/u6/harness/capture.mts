/**
 * Screenshots every U6 direction in a real VS Code webview, in Dark Modern and Light Modern.
 * Run from the repository root: pnpm exec tsx prototypes/u6/harness/capture.mts [direction ...]
 * U6_THEMES=dark,light,hc picks themes; U6_STATES=full,empty picks states.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { makeWorkspace } from '../../../packages/extension/test/launch.ts';
import { connectWindow } from '../../../packages/extension/test/cdp.ts';
import { captureWindow, freePort } from '../../../packages/extension/test/screenshot.ts';

const repo = path.resolve(import.meta.dirname, '../../..');
const { runTests } = createRequire(path.join(repo, 'packages/extension/package.json'))('@vscode/test-electron');
const common = path.dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim());
const cachePath = [path.join(repo, '.vscode-test'), path.join(common, '.vscode-test')].find(existsSync);
const out = process.env['U6_OUT'] ?? path.join(repo, 'docs/media/u6-proposals');

const protoDir = path.join(repo, 'prototypes/u6');
const all = readdirSync(protoDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(protoDir, d.name, 'index.html')))
  .map((d) => d.name);
const directions = process.argv.slice(2).length > 0 ? process.argv.slice(2) : all;
/** `full` is the finished turn from the top; `permission` is the run waiting on a command; `streaming` is mid-answer. */
const states = (process.env['U6_STATES'] ?? 'full,permission,streaming,empty').split(',');
const themes = (process.env['U6_THEMES'] ?? 'dark,light').split(',');
const fileName = (d: string, state: string, theme: string) => `${d}${state === 'full' ? '' : `-${state}`}-${theme}.png`;

/** Drags the sidebar's sash so the chat panel is as wide as in the U4 screenshots. */
async function widen(width: number) {
  const window = await connectWindow(port);
  try {
    const { result } = await window.page.send('Runtime.evaluate', {
      expression: `(() => { const r = document.querySelector('.part.sidebar').getBoundingClientRect(); return { x: r.right, y: r.top + r.height / 2, left: r.left }; })()`,
      returnByValue: true,
    });
    const { x, y, left } = result.value as { x: number; y: number; left: number };
    const mouse = (type: string, at: number) => window.page.send('Input.dispatchMouseEvent', { type, x: at, y, button: 'left', clickCount: 1 });
    await mouse('mouseMoved', x);
    await mouse('mousePressed', x);
    for (let step = 1; step <= 10; step++) await mouse('mouseMoved', x + ((left + width - x) * step) / 10);
    await mouse('mouseReleased', left + width);
    await window.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: left + width + 400, y });
  } finally {
    window.browser.close();
  }
}

const port = await freePort();
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const { direction, state, theme, width } = JSON.parse(body);
  try {
    if (width !== undefined) await widen(width);
    else await captureWindow(port, path.join(out, fileName(direction, state, theme)));
    res.writeHead(200).end();
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
await mkdir(out, { recursive: true });

const { workspace, work } = await makeWorkspace({}, { 'workbench.startupEditor': 'none', 'workbench.tips.enabled': false });
const code = await runTests({
  cachePath,
  extensionDevelopmentPath: path.join(protoDir, 'harness'),
  extensionTestsPath: path.join(protoDir, 'harness/suite.cjs'),
  // An empty extensions dir instead of --disable-extensions, which shows a toast in every screenshot.
  launchArgs: [workspace, `--extensions-dir=${work}/extensions`, '--skip-welcome', '--skip-release-notes', `--user-data-dir=${work}/ud`, `--remote-debugging-port=${port}`],
  extensionTestsEnv: {
    U6_HOST: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    U6_DIRECTIONS: JSON.stringify(directions),
    U6_STATES: JSON.stringify(states),
    U6_THEMES: JSON.stringify(themes),
  },
});
server.close();
console.log(code === 0 ? `captured ${directions.join(', ')} into ${out}` : `VS Code exited ${code}`);
process.exit(code);
