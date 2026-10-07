import { AGENT_PROMPTS, AGENT_TOOL_DEFINITIONS, PROMPT_TIERS, textTokens } from '../packages/core/src/index.js';

// Prints each prompt tier's size and the agent's built-in tool definitions, for docs/results/p24-prompt-tier.md.
for (const tier of PROMPT_TIERS) console.log(`${tier}: ${AGENT_PROMPTS[tier].length} chars, ~${textTokens(AGENT_PROMPTS[tier])} tokens`);
const tools = JSON.stringify(AGENT_TOOL_DEFINITIONS);
console.log(`built-in tool definitions: ${tools.length} chars, ~${textTokens(tools)} tokens`);
