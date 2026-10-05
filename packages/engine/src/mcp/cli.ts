import { parseArgs } from 'node:util';
import { describeServerState, MCP_SOURCE_LABELS } from '@g-code/core';
import { singleId, type Command } from '../command.js';
import { workspaceDir } from '../drive.js';
import { openMcpHub } from './hub.js';

const workspaceFlag = { workspace: { type: 'string', default: '.' } } as const;

/** `gcode mcp list`: every server the workspace sees, where it came from, and its state. Nothing is started. */
const list: Command = async (args, { io, store }) => {
  const { values } = parseArgs({ args, strict: true, options: workspaceFlag });
  const workspace = await workspaceDir(io.cwd, values.workspace);
  const hub = await openMcpHub({ store, env: io.env, workspace, acp: [] });
  const views = hub.views();
  const width = Math.max(4, ...views.map((view) => view.name.length));
  const sourceWidth = Math.max(...Object.values(MCP_SOURCE_LABELS).map((label) => label.length));
  for (const view of views) io.out(`${view.name.padEnd(width)}  ${MCP_SOURCE_LABELS[view.source].padEnd(sourceWidth)}  ${describeServerState(view.state)}`);
  if (views.length === 0) io.out(`no MCP servers for ${workspace}`);
  for (const problem of hub.problems) io.err(`problem: ${problem}`);
  if (views.some((view) => view.state.status === 'untrusted')) io.out('approve a workspace server with: gcode mcp trust <name>');
  return 0;
};

/** `gcode mcp trust <name>`: approves a workspace server's current definition for this workspace, without starting it. */
const trust: Command = async (args, { io, store }) => {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: workspaceFlag });
  const name = singleId(positionals, 'server');
  const workspace = await workspaceDir(io.cwd, values.workspace);
  const hub = await openMcpHub({ store, env: io.env, workspace, acp: [] });
  await hub.trust(name);
  io.out(`trusted ${name} for ${workspace}; a changed definition asks again`);
  return 0;
};

export const mcpCommands: Record<string, Command> = { list, trust };
