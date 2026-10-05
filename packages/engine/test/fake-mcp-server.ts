import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/** A test MCP server: `echo` (read-only), `env`, `crash`, `image`, plus `extra_<n>` tools to push past the lazy threshold. */
export function fakeMcpServer(extraTools = 0): McpServer {
  const server = new McpServer({ name: 'fake', version: '1.0.0' });
  server.registerTool(
    'echo',
    { description: 'Echo the text back.', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
  );
  server.registerTool('env', { description: 'Show the environment the server runs with.' }, async () => ({
    content: [{ type: 'text', text: JSON.stringify(process.env) }],
  }));
  server.registerTool('crash', { description: 'Exit without answering.' }, async () => {
    process.exit(1);
  });
  server.registerTool('image', { description: 'Return a tiny image.' }, async () => ({
    content: [
      { type: 'text', text: 'here it is' },
      { type: 'image', data: Buffer.from('fakepng').toString('base64'), mimeType: 'image/png' },
    ],
  }));
  server.registerTool('fail', { description: 'Report a tool error.' }, async () => ({ content: [{ type: 'text', text: 'it broke' }], isError: true }));
  for (let i = 0; i < extraTools; i++) {
    server.registerTool(`extra_${String(i).padStart(2, '0')}`, { description: `Extra tool ${i}.`, inputSchema: { n: z.number() } }, async ({ n }) => ({
      content: [{ type: 'text', text: `extra ${i} got ${n}` }],
    }));
  }
  server.registerPrompt('greet', { description: 'Say hello.', argsSchema: { who: z.string() } }, ({ who }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `hello ${who}` } }],
  }));
  server.registerResource('readme', 'fake://readme', { description: 'The readme.', mimeType: 'text/plain' }, async (uri) => ({
    contents: [{ uri: uri.href, text: 'read me' }],
  }));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The marker proves the process ran, which an untrusted server must never do.
  const marker = process.env['MARKER'];
  if (marker !== undefined) writeFileSync(marker, String(process.pid));
  await fakeMcpServer(Number(process.env['TOOL_COUNT'] ?? '0')).connect(new StdioServerTransport());
}
