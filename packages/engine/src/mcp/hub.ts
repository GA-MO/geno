import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  attachmentFileName,
  BROWSER_SERVER,
  BROWSER_TOOLS,
  classifierInputOf,
  definitionHash,
  isTrusted,
  mcpDefinitionView,
  MCP_SOURCE_LABELS,
  mcpCatalog,
  mcpDenialFor,
  mcpResultText,
  mcpToolDefinitions,
  MAX_MESSAGE_BYTES,
  type ImageAttachment,
  type McpContent,
  type McpPromptInfo,
  type McpResourceInfo,
  type McpServerView,
  type McpToolInfo,
} from '@g-code/core';
import { AttachmentError, describeImage, storeImage } from '../attachments.js';
import type { Env } from '../child-env.js';
import { EngineError } from '../errors.js';
import type { Store } from '../store.js';
import { modeOf, refusalOf, settle, type Approval } from '../tools/agent.js';
import { executor, ToolError, type Executor, type ToolContext } from '../tools/context.js';
import { browserExecutor, browserServerConfig, newBrowserState, type BrowserOptions } from './browser.js';
import { loadMcpConfig } from './config.js';
import { McpServerHandle } from './server.js';
import { approveServer, readDisabled, readTrust, setDisabled } from './trust.js';

/** What a turn adds to the agent's tools: definitions for the request, sorted, and their executors. */
export type McpToolset = { readonly tools: readonly Tool[]; readonly executors: Readonly<Record<string, Executor>> };

export const NO_MCP_TOOLS: McpToolset = { tools: [], executors: {} };

/**
 * A session's MCP servers. `start` starts them; `toolset` offers the tools of the servers ready at that moment and
 * never waits for one still starting, so a cold server joins a later turn instead of holding up this one.
 */
export type McpHub = {
  readonly problems: readonly string[];
  views(): McpServerView[];
  /** Starts every trusted, enabled server not yet started, and resolves once each is ready or failed. */
  start(): Promise<void>;
  /**
   * Approves a workspace server's definition, which must be the one with `hash` when given; the next start starts it.
   * The hash binds the approval to the definition the user was shown.
   */
  trust(name: string, hash?: string): Promise<void>;
  /** Turns a server off for this workspace, stopping it, or back on; the next start starts it. */
  setEnabled(name: string, enabled: boolean): Promise<void>;
  toolset(approval: Approval): Promise<McpToolset>;
  prompts(): Promise<McpPromptInfo[]>;
  resources(): Promise<McpResourceInfo[]>;
  stop(): Promise<void>;
};

export type McpHubOptions = {
  readonly store: Store;
  readonly env: Env;
  readonly workspace: string;
  /** The servers the editor passed in session/new. */
  readonly acp: readonly acp.McpServer[];
  /** The built-in browser; without it the session has none. */
  readonly browser?: BrowserOptions | undefined;
};

const argumentsSchema = z.record(z.string(), z.unknown());

/**
 * Stores each image of a result as an attachment, which the next request shows the model, and puts a line naming it
 * where it was. An image the attachment path refuses, such as an unknown format or one larger than `read` returns,
 * stays a text placeholder. The stored file is the image's path, which the editor shows as a thumbnail on the step.
 */
async function withImages(name: string, content: readonly McpContent[], ctx: ToolContext): Promise<{ content: McpContent[]; images: ImageAttachment[] }> {
  const images: ImageAttachment[] = [];
  const shown: McpContent[] = [];
  for (const block of content) {
    if (block.type !== 'image') {
      shown.push(block);
      continue;
    }
    const label = `${name} image ${images.length + 1}`;
    const bytes = Buffer.from(block.data, 'base64');
    if (bytes.length > MAX_MESSAGE_BYTES) {
      shown.push(block);
      continue;
    }
    try {
      const stored = await storeImage(ctx.attachmentsDir, bytes, { name: label });
      const image = { ...stored, path: path.join(ctx.attachmentsDir, attachmentFileName(stored)) };
      images.push(image);
      shown.push({ type: 'text', text: describeImage(label, image) });
    } catch (error) {
      if (!(error instanceof AttachmentError)) throw error;
      shown.push(block);
    }
  }
  return { content: shown, images };
}

