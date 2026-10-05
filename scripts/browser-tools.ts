// Lists the tools of the pinned browser server, run with Geno's flags, into core, so a session can offer them before
// Chrome starts. Rerun after changing BROWSER_SERVER_VERSION or browserServerArgs: npx tsx scripts/browser-tools.ts
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BROWSER_PACKAGE, BROWSER_SERVER, BROWSER_SERVER_ENV, BROWSER_SERVER_VERSION, browserServerArgs } from '../packages/core/src/browser.js';

const root = path.join(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'packages', 'engine', 'package.json'));
const { Client } = (await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href)) as typeof import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = (await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)) as typeof import('@modelcontextprotocol/sdk/client/stdio.js');

const manifest = require.resolve(`${BROWSER_PACKAGE}/package.json`);
const installed = (JSON.parse(await readFile(manifest, 'utf8')) as { version: string }).version;
if (installed !== BROWSER_SERVER_VERSION) throw new Error(`the engine's devDependency is ${BROWSER_PACKAGE}@${installed}, but BROWSER_SERVER_VERSION is ${BROWSER_SERVER_VERSION}`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(path.dirname(manifest), 'build', 'src', 'bin', 'chrome-devtools-mcp.js'), ...browserServerArgs({ headless: true }, tmpdir())],
  env: { PATH: process.env['PATH'] ?? '', HOME: tmpdir(), ...BROWSER_SERVER_ENV },
  stderr: 'ignore',
});
const client = new Client({ name: 'geno-browser-tools', version: '0.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

const infos = tools
  .map((tool) => ({
    server: BROWSER_SERVER,
    tool: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
    readOnly: tool.annotations?.readOnlyHint === true,
  }))
  .sort((a, b) => (a.tool < b.tool ? -1 : 1));

const out = path.join(root, 'packages', 'core', 'src', 'browser-tools.generated.ts');
await writeFile(
  out,
  `// Generated from ${BROWSER_PACKAGE}@${BROWSER_SERVER_VERSION} by scripts/browser-tools.ts. Rerun the script after changing the version or the flags.
import type { McpToolInfo } from './mcp.js';

export const BROWSER_TOOLS_VERSION = ${JSON.stringify(BROWSER_SERVER_VERSION)};

export const BROWSER_TOOLS: readonly McpToolInfo[] = ${JSON.stringify(infos, null, 2)} as unknown as readonly McpToolInfo[];
`,
);
console.log(`wrote ${path.relative(root, out)}: ${infos.length} tools, ${JSON.stringify(infos).length} bytes`);
