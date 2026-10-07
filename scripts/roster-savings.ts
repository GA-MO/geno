// Prints, per mode and client, the tools U46's roster defers and the tokens that saves a call, by the roster's own
// estimate. Rerun it after adding a tool and update the numbers in docs/u46.md, u48.md, u53.md, u55.md, u57.md, u59.md and u60.md.
// Run with: pnpm tsx scripts/roster-savings.ts
// The tool list mirrors the `own` list that runAgent builds in packages/engine/src/agent.ts, without MCP or subagent tools.
import {
  AGENT_MODE_TOOL_DEFINITIONS,
  deferredSavings,
  editorActionToolDefinitions,
  MIN_SAVED_TOKENS,
  readTerminalToolDefinitions,
  spinoffToolDefinitions,
  toolRoster,
  userToolDefinitions,
  webToolDefinitions,
  widgetToolDefinitions,
  type ApprovalMode,
  type UserToolName,
} from '../packages/core/src/index.js';

type Client = { readonly name: string; readonly user: readonly UserToolName[]; readonly widgets: boolean; readonly editor: boolean; readonly terminal: boolean; readonly spinoffs: boolean };

const CLIENTS: readonly Client[] = [
  { name: 'terminal', user: [], widgets: false, editor: false, terminal: false, spinoffs: false },
  { name: 'editor without remember or widget', user: ['ask_user'], widgets: false, editor: true, terminal: true, spinoffs: true },
  { name: 'editor with remember', user: ['ask_user', 'remember'], widgets: false, editor: true, terminal: true, spinoffs: true },
  { name: 'VS Code panel (remember and widget)', user: ['ask_user', 'remember'], widgets: true, editor: true, terminal: true, spinoffs: true },
];

const MODES: readonly ApprovalMode[] = ['non-interactive', 'plan', 'ask', 'auto'];

for (const search of [false, true]) {
  console.log(`\n${search ? 'with' : 'without'} a search key (threshold ${MIN_SAVED_TOKENS})`);
  for (const client of CLIENTS) {
    for (const mode of MODES) {
      if (mode === 'non-interactive' && client.name !== 'terminal') continue;
      const tools = [
        ...AGENT_MODE_TOOL_DEFINITIONS[mode],
        ...userToolDefinitions(mode, new Set(client.user)),
        ...widgetToolDefinitions(mode, client.widgets),
        ...editorActionToolDefinitions(mode, client.editor),
        ...readTerminalToolDefinitions(mode, client.terminal),
        ...spinoffToolDefinitions(mode, client.spinoffs),
        ...webToolDefinitions(search),
      ];
      const roster = toolRoster(tools);
      const saved = deferredSavings(tools);
      const deferred = roster.deferred.size === 0 ? 'nothing deferred' : [...roster.deferred.keys()].join(', ');
      console.log(`${client.name.padEnd(36)} ${mode.padEnd(16)} saves ${String(saved).padStart(5)}  ${deferred}`);
    }
  }
}
