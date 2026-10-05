// Live check for the MCP panel with a real server: chrome-devtools from a copy of payload-site-template's .mcp.json,
// trusted in the panel of a throwaway VS Code, started for real through npx. It calls no model and costs nothing.
// Run from the repository root: pnpm tsx packages/extension/test/mcp-live.ts [screenshot dir]
// GCODE_MCP_SOURCE names the .mcp.json to copy; it is read, never written.
import { copyFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { click, connectWindow, evaluate, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { captureWindow, freePort } from './screenshot.js';

const source = process.env['GCODE_MCP_SOURCE'] || path.join(homedir(), 'Development', 'payload-site-template', '.mcp.json');
const shots = process.argv[2];

async function main(): Promise<number> {
  const { workspace, home, suite, launchArgs } = await setUp('mcp-live', {}, { 'chat.mcp.enabled': false, 'chat.mcp.access': 'none', 'chat.mcp.autostart': 'never' });
  await copyFile(source, path.join(workspace, '.mcp.json'));
  const debugPort = await freePort();
  let window: Window | undefined;
  const view = async () => webview((window ??= await connectWindow(debugPort)), 'g-code.g-code', '.transcript');
  const ui = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk));
    req.on('end', async () => {
      const action = JSON.parse(body) as { do: string; expression?: string; selector?: string; text?: string; name?: string };
      try {
        let result: unknown;
        if (action.do === 'eval') result = await evaluate(await view(), action.expression!);
        if (action.do === 'click') await click(await view(), action.selector!, action.text);
        if (action.do === 'screenshot' && shots !== undefined) await captureWindow(debugPort, path.resolve(shots, `${action.name}.png`));
        res.writeHead(200).end(result === undefined ? '' : JSON.stringify(result));
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
    });
  });
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(ui.address() as AddressInfo).port}`;
  try {
    return await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: suite,
      cachePath,
      launchArgs: [...launchArgs, `--remote-debugging-port=${debugPort}`],
      extensionTestsEnv: { GCODE_HOME: home, GCODE_PROVIDER: 'modelstudio', GCODE_MODEL: 'qwen3.8-flash', DASHSCOPE_API_KEY: 'sk-unused', DASHSCOPE_BASE_URL: url, GCODE_FAKE_MODEL: url },
    });
  } finally {
    window?.browser.close();
    ui.close();
  }
}

void main().then((code) => (process.exitCode = code));
