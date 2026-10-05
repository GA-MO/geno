import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import {
  classifierInputOf,
  definitionHash,
  describeMcpTool,
  isTrusted,
  MCP_CALL_TOOL,
  MCP_DESCRIBE_TOOL,
  MCP_LAZY_THRESHOLD,
  mcpCatalog,
  mcpDenialFor,
  mcpResultText,
  mcpToolDefinitions,
  type ImageAttachment,
  type McpCatalog,
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
import { denialText, modeOf, settle, type Approval } from '../tools/agent.js';
import { executor, ToolDenied, ToolError, type Executor, type ToolContext } from '../tools/context.js';
import { loadMcpConfig } from './config.js';
import { McpServerHandle } from './server.js';
import { approveServer, readTrust } from './trust.js';

/** What a turn adds to the agent's tools: definitions for the request, sorted, and their executors. */
export type McpToolset = { readonly tools: readonly Tool[]; readonly executors: Readonly<Record<string, Executor>> };

export const NO_MCP_TOOLS: McpToolset = { tools: [], executors: {} };

/** A session's MCP servers. Nothing starts until the session first asks for tools. */
export type McpHub = {
  readonly problems: readonly string[];
  views(): McpServerView[];
  /** Approves a workspace server's current definition; it starts at the next need. */
  trust(name: string): Promise<void>;
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
};

const argumentsSchema = z.record(z.string(), z.unknown());
const nameSchema = z.strictObject({ name: z.string().min(1) });
const callSchema = z.strictObject({ name: z.string().min(1), arguments: argumentsSchema.nullish() });

/**
 * Stores each image of a result as an attachment, which the next request shows the model, and puts a line naming it
 * where it was. An image the attachment path refuses, such as an unknown format, stays a text placeholder.
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
    try {
      const image = await storeImage(ctx.attachmentsDir, Buffer.from(block.data, 'base64'), { name: label });
      images.push(image);
      shown.push({ type: 'text', text: describeImage(label, image) });
    } catch (error) {
      if (!(error instanceof AttachmentError)) throw error;
      shown.push(block);
    }
  }
  return { content: shown, images };
}

const unknownTool = (name: string, catalog: McpCatalog) =>
  new ToolError(`no MCP tool ${name}; the tools are listed in the ${MCP_DESCRIBE_TOOL} description${catalog.size === 0 ? ', and there are none now' : ''}`);

export async function openMcpHub({ store, env, workspace, acp }: McpHubOptions): Promise<McpHub> {
  const { servers, problems } = await loadMcpConfig(store, env, workspace, acp);
  const trust = await readTrust(store);
  const handles = new Map(servers.map((config) => [config.name, new McpServerHandle(config, isTrusted(config, workspace, trust), env, workspace)]));
  // Tools the user allowed for the rest of the session, by model-facing name.
  const allowed = new Set<string>();

  const ready = () => [...handles.values()].filter((handle) => handle.state.status === 'ready');

  // A server approved elsewhere, such as by `gcode mcp trust`, is picked up at the next need.
  const refreshTrust = async () => {
    const waiting = [...handles.values()].filter((handle) => handle.state.status === 'untrusted');
    if (waiting.length === 0) return;
    const entries = await readTrust(store);
    for (const handle of waiting) if (isTrusted(handle.config, workspace, entries)) handle.trust();
  };

  const toolExecutor = (name: string, info: McpToolInfo, approval: Approval): Executor =>
    executor({
      input: argumentsSchema,
      describe: (args) => `${name} ${JSON.stringify(args)}`,
      async run(args, ctx) {
        const handle = handles.get(info.server)!;
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
                () => allowed.add(name),
              );
        if (record?.verdict === 'deny') throw new ToolDenied(denialText(record), record);
        const result = await handle.call(info.tool, args, ctx.signal);
        if (result.isError) throw new ToolError(mcpResultText(result.content, result.structured));
        const { content, images } = await withImages(name, result.content, ctx);
        const text = mcpResultText(content, result.structured);
        if (record === undefined && images.length === 0) return text;
        return { text, ...(record === undefined ? {} : { approval: record }), ...(images.length === 0 ? {} : { images }) };
      },
    });

  return {
    problems,
    views: () =>
      [...handles.values()].map(({ config, state, tools }) => ({
        name: config.name,
        source: config.source,
        hash: definitionHash(config),
        state,
        tools: [...mcpCatalog(tools).keys()],
      })),
    async trust(name) {
      const handle = handles.get(name);
      if (handle === undefined) throw new EngineError(`no MCP server ${name}; the servers are ${[...handles.keys()].join(', ') || 'none'}`);
      if (handle.state.status !== 'untrusted') return;
      await approveServer(store, workspace, handle.config);
      handle.trust();
    },
    async toolset(approval) {
      if (approval.kind === 'non-interactive' && approval.mcp !== true) return NO_MCP_TOOLS;
      await refreshTrust();
      await Promise.all([...handles.values()].map((handle) => handle.ready()));
      const catalog = mcpCatalog(ready().flatMap((handle) => handle.tools));
      const executors: Record<string, Executor> = {};
      for (const [name, info] of catalog) executors[name] = toolExecutor(name, info, approval);
      if (catalog.size > MCP_LAZY_THRESHOLD) {
        executors[MCP_DESCRIBE_TOOL] = executor({
          input: nameSchema,
          describe: ({ name }) => `${MCP_DESCRIBE_TOOL} ${name}`,
          async run({ name }) {
            const info = catalog.get(name);
            if (info === undefined) throw unknownTool(name, catalog);
            return describeMcpTool(name, info);
          },
        });
        executors[MCP_CALL_TOOL] = executor({
          input: callSchema,
          describe: ({ name, arguments: args }) => `${name} ${JSON.stringify(args ?? {})}`,
          async run({ name, arguments: args }, ctx) {
            if (!catalog.has(name)) throw unknownTool(name, catalog);
            return executors[name]!.run(args ?? {}, ctx);
          },
        });
      }
      return { tools: mcpToolDefinitions(catalog), executors };
    },
    prompts: async () => (await Promise.all(ready().map((handle) => handle.connection?.prompts() ?? []))).flat(),
    resources: async () => (await Promise.all(ready().map((handle) => handle.connection?.resources() ?? []))).flat(),
    async stop() {
      await Promise.all([...handles.values()].map((handle) => handle.stop()));
    },
  };
}
