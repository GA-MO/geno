/**
 * `pnpm tsx packages/extension/test/webview/capture-themes.mts`, from the repository root: opens the chat panel in a
 * real VS Code and writes what VS Code gives its webview in each theme to `themes/<slug>.json`, for the browser
 * harness to apply. Run it again after a VS Code upgrade changes the theme colors.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { useTestTmp } from '../../../../scripts/test-tmp.js';
import { buildExtension } from '../../build.mjs';
import { connectWindow, evaluate, webview, type Window } from '../cdp.js';
import { cachePath, root, setUp } from '../launch.js';
import { freePort } from '../screenshot.js';
import type { ThemeDump } from './theme.js';

const EXTENSION = 'g-code.g-code';
const READY = '.transcript';
const OUT = path.join(root, 'test/webview/themes');

/** Everything VS Code sets on the webview's document for the theme; the panel's own body attributes stay out. */
const DUMP = `({
  htmlStyle: doc.documentElement.getAttribute('style') ?? '',
  bodyClasses: [...doc.body.classList].filter((c) => c.startsWith('vscode-')),
  bodyAttributes: Object.fromEntries([...doc.body.attributes].filter((a) => a.name.startsWith('data-vscode-')).map((a) => [a.name, a.value])),
  defaultStyles: doc.getElementById('_defaultStyles')?.textContent ?? '',
  viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
})`;

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

useTestTmp();
const debugPort = await freePort();
let window: Window | undefined;
const fake = createServer((req, res) => {
  void (async () => {
    const action = JSON.parse(await bodyOf(req)) as { do: 'ready' | 'dump'; slug?: string; theme?: string };
    try {
      window ??= await connectWindow(debugPort);
      if (action.do === 'ready') {
        const ready = await webview(window, EXTENSION, READY).then(() => true, () => false);
        res.writeHead(200).end(String(ready));
        return;
      }
      const dump: ThemeDump = { theme: action.theme!, ...(await evaluate<Omit<ThemeDump, 'theme'>>(await webview(window, EXTENSION, READY), DUMP)) };
      await writeFile(path.join(OUT, `${action.slug}.json`), `${JSON.stringify(dump, null, 2)}\n`);
      console.log(`wrote ${action.slug}.json: ${dump.bodyClasses.join(' ')}, ${dump.htmlStyle.split(';').length} declarations`);
      res.writeHead(200).end('');
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  })();
});
await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
await mkdir(OUT, { recursive: true });
await buildExtension();
const { home, suite, launchArgs } = await setUp('theme-capture', { 'a.ts': 'export const a = 1;\n' }, {});
try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: suite,
    cachePath,
    ...(process.env['GCODE_VSCODE_VERSION'] ? { version: process.env['GCODE_VSCODE_VERSION'] } : {}),
    launchArgs: [...launchArgs, `--remote-debugging-port=${debugPort}`],
    extensionTestsEnv: { GCODE_HOME: home, GCODE_FAKE_MODEL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` },
  });
} finally {
  window?.browser.close();
  fake.close();
}