export async function openMcpHub({ store, env, workspace, acp, browser }: McpHubOptions): Promise<McpHub> {
  const loaded = await loadMcpConfig(store, env, workspace, acp);
  const problems = [...loaded.problems];
  const servers = loaded.servers.filter((config) => {
    if (config.name !== BROWSER_SERVER) return true;
    problems.push(`${config.name} from ${MCP_SOURCE_LABELS[config.source]} is left out: the name belongs to Geno's built-in browser`);
    return false;
  });
  const trust = await readTrust(store);
  const disabled = await readDisabled(store, workspace);
  const handles = new Map(
    servers.map((config) => [config.name, new McpServerHandle(config, isTrusted(config, workspace, trust), disabled.has(config.name), env, workspace)]),
  );
  // Its on and off live in the editor's settings, not the disabled file.
  if (browser !== undefined) {
    // The server's working folder, which must exist for it to start.
    await mkdir(browser.home, { recursive: true });
    handles.set(BROWSER_SERVER, new McpServerHandle(browserServerConfig(browser, workspace), true, !browser.settings.enabled, env, workspace));
  }
  const browserState = newBrowserState();
  const isBuiltin = (handle: McpServerHandle): boolean => handle.config.source === 'builtin';
  const handleOf = (name: string): McpServerHandle => {
    const handle = handles.get(name);
    if (handle === undefined) throw new EngineError(`no MCP server ${name}; the servers are ${[...handles.keys()].join(', ') || 'none'}`);
    return handle;
  };
  // Once the session's servers are stopped, a start still on its way must not bring them back.
  let stopped = false;
  // Tools the user allowed for the rest of the session, by model-facing name.
  const allowed = new Set<string>();

  const ready = () => [...handles.values()].filter((handle) => handle.state.status === 'ready');
  // A built-in server offers the tools of its pinned version until it is off, and starts at the first call of one.
  const offered = (handle: McpServerHandle): readonly McpToolInfo[] =>
    isBuiltin(handle) ? (handle.state.status === 'disabled' ? [] : BROWSER_TOOLS) : handle.tools;

  /** Runs one call on the server and turns its result into the model's text and stored images. */
  const callTool = async (handle: McpServerHandle, name: string, info: McpToolInfo, args: Record<string, unknown>, ctx: ToolContext) => {
    const result = await handle.call(info.tool, args, ctx.signal);
    if (result.isError) throw new ToolError(mcpResultText(result.content, result.structured));
    const { content, images } = await withImages(name, result.content, ctx);
    return { text: mcpResultText(content, result.structured), images };
  };

  // A server approved elsewhere, such as by `gcode mcp trust`, is picked up at the next need.
  const refreshTrust = async () => {
    const waiting = [...handles.values()].filter((handle) => handle.state.status === 'untrusted');
    if (waiting.length === 0) return;
    const entries = await readTrust(store);
    for (const handle of waiting) if (isTrusted(handle.config, workspace, entries)) handle.trust();
  };

  const toolExecutor = (name: string, info: McpToolInfo, approval: Approval): Executor => {
    const handle = handles.get(info.server)!;
    if (isBuiltin(handle)) {
      return browserExecutor(name, info, { handle, approval, state: browserState, allowed, call: (args, ctx) => callTool(handle, name, info, args, ctx) });
    }
    return executor({
      // Asked as its batch forms: a read-only tool runs beside others only while its rules let it run without asking.
      concurrent: () => info.readOnly && mcpDenialFor({ name, readOnly: true }, modeOf(approval), allowed.has(name)) === undefined,
      input: argumentsSchema,
      describe: (args) => `${name} ${JSON.stringify(args)}`,
      async run(args, ctx) {
        const mode = modeOf(approval);
        const denial = mcpDenialFor({ name, readOnly: info.readOnly }, mode, allowed.has(name));
        const record =
          denial === undefined
            ? undefined
            : await settle(
                approval,
                mode,
                denial,
                () => ({ ...classifierInputOf(ctx.events(), name, denial), mcp: { server: info.server, tool: info.tool, arguments: JSON.stringify(args) } }),
                ctx.signal,
                () => {
                  allowed.add(name);
                },
              );
        if (record?.verdict === 'deny') throw refusalOf(record);
        const { text, images } = await callTool(handle, name, info, args, ctx);
        if (record === undefined && images.length === 0) return text;
        return { text, ...(record === undefined ? {} : { approval: record }), ...(images.length === 0 ? {} : { images }) };
      },
    });
  };

  return {
    problems,
    views: () =>
      [...handles.values()].map((handle) => ({
        name: handle.config.name,
        source: handle.config.source,
        startsOn: isBuiltin(handle) ? ('first-use' as const) : ('session' as const),
        hash: definitionHash(handle.config),
        definition: mcpDefinitionView(handle.config.transport),
        state: handle.state,
        tools: [...mcpCatalog(offered(handle)).keys()],
      })),
    async start() {
      if (stopped) return;
      await refreshTrust();
      if (stopped) return;
      await Promise.all([...handles.values()].filter((handle) => !isBuiltin(handle)).map((handle) => handle.ready()));
    },
    async trust(name, hash) {
      const handle = handleOf(name);
      if (hash !== undefined && hash !== definitionHash(handle.config)) {
        throw new EngineError(`the definition of ${name} changed since it was shown; look at it again before allowing it`);
      }
      const { status } = handle.state;
      if (status !== 'untrusted' && !(status === 'disabled' && !handle.state.trusted)) return;
      await approveServer(store, workspace, handle.config);
      handle.trust();
    },
    async setEnabled(name, enabled) {
      const handle = handleOf(name);
      if (!isBuiltin(handle)) await setDisabled(store, workspace, name, !enabled);
      if (enabled) handle.enable();
      else await handle.disable();
    },
    async toolset(approval) {
      if (approval.kind === 'non-interactive' && approval.mcp !== true) return NO_MCP_TOOLS;
      const catalog = mcpCatalog([...handles.values()].flatMap(offered));
      const executors: Record<string, Executor> = {};
      for (const [name, info] of catalog) executors[name] = toolExecutor(name, info, approval);
      return { tools: mcpToolDefinitions(catalog), executors };
    },
    prompts: async () => (await Promise.all(ready().map((handle) => handle.connection?.prompts() ?? []))).flat(),
    resources: async () => (await Promise.all(ready().map((handle) => handle.connection?.resources() ?? []))).flat(),
    async stop() {
      stopped = true;
      await Promise.all([...handles.values()].map((handle) => handle.stop()));
    },
  };
}
