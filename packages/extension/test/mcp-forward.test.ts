import { describe, expect, it } from 'vitest';
import { forwardedServers, stripJsonc, userMcpFile } from '../src/chat/mcp-forward.js';

const vars = { env: { TOKEN: 't0k', HOME: '/home/me' }, userHome: '/home/me', workspaceFolder: '/ws' };

describe('the servers forwarded from the user mcp.json', () => {
  it('finds the user mcp.json beside settings.json, from the global storage folder', () => {
    expect(userMcpFile('/data/User/globalStorage/g-code.g-code')).toBe('/data/User/mcp.json');
  });

  it('reads VS Code JSONC, with comments and trailing commas, and leaves strings alone', () => {
    expect(JSON.parse(stripJsonc('{\n // a comment\n "a": "x // not a comment, }", /* block */ "b": [1, 2,],\n}'))).toEqual({ a: 'x // not a comment, }', b: [1, 2] });
  });

  it('turns stdio, http and sse entries into ACP servers with their variables expanded', () => {
    const text = JSON.stringify({
      servers: {
        local: { type: 'stdio', command: 'node', args: ['${userHome}/srv.js'], env: { TOKEN: '${env:TOKEN}', DROP: null } },
        bare: { command: 'npx', args: ['-y', 'thing'] },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${env:TOKEN}' } },
        legacy: { type: 'sse', url: 'https://old.example.com/sse' },
      },
    });
    expect(forwardedServers(text, vars)).toEqual({
      servers: [
        { name: 'local', command: 'node', args: ['/home/me/srv.js'], env: [{ name: 'TOKEN', value: 't0k' }] },
        { name: 'bare', command: 'npx', args: ['-y', 'thing'], env: [] },
        { type: 'http', name: 'remote', url: 'https://mcp.example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer t0k' }] },
        { type: 'sse', name: 'legacy', url: 'https://old.example.com/sse', headers: [] },
      ],
      problems: [],
    });
  });

  it('leaves out a server that asks for an input prompt or does not parse, and says why', () => {
    const text = JSON.stringify({ servers: { asks: { command: 'x', env: { KEY: '${input:key}' } }, broken: { type: 'http' }, fine: { command: 'y' } } });
    const { servers, problems } = forwardedServers(text, vars);
    expect(servers.map((server) => server.name)).toEqual(['fine']);
    expect(problems).toEqual([expect.stringMatching(/^asks: \$\{input:key\} is not supported/), expect.stringMatching(/^broken: /)]);
  });

  it('forwards nothing from a file that is not JSON', () => {
    expect(forwardedServers('{ nope', vars)).toEqual({ servers: [], problems: [expect.stringMatching(/^mcp\.json: /)] });
  });
});
